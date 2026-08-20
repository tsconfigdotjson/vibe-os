// An owner for every process vibe-os starts, and a broom for the ones that
// slip loose anyway.
//
// Three leaks in two days on the VPS (#38, #39) shared one cause: every
// teardown path reached exactly one pid by matching its argv, and anything
// below or beside that pid survived — reparented to init, unreachable by name,
// running for a week in a worktree that no longer existed. The rules this
// module exists to hold (#40):
//
//   1. A session survives disconnect. That is the point of dtach.
//   2. A client must not survive its terminal.
//   3. Nothing survives its workspace.
//
// The mechanism for 3 is not, as first proposed, a process group. dtach's
// master creates the pty with forkpty, and forkpty calls setsid in the child —
// so the harness is a *session* leader of its own kernel session, and the
// master's pgid never covers a single grandchild. What does cover them, all of
// them, is the environment: session.ts stamps `VIBE_OS_SOCK=<socket>` onto
// the create command, every descendant inherits it — across
// fork, exec, daemonisation, even a second setsid — and /proc/<pid>/environ
// lets it be read back later. That variable is the owner's name; this module
// is what reads it.
//
// The reaper below is the admission that the rules will still be broken
// sometimes: a server crash mid-teardown, a session created before the marker
// existed. Two cheap signals found every leak in the original batch by hand —
// a cwd that is a deleted path under `.vibe-worktrees/`, and a process tied to
// a session socket that no longer exists — so those are exactly what it looks
// for, on server start and in `vibe-os doctor`.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readlink } from "node:fs/promises";
import { promisify } from "node:util";
import type { Config } from "./config.ts";
import { log } from "./log.ts";

const run = promisify(execFile);

/** The environment variable that names a process's owning session socket. */
export const SOCK_VAR = "VIBE_OS_SOCK";

/**
 * The directory component that marks a workspace worktree.
 *
 * projects.ts owns the real `WORKTREE_DIR` constant. It is repeated here
 * rather than imported because projects.ts imports attach.ts, which imports
 * this file — and if the two ever drift, the reaper misses a class of leak
 * rather than killing anything wrong.
 */
const WORKTREE_MARK = "/.vibe-worktrees/";

/**
 * How old a process must be before a missing socket counts against it.
 *
 * The create path in session.ts is `rm -f <sock>; dtach -n <sock> …`, so a
 * session being born is briefly a dtach whose socket does not exist yet. dtach
 * binds within milliseconds; a minute is three orders of magnitude of slack.
 * The deleted-cwd signal needs no such grace — teardown kills before it
 * removes the worktree, so a live process in a deleted worktree is
 * definitionally a leak.
 */
const MIN_AGE_S = 60;

/** One process, as much of it as this platform lets us see. */
export interface ProcInfo {
  pid: number;
  /** Seconds since it started. */
  age: number;
  /** Full argv as one line, as ps prints it. */
  args: string;
  /** readlink of its cwd, ` (deleted)` suffix intact. Linux only. */
  cwd: string | null;
  /** The `VIBE_OS_SOCK` it inherited, if any. Linux only. */
  sock: string | null;
}

export interface Leak {
  pid: number;
  reason: string;
  args: string;
}

/** Pulls the session marker out of a NUL-delimited /proc environ blob. */
export function markerFromEnviron(environ: string): string | null {
  for (const entry of environ.split("\0")) {
    if (entry.startsWith(`${SOCK_VAR}=`))
      return entry.slice(SOCK_VAR.length + 1) || null;
  }
  return null;
}

/**
 * Seconds from a `ps -o etime` value: `[[dd-]hh:]mm:ss`.
 *
 * `etimes` (plain seconds) would skip the parsing but is procps-only; `etime`
 * is in POSIX ps and prints the same way on Linux and macOS. A bare number is
 * accepted too, so a caller with seconds in hand loses nothing.
 */
export function parseEtime(value: string): number {
  const m = value.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return Number(value.trim()) || 0;
  const [, d, h, min, s] = m;
  return (
    (Number(d ?? 0) * 24 + Number(h ?? 0)) * 3600 + Number(min) * 60 + Number(s)
  );
}

async function pgrep(args: string[]): Promise<number[]> {
  try {
    const { stdout } = await run("pgrep", args, { timeout: 10_000 });
    return stdout
      .split("\n")
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch {
    // pgrep exits non-zero when nothing matches.
    return [];
  }
}

/** Every process on the box, one ps call plus /proc reads where /proc exists. */
export async function scanProcesses(): Promise<ProcInfo[]> {
  const { stdout } = await run("ps", ["-A", "-o", "pid=,etime=,args="], {
    timeout: 10_000,
    maxBuffer: 8 * 1024 * 1024,
  }).catch(() => ({ stdout: "" }));

  const rows: Array<Omit<ProcInfo, "cwd" | "sock">> = [];
  for (const line of stdout.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\S+)\s+(.*)$/);
    if (m) rows.push({ pid: Number(m[1]), age: parseEtime(m[2]), args: m[3] });
  }

  // Both reads fail for processes owned by other users; those are not ours to
  // reap, so "could not see" and "not a leak" are the same answer.
  const linux = process.platform === "linux";
  return Promise.all(
    rows.map(async (row) => ({
      ...row,
      cwd: linux
        ? await readlink(`/proc/${row.pid}/cwd`).catch(() => null)
        : null,
      sock: linux
        ? markerFromEnviron(
            await readFile(`/proc/${row.pid}/environ`, "utf8").catch(() => ""),
          )
        : null,
    })),
  );
}

