import { execFile, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { promisify } from "node:util";
import pkg from "../package.json" with { type: "json" };
import {
  type AttachTarget,
  commandFor,
  listTargets,
  liveSessions,
  resolveTarget,
} from "./attach.ts";
import {
  archSupported,
  BROWSER_COMMANDS,
  browserServices,
  browserUnits,
  CHROME_UNIT_PATH,
  DEFAULT_CDP_PORT,
  defaultBrowserOptions,
  hermesBrowserSettings,
  portsFromUnits,
  type Unit,
  VNC_PASSWORD_LENGTH,
  vncPasswordFileFromUnit,
  vncPasswordPath,
  XVNC_UNIT_PATH,
} from "./browser.ts";
import {
  type Config,
  parseCliArgs,
  type RawOptions,
  resolveConfig,
  savePersisted,
} from "./config.ts";
import { openDb } from "./db.ts";
import { type Check, homeFor, onPath, runDoctor } from "./doctor.ts";
import { HERMES_INSTALL } from "./harness.ts";
import { startServer } from "./index.ts";
import { color, describeError, log } from "./log.ts";
import { ENTRY, FETCH_WASM, IS_COMPILED } from "./runtime.ts";

const run = promisify(execFile);
const BUN = process.execPath;
/** Plenty for the fetcher's few lines of progress output. */
const FETCH_OUTPUT_LIMIT = 1024 * 1024;

const HELP = `
  ${color.bold("vibe-os")} — a terminal multiplexer in the browser

  ${color.bold("Usage")}
    vibe-os [start]              serve the UI and the SSH bridge
    vibe-os attach [window]      attach a real terminal to a window's session
    vibe-os doctor               check this machine is ready
    vibe-os install-service      write and enable a systemd unit (needs root)
    vibe-os install-browser      run one Chrome on a virtual display (needs root)
    vibe-os connect-hermes       point Hermes' browser tools at that Chrome
    vibe-os fetch-wasm           (re)download the SSH WASM runtime

  ${color.bold("Options")}
    --port <n>          HTTP port (default 80)
    --host <addr>       bind address (default 0.0.0.0)
    --domain <fqdn>     provision a Let's Encrypt certificate and serve HTTPS
    --email <addr>      contact address for Let's Encrypt
    --acme-staging      use the Let's Encrypt staging environment
    --tls-port <n>      HTTPS port (default 443)

    --token [value]     require a token; generates and remembers one if omitted
    --no-token          disable the gate (default, prints a warning)

    --ssh-host <addr>   SSH target for the bridge (default 127.0.0.1)
    --ssh-port <n>      SSH target port (default 22)
    --ssh-advertise <host[:port]>
                        host to print in attach commands, when it is not the
                        one the browser reached the desktop on
    --user <name>       unix user to log in as (default: current user)
    --no-sessions       plain login shells instead of persistent dtach sessions
    --cert-ttl <secs>   certificate lifetime (default 43200)

    --workspace <dir>   root for projects and worktrees (default ~/workspace)
    --state-dir <dir>   CA and TLS material (default ~/.vibe-os)
    --web-root <dir>    built web assets

    -h, --help          show this
    -v, --version       print the version

  ${color.bold("install-browser")}
    --geometry <WxH>    virtual screen size (default 1600x900)
    --display <n>       X display number (default 99)
    --vnc-port <n>      VNC port, bound to loopback (default 5900)
    --cdp-port <n>      Chrome debug port, bound to loopback (default 9222)
    --restart-at <expr> nightly restart, a systemd OnCalendar expression
                        (default '*-*-* 02:00:00 America/New_York')
    --no-restart        do not install the nightly restart timer
    --vnc-password [value]
                        require a VNC password; generates and prints one if
                        omitted. macOS Screen Sharing will not connect without
                        this. An existing one is kept unless --no-vnc-password
    --no-vnc-password   serve the display with no authentication

  ${color.bold("connect-hermes")}
    --cdp-port <n>      the debug port to point Hermes at, when there is no
                        installed browser unit to read it from
`;

function version(): string {
  return pkg.version;
}

/**
 * Prints the check list.
 *
 * Failures carry the command that fixes them, indented underneath, because the
 * person reading this is on a fresh box and should not have to go and look it
 * up somewhere else.
 */
function printChecks(checks: Check[]): number {
  console.log("");
  let failed = 0;
  for (const check of checks) {
    const mark = check.ok
      ? color.green("\u2713")
      : check.fatal
        ? color.red("\u2717")
        : color.yellow("!");
    if (!check.ok && check.fatal) failed += 1;
    console.log(
      `  ${mark} ${color.bold(check.label.padEnd(14))} ${color.dim(check.detail)}`,
    );
    if (!check.ok && check.fix)
      console.log(`    ${" ".repeat(14)} ${color.cyan(check.fix)}`);
  }
  console.log("");
  if (failed > 0) {
    console.log(
      `  ${color.red(`${failed} blocking problem${failed === 1 ? "" : "s"}.`)} vibe-os will not work until these are fixed.`,
    );
    console.log("");
  }
  return failed > 0 ? 1 : 0;
}

const UNIT_PATH = "/etc/systemd/system/vibe-os.service";

async function installService(config: Config, argv: string[]): Promise<number> {
  if (process.getuid?.() !== 0) {
    log.error(
      "install-service must run as root (try: sudo vibe-os install-service …)",
    );
    return 1;
  }

  // Forward the flags used here to the unit so the service behaves identically.
  const forwarded = argv.filter((a) => a !== "install-service");

  const user = process.env.SUDO_USER ?? config.user;
  if (!user || user === "unknown" || user === "root") {
    log.error(
      `refusing to install a unit that runs as ${user || "an unknown user"} — ` +
        "windows would get a root shell, and the CA line would land in root's home.",
    );
    log.error(
      "run this with sudo from your own account, or pass --user <name>.",
    );
    return 1;
  }

  // Asked for, not built from a template: a home directory is whatever the
  // passwd entry says, and /home/<user> is only usually right.
  const home = await homeFor(user);
  if (!home) {
    log.error(`could not resolve a home directory for ${user}`);
    return 1;
  }

  /**
   * A compiled binary is its own entry point.
   *
   * `process.execPath` plus the source path is right from a checkout and wrong
   * everywhere else: inside a standalone executable the source lives at a
   * virtual `/$bunfs/` path that exists only while the process is running. The
   * generated unit would pass that path as the subcommand and fail on every
   * boot — on precisely the install the VPS instructions recommend.
   */
  const command = IS_COMPILED ? process.execPath : `${BUN} ${ENTRY}`;

  const unit = `[Unit]
Description=vibe-os — terminal multiplexer in the browser
After=network-online.target sshd.service
Wants=network-online.target

[Service]
Type=simple
User=${user}
Environment=HOME=${home}
# systemd hands a service a minimal PATH, which omits the ~/.local/bin that the
# Claude installer — and most "curl | sh" installers — write to. A login shell
# gets it from .profile, so without this the harness a window launches resolves
# and the server's own lookup of the same binary does not.
Environment=PATH=${home}/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Environment=NODE_ENV=production
WorkingDirectory=${home}
ExecStart=${command} start${forwarded.length ? ` ${forwarded.join(" ")}` : ""}
Restart=on-failure
RestartSec=2
# Lets an unprivileged user bind port 80 without setcap on the node binary.
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=false

[Install]
WantedBy=multi-user.target
`;

  await writeFile(UNIT_PATH, unit, { mode: 0o644 });
  log.ok(`wrote ${UNIT_PATH}`);

  await run("systemctl", ["daemon-reload"]);
  await run("systemctl", ["enable", "--now", "vibe-os"]);
  log.ok("enabled and started vibe-os.service");
  console.log("");
  console.log(`  logs:    ${color.cyan("journalctl -u vibe-os -f")}`);
  console.log(`  restart: ${color.cyan("systemctl restart vibe-os")}`);
  console.log("");
  return 0;
}

/**
 * Installs the always-on browser.
 *
 * Separate from `install-service` on purpose. vibe-os runs perfectly well with
 * no browser on the box, the packages this needs are large, and Chrome for
 * Linux is x86_64 only — so this is opted into rather than arriving with
 * everything else.
 */
async function installBrowser(
  config: Config,
  values: RawOptions,
): Promise<number> {
  if (process.getuid?.() !== 0) {
    log.error(
      "install-browser must run as root (try: sudo vibe-os install-browser …)",
    );
    return 1;
  }

  if (!archSupported()) {
    log.error(
      `Google publishes no Chrome for Linux on ${os.arch()} — only x86_64.`,
    );
    log.error(
      "Chromium is not a substitute here: the Claude extension requires Chrome itself.",
    );
    return 1;
  }

  const user = process.env.SUDO_USER ?? config.user;
  if (!user || user === "unknown" || user === "root") {
    log.error(
      `refusing to run a browser as ${user || "an unknown user"} — Chrome will ` +
        "not start as root without --no-sandbox, and turning the sandbox off on " +
        "a box that holds your credentials is not a trade worth making.",
    );
    log.error("run this with sudo from your own account.");
    return 1;
  }

  const home = await homeFor(user);
  if (!home) {
    log.error(`could not resolve a home directory for ${user}`);
    return 1;
  }

  // Every missing command at once. Finding out about them one install at a time
  // is three round trips to a box you are probably ssh'd into.
  const missing: string[] = [];
  for (const entry of BROWSER_COMMANDS) {
    if (!(await onPath(entry.command)))
      missing.push(`${entry.command} (${entry.package}) — ${entry.why}`);
  }
  if (missing.length > 0) {
    log.error("missing commands:");
    for (const line of missing) console.log(`    ${line}`);
    console.log("");
    console.log(
      `  ${color.cyan("sudo apt install -y tigervnc-standalone-server openbox x11-utils")}`,
    );
    console.log(
      `  ${color.dim("Chrome is not in the distro repos; see the README for the Google apt repo.")}`,
    );
    console.log("");
    return 1;
  }

  const opts = defaultBrowserOptions(user, home);
  if (values.geometry) opts.geometry = String(values.geometry);
  if (values.display) opts.display = numeric(values.display, "display");
  if (values["vnc-port"])
    opts.vncPort = numeric(values["vnc-port"], "vnc-port");
  if (values["cdp-port"])
    opts.cdpPort = numeric(values["cdp-port"], "cdp-port");
  if (values["restart-at"]) opts.restartAt = String(values["restart-at"]);
  if (values["no-restart"]) opts.restartAt = null;

  // VNC authentication, resolved before anything is written.
  //
  // The default is "whatever this box already had". install-browser rewrites
  // every unit, so a reinstall is exactly when a password someone set by hand
  // would disappear without a word.
  const existing = vncPasswordFileFromUnit(
    await readFile(XVNC_UNIT_PATH, "utf8").catch(() => null),
  );
  let generated: string | null = null;

  if (values["no-vnc-password"]) {
    opts.vncPasswordFile = null;
  } else if (values["vnc-password"] !== undefined) {
    const supplied = String(values["vnc-password"]);
    // A bare --vnc-password means "make one up", and the caller has to be told
    // what it was, so remember it for the summary rather than only writing it.
    if (!supplied) generated = randomVncPassword();
    const password = supplied || (generated as string);
    const file = vncPasswordPath(home);
    try {
      await writeVncPassword(file, password, user);
    } catch (err) {
      log.error(`could not write ${file}: ${describeError(err)}`);
      return 1;
    }
    opts.vncPasswordFile = file;
    if (supplied.length > VNC_PASSWORD_LENGTH)
      log.warn(
        `VNC authentication truncates at ${VNC_PASSWORD_LENGTH} characters, so only the first ${VNC_PASSWORD_LENGTH} count`,
      );
  } else if (existing) {
    opts.vncPasswordFile = existing;
    log.info(`keeping the VNC password already set in ${existing}`);
  }

  let units: Unit[];
  try {
    units = browserUnits(opts);
  } catch (err) {
    log.error(describeError(err));
    return 1;
  }

  // systemd is the authority on its own calendar syntax, and a timer that never
  // fires is silent. Ask it before writing the unit rather than after.
  if (opts.restartAt) {
    try {
      await run("systemd-analyze", ["calendar", opts.restartAt]);
    } catch {
      log.error(
        `systemd cannot parse --restart-at ${JSON.stringify(opts.restartAt)}`,
      );
      log.error(
        "try:  --restart-at '*-*-* 02:00:00 America/New_York'   (include the timezone)",
      );
      return 1;
    }
  }

  await mkdir(opts.profileDir, { recursive: true });
  await run("chown", ["-R", `${user}:`, opts.profileDir]).catch(() => {});

  for (const unit of units) {
    await writeFile(`/etc/systemd/system/${unit.name}`, unit.contents, {
      mode: 0o644,
    });
    log.ok(`wrote /etc/systemd/system/${unit.name}`);
  }

  await run("systemctl", ["daemon-reload"]);
  await run("systemctl", ["enable", "--now", ...browserServices(opts)]);
  log.ok("enabled and started the browser");

  console.log("");
  console.log(
    `  view it:  ${color.cyan(`ssh -L ${opts.vncPort}:127.0.0.1:${opts.vncPort} ${user}@<this-host>`)}`,
  );
  console.log(
    `            ${color.dim(`then point any VNC viewer at 127.0.0.1:${opts.vncPort}`)}`,
  );
  console.log(`  logs:     ${color.cyan("journalctl -u vibe-os-chrome -f")}`);
  console.log(`  restart:  ${color.cyan("systemctl restart vibe-os-chrome")}`);
  if (opts.restartAt) console.log(`  nightly:  ${color.dim(opts.restartAt)}`);
  console.log("");
  if (generated) {
    console.log(`  ${color.bold("VNC password:")} ${color.cyan(generated)}`);
    console.log(
      `            ${color.dim("shown once, and stored obfuscated in " + opts.vncPasswordFile)}`,
    );
  } else if (opts.vncPasswordFile) {
    console.log(
      `  ${color.dim(`VNC password from ${opts.vncPasswordFile}, username blank`)}`,
    );
  } else {
    console.log(
      `  ${color.dim("No VNC password. macOS Screen Sharing needs one: rerun with --vnc-password")}`,
    );
  }
  console.log("");
  console.log(
    `  ${color.dim("Sign in to the extension once, through the viewer. The profile keeps it.")}`,
  );

  // Last, and quietly. Hermes usually arrives after the browser, so not finding
  // it is the common case rather than a failure worth interrupting the summary.
  if (await connectHermes(user, home, opts.cdpPort, true)) {
    console.log("");
    console.log(
      `  ${color.dim(`Hermes browser tools point at 127.0.0.1:${opts.cdpPort}.`)}`,
    );
  } else {
    console.log("");
    console.log(
      `  ${color.dim("For Hermes browser tools, install it and run: vibe-os connect-hermes")}`,
    );
  }
  console.log("");
  return 0;
}

/**
 * Points Hermes' browser tools at this box's Chrome.
 *
 * Every setting goes through `hermes config set` rather than into the YAML
 * directly. Hermes owns that file, knows which of its keys are secrets and
 * belong in `.env` instead, and migrates its own schema between versions —
 * three things a hand-written merge here would have to keep guessing at.
 *
 * ── Why this is a box-wide setting and not a profile one ─────────────────────
 * The CDP target lives at `browser.cdp_url` in `~/.hermes/config.yaml` and has
 * no command-line equivalent, so there is nothing a profile could carry. Doing
 * it per launch would mean two Python startups before every window and a global
 * file rewritten by whichever window opened last.
 *
 * Returns false when Hermes is not installed, which is not an error: plenty of
 * boxes run the browser for the Claude extension and nothing else.
 */
async function connectHermes(
  user: string,
  home: string,
  cdpPort: number,
  /** True when this process is root and has to drop to the login user. */
  asUser: boolean,
): Promise<boolean> {
  /*
   * A login shell, deliberately.
   *
   * Hermes installs to `/usr/local/bin` when it can write there and
   * `~/.local/bin` when it cannot, and root's PATH reaches neither reliably
   * under systemd. `runuser -l` runs `.profile`, which is what put the second
   * one on PATH in the first place. runuser is util-linux, the same package
   * `flock` comes from, so it is present wherever the session lock already is.
   */
  const asLoginUser = (script: string): [string, string[]] =>
    asUser
      ? ["runuser", ["-u", user, "--", "/bin/sh", "-lc", script]]
      : ["/bin/sh", ["-lc", script]];

  const [probe, probeArgs] = asLoginUser("command -v hermes");
  const installed = await run(probe, probeArgs, {
    timeout: 10_000,
    env: { ...process.env, HOME: home },
  })
    .then(({ stdout }) => Boolean(stdout.trim()))
    .catch(() => false);
  if (!installed) return false;

  for (const { key, value } of hermesBrowserSettings(cdpPort)) {
    // Quoted as a single argument: a value never contains a space today, and
    // the day one does is not the day to find out this was a bare expansion.
    const [cmd, args] = asLoginUser(
      `hermes config set ${JSON.stringify(key)} ${JSON.stringify(value)}`,
    );
    try {
      await run(cmd, args, {
        timeout: 60_000,
        env: { ...process.env, HOME: home },
      });
      log.ok(`hermes ${key} = ${value}`);
    } catch (err) {
      log.error(`could not set hermes ${key}: ${describeError(err)}`);
      return false;
    }
  }
  return true;
}

/**
 * `vibe-os connect-hermes` — the same thing, for a Hermes installed later.
 *
 * `install-browser` does this as its last step, but it is the browser's
 * installer and Hermes usually arrives after it. No root: it writes one file in
 * your own home directory, through a command you own.
 */
async function connectHermesCommand(
  config: Config,
  values: RawOptions,
): Promise<number> {
  const user = process.env.SUDO_USER ?? config.user;
  const home = (await homeFor(user)) ?? os.homedir();

  // What the unit actually opened, not what the default is. install-browser may
  // have been given --cdp-port long ago, and writing the default into Hermes
  // would point it at a port nothing is listening on.
  const unit = await readFile(CHROME_UNIT_PATH, "utf8").catch(() => null);
  const cdpPort = values["cdp-port"]
    ? numeric(values["cdp-port"], "cdp-port")
    : unit
      ? portsFromUnits({ chrome: unit }).cdpPort
      : DEFAULT_CDP_PORT;

  if (!unit && !values["cdp-port"]) {
    log.warn(
      `no browser installed here, so this assumes the default port ${cdpPort}`,
    );
    log.warn("run sudo vibe-os install-browser first, or pass --cdp-port");
  }

  const connected = await connectHermes(
    user,
    home,
    cdpPort,
    process.getuid?.() === 0,
  );
  if (!connected) {
    log.error(`hermes is not installed for ${user}`);
    console.log("");
    console.log(`  ${color.cyan(HERMES_INSTALL)}`);
    console.log("");
    return 1;
  }

  console.log("");
  console.log(
    `  Hermes browser tools will drive the box's Chrome on 127.0.0.1:${cdpPort}.`,
  );
  console.log(
    `  ${color.dim("Watch it work: ssh -L 5900:127.0.0.1:5900, then any VNC viewer.")}`,
  );
  console.log("");
  return 0;
}

/** A flag that must be a positive integer, rejected loudly when it is not. */
function numeric(value: string | boolean, label: string): number {
  const n = Number(String(value));
  if (!Number.isInteger(n) || n < 0)
    throw new Error(`invalid --${label}: ${String(value)}`);
  return n;
}

/**
 * Eight characters, because VNC authentication silently ignores the rest.
 *
 * Alphanumeric only: this gets typed into a viewer's password box by hand, and
 * a character that needs a modifier on somebody's keyboard layout is a support
 * question rather than security.
 */
function randomVncPassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = randomBytes(VNC_PASSWORD_LENGTH * 2);
  let out = "";
  for (const byte of bytes) {
    if (out.length === VNC_PASSWORD_LENGTH) break;
    // Reject the tail of the byte range rather than modulo it, so every
    // character stays equally likely.
    if (byte >= 256 - (256 % alphabet.length)) continue;
    out += alphabet[byte % alphabet.length];
  }
  return out.padEnd(VNC_PASSWORD_LENGTH, "x");
}

