// Pre-flight for a real machine.
//
// Everything here exists because it fails *silently* otherwise. A browser
// window that cannot log in says "handshake failed: websocket was closed by
// server" and nothing else — the actual cause is in sshd's log, on a box you
// were hoping to administer through the terminal that just failed to open. So
// these checks read sshd's own effective configuration and answer the only
// question that matters: will a certificate this host signs actually be
// accepted for this user?

import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  archSupported,
  BROWSER_COMMANDS,
  memoryHeadroom,
  parseMemInfo,
  portsFromUnits,
  vncExposure,
  vncPasswordFileFromUnit,
} from "./browser.ts";
import type { Config } from "./config.ts";
import {
  CLAUDE_INSTALL,
  CURSOR_INSTALL,
  discoverCursor,
  discoverHermes,
  HERMES_INSTALL,
  UV_INSTALL,
} from "./harness.ts";
import { findLeaks } from "./reaper.ts";
import { IS_COMPILED } from "./runtime.ts";
import { discoverHostKey, SshCa } from "./ssh-ca.ts";

const run = promisify(execFile);

/**
 * What the host firewall is doing, as far as this machine can tell.
 *
 * Two honest limits, both stated in the check's own output rather than left for
 * the reader to infer:
 *
 * - This is *configuration*, not reachability. Proving a port is unreachable
 *   needs a packet sent from somewhere else, and nothing on this box qualifies.
 * - Your provider's firewall — OVH's Network Firewall, AWS security groups,
 *   Hetzner's — sits in front of the machine and is invisible from inside it. A
 *   clean answer here says nothing about that layer.
 *
 * Both of those are why this reports rather than blocks: a wrong "you are safe"
 * is worse than no answer.
 */
interface FirewallState {
  /** null when no firewall tool could be read at all. */
  tool: "ufw" | "nftables" | "iptables" | null;
  active: boolean;
  /** Incoming denied unless explicitly allowed. */
  defaultDeny: boolean;
  /** An allow rule for the tailscale interface. */
  tailnetAllowed: boolean;
  /** 41641/udp, which keeps Tailscale on a direct path instead of a relay. */
  directUdpAllowed: boolean;
  /** True when we could not read the rules — almost always "not root". */
  unreadable: boolean;
}

export function parseUfw(
  status: string,
): Omit<FirewallState, "tool" | "unreadable"> {
  const text = status.toLowerCase();
  return {
    active: /status:\s*active/.test(text),
    defaultDeny: /default:\s*deny\s*\(incoming\)/.test(text),
    tailnetAllowed: /tailscale\d*\b[^\n]*allow in/.test(text),
    directUdpAllowed: /41641\/udp[^\n]*allow in/.test(text),
  };
}

export function parseNftOrIptables(
  rules: string,
): Omit<FirewallState, "tool" | "unreadable"> {
  const text = rules.toLowerCase();
  return {
    // A ruleset we could read at all, with an input chain, counts as active.
    active: /input/.test(text),
    defaultDeny:
      /-p\s+input\s+drop/.test(text) ||
      /chain\s+input\b[^\n]*policy\s+drop/.test(text) ||
      // nft writes `hook input priority 0; policy drop;` — the policy sits after
      // a semicolon, so this must be allowed to cross one.
      /hook\s+input[\s\S]{0,120}?policy\s+drop/.test(text),
    tailnetAllowed:
      /(iifname\s+"?tailscale\d*"?|-i\s+tailscale\d*)[^\n]*(accept|-j accept)/.test(
        text,
      ),
    directUdpAllowed: /41641[^\n]*(accept|-j accept)/.test(text),
  };
}

async function firewallState(): Promise<FirewallState> {
  const blank = {
    active: false,
    defaultDeny: false,
    tailnetAllowed: false,
    directUdpAllowed: false,
  };

  // ufw first: it is what the README documents, and its status output says
  // plainly whether it is switched on, which a raw ruleset does not.
  const ufw = await run("ufw", ["status", "verbose"], { timeout: 5000 })
    .then((r) => r.stdout)
    .catch(() => null);
  if (ufw) return { tool: "ufw", unreadable: false, ...parseUfw(ufw) };

  for (const [tool, cmd, args] of [
    ["nftables", "nft", ["list", "ruleset"]],
    ["iptables", "iptables", ["-S"]],
  ] as const) {
    const out = await run(cmd, [...args], { timeout: 5000 })
      .then((r) => r.stdout)
      .catch(() => null);
    if (out?.trim())
      return { tool, unreadable: false, ...parseNftOrIptables(out) };
  }

  return { tool: null, unreadable: true, ...blank };
}

