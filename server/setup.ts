// `vibe-os setup`: doctor's checks, with an offer to fix each one.
//
// The rule every step follows is the one the README's agent prompt used to ask
// an agent for: say what is about to run, then run it. Each step checks first
// and stays quiet when there is nothing to do, so running setup again on a box
// it already set up is a cheap way to see that nothing drifted.
//
// It runs as the login user and reaches for sudo per command, rather than
// running as root throughout. Harness installers write to the home directory of
// whoever runs them, the token belongs in that user's state dir, and
// install-service reads SUDO_USER to decide who the unit runs as. All three are
// right by construction this way and would each need correcting from root.

import { spawn } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";

import { type Config, type RawOptions, savePersisted } from "./config.ts";
import {
  authorizedKeysPaths,
  homeFor,
  onPath,
  parseSshdConfig,
  parseUfw,
  probeTcp,
} from "./doctor.ts";
import { CLAUDE_INSTALL, CURSOR_INSTALL, HERMES_INSTALL } from "./harness.ts";
import { color, describeError } from "./log.ts";
import { type OomState, oomState, scopeState } from "./memory.ts";
import { ENTRY, IS_COMPILED, invocation } from "./runtime.ts";

export const TAILSCALE_INSTALL =
  "curl -fsSL https://tailscale.com/install.sh | sh";

/** The port setup serves on when not told otherwise, behind `tailscale serve`. */
export const SETUP_PORT = 7681;

const UNIT_PATH = "/etc/systemd/system/vibe-os.service";
const HARDENING_PATH = "/etc/ssh/sshd_config.d/01-hardening.conf";
const HARDENING =
  "PasswordAuthentication no\nKbdInteractiveAuthentication no\n";

/** The transient timer that turns ufw back off unless someone confirms. */
const REVERT_UNIT = "vibe-os-firewall-revert";
const REVERT_AFTER_SECONDS = 300;
/** Written by `vibe-os confirm-firewall`, from a session over the tailnet. */
const CONFIRM_FILE = "firewall-confirmed";

// ── the pure parts ─────────────────────────────────────────────────────────

export type Manager = "apt" | "dnf" | "yum" | "pacman" | "zypper";

/**
 * What a missing command is called in each distro's repositories.
 *
 * Only the names that differ are the reason this is a table: openssh is one
 * package on Arch and two everywhere else, and the client half is
 * `openssh-clients` on the RPM side.
 */
const PACKAGES: Record<string, Record<Manager, string>> = {
  sshd: {
    apt: "openssh-server",
    dnf: "openssh-server",
    yum: "openssh-server",
    pacman: "openssh",
    zypper: "openssh-server",
  },
  "ssh-keygen": {
    apt: "openssh-client",
    dnf: "openssh-clients",
    yum: "openssh-clients",
    pacman: "openssh",
    zypper: "openssh-clients",
  },
  "ssh-keyscan": {
    apt: "openssh-client",
    dnf: "openssh-clients",
    yum: "openssh-clients",
    pacman: "openssh",
    zypper: "openssh-clients",
  },
  gh: {
    apt: "gh",
    dnf: "gh",
    yum: "gh",
    pacman: "github-cli",
    zypper: "gh",
  },
};

/** Package names for a list of commands, deduplicated, in the order given. */
export function packagesFor(commands: string[], manager: Manager): string[] {
  const names = commands.map((c) => PACKAGES[c]?.[manager] ?? c);
  return [...new Set(names)];
}

/** The commands that install packages, non-interactively. */
export function installCommands(manager: Manager, pkgs: string[]): string[][] {
  switch (manager) {
    case "apt":
      // DEBIAN_FRONTEND keeps a package's debconf questions from stopping an
      // unattended run; `env` carries it through sudo, which drops the rest of
      // the environment.
      return [
        ["apt-get", "update"],
        [
          "env",
          "DEBIAN_FRONTEND=noninteractive",
          "apt-get",
          "install",
          "-y",
          ...pkgs,
        ],
      ];
    case "dnf":
    case "yum":
      return [[manager, "install", "-y", ...pkgs]];
    case "pacman":
      return [["pacman", "-S", "--needed", "--noconfirm", ...pkgs]];
    case "zypper":
      return [["zypper", "--non-interactive", "install", ...pkgs]];
  }
}