/**
 * Writes TigerVNC's obfuscated password file.
 *
 * The plaintext goes in on stdin rather than as an argument: an argument would
 * be visible in `ps` for as long as the call takes, on the one command whose
 * entire purpose is to keep a secret.
 */
async function writeVncPassword(
  file: string,
  password: string,
  user: string,
): Promise<void> {
  const result = spawnSync("vncpasswd", ["-f"], { input: password });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `vncpasswd exited ${result.status}: ${String(result.stderr).trim()}`,
    );
  const obfuscated = result.stdout;
  if (!obfuscated || obfuscated.length === 0)
    throw new Error("vncpasswd produced an empty password file");

  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, obfuscated, { mode: 0o600 });
  // Written by root, read by the X server running as the login user.
  await run("chown", [`${user}:`, file]).catch(() => {});
}

/**
 * Lets someone pick a window when they did not name one.
 *
 * The reason this exists: on your own laptop you do not have a window id or a
 * ref, you have "the thing I was doing yesterday". `ssh -t box vibe-os attach`
 * with nothing after it is the command worth remembering, and this is what
 * makes it answerable.
 *
 * Returns undefined when the person backs out, which must not be confused with
 * a failure — quitting the picker is a perfectly good outcome.
 */
async function pickTarget(
  config: Config,
  targets: AttachTarget[],
): Promise<AttachTarget | undefined> {
  const live = await liveSessions(config);
  console.log("");
  console.log(
    `  ${color.bold(color.cyan("vibe-os"))} ${color.dim(`· ${targets.length} window${targets.length === 1 ? "" : "s"}`)}`,
  );
  console.log("");
  targets.forEach((t, i) => {
    const n = color.bold(String(i + 1).padStart(3));
    const state = live.has(t.session) ? color.green("live") : color.dim("idle");
    const role = t.role ?? color.dim("terminal");
    console.log(
      `  ${n}  ${state}  ${t.ref.padEnd(28)} ${role.padEnd(22)} ${color.dim(`${t.project}/${t.workspace}`)}`,
    );
  });
  console.log("");

  // Closed before anything is spawned: dtach needs the terminal in raw mode and
  // readline holds it in canonical mode until it lets go.
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(
    `  attach [1-${targets.length}, q to quit]: `,
  );
  rl.close();

  const choice = Number(answer.trim());
  if (!Number.isInteger(choice) || choice < 1 || choice > targets.length)
    return undefined;
  return targets[choice - 1];
}

