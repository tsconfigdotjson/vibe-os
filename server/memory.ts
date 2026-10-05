// Keeping agent sessions from taking the box down (#50).
//
// An agent session costs 300 to 700 MB and grows with age, and the boxes this
// runs on are small. On a 4 GB VPS a handful of them push the kernel into
// page-cache thrash: near 100% system time, heavy block reads, almost no swap
// traffic. With swap present the kernel never decides to OOM-kill anything, so
// the box stays unusable until a person intervenes.
//
// Three defences, in the order they act:
//
//   1. Each session starts in its own systemd user scope with MemoryHigh and
//      MemoryMax. Past High the kernel reclaims from that scope alone, so one
//      runaway agent slows itself down instead of the box. Past Max it is
//      OOM-killed inside its own scope.
//   2. The desktop shows what each window costs and what the box's memory
//      pressure is, read from here.
//   3. Opening another agent when the box cannot fit one asks first.
//
// Everything here degrades to nothing rather than failing. A container has no
// user systemd and a Mac has no /proc; windows still open in both, without the
// scope and without the numbers.

import { execFile } from "node:child_process";
import { access, readdir, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import type { MemoryReport } from "../shared/wire.ts";
import { markerFromEnviron } from "./reaper.ts";

const run = promisify(execFile);

/**
 * A size systemd accepts for MemoryHigh and MemoryMax.
 *
 * Bytes with an optional K/M/G/T suffix, a percentage of physical memory, or
 * `infinity`. Validated strictly because the value is pasted into the shell
 * command a certificate forces, and because systemd-run rejects a property it
 * cannot parse, which would mean a window that never opens.
 */
const SIZE = /^(\d+(?:\.\d+)?)([KMGT]?)$/;
const PERCENT = /^(\d+)%$/;

/** Normalises a size, or throws with the reason. Empty means "not set". */
export function parseSize(raw: unknown, label: string): string | null {
  if (raw === undefined || raw === null) return null;
  const value = String(raw).trim().toUpperCase().replace(/B$/, "");
  if (value === "") return null;
  if (value === "INFINITY" || value === "NONE") return "infinity";
  const pct = PERCENT.exec(value);
  if (pct) {
    const n = Number(pct[1]);
    if (n <= 0 || n > 100)
      throw new Error(`${label} must be between 1% and 100%`);
    return `${pct[1]}%`;
  }
  const size = SIZE.exec(value);
  if (!size || Number(size[1]) <= 0)
    throw new Error(
      `${label} must look like 1500M, 2G, 40% or infinity, not ${String(raw)}`,
    );
  return `${size[1]}${size[2]}`;
}

const UNITS: Record<string, number> = {
  "": 1,
  K: 1024,
  M: 1024 ** 2,
  G: 1024 ** 3,
  T: 1024 ** 4,
};

/** Bytes for a parsed size, given the box's physical memory. null is no limit. */
export function sizeToBytes(size: string | null, total: number): number | null {
  if (size === null || size === "infinity") return null;
  const pct = PERCENT.exec(size);
  if (pct) return Math.floor((Number(pct[1]) / 100) * total);
  const m = SIZE.exec(size);
  return m ? Math.floor(Number(m[1]) * UNITS[m[2]]) : null;
}

export interface MemoryLimits {
  high: string | null;
  max: string | null;
  /**
   * MemorySwapMax. Without it MemoryMax is no limit at all on a box with swap:
   * a scope at its maximum pushes pages out to swap instead of being killed,
   * which is the thrash all of this exists to prevent. Measured on the
   * reference box: a 100M scope allocated 400M and carried on. Server-wide
   * only; a profile sets the other two.
   */
  swapMax: string | null;
}

/**
 * What a session is actually started with: the profile's own value where it
 * set one, the server's otherwise.
 */
export function effectiveLimits(
  global: MemoryLimits,
  profile?: { memoryHigh: string | null; memoryMax: string | null } | null,
): MemoryLimits {
  return {
    high: profile?.memoryHigh ?? global.high,
    max: profile?.memoryMax ?? global.max,
    swapMax: global.swapMax,
  };
}

/**
 * The prefix that starts a command in its own scope, or "" for no scope.
 *
 * `--scope` runs the command directly rather than handing it to the manager,
 * so it inherits this environment (the session marker included) and dtach's
 * daemonised child stays in the scope after systemd-run's own process exits.
 * `--collect` stops a scope that ended badly from lingering as a failed unit.
 *
 * Returned as argv words already quoted for the shell, because session.ts
 * splices it into a command that is quoted twice more on its way to sshd.
 */
export function scopePrefix(limits: MemoryLimits, session: string): string {
  const props: string[] = [];
  if (limits.high !== null) props.push(`-p MemoryHigh=${limits.high}`);
  if (limits.max !== null) props.push(`-p MemoryMax=${limits.max}`);
  if (limits.swapMax !== null) props.push(`-p MemorySwapMax=${limits.swapMax}`);
  if (props.length === 0) return "";
  // The session name is `vibe-<words>-<n>`, so it needs no quoting of its own,
  // and the description is what `systemctl --user status` shows for the scope.
  return `systemd-run --user --scope --quiet --collect ${props.join(" ")} --description=vibe-os:${session} -- `;
}

/** Where logind records that a user lingers. */
export const LINGER_DIR = "/var/lib/systemd/linger";

/**
 * Shell that is true when a user systemd manager is there to take a scope, and
 * will still be there after this login ends.
 *
 * The second half is the one that matters. sshd gives every login a manager
 * through pam_systemd, but without lingering logind stops that manager when the
 * user's last login closes, and every unit under it goes too. A scope would
 * then end each window the moment the last browser tab did: on the reference
 * box a session died at exactly the second the only ssh login disconnected.
 * Unscoped, the session sits in the login's own scope, which logind leaves
 * running. So no linger, no scope; doctor says so and setup offers the fix.
 *
 * A container usually has no manager at all, and then the session starts the
 * way it always did. Checked per create, not once at startup, because both are
 * properties of the login the force-command runs in, not of the server.
 */
export const SCOPE_PROBE = `[ -e "${LINGER_DIR}/$(id -un)" ] && command -v systemd-run > /dev/null 2>&1 && systemctl --user show-environment > /dev/null 2>&1`;

// ── what the box has ─────────────────────────────────────────────────────────

export type BoxMemory = NonNullable<MemoryReport["box"]>;

/** Reads `MemTotal:  3905536 kB` lines into bytes. */
export function parseMeminfo(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of text.split("\n")) {
    const m = /^(\w+):\s+(\d+)(?:\s+kB)?/.exec(line);
    if (m) out[m[1]] = Number(m[2]) * (line.includes("kB") ? 1024 : 1);
  }
  return out;
}