/** A command as a person would type it, for showing before it runs. */
export function display(argv: string[]): string {
  return argv
    .map((a) =>
      a === "" || /[^\w@%+=:,./-]/.test(a)
        ? `'${a.replaceAll("'", `'\\''`)}'`
        : a,
    )
    .join(" ");
}

export interface UnitFlags {
  port: number | null;
  host: string | null;
  /** undefined: no token flag, so the service uses the remembered one. */
  token: string | null | undefined;
}

/**
 * The flags an installed vibe-os unit starts with.
 *
 * The service is the source of truth for where vibe-os is listening and which
 * token it wants, and setup reads it rather than assuming its own defaults
 * were the ones used: a unit installed by hand with `--port 8080` is served on
 * 8080, and the URL printed at the end has to say so.
 */
export function unitFlags(unit: string): UnitFlags {
  const line = unit.split("\n").find((l) => l.startsWith("ExecStart="));
  const words = line?.slice("ExecStart=".length).trim().split(/\s+/) ?? [];
  const flags: UnitFlags = { port: null, host: null, token: undefined };

  const value = (i: number, name: string): string | undefined => {
    const word = words[i] as string;
    if (word.startsWith(`${name}=`)) return word.slice(name.length + 1);
    const next = words[i + 1];
    return next === undefined || next.startsWith("-") ? "" : next;
  };

  words.forEach((word, i) => {
    if (word === "--port" || word.startsWith("--port=")) {
      const n = Number(value(i, "--port"));
      if (Number.isInteger(n) && n > 0) flags.port = n;
    } else if (word === "--host" || word.startsWith("--host=")) {
      flags.host = value(i, "--host") || null;
    } else if (word === "--no-token") {
      flags.token = null;
    } else if (word === "--token" || word.startsWith("--token=")) {
      // A bare `--token` means "the remembered one", same as no flag at all.
      flags.token = value(i, "--token") || undefined;
    }
  });
  return flags;
}

/** Whether sshd still accepts a password, by any of its names for one. */
export function passwordLoginOn(sshd: Map<string, string>): boolean {
  return (
    sshd.get("passwordauthentication") !== "no" ||
    // Absent on sshd older than 8.7, which calls it challengeresponse; absent
    // is not the same as on.
    (sshd.get("kbdinteractiveauthentication") ?? "no") !== "no"
  );
}

/**
 * Whether an authorized_keys file lets somebody in with a key.
 *
 * The question before turning password logins off is whether that leaves any
 * way in at all. The `cert-authority` line vibe-os writes does not count: it
 * trusts certificates this box signs, which a person on a laptop does not have.
 */
export function hasLoginKey(authorizedKeys: string): boolean {
  return authorizedKeys.split("\n").some((raw) => {
    const line = raw.trim();
    return (
      line.length > 0 &&
      !line.startsWith("#") &&
      !/\bcert-authority\b/.test(line)
    );
  });
}

export interface TailscaleState {
  running: boolean;
  /** The MagicDNS name, without the trailing dot. */
  dnsName: string | null;
  ip: string | null;
}

export function parseTailscaleStatus(json: string): TailscaleState {
  try {
    const status = JSON.parse(json) as {
      BackendState?: string;
      Self?: { DNSName?: string; TailscaleIPs?: string[] };
    };
    return {
      running: status.BackendState === "Running",
      dnsName: status.Self?.DNSName?.replace(/\.$/, "") || null,
      ip: status.Self?.TailscaleIPs?.find((a) => a.includes(".")) ?? null,
    };
  } catch {
    return { running: false, dnsName: null, ip: null };
  }
}

/** Whether `tailscale serve status` already proxies to this port. */
export function serveCovers(status: string, port: number): boolean {
  return new RegExp(`(127\\.0\\.0\\.1|localhost):${port}\\b`).test(status);
}

// ── running things ─────────────────────────────────────────────────────────

interface Options {
  yes: boolean;
  firewall: boolean;
  hermes: boolean;
  cursor: boolean;
}

/** Closed over by every step: how to ask, and how to run with privileges. */
class Session {
  /** Things to do by hand afterwards, printed together at the end. */
  readonly next: string[] = [];
  private readonly sudo: string[];

  constructor(
    readonly opts: Options,
    asRoot: boolean,
  ) {
    this.sudo = asRoot ? [] : ["sudo"];
  }

  heading(text: string): void {
    console.log("");
    console.log(`  ${color.bold(text)}`);
  }

  note(text: string): void {
    console.log(`  ${color.dim(text)}`);
  }

  done(text: string): void {
    console.log(`  ${color.green("✓")} ${text}`);
  }

  warn(text: string): void {
    console.log(`  ${color.yellow("!")} ${text}`);
  }

  /**
   * Asks a yes/no question, or answers it with the default under `--yes`.
   *
   * The commands are printed before the question rather than after the answer,
   * because "install these packages?" is not a question anyone can answer
   * without seeing which packages and how.
   *
   * A fresh readline per question, closed before anything runs: a child given
   * this terminal (sudo asking for a password, `tailscale up` printing its
   * login URL) needs stdin to itself, and readline holds it while open.
   */
  async confirm(
    question: string,
    def: boolean,
    commands: string[][] = [],
  ): Promise<boolean> {
    for (const argv of commands)
      console.log(`    ${color.cyan(display(argv))}`);
    if (this.opts.yes) return def;
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      const answer = (
        await rl.question(`  ${question} ${def ? "[Y/n]" : "[y/N]"} `)
      )
        .trim()
        .toLowerCase();
      return answer === "" ? def : answer === "y" || answer === "yes";
    } finally {
      rl.close();
    }
  }

  /** A free-text answer, for the one question that is not yes or no. */
  async ask(question: string, def: string): Promise<string> {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      const answer = (await rl.question(`  ${question} [${def}] `)).trim();
      return answer || def;
    } finally {
      rl.close();
    }
  }

  /** Runs a command on this terminal, printing it first. */
  run(argv: string[], privileged = false): Promise<boolean> {
    const full = privileged ? [...this.sudo, ...argv] : argv;
    console.log(`  ${color.dim("$")} ${display(full)}`);
    return new Promise((resolve) => {
      const child = spawn(full[0] as string, full.slice(1), {
        stdio: "inherit",
      });
      child.once("error", (err) => {
        this.warn(`could not run ${full[0]}: ${err.message}`);
        resolve(false);
      });
      child.once("exit", (code) => resolve(code === 0));
    });
  }

  /** Runs each in turn, stopping at the first that fails. */
  async runAll(commands: string[][], privileged = false): Promise<boolean> {
    for (const argv of commands)
      if (!(await this.run(argv, privileged))) return false;
    return true;
  }

  /** A command's stdout, quietly, or null if it failed. */
  capture(argv: string[], privileged = false): Promise<string | null> {
    // -n: a read never prompts. The sudo step at the top has already cached
    // credentials, and a read that stops to ask for a password mid-step would
    // be a prompt with nothing printed above it to say why.
    const full =
      privileged && this.sudo.length > 0 ? ["sudo", "-n", ...argv] : argv;
    return new Promise((resolve) => {
      let out = "";
      const child = spawn(full[0] as string, full.slice(1), {
        stdio: ["ignore", "pipe", "ignore"],
      });
      child.stdout.on("data", (chunk) => {
        out += chunk;
      });
      child.once("error", () => resolve(null));
      child.once("exit", (code) => resolve(code === 0 ? out : null));
    });
  }

  /** Writes a root-owned file by way of a temporary one the user owns. */
  async install(
    file: string,
    contents: string,
    mode: string,
  ): Promise<boolean> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "vibe-os-setup-"));
    const tmp = path.join(dir, path.basename(file));
    try {
      await writeFile(tmp, contents);
      return await this.run(["install", "-m", mode, tmp, file], true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

/** How to run this same vibe-os again, from a checkout or a binary. */
const SELF = IS_COMPILED ? [process.execPath] : [process.execPath, ENTRY];

const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  );

/**
 * A command that may live in sbin.
 *
 * Debian leaves /usr/sbin off an ordinary user's PATH, so `sshd` and `ufw` are
 * both "not found" to a non-root lookup on a box that has them.
 */
async function findSbin(command: string): Promise<string | null> {
  for (const dir of ["/usr/sbin", "/usr/local/sbin", "/sbin", "/usr/bin"]) {
    const candidate = path.join(dir, command);
    if (await exists(candidate)) return candidate;
  }
  return (await onPath(command)) ? command : null;
}

async function detectManager(): Promise<Manager | null> {
  for (const [command, manager] of [
    ["apt-get", "apt"],
    ["dnf", "dnf"],
    ["yum", "yum"],
    ["pacman", "pacman"],
    ["zypper", "zypper"],
  ] as const) {
    if (await onPath(command)) return manager;
  }
  return null;
}

/** Debian calls the unit `ssh`; everyone else calls it `sshd`. */
async function sshUnit(s: Session): Promise<string> {
  return (await s.capture(["systemctl", "cat", "ssh.service"])) !== null
    ? "ssh"
    : "sshd";
}

// ── the steps ──────────────────────────────────────────────────────────────

/**
 * Root: refuse, or make the user to run as.
 *
 * vibe-os hands out shells as whoever runs it, so the user it runs as matters
 * more than anything else setup decides. Setup stops after creating one rather
 * than carrying on as them: every later step should run as that user, from a
 * login as that user, and the honest way to prove the login works is to use it.
 */
async function fromRoot(s: Session, values: RawOptions): Promise<number> {
  s.heading("user");
  s.warn("running as root, and vibe-os would hand out root shells");

  let name = typeof values.user === "string" ? values.user : "";
  if (!name) {
    if (s.opts.yes) {
      s.note("pass --user <name> to create one, or log in as another user");
      return 1;
    }
    name = await s.ask("Name for a new user to run vibe-os as?", "vibe");
    if (!/^[a-z_][a-z0-9_-]*$/.test(name)) {
      s.warn(`not a usable name: ${name}`);
      return 1;
    }
  }

  if (await homeFor(name)) {
    s.done(`${name} already exists`);
  } else {
    const group = (await s.capture(["getent", "group", "sudo"]))
      ? "sudo"
      : "wheel";
    const sudoers = `/etc/sudoers.d/90-vibe-os-${name}`;
    const commands = [
      [
        "useradd",
        "--create-home",
        "--shell",
        "/bin/bash",
        "--groups",
        group,
        name,
      ],
    ];
    s.note(
      `${name} gets no password, so sudo for it needs none either (${sudoers}),`,
    );
    s.note("and your SSH keys are copied from root so you can log in as it.");
    if (!(await s.confirm(`Create ${name}?`, true, commands))) return 1;
    if (!(await s.runAll(commands))) return 1;

    const rule = `${name} ALL=(ALL) NOPASSWD:ALL\n`;
    const dir = await mkdtemp(path.join(os.tmpdir(), "vibe-os-setup-"));
    try {
      const tmp = path.join(dir, "sudoers");
      await writeFile(tmp, rule, { mode: 0o440 });
      // visudo -c before it lands: a sudoers file sudo cannot parse breaks sudo
      // for everyone, on a box that may have no root password.
      if (
        !(await s.run(["visudo", "-cf", tmp])) ||
        !(await s.run(["install", "-m", "0440", tmp, sudoers]))
      )
        return 1;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }

    const home = (await homeFor(name)) ?? `/home/${name}`;
    if (await exists("/root/.ssh/authorized_keys")) {
      await s.runAll([
        ["install", "-d", "-m", "0700", "-o", name, "-g", name, `${home}/.ssh`],
        [
          "install",
          "-m",
          "0600",
          "-o",
          name,
          "-g",
          name,
          "/root/.ssh/authorized_keys",
          `${home}/.ssh/authorized_keys`,
        ],
      ]);
    } else {
      s.warn(
        `root has no authorized_keys to copy, so add a key for ${name} yourself`,
      );
    }
  }

  // A binary under /root is unreadable to the user it is about to be run as.
  if (IS_COMPILED && process.execPath.startsWith("/root/"))
    s.warn(
      `this binary is in ${path.dirname(process.execPath)}, which ${name} cannot read: reinstall it as ${name}`,
    );

  console.log("");
  console.log(
    `  Log in as ${color.bold(name)} and run setup again from there:`,
  );
  console.log("");
  console.log(`    ${color.cyan(`ssh ${name}@${os.hostname()}`)}`);
  console.log(`    ${color.cyan(`${invocation()} setup`)}`);
  console.log("");
  return 0;
}

async function sudoStep(s: Session): Promise<boolean> {
  if ((await s.capture(["sudo", "-n", "true"])) !== null) return true;
  if (!process.stdin.isTTY) {
    s.warn("sudo needs a password, and there is no terminal to type it into");
    s.note(
      "run setup from an interactive session (ssh -t), or give this user passwordless sudo",
    );
    return false;
  }
  s.heading("sudo");
  s.note("most of what follows needs root, one command at a time");
  return s.run(["sudo", "-v"]);
}

async function packagesStep(
  s: Session,
  manager: Manager | null,
): Promise<void> {
  const missing: string[] = [];
  if (!(await findSbin("sshd"))) missing.push("sshd");
  for (const command of ["ssh-keygen", "ssh-keyscan", "dtach", "git", "curl"])
    if (!(await onPath(command))) missing.push(command);
  const wantGh = !(await onPath("gh"));

  if (missing.length === 0 && !wantGh) {
    s.done("prerequisites installed");
    return;
  }

  s.heading("prerequisites");
  if (!manager) {
    s.warn(
      `missing ${[...missing, ...(wantGh ? ["gh"] : [])].join(", ")}, and no package manager this knows`,
    );
    return;
  }
  if (missing.length > 0) s.note(`missing: ${missing.join(", ")}`);
  if (
    wantGh &&
    (await s.confirm(
      "Install gh as well, for PRs and issues? (optional)",
      true,
    ))
  )
    missing.push("gh");
  if (missing.length === 0) return;

  const commands = installCommands(manager, packagesFor(missing, manager));
  if (!(await s.confirm("Install them?", true, commands))) return;
  if (await s.runAll(commands, true)) s.done("installed");
}

/**
 * What it takes to get an OOM daemon running: nothing when one already is,
 * starting earlyoom when it is installed, installing it otherwise. null when
 * it has to be installed and there is no package manager to do it with. Same
 * package name on every manager.
 */
export function oomCommands(
  oom: OomState,
  manager: Manager | null,
): string[][] | null {
  if (oom.oomd || oom.earlyoom === "active") return [];
  const enable = ["systemctl", "enable", "--now", "earlyoom"];
  if (oom.earlyoom === "installed") return [enable];
  if (!manager) return null;
  return [...installCommands(manager, ["earlyoom"]), enable];
}

/**
 * An OOM daemon, so a box out of memory kills one process instead of
 * thrashing until someone notices.
 */
async function oomStep(s: Session, manager: Manager | null): Promise<void> {
  if (process.platform !== "linux") return;
  const oom = await oomState();
  const commands = oomCommands(oom, manager);
  if (commands?.length === 0) {
    s.done(`${oom.oomd ? "systemd-oomd" : "earlyoom"} running`);
    return;
  }
  s.heading("oom daemon");
  s.note(
    oom.swapTotal > 0
      ? "with swap and nothing watching, running out of memory stalls the box instead of ending one process"
      : "nothing ends a runaway process before the box stalls",
  );
  if (commands === null) {
    s.warn("no package manager this knows; install earlyoom by hand");
    return;
  }
  const question =
    oom.earlyoom === "installed"
      ? "Start earlyoom, and on every boot?"
      : "Install earlyoom?";
  if (!(await s.confirm(question, true, commands))) return;
  if (await s.runAll(commands, true)) s.done("earlyoom running");
}

/**
 * Lingering, without which windows get no memory limits: a scope lives under
 * the user's manager, and logind stops that manager with the last login.
 */
async function lingerStep(s: Session, config: Config): Promise<void> {
  if (process.platform !== "linux") return;
  const scope = await scopeState(config.user, null);
  if (!scope.systemd) return;
  if (scope.linger) {
    s.done(`${config.user} lingers, so windows get memory limits`);
    return;
  }
  s.heading("memory limits");
  s.note(
    "each window runs in its own scope under your user manager, which has to outlive your logins",
  );
  const command = ["loginctl", "enable-linger", config.user];
  if (await s.confirm("Keep your user manager running?", true, [command]))
    if (await s.run(command, true)) s.done("lingering on");
}

async function sshdStep(s: Session, config: Config): Promise<void> {
  if (await probeTcp(config.sshHost, config.sshPort)) {
    s.done(`sshd answering on ${config.sshHost}:${config.sshPort}`);
    return;
  }
  const unit = await sshUnit(s);
  s.heading("sshd");
  s.note("every window logs in through it");
  const command = ["systemctl", "enable", "--now", unit];
  if (await s.confirm("Start sshd, and on every boot?", true, [command]))
    if (await s.run(command, true)) s.done("sshd running");
}

async function harnessStep(s: Session): Promise<void> {
  const harnesses = [
    {
      name: "Claude Code",
      command: "claude",
      scripts: [CLAUDE_INSTALL],
      def: true,
      after: "run claude once to sign in",
    },
    {
      name: "Hermes",
      command: "hermes",
      scripts: [HERMES_INSTALL],
      def: s.opts.hermes,
      after: "run hermes setup to pick a provider",
    },
    {
      name: "Cursor",
      command: "cursor-agent",
      scripts: [CURSOR_INSTALL],
      def: s.opts.cursor,
      after: "run cursor-agent login",
    },
  ];

  const missing = [];
  for (const h of harnesses) {
    if (await onPath(h.command)) s.done(`${h.name} installed`);
    else missing.push(h);
  }
  if (missing.length === 0) return;

  s.heading("harnesses");
  s.note("the agents a profile can launch; each installs to ~/.local/bin");
  for (const h of missing) {
    const commands = h.scripts.map((script) => ["sh", "-c", script]);
    const optional = h.command === "claude" ? "" : " (optional)";
    if (!(await s.confirm(`Install ${h.name}?${optional}`, h.def, commands)))
      continue;
    if (await s.runAll(commands)) {
      s.done(`${h.name} installed`);
      s.next.push(`${h.name}: ${h.after}`);
    }
  }
}

async function tailscaleStep(s: Session): Promise<TailscaleState> {
  const down: TailscaleState = { running: false, dnsName: null, ip: null };
  if (!(await onPath("tailscale"))) {
    s.heading("tailscale");
    s.note("serves vibe-os over HTTPS on your tailnet, and nowhere else");
    const command = ["sh", "-c", TAILSCALE_INSTALL];
    if (!(await s.confirm("Install Tailscale?", true, [command]))) return down;
    if (!(await s.run(command))) return down;
  }

  const read = async () =>
    parseTailscaleStatus(
      (await s.capture(["tailscale", "status", "--json"])) ?? "",
    );
  let state = await read();
  if (!state.running) {
    s.heading("tailscale");
    s.note("this prints a URL to open, and waits until you have signed in");
    const command = ["tailscale", "up"];
    if (!(await s.confirm("Bring Tailscale up?", true, [command]))) return down;
    await s.run(command, true);
    state = await read();
  }
  if (state.running)
    s.done(`Tailscale up as ${state.dnsName ?? state.ip ?? "this machine"}`);
  else
    s.warn("Tailscale is not up, so the steps that need a tailnet are skipped");
  return state;
}

interface Service {
  port: number;
  host: string;
  token: string | null;
  installed: boolean;
}

async function serviceStep(
  s: Session,
  config: Config,
  values: RawOptions,
): Promise<Service> {
  const unit = await readFile(UNIT_PATH, "utf8").catch(() => null);
  const current = unit ? unitFlags(unit) : null;
  // An installed unit with no --port or --host has vibe-os's own defaults, not
  // setup's.
  const port = values.port
    ? config.port
    : current
      ? (current.port ?? 80)
      : SETUP_PORT;
  const host = values.host
    ? config.host
    : current
      ? (current.host ?? "0.0.0.0")
      : "127.0.0.1";

  // An existing unit is kept unless asked for something different, which is
  // what makes a second run of setup safe on a box set up by hand.
  const differs =
    current !== null &&
    ((values.port !== undefined && current.port !== port) ||
      (values.host !== undefined && current.host !== host));
  if (current && !differs) {
    s.done(`service installed, on ${host}:${port}`);
    return {
      port,
      host,
      token: current.token === undefined ? config.token : current.token,
      installed: true,
    };
  }

  // Forwarded so the service sees the same paths setup was given.
  const forwarded: string[] = ["--port", String(port), "--host", host];
  for (const key of ["workspace", "state-dir", "theme-color"] as const) {
    const value = values[key];
    if (typeof value === "string") forwarded.push(`--${key}`, value);
  }
  const command = [...SELF, "install-service", ...forwarded];

  s.heading("service");
  s.note(
    current
      ? `replaces the installed unit, which listens on ${current.host ?? "0.0.0.0"}:${current.port ?? 80}`
      : "runs vibe-os on boot, as this user",
  );
  s.note(
    `the token is kept in ${path.join(config.stateDir, "config.json")}, not in the unit`,
  );
  if (!(await s.confirm("Install the service?", true, [["sudo", ...command]])))
    return { port, host, token: config.token, installed: false };

  // Remembered first, so the service's first start finds it. A token on the
  // ExecStart line would be readable by every user on the box: units are 0644.
  if (config.token)
    await savePersisted(config.stateDir, { token: config.token });
  const installed = await s.run(command, true);
  return { port, host, token: config.token, installed };
}

async function serveStep(
  s: Session,
  tailnet: TailscaleState,
  port: number,
): Promise<boolean> {
  if (!tailnet.running) return false;
  const status =
    (await s.capture(["tailscale", "serve", "status"], true)) ?? "";
  if (serveCovers(status, port)) {
    s.done(`tailscale serve proxies to port ${port}`);
    return true;
  }
  s.heading("https");
  s.note(
    `https://${tailnet.dnsName ?? "<machine>.<tailnet>.ts.net"}, with a real certificate`,
  );
  const command = ["tailscale", "serve", "--bg", String(port)];
  if (!(await s.confirm("Serve vibe-os on the tailnet?", true, [command])))
    return false;
  return s.run(command, true);
}