/**
 * Attaches this terminal to a window's session.
 *
 * The command comes from session.ts, which is the same place the certificate
 * signer gets it — so arriving over ssh puts you in the same session, in the
 * same worktree, running the same harness as the browser would. Composing a
 * dtach invocation here instead would be one line shorter and would drift away
 * from the browser's the first time either changed.
 */
async function attach(
  config: Config,
  ref: string | undefined,
): Promise<number> {
  if (!config.sessions) {
    log.error(
      "attach needs dtach — this server runs plain login shells (--no-sessions)",
    );
    return 1;
  }

  const db = openDb(config.stateDir);
  const targets = listTargets(db);
  if (targets.length === 0) {
    log.error(`no windows in ${config.stateDir}`);
    // Almost always the cause: sshd logged you in as someone else, so the
    // state directory resolved to a different home and vibe-os made an empty
    // database there rather than reading the one with the windows in it.
    log.error(
      `open the desktop and make one, or check you are logged in as the user vibe-os runs as`,
    );
    return 1;
  }

  const target = ref
    ? resolveTarget(db, ref)
    : await pickTarget(config, targets);
  if (ref && !target) {
    log.error(`no window called ${ref}`);
    console.log("");
    for (const t of targets) console.log(`    ${t.ref}`);
    console.log("");
    return 1;
  }
  if (!target) return 0;

  const command = commandFor(db, config, target);
  if (!command) {
    log.error(`could not build a command for ${target.ref}`);
    return 1;
  }

  /*
   * Run through a shell, because that is what the string is written for.
   *
   * It is the same string sshd hands to `$SHELL -c` as a forced command, `\;`
   * separators and two layers of quoting included. Handing it to a shell here
   * is what makes the two paths identical rather than merely similar.
   *
   * spawnSync rather than a detached child: dtach needs this terminal, and the
   * exit code needs to be ours. There is no exec() to replace the process with
   * in a Bun binary, so this one stays resident and idle for the session.
   */
  const child = spawnSync("/bin/sh", ["-c", command], { stdio: "inherit" });
  if (child.error) {
    log.error(`could not start the session: ${child.error.message}`);
    return 1;
  }
  return child.status ?? 0;
}