/**
 * Is this process a leak? Pure, so the answer is testable without a /proc.
 *
 * Three signals, each sufficient on its own:
 *  - its cwd is a deleted path under `.vibe-worktrees/` — the workspace is
 *    gone, so rule 3 says the process should be too;
 *  - the `VIBE_OS_SOCK` it inherited names a socket that no longer exists;
 *  - it is a dtach whose argv names such a socket, which is the same fact for
 *    processes older than the marker.
 */
export function classifyLeak(
  p: ProcInfo,
  opts: { sessionsDir: string; socketExists: (path: string) => boolean },
): Leak | null {
  if (p.cwd?.includes(WORKTREE_MARK) && p.cwd.endsWith(" (deleted)"))
    return { pid: p.pid, args: p.args, reason: "its worktree was deleted" };

  const dir = `${opts.sessionsDir}/`;
  const gone = (sock: string) =>
    sock.startsWith(dir) && p.age > MIN_AGE_S && !opts.socketExists(sock);

  if (p.sock && gone(p.sock))
    return { pid: p.pid, args: p.args, reason: "its session socket is gone" };

  const dtach = p.args.match(/^dtach -[nap] (\S+\.sock)\b/);
  if (dtach && gone(dtach[1]))
    return { pid: p.pid, args: p.args, reason: "its session socket is gone" };

  return null;
}

/**
 * Finds the leaks, says what they were, ends them.
 *
 * The log line carries the argv because by the time anyone reads it the
 * process is gone, and "reaped 444043" answers nothing.
 */
export async function reapLeaks(config: Config): Promise<Leak[]> {
  const leaks = await findLeaks(config);
  for (const leak of leaks)
    log.warn(`reaping ${leak.pid} (${leak.reason}): ${leak.args}`);
  await terminate(leaks.map((leak) => leak.pid));
  return leaks;
}

/** Every leaked process this platform can see, scoped to this state dir. */
export async function findLeaks(config: Config): Promise<Leak[]> {
  const sessionsDir = `${config.stateDir}/sessions`;
  const leaks: Leak[] = [];
  for (const p of await scanProcesses()) {
    if (p.pid <= 1 || p.pid === process.pid) continue;
    const leak = classifyLeak(p, {
      sessionsDir,
      socketExists: (sock) => existsSync(sock),
    });
    if (leak) leaks.push(leak);
  }
  return leaks;
}

/**
 * Every process belonging to a session, to the last grandchild.
 *
 * Three nets, because no single one reaches everything:
 *  - the dtach master itself, by argv — the only thing the old pkill reached;
 *  - everything sharing the pty's kernel session: forkpty makes dtach's child
 *    a session leader, so the harness and every job it started carry that sid
 *    (`ps -o sess` reads it back on Linux and macOS alike), including children
 *    already reparented to init;
 *  - everything that inherited the `VIBE_OS_SOCK` marker, which is the only
 *    net that still holds after a second setsid or after the master has died.
 */
export async function sessionProcesses(sock: string): Promise<number[]> {
  const pids = new Set<number>();

  const masters = await pgrep(["-f", `^dtach -n ${sock}`]);
  for (const pid of masters) pids.add(pid);

  const leaders = new Set<number>();
  for (const master of masters)
    for (const child of await pgrep(["-P", String(master)])) leaders.add(child);

  if (leaders.size > 0) {
    const { stdout } = await run("ps", ["-A", "-o", "pid=,sess="], {
      timeout: 10_000,
      maxBuffer: 8 * 1024 * 1024,
    }).catch(() => ({ stdout: "" }));
    for (const line of stdout.split("\n")) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s*$/);
      if (m && leaders.has(Number(m[2]))) pids.add(Number(m[1]));
    }
  }

  if (process.platform === "linux") {
    for (const p of await scanProcesses()) if (p.sock === sock) pids.add(p.pid);
  }

  pids.delete(process.pid);
  return [...pids];
}

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM is "alive but not ours" — SIGKILL would fail the same way, so
    // there is nothing more to do with it, but it must not count as dead.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * TERM, a short grace, then KILL for whatever ignored it.
 *
 * Returns the pids actually signalled. The grace is polled rather than slept
 * through so the common case — everything honours TERM at once — costs one
 * tick, not the whole allowance.
 */
export async function terminate(
  pids: number[],
  graceMs = 2000,
): Promise<number[]> {
  const targets = [...new Set(pids)].filter(
    (pid) => pid > 1 && pid !== process.pid,
  );
  const signalled: number[] = [];
  for (const pid of targets) {
    try {
      process.kill(pid, "SIGTERM");
      signalled.push(pid);
    } catch {
      // Already gone, or not ours to signal.
    }
  }

  const deadline = Date.now() + graceMs;
  let alive = signalled.filter(isAlive);
  while (alive.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    alive = alive.filter(isAlive);
  }
  for (const pid of alive) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Died between the poll and now.
    }
  }
  return signalled;
}