async function hardeningStep(s: Session, config: Config): Promise<void> {
  const sshd = await findSbin("sshd");
  if (!sshd) return;
  const spec = [
    "-T",
    "-C",
    `user=${config.user},host=localhost,addr=127.0.0.1`,
  ];
  const read = async () => {
    const out = await s.capture([sshd, ...spec], true);
    return out === null ? null : parseSshdConfig(out);
  };

  const before = await read();
  if (!before) {
    s.warn(
      "could not read sshd's effective config, so password login was left alone",
    );
    return;
  }
  if (!passwordLoginOn(before)) {
    s.done("sshd refuses passwords");
    return;
  }

  s.heading("ssh hardening");
  s.note("sshd accepts passwords, which every bot on the internet is guessing");

  // Turning passwords off with no key in place is the lockout this step most
  // needs to avoid.
  const home = (await homeFor(config.user)) ?? os.homedir();
  const files = authorizedKeysPaths(
    before.get("authorizedkeysfile") ?? ".ssh/authorized_keys",
    home,
    config.user,
  );
  let keyed = false;
  for (const file of files)
    if (hasLoginKey(await readFile(file, "utf8").catch(() => ""))) keyed = true;
  if (!keyed) {
    s.warn(
      `${config.user} has no SSH key in ${files[0]}, so passwords stay on`,
    );
    s.note("add your public key there, log in with it, then run setup again");
    return;
  }

  const existing = await readFile(HARDENING_PATH, "utf8").catch(() => null);
  const contents = existing
    ? `${existing.replace(/\n?$/, "\n")}${HARDENING}`
    : HARDENING;
  const unit = await sshUnit(s);
  const reload = ["systemctl", "try-reload-or-restart", unit];
  s.note(`adds to ${HARDENING_PATH}:`);
  for (const line of HARDENING.trim().split("\n"))
    console.log(`    ${color.cyan(line)}`);
  s.note("then checks the result and reloads:");
  if (
    !(await s.confirm("Turn off password logins?", true, [
      [sshd, "-t"],
      reload,
    ]))
  )
    return;

  if (!(await s.install(HARDENING_PATH, contents, "0644"))) return;
  if (!(await s.run([sshd, "-t"], true))) {
    // Never reload a config sshd has just said it cannot parse.
    s.warn("sshd rejected it, so the previous file is back");
    if (existing !== null) await s.install(HARDENING_PATH, existing, "0644");
    else await s.run(["rm", "-f", HARDENING_PATH], true);
    return;
  }
  await s.run(reload, true);

  // sshd takes the first value it sees, and a file that sorts earlier, or a
  // sshd_config with no Include, wins over this one. Only sshd can say.
  const after = await read();
  if (after && !passwordLoginOn(after)) s.done("sshd refuses passwords");
  else
    s.warn(
      `sshd still accepts passwords: something read before ${HARDENING_PATH} turns them on`,
    );
  s.next.push(
    "Check a fresh key-based ssh login works before closing this session",
  );
}