export async function main(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseCliArgs>;
  try {
    parsed = parseCliArgs(argv);
  } catch (err) {
    log.error(describeError(err));
    console.log(HELP);
    return 1;
  }

  const { values, positionals } = parsed;
  const command = positionals[0] ?? "start";

  if (values.help) {
    console.log(HELP);
    return 0;
  }
  if (values.version) {
    console.log(version());
    return 0;
  }

  // Inside the same guard as arg parsing: `--port abc` and `--bogus` are the
  // same class of mistake, and only one of them used to get a readable answer.
  // `resolveConfig` throws for any unparsable numeric flag, and main.ts has no
  // catch, so the other one printed a raw unhandled-rejection stack trace.
  let config: Awaited<ReturnType<typeof resolveConfig>>;
  try {
    config = await resolveConfig(values);
  } catch (err) {
    log.error(describeError(err));
    console.log(HELP);
    return 1;
  }

  switch (command) {
    case "start": {
      // A generated token is only useful if it survives a restart.
      if (config.token)
        await savePersisted(config.stateDir, { token: config.token });
      await startServer(config);
      return -1; // keep running
    }
    case "attach":
      return attach(config, positionals[1]);
    case "doctor":
      return printChecks(await runDoctor(config));
    case "install-service":
      return installService(config, argv);
    case "install-browser":
      return installBrowser(config, values);
    case "connect-hermes":
      return connectHermesCommand(config, values);
    case "fetch-wasm": {
      // A standalone binary carries the wasm inside it: there is no script on
      // disk to run (FETCH_WASM points into the virtual /$bunfs root) and
      // process.execPath is this binary rather than bun, so running it would
      // re-invoke vibe-os with a path as its subcommand, hit the default arm,
      // and surface as an unhandled rejection.
      if (IS_COMPILED) {
        log.info("this build has the SSH runtime embedded — nothing to fetch");
        return 0;
      }
      const { stdout } = await run(process.execPath, [FETCH_WASM], {
        maxBuffer: FETCH_OUTPUT_LIMIT,
      });
      process.stdout.write(stdout);
      return 0;
    }
    case "help":
      console.log(HELP);
      return 0;
    default:
      log.error(`unknown command: ${command}`);
      console.log(HELP);
      return 1;
  }
}