const CHROME_UNIT = "/etc/systemd/system/vibe-os-chrome.service";
const XVNC_UNIT = "/etc/systemd/system/vibe-os-xvnc.service";

export interface Check {
  label: string;
  ok: boolean;
  detail: string;
  /** A failure that stops vibe-os working at all, rather than degrading it. */
  fatal?: boolean;
  /** A command or edit that would fix it. */
  fix?: string;
}

const ok = (label: string, detail: string): Check => ({
  label,
  ok: true,
  detail,
});
const bad = (label: string, detail: string, fix?: string): Check => ({
  label,
  ok: false,
  detail,
  fix,
});
const fatal = (label: string, detail: string, fix?: string): Check => ({
  label,
  ok: false,
  detail,
  fix,
  fatal: true,
});

export function probeTcp(
  host: string,
  port: number,
  timeout = 2000,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (result: boolean) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeout);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

/**
 * Why a port is unavailable, which is not one answer but two.
 *
 * "Permission denied" wants a capability; "address in use" usually means
 * vibe-os is already running and the check has nothing to report. Telling
 * someone to run setcap because their own server is up is worse than useless.
 */
function bindStatus(
  port: number,
  host: string,
): Promise<"free" | "in-use" | "denied"> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", (err: NodeJS.ErrnoException) => {
      resolve(err.code === "EADDRINUSE" ? "in-use" : "denied");
    });
    server.once("listening", () => server.close(() => resolve("free")));
    server.listen(port, host);
  });
}

/**
 * Is this command on PATH?
 *
 * One `/bin/sh -c` invocation, with the command passed as `$1` rather than
 * interpolated into the script. The previous version ran the same thing twice —
 * `execFile` with `shell: "/bin/sh"` already builds a `sh -c` string, so the
 * "fall back to asking the shell directly" branch was the identical call and
 * could only fire if /bin/sh were missing, in which case it failed too. It also
 * built its script by interpolation, which no caller exploited but nothing
 * stopped either.
 */
export async function onPath(command: string): Promise<boolean> {
  try {
    await run("/bin/sh", ["-c", 'command -v "$1" > /dev/null', "sh", command]);
    return true;
  } catch {
    return false;
  }
}

/**
 * The always-on browser, when there is one.
 *
 * Returns nothing at all unless the units are installed or Chrome is present,
 * so this stays invisible on the boxes that never asked for it.
 */
