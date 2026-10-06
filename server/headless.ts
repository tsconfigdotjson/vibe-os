// Starting a window, and typing into one, with no terminal attached.
//
// A window's session is normally created by the certificate's force-command
// the first time a browser or `vibe-os attach` logs in as it. Automation wants
// the window running before anyone looks at it, so `startSession` logs in the
// same way: it mints a throwaway key, has the CA sign it with the window's
// command, and connects to sshd with it. The session then comes from sshd, like
// every other one, with the login environment and the logind session that go
// with it. Spawning the command from this process instead would put it in the
// server's cgroup, where restarting the service ends it.
//
// `sendText` is the prompt band's Send, done from here: the text goes into the
// pty wrapped in bracketed-paste markers, through `dtach -p`, which writes to a
// session without attaching to it.

import { execFile, spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { type AttachTarget, liveSessions } from "./attach.ts";
import type { Config } from "./config.ts";
import { log } from "./log.ts";
import type { Profile } from "./profiles.ts";
import { pgrep } from "./reaper.ts";
import { socketPath, windowCommand } from "./session.ts";
import type { SshCa } from "./ssh-ca.ts";

const run = promisify(execFile);

/** How long the certificate behind a headless login is good for. */
const CERT_TTL_S = 60;
/** How long the ssh login that creates the session may take. */
const LOGIN_TIMEOUT_MS = 30_000;
/** How long after the login the socket has to start answering. */
const SOCKET_WAIT_MS = 5_000;
/** How long `sendText` waits for the program to start reading keys. */
export const INPUT_WAIT_MS = 60_000;
/**
 * How long the pty has to stay in raw mode before the program counts as ready.
 *
 * A harness switches the terminal to raw mode early in its startup, and
 * switches on bracketed paste a moment after. Text that arrives in between is
 * read as typed keys. A second of quiet covers the gap with room to spare.
 */
const SETTLE_MS = 1_000;
const POLL_MS = 250;
/** Between the paste and the Enter that submits it, so they are two events. */
const SUBMIT_DELAY_MS = 300;

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface StartDeps {
  config: Config;
  ca: SshCa;
  /** `type blob`, as discovered at startup. Null skips host key checking. */
  hostKey: string | null;
}

/** Whether a window's session is running. */
export async function isLive(
  config: Config,
  target: AttachTarget,
): Promise<boolean> {
  return (await liveSessions(config)).has(target.session);
}

/**
 * Creates a window's session if it is not running, without attaching to it.
 *
 * Returns false when the session was already there. `resume` is asked only when
 * a session is about to be created, because answering it clears the window's
 * flag: see `takeResume`.
 */
export async function startSession(
  deps: StartDeps,
  target: AttachTarget,
  profile: Profile | undefined,
  resume: () => boolean,
): Promise<boolean> {
  const { config, ca, hostKey } = deps;
  if (await isLive(config, target)) return false;

  const forceCommand = windowCommand(
    target.session,
    target.cwd,
    config,
    profile,
    { resume: resume(), detached: true },
  );
  if (!forceCommand) throw new Error("sessions are off (--no-sessions)");

  const dir = await mkdtemp(path.join(os.tmpdir(), "vibe-os-start-"));
  try {
    await chmod(dir, 0o700);
    const key = path.join(dir, "id");
    await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key], {
      timeout: 15_000,
    });
    const cert = await ca.signUserCert({
      publicKey: await readFile(`${key}.pub`, "utf8"),
      principal: config.user,
      identity: `vibe-os/${target.session}/headless`,
      forceCommand,
      ttlSeconds: CERT_TTL_S,
    });
    await writeFile(`${key}-cert.pub`, cert, { mode: 0o600 });

    const knownHosts = path.join(dir, "known_hosts");
    if (hostKey) {
      await writeFile(
        knownHosts,
        `${knownHostsName(config.sshHost, config.sshPort)} ${hostKey}\n`,
        { mode: 0o600 },
      );
    }

    await ssh(
      sshArgs(config, key, hostKey ? knownHosts : null),
      LOGIN_TIMEOUT_MS,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  // The login returns once dtach has forked, which can be a moment before the
  // socket is listening.
  const deadline = Date.now() + SOCKET_WAIT_MS;
  while (!(await isLive(config, target))) {
    if (Date.now() > deadline)
      throw new Error(
        `${target.session} did not start; check the server log and vibe-os doctor`,
      );
    await sleep(POLL_MS);
  }
  log.info(`started ${target.session} with no terminal attached`);
  return true;
}

/** How a host appears in known_hosts: bare on port 22, bracketed otherwise. */
export function knownHostsName(host: string, port: number): string {
  return port === 22 ? host : `[${host}]:${port}`;
}

/**
 * The ssh invocation for a headless login.
 *
 * No command: the certificate forces one. `-T` because there is no terminal to
 * give it, and `BatchMode` so nothing can stop to ask a question.
 */
export function sshArgs(
  config: Config,
  key: string,
  knownHosts: string | null,
): string[] {
  const hostChecking = knownHosts
    ? [
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        `UserKnownHostsFile=${knownHosts}`,
      ]
    : ["-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null"];
  return [
    "-T",
    "-i",
    key,
    "-o",
    `CertificateFile=${key}-cert.pub`,
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "LogLevel=ERROR",
    "-o",
    "GlobalKnownHostsFile=/dev/null",
    ...hostChecking,
    "-p",
    String(config.sshPort),
    `${config.user}@${config.sshHost}`,
  ];
}

function ssh(args: string[], timeout: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", args, {
      stdio: ["ignore", "ignore", "pipe"],
      timeout,
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) =>
      reject(new Error(`could not run ssh: ${err.message}`)),
    );
    child.on("exit", (code, signal) => {
      if (code === 0) return resolve();
      const reason =
        stderr.trim().split("\n").pop() || `exit ${code ?? signal}`;
      reject(new Error(`headless login failed: ${reason}`));
    });
  });
}