export function parsePressure(
  text: string,
): { some10: number; full10: number } | null {
  const avg = (kind: string) => {
    const m = new RegExp(`^${kind} avg10=([\\d.]+)`, "m").exec(text);
    return m ? Number(m[1]) : null;
  };
  const some10 = avg("some");
  if (some10 === null) return null;
  return { some10, full10: avg("full") ?? 0 };
}

export async function readBoxMemory(): Promise<BoxMemory | null> {
  const meminfo = await readFile("/proc/meminfo", "utf8").catch(() => null);
  if (meminfo === null) return null;
  const m = parseMeminfo(meminfo);
  const pressure = await readFile("/proc/pressure/memory", "utf8")
    .then(parsePressure)
    .catch(() => null);
  return {
    total: m.MemTotal ?? 0,
    available: m.MemAvailable ?? m.MemFree ?? 0,
    swapTotal: m.SwapTotal ?? 0,
    swapFree: m.SwapFree ?? 0,
    pressure,
  };
}

// ── what each session costs ──────────────────────────────────────────────────

export type SessionMemory = MemoryReport["windows"][string];

/**
 * The cgroup a process is in, from `/proc/<pid>/cgroup` on cgroup v2.
 *
 * Only a scope under the user manager counts as the session's own. A session
 * started before this feature, or without user systemd, sits in the login's
 * `session-N.scope`, which it shares with whatever else that login ran.
 */
export function ownScope(cgroupFile: string): string | null {
  const m = /^0::(\/.*)$/m.exec(cgroupFile);
  if (!m) return null;
  const p = m[1].trim();
  return /\/user@\d+\.service\/.*\.scope$/.test(p) ? p : null;
}

const readNumber = async (file: string): Promise<number | null> => {
  const text = await readFile(file, "utf8").catch(() => null);
  if (text === null) return null;
  const n = Number(text.trim());
  return Number.isFinite(n) ? n : null;
};

const rssBytes = (statusText: string): number => {
  const m = /^VmRSS:\s+(\d+)\s+kB/m.exec(statusText);
  return m ? Number(m[1]) * 1024 : 0;
};

/**
 * Memory per session socket, for the sockets asked about.
 *
 * One pass over /proc. Every process that inherited the session marker is
 * that session's, which reaches grandchildren a process tree would miss (see
 * reaper.ts). A process owned by another user fails every read and is skipped,
 * which is the right answer: it is not ours.
 */