async function browserChecks(): Promise<Check[]> {
  const readIfPresent = (p: string) =>
    readFile(p, "utf8").catch(() => null as string | null);
  const [chromeUnit, xvncUnit] = await Promise.all([
    readIfPresent(CHROME_UNIT),
    readIfPresent(XVNC_UNIT),
  ]);
  const chromeInstalled = await onPath("google-chrome");
  if (!chromeUnit && !xvncUnit && !chromeInstalled) return [];

  const checks: Check[] = [];
  const { vncPort, cdpPort } = portsFromUnits({
    xvnc: xvncUnit,
    chrome: chromeUnit,
  });

  if (!archSupported()) {
    checks.push(
      bad(
        "browser",
        `Chrome for Linux is x86_64 only, and this is ${os.arch()}`,
        "there is no fix — the extension needs Chrome itself, not Chromium",
      ),
    );
    return checks;
  }

  const missing = [];
  for (const entry of BROWSER_COMMANDS) {
    if (!(await onPath(entry.command))) missing.push(entry.package);
  }
  if (missing.length > 0) {
    checks.push(
      bad(
        "browser",
        `installed as a service, but missing: ${missing.join(", ")}`,
        "vibe-os install-browser prints the apt line",
      ),
    );
  }

  // Is it actually up? A unit that exists and a browser that answers are
  // different claims, and only the second one means you can use it.
  if (chromeUnit) {
    const answering = await probeTcp("127.0.0.1", cdpPort, 3000);
    checks.push(
      answering
        ? ok("browser", `Chrome answering on 127.0.0.1:${cdpPort}`)
        : bad(
            "browser",
            `installed, but nothing answers the debug port on 127.0.0.1:${cdpPort}`,
            "systemctl status vibe-os-chrome && journalctl -u vibe-os-chrome -n 50",
          ),
    );
  }

  // Where the display is listening is the whole security model for it: served
  // with no password, on the argument that only loopback can reach it.
  const ss = await run("ss", ["-ltnH"], { timeout: 5_000 })
    .then((r) => r.stdout)
    .catch(() => null);

  if (!ss) {
    checks.push(
      bad(
        "display",
        "could not read listening sockets, so nothing here can say where VNC is bound",
        "install iproute2, or check by hand: ss -ltn | grep 5900",
      ),
    );
  } else {
    const exposure = vncExposure(ss, vncPort);
    const auth = vncPasswordFileFromUnit(xvncUnit)
      ? "password set"
      : "no password, so SSH is the only gate";
    if (exposure === "loopback") {
      checks.push(
        ok(
          "display",
          `VNC on ${vncPort}, loopback only, ${auth} — reach it with ssh -L ${vncPort}:127.0.0.1:${vncPort}`,
        ),
      );
    } else if (exposure === "exposed") {
      checks.push(
        fatal(
          "display",
          `VNC on ${vncPort} is bound beyond loopback, and it has no password — ` +
            "anyone who can route here gets the browser and everything signed in to it",
          "add -localhost to the Xtigervnc line in vibe-os-xvnc.service, then: systemctl restart vibe-os-xvnc",
        ),
      );
    } else if (chromeUnit || xvncUnit) {
      checks.push(
        bad(
          "display",
          `nothing listening on ${vncPort} — the virtual display is not running`,
          "systemctl status vibe-os-xvnc",
        ),
      );
    }
  }

  const mem = parseMemInfo(
    await readIfPresent("/proc/meminfo").then((t) => t ?? ""),
  );
  if (mem) {
    const headroom = memoryHeadroom(mem);
    checks.push(
      headroom.ok
        ? ok("browser memory", headroom.detail)
        : bad(
            "browser memory",
            `${headroom.detail} — Chrome idles near 0.5GiB and the OOM killer takes terminals, not tabs`,
            "sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile",
          ),
    );
  }

  return checks;
}

/**
 * Hermes, and whether its browser tools land anywhere useful.
 *
 * Three questions, and the second two only make sense once the first is yes.
 * None of them is fatal: a box that never installs Hermes is a working box, the
 * same way one without Claude is.
 */
async function hermesChecks(): Promise<Check[]> {
  // Cheap when it is missing — this returns as soon as the binary is not found,
  // which is the answer on most boxes.
  const hermes = await discoverHermes();
  if (!hermes.available) {
    return [
      bad(
        "hermes",
        "not on PATH — profiles using the Hermes harness fall back to a shell",
        HERMES_INSTALL,
      ),
    ];
  }

  const checks: Check[] = [
    ok(
      "hermes",
      `${hermes.version ?? "installed"} — the Hermes harness will run`,
    ),
  ];

  // Without the CLI, Browser Use mode silently does not engage. Hermes keeps
  // working with its twelve built-in browser tools, so nothing looks wrong;
  // you just pay for a dozen tool schemas in every request and never find out.
  checks.push(
    hermes.browser.browserUse
      ? ok("browser-use", "runnable — Hermes gets the single browser_exec tool")
      : bad(
          "browser-use",
          "no browser-use or uvx on PATH — Hermes keeps its twelve built-in browser tools",
          UV_INSTALL,
        ),
  );

  // Only worth asking when there is a browser here to be pointed at. On a box
  // with no `install-browser`, an unset cdp_url is the correct configuration.
  if (hermes.browser.cdpPort !== null) {
    checks.push(
      hermes.browser.connected
        ? ok(
            "hermes browser",
            `driving this box's Chrome on 127.0.0.1:${hermes.browser.cdpPort}`,
          )
        : bad(
            "hermes browser",
            hermes.browser.cdpUrl
              ? `browser.cdp_url is ${hermes.browser.cdpUrl}, not this box's Chrome on ${hermes.browser.cdpPort}`
              : "browser.cdp_url is unset — Hermes will not use the browser running here",
            "vibe-os connect-hermes",
          ),
    );
  }

  return checks;
}