/**
 * Closes the box to everything but the tailnet.
 *
 * The one step that can cost the operator the machine, so it is arranged to
 * fail open. A transient systemd timer that turns ufw off is armed before ufw
 * is turned on, and the only thing that cancels it is a file written from a new
 * session that arrived over the tailnet. Nothing typed into this terminal
 * counts: this session is already connected, and ufw lets established
 * connections live, so it cannot prove a new one would get in.
 */
async function firewallStep(
  s: Session,
  config: Config,
  tailnet: TailscaleState,
  manager: Manager | null,
): Promise<void> {
  if (!tailnet.running) {
    s.warn(
      "firewall skipped: it allows only the tailnet, and Tailscale is not up",
    );
    return;
  }

  const ufw = await findSbin("ufw");
  const status = ufw
    ? await s.capture(["ufw", "status", "verbose"], true)
    : null;
  if (status) {
    const fw = parseUfw(status);
    if (
      fw.active &&
      fw.defaultDeny &&
      fw.tailnetAllowed &&
      fw.directUdpAllowed
    ) {
      s.done("ufw allows the tailnet and denies the rest");
      return;
    }
  }

  const rules = [
    ["ufw", "allow", "in", "on", "tailscale0"],
    ["ufw", "allow", "41641/udp"],
    ["ufw", "default", "deny", "incoming"],
    ["ufw", "default", "allow", "outgoing"],
  ];
  const minutes = REVERT_AFTER_SECONDS / 60;
  const arm = (ufwPath: string) => [
    "systemd-run",
    `--unit=${REVERT_UNIT}`,
    `--on-active=${REVERT_AFTER_SECONDS}`,
    // Timers coalesce within a minute by default, which made "five minutes"
    // anything up to six.
    "--timer-property=AccuracySec=1s",
    ufwPath,
    "disable",
  ];

  s.heading("firewall");
  s.warn("this can lock you out of the box");
  s.note(
    `ufw is turned back off after ${minutes} minutes unless a new ssh session`,
  );
  s.note(
    "over the tailnet confirms it got in. Know where your provider's console is.",
  );
  if (
    !(await s.confirm(
      "Close the box to everything but the tailnet?",
      s.opts.firewall,
      [arm(ufw ?? "/usr/sbin/ufw"), ...rules, ["ufw", "--force", "enable"]],
    ))
  ) {
    if (s.opts.yes)
      s.note("left alone: the firewall needs --firewall as well as --yes");
    return;
  }

  if (!ufw) {
    if (!manager) {
      s.warn(
        "ufw is not installed, and there is no package manager this knows",
      );
      return;
    }
    if (!(await s.runAll(installCommands(manager, ["ufw"]), true))) return;
  }
  // systemd-run wants a path, and the package may have only just put it there.
  const ufwPath = (await findSbin("ufw")) ?? "/usr/sbin/ufw";

  const marker = path.join(config.stateDir, CONFIRM_FILE);
  await rm(marker, { force: true });
  // A leftover timer from an earlier run would make systemd-run refuse the name.
  await s.capture(["systemctl", "stop", `${REVERT_UNIT}.timer`], true);
  await s.capture(
    ["systemctl", "reset-failed", `${REVERT_UNIT}.service`],
    true,
  );
  if (!(await s.run(arm(ufwPath), true))) {
    s.warn("could not arm the revert timer, so ufw was not turned on");
    return;
  }

  const cancel = () =>
    s.capture(["systemctl", "stop", `${REVERT_UNIT}.timer`], true);
  if (!(await s.runAll([...rules, ["ufw", "--force", "enable"]], true))) {
    await s.run(["ufw", "disable"], true);
    await cancel();
    s.warn("a rule failed, so ufw is off again");
    return;
  }

  const where = tailnet.dnsName ?? tailnet.ip ?? "<tailnet address>";
  console.log("");
  console.log("  From a new terminal, over the tailnet:");
  console.log("");
  console.log(
    `    ${color.cyan(`ssh ${config.user}@${where} ${invocation()} confirm-firewall`)}`,
  );
  console.log("");
  s.note(
    `waiting up to ${minutes} minutes; ufw turns itself off if this never arrives`,
  );

  const confirmed = await waitFor(marker, async () => {
    const out = await s.capture([
      "systemctl",
      "is-active",
      `${REVERT_UNIT}.timer`,
    ]);
    return out !== null;
  });
  await rm(marker, { force: true });

  if (confirmed) {
    await cancel();
    s.done("confirmed over the tailnet; ufw stays on");
    s.next.push(
      "Your provider's firewall is separate: leave 41641/udp open there for a direct Tailscale path",
    );
  } else {
    // The timer has fired by now, or is about to; make sure rather than trust it.
    await s.run(["ufw", "disable"], true);
    await cancel();
    s.warn(
      "no confirmation arrived, so ufw is off again; run setup to try again",
    );
  }
}