// ── typing into a session ────────────────────────────────────────────────────

/**
 * The bytes a paste of `text` puts on the wire.
 *
 * What xterm.js does for the browser's Send: line endings become carriage
 * returns, the way a terminal sends Enter, and the text is wrapped in
 * bracketed-paste markers so a multi-line prompt arrives as one block rather
 * than submitting at its first newline. An end marker inside the text would
 * close the paste early and type the rest, so the markers are stripped from it.
 */
export function pasteBytes(text: string): string {
  const body = text
    .replaceAll(PASTE_START, "")
    .replaceAll(PASTE_END, "")
    .replace(/\r?\n/g, "\r");
  return `${PASTE_START}${body}${PASTE_END}`;
}

/** Writes bytes into a session's pty, as if typed, without attaching. */
async function push(sock: string, bytes: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("dtach", ["-p", sock], {
      stdio: ["pipe", "ignore", "pipe"],
      timeout: 10_000,
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(stderr.trim() || `dtach -p exited ${code}`)),
    );
    child.stdin.end(bytes);
  });
}

/**
 * The terminal device the session's program runs on, like `/dev/pts/3`.
 *
 * The dtach master holds the pty and its one child is the program, which is
 * where `ps` reports the device.
 */
async function sessionTty(sock: string): Promise<string | null> {
  for (const master of await pgrep(["-f", `^([^ ]*/)?dtach -n ${sock}`])) {
    for (const child of await pgrep(["-P", String(master)])) {
      const { stdout } = await run("ps", ["-o", "tty=", "-p", String(child)], {
        timeout: 10_000,
      }).catch(() => ({ stdout: "" }));
      const tty = stdout.trim();
      if (tty && tty !== "?" && tty !== "??") return `/dev/${tty}`;
    }
  }
  return null;
}

/**
 * Whether a terminal is in raw mode, which is how a program says it is reading
 * keys itself. Null when it cannot be read.
 */
export async function isRaw(tty: string): Promise<boolean | null> {
  const flag = process.platform === "darwin" ? "-f" : "-F";
  try {
    const { stdout } = await run("stty", [flag, tty, "-a"], {
      timeout: 5_000,
    });
    return parseRaw(stdout);
  } catch {
    return null;
  }
}

/** Reads `stty -a` output: `-icanon` means raw, `icanon` means cooked. */
export function parseRaw(sttyOutput: string): boolean | null {
  const words = sttyOutput.split(/[\s;]+/);
  if (words.includes("-icanon")) return true;
  if (words.includes("icanon")) return false;
  return null;
}

/**
 * Waits until the session's program is reading keys.
 *
 * A session started a moment ago is still a shell running `cd` and `stty`, and
 * then a harness loading. The pty is in canonical mode until the program takes
 * it, and the program's own setup may flush what is waiting, so text sent
 * before then is lost or garbled. Raw mode held for `SETTLE_MS` is the signal.
 */
export async function waitForInput(
  config: Config,
  session: string,
  timeoutMs = INPUT_WAIT_MS,
): Promise<void> {
  const sock = socketPath(config, session);
  const deadline = Date.now() + timeoutMs;
  let rawSince: number | null = null;
  for (;;) {
    const tty = await sessionTty(sock);
    const raw = tty ? await isRaw(tty) : null;
    const now = Date.now();
    if (raw) {
      rawSince ??= now;
      if (now - rawSince >= SETTLE_MS) return;
    } else {
      rawSince = null;
    }
    if (now > deadline)
      throw new Error(
        tty
          ? `${session} is not reading input after ${Math.round(timeoutMs / 1000)}s`
          : `${session} is not running`,
      );
    await sleep(POLL_MS);
  }
}

/** Pastes text into a running session, then presses Enter if asked to. */
export async function sendText(
  config: Config,
  session: string,
  text: string,
  opts: { submit?: boolean; timeoutMs?: number } = {},
): Promise<void> {
  const sock = socketPath(config, session);
  await waitForInput(config, session, opts.timeoutMs);
  await push(sock, pasteBytes(text));
  if (opts.submit) {
    await sleep(SUBMIT_DELAY_MS);
    await push(sock, "\r");
  }
  log.info(
    `sent ${text.length} characters to ${session}${opts.submit ? " and submitted" : ""}`,
  );
}