/**
 * Cursor, and whether a window opened as it would get past the login prompt.
 *
 * Two questions. Neither is fatal, for the reason the Hermes checks give: a box
 * that never installs Cursor is a working box. The login check exists because
 * its failure is quiet in exactly the way this file cares about — the window
 * opens, the harness runs, and it sits asking for a browser login on a box that
 * may not have one attached.
 */
async function cursorChecks(): Promise<Check[]> {
  const cursor = await discoverCursor();
  if (!cursor.available) {
    return [
      bad(
        "cursor",
        "not on PATH — profiles using the Cursor harness fall back to a shell",
        CURSOR_INSTALL,
      ),
    ];
  }

  const checks: Check[] = [
    ok(
      "cursor",
      `${cursor.version ?? "installed"} — the Cursor harness will run`,
    ),
  ];

  if (cursor.loggedIn === false) {
    checks.push(
      bad(
        "cursor login",
        "not logged in — Cursor windows will sit at a login prompt",
        "cursor-agent login",
      ),
    );
  } else if (cursor.loggedIn === true) {
    checks.push(
      ok(
        "cursor login",
        `logged in${cursor.models.length > 0 ? `, ${cursor.models.length} models offered` : ""}`,
      ),
    );
  }
  // null stays silent: status output this build cannot read is not a finding.

  return checks;
}

/** The home directory sshd will use for a user, which need not be ours. */
export async function homeFor(user: string): Promise<string | null> {
  if (user === os.userInfo().username) return os.homedir();
  try {
    const { stdout } = await run("getent", ["passwd", user], {
      timeout: 5_000,
    });
    const home = stdout.split("\n")[0]?.split(":")[5];
    return home && home.length > 0 ? home : null;
  } catch {
    return null;
  }
}

/**
 * `sshd -T` output as a map.
 *
 * sshd -T lowercases keywords and prints repeated ones on their own lines;
 * joining preserves multi-value keywords like allowusers.
 */
export function parseSshdConfig(stdout: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const space = trimmed.indexOf(" ");
    const key = space === -1 ? trimmed : trimmed.slice(0, space);
    const value = space === -1 ? "" : trimmed.slice(space + 1);
    map.set(key, map.has(key) ? `${map.get(key)} ${value}` : value);
  }
  return map;
}

/**
 * sshd's effective configuration, evaluated for the user who will log in.
 *
 * `sshd -T` is the only honest source: it applies Include directives, drop-in
 * files and Match blocks, which reading sshd_config by hand does not. It needs
 * root, so a non-root run degrades to "unknown" rather than guessing.
 */