export async function sessionMemory(
  sockets: string[],
): Promise<Map<string, SessionMemory>> {
  const wanted = new Set(sockets);
  const out = new Map<string, SessionMemory>();
  if (wanted.size === 0) return out;
  const pids = await readdir("/proc").catch(() => [] as string[]);

  const rss = new Map<string, number>();
  const scopes = new Map<string, string>();
  await Promise.all(
    pids
      .filter((name) => /^\d+$/.test(name))
      .map(async (pid) => {
        const environ = await readFile(`/proc/${pid}/environ`, "utf8").catch(
          () => "",
        );
        const sock = markerFromEnviron(environ);
        if (!sock || !wanted.has(sock)) return;
        const [status, cgroup] = await Promise.all([
          readFile(`/proc/${pid}/status`, "utf8").catch(() => ""),
          readFile(`/proc/${pid}/cgroup`, "utf8").catch(() => ""),
        ]);
        rss.set(sock, (rss.get(sock) ?? 0) + rssBytes(status));
        const scope = ownScope(cgroup);
        if (scope) scopes.set(sock, scope);
      }),
  );

  for (const sock of wanted) {
    const scope = scopes.get(sock);
    if (scope) {
      const dir = `/sys/fs/cgroup${scope}`;
      const current = await readNumber(`${dir}/memory.current`);
      if (current !== null) {
        out.set(sock, {
          bytes: current,
          // "max" reads as NaN through readNumber, which is "no limit".
          high: await readNumber(`${dir}/memory.high`),
          max: await readNumber(`${dir}/memory.max`),
          scoped: true,
        });
        continue;
      }
    }
    if (rss.has(sock))
      out.set(sock, {
        bytes: rss.get(sock) ?? 0,
        high: null,
        max: null,
        scoped: false,
      });
  }
  return out;
}

// ── will another one fit? ────────────────────────────────────────────────────

/**
 * What one more agent session is budgeted at: the top of the range measured on
 * the reference box, where a cursor-agent reached 683 MB after four hours.
 */
export const AGENT_BUDGET = 700 * 1024 ** 2;

/** Memory left over for the kernel's page cache and everything else. */
const RESERVE_SHARE = 0.1;

/**
 * Why opening another agent now is a bad idea, or null when it is fine.
 *
 * Pure, so it can be tested without a box. The budget is the agent's MemoryHigh
 * when the profile sets an absolute one, since that is what it is allowed to
 * grow to before being throttled, and the measured typical cost otherwise.
 *
 * Available memory only, not pressure. A window held at its MemoryHigh is
 * throttled by sleeping, and the kernel counts that sleep as a memory stall:
 * on the reference box one throttled scope put `/proc/pressure/memory` at 95%
 * while the CPU sat 95% idle with no I/O. High pressure no longer means the box
 * cannot take another session.
 */
export function capacityWarning(
  box: BoxMemory | null,
  high: string | null,
): string | null {
  if (!box || box.total === 0) return null;
  const limit = sizeToBytes(high, box.total);
  const budget = limit !== null ? Math.min(limit, AGENT_BUDGET) : AGENT_BUDGET;
  const reserve = box.total * RESERVE_SHARE;
  if (box.available - budget < reserve) {
    return `Only ${formatBytes(box.available)} of ${formatBytes(box.total)} is free, and an agent session needs about ${formatBytes(budget)}. Opening it may make the box unresponsive.`;
  }
  return null;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

// ── what doctor and setup look at ────────────────────────────────────────────

const unitActive = async (unit: string): Promise<boolean> => {
  try {
    const { stdout } = await run("systemctl", ["is-active", unit], {
      timeout: 5_000,
    });
    return stdout.trim() === "active";
  } catch {
    // is-active exits non-zero for every state but active.
    return false;
  }
};

const exists = (file: string) =>
  access(file).then(
    () => true,
    () => false,
  );

export interface OomState {
  oomd: boolean;
  /** Running, installed but not running, or absent. */
  earlyoom: "active" | "installed" | null;
  swapTotal: number;
}

/**
 * Whether anything will kill a process before the box thrashes.
 *
 * The kernel's own OOM killer acts only when reclaim has completely failed,
 * and with swap present it practically never has: the box spends its time
 * refaulting page cache instead. systemd-oomd and earlyoom act on pressure or
 * free memory, early enough to matter.
 */
export async function oomState(): Promise<OomState> {
  const [oomd, earlyoomActive, earlyoomBinary, meminfo] = await Promise.all([
    unitActive("systemd-oomd"),
    unitActive("earlyoom"),
    exists("/usr/bin/earlyoom"),
    readFile("/proc/meminfo", "utf8").catch(() => ""),
  ]);
  return {
    oomd,
    earlyoom: earlyoomActive ? "active" : earlyoomBinary ? "installed" : null,
    swapTotal: parseMeminfo(meminfo).SwapTotal ?? 0,
  };
}

export interface ScopeState {
  /** systemd is PID 1 and systemd-run exists. */
  systemd: boolean;
  /** The user's manager outlives their logins, which a scope needs. */
  linger: boolean;
  /**
   * The user manager's delegated controllers, or null when they could not be
   * read: no manager running for that user yet, or no cgroup v2.
   */
  controllers: string[] | null;
}

export async function scopeState(
  user: string,
  uid: number | null,
): Promise<ScopeState> {
  const systemd =
    (await exists("/run/systemd/system")) &&
    ((await exists("/usr/bin/systemd-run")) ||
      (await exists("/bin/systemd-run")));
  const linger = await exists(`${LINGER_DIR}/${user}`);
  if (!systemd || uid === null) return { systemd, linger, controllers: null };
  const text = await readFile(
    `/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service/cgroup.controllers`,
    "utf8",
  ).catch(() => null);
  return {
    systemd,
    linger,
    controllers: text === null ? null : text.trim().split(/\s+/),
  };
}