/** Polls for the marker while the timer is still armed. */
async function waitFor(
  marker: string,
  armed: () => Promise<boolean>,
): Promise<boolean> {
  const deadline = Date.now() + REVERT_AFTER_SECONDS * 1000;
  while (Date.now() < deadline) {
    if (await exists(marker)) return true;
    if (!(await armed())) return false;
    await Bun.sleep(1_000);
  }
  return exists(marker);
}

/**
 * The end of setup is doctor's report, run with root so the sshd and firewall
 * checks are real, and with the flags the service has so the port is the one
 * that matters.
 */
async function doctorStep(
  s: Session,
  config: Config,
  port: number,
  host: string,
): Promise<void> {
  s.heading("doctor");
  // sudo resets PATH to secure_path, which has no ~/.local/bin, and doctor
  // would report every harness setup just installed as missing.
  await s.run(
    [
      "env",
      `PATH=${process.env.PATH ?? ""}`,
      ...SELF,
      "doctor",
      "--user",
      config.user,
      "--state-dir",
      config.stateDir,
      "--port",
      String(port),
      "--host",
      host,
    ],
    true,
  );
}

export async function runSetup(
  config: Config,
  values: RawOptions,
): Promise<number> {
  const opts: Options = {
    yes: values.yes === true,
    firewall: values.firewall === true,
    hermes: values.hermes === true,
    cursor: values.cursor === true,
  };

  if (process.platform !== "linux") {
    console.error("  setup configures a Linux server; run doctor instead");
    return 1;
  }
  if (!opts.yes && !process.stdin.isTTY) {
    console.error(
      "  setup asks before each change, and there is no terminal to ask on: pass --yes",
    );
    return 1;
  }

  const asRoot = process.getuid?.() === 0;
  const s = new Session(opts, asRoot);
  if (asRoot) return fromRoot(s, values);

  // Installers write to ~/.local/bin, and every later lookup in this process
  // should find what they wrote without a new shell.
  const local = path.join(os.homedir(), ".local", "bin");
  if (!(process.env.PATH ?? "").split(":").includes(local))
    process.env.PATH = `${local}:${process.env.PATH ?? ""}`;

  try {
    if (!(await sudoStep(s))) return 1;
    const manager = await detectManager();
    await packagesStep(s, manager);
    await oomStep(s, manager);
    await lingerStep(s, config);
    await sshdStep(s, config);
    await harnessStep(s);
    const tailnet = await tailscaleStep(s);
    const service = await serviceStep(s, config, values);
    const served = await serveStep(s, tailnet, service.port);
    await hardeningStep(s, config);
    await firewallStep(s, config, tailnet, manager);

    await doctorStep(s, config, service.port, service.host);

    const query = service.token ? `/?token=${service.token}` : "/";
    console.log("");
    if (service.installed && served && tailnet.dnsName) {
      console.log(
        `  ${color.bold("Open:")} ${color.cyan(`https://${tailnet.dnsName}${query}`)}`,
      );
    } else if (service.installed) {
      console.log(
        `  ${color.bold("Open:")} ${color.cyan(`http://127.0.0.1:${service.port}${query}`)}`,
      );
      s.note(
        `through a tunnel: ssh -L ${service.port}:127.0.0.1:${service.port} ${config.user}@${os.hostname()}`,
      );
    }
    if (s.next.length > 0) {
      console.log("");
      console.log(`  ${color.bold("Next")}`);
      for (const line of s.next) console.log(`    ${line}`);
    }
    console.log("");
    return 0;
  } catch (err) {
    console.error(`  setup stopped: ${describeError(err)}`);
    return 1;
  }
}

/**
 * `vibe-os confirm-firewall`: proof that a new session got in.
 *
 * No root, and nothing but a file in the state dir, because the only thing it
 * has to establish is that it ran at all. Setup is watching for the file from
 * the other session and does the privileged part itself.
 */
export async function confirmFirewall(config: Config): Promise<number> {
  await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  await writeFile(path.join(config.stateDir, CONFIRM_FILE), `${Date.now()}\n`);
  console.log("  confirmed; setup will keep the firewall on");
  return 0;
}