async function sshdEffectiveConfig(
  user: string,
): Promise<Map<string, string> | null> {
  const binaries = ["sshd", "/usr/sbin/sshd", "/usr/local/sbin/sshd"];
  for (const bin of binaries) {
    try {
      const { stdout } = await run(
        bin,
        ["-T", "-C", `user=${user},host=localhost,addr=127.0.0.1`],
        { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
      );
      return parseSshdConfig(stdout);
    } catch {
      // not this path, or not root — try the next
    }
  }
  return null;
}

/**
 * Expands sshd's AuthorizedKeysFile tokens into real paths.
 *
 * `%%` is an escaped percent, so it has to stop what follows being read as a
 * token: `%%h` is the literal `%h`, not the home directory. Parking it on a
 * character the input cannot contain, expanding the real tokens, then putting
 * the percent back is what keeps those two apart in a single pass.
 *
 * The sentinel is spelled `\u0000` rather than written as a raw NUL byte. Same
 * value, but a NUL in the source makes the entire file binary to grep, ripgrep
 * and diffs, which silently breaks searching it.
 */
export function authorizedKeysPaths(
  spec: string,
  home: string,
  user: string,
): string[] {
  return spec
    .split(/\s+/)
    .filter(Boolean)
    .map((entry) =>
      entry
        .replaceAll("%%", "\u0000")
        .replaceAll("%h", home)
        .replaceAll("%u", user)
        .replaceAll("\u0000", "%"),
    )
    .map((entry) => (path.isAbsolute(entry) ? entry : path.join(home, entry)));
}

/**
 * StrictModes: sshd ignores authorized_keys outright if the path to it is
 * writable by anyone but its owner. It logs why; nothing else tells you.
 */
async function badPermissions(home: string): Promise<string[]> {
  const problems: string[] = [];
  const targets = [
    home,
    path.join(home, ".ssh"),
    path.join(home, ".ssh", "authorized_keys"),
  ];
  for (const target of targets) {
    try {
      const info = await stat(target);
      if ((info.mode & 0o022) !== 0) {
        problems.push(
          `${target} is ${(info.mode & 0o777).toString(8)} (group/other writable)`,
        );
      }
    } catch {
      // absent is not a permission problem; other checks cover it
    }
  }
  return problems;
}

/** A tailnet address on this host, if Tailscale is up. */
async function tailscaleAddress(): Promise<string | null> {
  for (const iface of Object.values(os.networkInterfaces())) {
    for (const info of iface ?? []) {
      // The CGNAT range Tailscale assigns from: 100.64.0.0/10.
      if (
        info.family === "IPv4" &&
        /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(info.address)
      ) {
        return info.address;
      }
    }
  }
  return null;
}

export async function runDoctor(config: Config): Promise<Check[]> {
  const checks: Check[] = [];
  const user = config.user;

  // ── the toolchain ────────────────────────────────────────────────────────
  const bunMajor = Number((Bun.version ?? "0").split(".")[0]);
  checks.push(
    bunMajor >= 1
      ? ok("bun", `v${Bun.version}`)
      : fatal("bun", "vibe-os runs on Bun 1+"),
  );

  for (const [command, label, why, fix] of [
    [
      "ssh-keygen",
      "ssh-keygen",
      "signs every certificate",
      "apt install openssh-client",
    ],
    [
      "ssh-keyscan",
      "ssh-keyscan",
      "discovers the host key to pin",
      "apt install openssh-client",
    ],
    ["git", "git", "projects and worktrees", "apt install git"],
  ] as const) {
    const found = await onPath(command);
    if (command === "ssh-keygen") {
      checks.push(
        found ? ok(label, why) : fatal(label, `not on PATH — ${why}`, fix),
      );
    } else {
      checks.push(
        found ? ok(label, why) : bad(label, `not on PATH — ${why}`, fix),
      );
    }
  }

  checks.push(
    config.sessions
      ? ok(
          "dtach",
          "found — sessions survive reloads, and profiles can launch a harness",
        )
      : bad(
          "dtach",
          "not installed — windows become plain shells and profiles launch nothing at all",
          "apt install dtach",
        ),
  );

  const claude = await onPath("claude");
  checks.push(
    claude
      ? ok("claude", "on PATH — the Claude harness will run")
      : bad(
          "claude",
          "not on PATH — profiles using the Claude harness fall back to a shell",
          CLAUDE_INSTALL,
        ),
  );

  checks.push(...(await hermesChecks()));
  checks.push(...(await cursorChecks()));

  // ── can a browser actually log in? ───────────────────────────────────────
  const sshdUp = await probeTcp(config.sshHost, config.sshPort);
  checks.push(
    sshdUp
      ? ok("sshd", `reachable at ${config.sshHost}:${config.sshPort}`)
      : fatal(
          "sshd",
          `nothing listening on ${config.sshHost}:${config.sshPort} — no window will connect`,
          "systemctl enable --now ssh",
        ),
  );

  const home = await homeFor(user);
  if (!home) {
    checks.push(
      fatal(
        "login user",
        `no such user: ${user}`,
        "pass --user <name> for an account that exists",
      ),
    );
  } else {
    const mine = os.homedir();
    // Root is checking on someone's behalf (`sudo vibe-os doctor`, or the end
    // of setup), not running the server, so where its own home is says nothing.
    checks.push(
      home === mine || process.getuid?.() === 0
        ? ok("login user", `${user} (${home})`)
        : bad(
            "login user",
            `windows log in as ${user} (${home}), but vibe-os is running as ` +
              `${os.userInfo().username} (${mine}) and writes its CA line there`,
            `run vibe-os as ${user}, or drop the --user flag`,
          ),
    );
  }

  const sshd = await sshdEffectiveConfig(user);
  if (!sshd) {
    checks.push(
      bad(
        "sshd config",
        "could not read sshd's effective config — the checks below are the defaults, not the truth",
        "sudo vibe-os doctor",
      ),
    );
  }

  if (sshd) {
    const pubkey = sshd.get("pubkeyauthentication") ?? "yes";
    checks.push(
      pubkey === "yes"
        ? ok("pubkey auth", "enabled")
        : fatal(
            "pubkey auth",
            "PubkeyAuthentication is off — certificates cannot be used",
            "set PubkeyAuthentication yes",
          ),
    );

    // Allow/Deny lists are the quiet way a hardened VPS refuses the very user
    // vibe-os is about to hand out certificates for.
    const allowUsers = sshd.get("allowusers");
    const denyUsers = sshd.get("denyusers");
    const listed = (spec: string | undefined) =>
      spec?.split(/\s+/).filter(Boolean) ?? [];
    if (denyUsers && listed(denyUsers).some((pattern) => pattern === user)) {
      checks.push(
        fatal(
          "sshd access",
          `DenyUsers excludes ${user}`,
          `remove ${user} from DenyUsers`,
        ),
      );
    } else if (
      allowUsers &&
      !listed(allowUsers).some(
        (pattern) => pattern === user || pattern.includes("*"),
      )
    ) {
      checks.push(
        fatal(
          "sshd access",
          `AllowUsers does not include ${user}`,
          `add ${user} to AllowUsers in sshd_config`,
        ),
      );
    } else {
      checks.push(ok("sshd access", `${user} is permitted to log in`));
    }
  }

  // ── is the CA trusted in the file sshd will actually read? ───────────────
  const ca = new SshCa(config.stateDir);
  let caBlob = "";
  try {
    await stat(ca.pubPath);
    await ca.ensure();
    caBlob = ca.publicKey.split(/\s+/)[1] ?? "";
  } catch {
    // not created yet
  }

  if (!caBlob) {
    checks.push(ok("ssh CA", "not created yet — the first start writes it"));
  } else if (home) {
    const spec =
      sshd?.get("authorizedkeysfile") ??
      ".ssh/authorized_keys .ssh/authorized_keys2";
    const candidates = authorizedKeysPaths(spec, home, user);
    let foundIn: string | null = null;
    for (const file of candidates) {
      const contents = await readFile(file, "utf8").catch(() => "");
      if (contents.includes(caBlob)) {
        foundIn = file;
        break;
      }
    }
    checks.push(
      foundIn
        ? ok("ssh CA", `trusted in ${foundIn}`)
        : fatal(
            "ssh CA",
            `the CA line is not in any file sshd reads for ${user} (${candidates.join(", ")})`,
            `append this to ${candidates[0]}:  cert-authority ${ca.publicKey}`,
          ),
    );

    if (sshd?.get("strictmodes") !== "no") {
      const problems = await badPermissions(home);
      checks.push(
        problems.length === 0
          ? ok("key file perms", "StrictModes satisfied")
          : fatal(
              "key file perms",
              `sshd will ignore authorized_keys: ${problems.join("; ")}`,
              `chmod go-w ${home} ${home}/.ssh ${home}/.ssh/authorized_keys`,
            ),
      );
    }
  }

  const hostKey = await discoverHostKey(config.sshHost, config.sshPort);
  checks.push(
    hostKey
      ? ok(
          "host key",
          `${hostKey.split(" ")[0]} discovered — pinned, no trust prompt`,
        )
      : bad(
          "host key",
          "not discoverable — the browser will prompt once on first connect",
        ),
  );

  // ── serving ──────────────────────────────────────────────────────────────
  // A compiled binary carries the web assets inside it — there is no directory
  // to check, and checking one reports a fatal error on a perfectly good
  // install. This is the recommended way to run on a VPS, so getting it wrong
  // here would fail exactly the people this command exists for.
  if (IS_COMPILED) {
    checks.push(ok("web build", "embedded in this binary"));
  } else {
    const built = await stat(path.join(config.webRoot, "index.html")).then(
      () => true,
      () => false,
    );
    checks.push(
      built
        ? ok("web build", config.webRoot)
        : fatal("web build", `missing at ${config.webRoot}`, "bun run build"),
    );
  }

  const bind = await bindStatus(config.port, config.host);
  if (bind === "free") {
    checks.push(ok(`port ${config.port}`, `bindable on ${config.host}`));
  } else if (bind === "in-use") {
    checks.push(
      ok(`port ${config.port}`, "already in use — vibe-os is probably running"),
    );
  } else {
    checks.push(
      bad(
        `port ${config.port}`,
        `permission denied binding ${config.host}:${config.port}`,
        config.port < 1024
          ? "use a high port with Tailscale in front, or: sudo setcap 'cap_net_bind_service=+ep' $(readlink -f \"$(which bun)\")"
          : "check what else holds this port",
      ),
    );
  }

  // ── firewall ─────────────────────────────────────────────────────────────
  //
  // Reads the host firewall's configuration. Deliberately a warning and never
  // fatal: a box on a trusted LAN or inside the container legitimately has no
  // firewall, and doctor exits non-zero on fatals.
  const fw = await firewallState();
  // Said on every outcome, including the good one, because a ✓ here is the
  // moment someone is most likely to conclude more than it means.
  const scope =
    " (local rules only: your provider's firewall is separate, and proving a port is shut needs a packet from outside)";

  if (fw.unreadable) {
    checks.push(
      bad(
        "firewall",
        "could not read any firewall — needs root, or none is installed",
        "sudo vibe-os doctor    (and see the firewall rules in the README)",
      ),
    );
  } else if (!fw.active) {
    checks.push(
      bad(
        "firewall",
        `${fw.tool} found but not active — this machine answers on its public address`,
        "sudo ufw allow in on tailscale0 && sudo ufw allow 41641/udp && sudo ufw default deny incoming && sudo ufw enable",
      ),
    );
  } else if (!fw.defaultDeny) {
    checks.push(
      bad(
        "firewall",
        `${fw.tool} is active but does not deny incoming by default`,
        "sudo ufw default deny incoming",
      ),
    );
  } else {
    const missing = [
      fw.tailnetAllowed ? null : "no allow rule for the tailscale interface",
      fw.directUdpAllowed
        ? null
        : "41641/udp closed, so Tailscale relays via DERP",
    ].filter(Boolean);
    checks.push(
      missing.length === 0
        ? ok(
            "firewall",
            `${fw.tool}: incoming denied by default, tailnet and 41641/udp allowed${scope}`,
          )
        : bad(
            "firewall",
            `${fw.tool} denies incoming by default, but ${missing.join("; ")}`,
            "sudo ufw allow in on tailscale0 && sudo ufw allow 41641/udp",
          ),
    );
  }

  // ── the always-on browser ────────────────────────────────────────────────
  //
  // Only reported when there is something to report. vibe-os is complete
  // without a browser on the box, and a machine that never asked for one should
  // not be told about four things it does not have.
  checks.push(...(await browserChecks()));

  // ── leaked processes ─────────────────────────────────────────────────────
  //
  // Processes that outlived their workspace or session: a cwd that is a
  // deleted path under `.vibe-worktrees/`, or a tie to a session socket that
  // no longer exists. Teardown is supposed to make these impossible; this is
  // how the times it did not (#38, #39) get found without an afternoon of ps.
  const leaks = await findLeaks(config);
  if (leaks.length === 0) {
    checks.push(
      ok("leaks", "no process has outlived its workspace or session"),
    );
  } else {
    const shown = leaks
      .slice(0, 4)
      .map((l) => `${l.pid} (${l.args.slice(0, 40)})`)
      .join(", ");
    const more = leaks.length > 4 ? `, and ${leaks.length - 4} more` : "";
    checks.push(
      bad(
        "leaks",
        `${leaks.length} process${leaks.length === 1 ? " has" : "es have"} outlived their workspace or session: ${shown}${more}`,
        "vibe-os doctor --reap",
      ),
    );
  }

  // ── exposure ─────────────────────────────────────────────────────────────
  //
  // The one check that is about the box rather than the software. vibe-os hands
  // out shells; who can reach the port is the whole security model.
  const tailnet = await tailscaleAddress();
  const wildcard = config.host === "0.0.0.0" || config.host === "::";

  if (config.token) {
    checks.push(
      ok(
        "exposure",
        `token required${tailnet ? `, and Tailscale is up (${tailnet})` : ""}`,
      ),
    );
  } else if (!wildcard) {
    checks.push(ok("exposure", `no token, but bound only to ${config.host}`));
  } else if (tailnet) {
    checks.push(
      bad(
        "exposure",
        `no token and bound to every interface — Tailscale is up (${tailnet}), but so is any public address`,
        `bind to the tailnet only:  --host ${tailnet}   (and see the firewall rules in the README)`,
      ),
    );
  } else {
    checks.push(
      bad(
        "exposure",
        "no token, bound to every interface, and no tailnet found — anyone who can reach this port gets a shell",
        "start with --token, or put it behind Tailscale and bind to the tailnet address",
      ),
    );
  }

  return checks;
}
