// Hibernation: idle Claude windows give their memory back.
//
// A Claude session sitting at its prompt still holds a few hundred MB, more
// with MCP servers and a long history, and on a small box that is the
// difference between three agents and six. Everything Claude knows is already
// on disk in its transcript, so the process can go and the conversation can
// come back later, exactly, with `claude --resume <id>`. The idea and most of
// its safety rules come from bengemine/herdr-hibernate.
//
// vibe-os needs far less machinery for it than a multiplexer does. A window's
// session is created by whatever logs in to it next, so a hibernated window is
// only a window with no session and a marker file naming its conversation
// (session.ts reads the marker at launch). Nothing waits in the window, and a
// reboot changes nothing. Opening the window, or the API sending to it, is
// what wakes it.
//
// So the work here is deciding when, and every rule errs towards leaving the
// window alone:
//
//   - nothing is attached. A window someone can see is never touched, which is
//     what makes this invisible: only other workspaces, minimised windows and
//     closed laptops are candidates;
//   - Claude's own registry (`~/.claude/sessions/<pid>.json`) says `idle`. It
//     says `busy` while Claude works and `shell` while a background job runs,
//     and it is also where the conversation id comes from. argv cannot be
//     trusted for that: `/clear` and `/resume` change the id and not argv;
//   - the screen is quiet, is not a question, and has nothing typed at the
//     prompt, since a draft lives only in the process;
//   - the newest timestamp in the transcript, or in any subagent's, is older
//     than the threshold. Timestamps, not mtime: Claude rewrites bookkeeping
//     lines into the file without any activity;
//   - the process is older than the threshold, so a window just woken is not
//     put straight back to sleep with its still-old transcript;
//   - nothing in the session started well after Claude did, which is a
//     background job Claude may be waiting on. MCP servers start with Claude.
//
// Scheduled wake-ups make no activity before they fire and die with the
// process. They fire within an hour, so a threshold over that is safe for them.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  open,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Activity } from "../shared/wire.ts";
import { clientsOn, listTargets, liveSessions } from "./attach.ts";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import { describeError, log } from "./log.ts";
import { formatBytes, sessionMemory } from "./memory.ts";
import { getProfile } from "./profiles.ts";
import {
  type ProcInfo,
  scanProcesses,
  sessionProcesses,
  terminate,
} from "./reaper.ts";
import type { Screens } from "./screens.ts";
import { resumeMarker, savedScreen, socketPath } from "./session.ts";

/** How often to look for windows to hibernate. */
export const SWEEP_MS = 60_000;
/**
 * A process starting this long after Claude is a job Claude may be waiting on.
 *
 * Short, because a dev server started in a session's first minute is as much
 * a job as one started an hour in. MCP servers start within seconds of Claude,
 * and the ones started later carry "mcp" in their command line.
 */
export const LATE_CHILD_MS = 30_000;
/** How much of the end of a transcript to read for its newest timestamp. */
const TAIL_BYTES = 2 * 1024 * 1024;
/** Lines of screen kept for reading a hibernated window. */
const SAVED_LINES = 2_000;
/** How long to wait for a login holding the window's lock. */
const LOCK_WAIT_S = 10;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Flags that rule a window out: someone may be driving it from elsewhere. */
const REMOTE_FLAGS = new Set(["--remote-control"]);
/** Flags that pin a conversation already, which a resume by id would contradict. */
const PINNED_FLAGS = new Set(["--resume", "-r", "--session-id"]);

/** How long after a login a window is left alone. */
export const LOGIN_GRACE_MS = 60_000;

/**
 * When each session was last logged in to, by this server's clock.
 *
 * A login probes the session under the lock and attaches after letting go of
 * it, so for a moment it is on its way and not yet a client. A sweep landing in
 * that moment would end the session it is about to attach to.
 */
const logins = new Map<string, number>();

/** Records a login to a session: a certificate signed, or a headless start. */
export function noteLogin(session: string, now = Date.now()): void {
  logins.set(session, now);
}

/** What Claude Code says about one of its running processes. */
export interface Registry {
  sessionId: string;
  status: string;
  statusUpdatedAt?: number;
  cwd?: string;
}

export function claudeDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

/** A running Claude's registry entry, or null if it has none we can use. */
export async function readRegistry(pid: number): Promise<Registry | null> {
  try {
    const raw = JSON.parse(
      await readFile(path.join(claudeDir(), "sessions", `${pid}.json`), "utf8"),
    ) as Partial<Registry> & { pid?: number };
    if (raw.pid !== pid) return null;
    if (typeof raw.sessionId !== "string" || !UUID.test(raw.sessionId))
      return null;
    if (typeof raw.status !== "string") return null;
    return {
      sessionId: raw.sessionId,
      status: raw.status,
      statusUpdatedAt:
        typeof raw.statusUpdatedAt === "number"
          ? raw.statusUpdatedAt
          : undefined,
      cwd: typeof raw.cwd === "string" ? raw.cwd : undefined,
    };
  } catch {
    return null;
  }
}

/** The directory Claude files a working directory's transcripts under. */
export function projectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/** The newest `"timestamp":"…"` in a stretch of JSONL, in ms, or null. */
export function newestTimestamp(text: string): number | null {
  let newest: number | null = null;
  for (const m of text.matchAll(/"timestamp":"([0-9T:.+\-Z]{19,35})"/g)) {
    const t = Date.parse(m[1]);
    if (Number.isFinite(t) && (newest === null || t > newest)) newest = t;
  }
  return newest;
}

async function tailTimestamp(file: string): Promise<number | null> {
  const handle = await open(file, "r").catch(() => null);
  if (!handle) return null;
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(length);
    await handle.read(buf, 0, length, size - length);
    return newestTimestamp(buf.toString("utf8"));
  } finally {
    await handle.close();
  }
}

/** Where a conversation's transcript is, or null if it is nowhere. */
export async function findTranscript(
  sessionId: string,
  cwd: string | undefined,
): Promise<string | null> {
  const projects = path.join(claudeDir(), "projects");
  if (cwd) {
    const guess = path.join(
      projects,
      projectDirName(cwd),
      `${sessionId}.jsonl`,
    );
    if (existsSync(guess)) return guess;
  }
  // Long paths are shortened in ways not worth reproducing; the id is unique.
  for (const dir of await readdir(projects).catch(() => [] as string[])) {
    const file = path.join(projects, dir, `${sessionId}.jsonl`);
    if (existsSync(file)) return file;
  }
  return null;
}

/**
 * When a conversation last did anything: its own transcript, and the
 * transcripts of any subagents it started, which are where an orchestrator
 * waiting on its workers shows activity.
 */
export async function lastActivity(transcript: string): Promise<number | null> {
  const files = [transcript];
  const subagents = path.join(transcript.replace(/\.jsonl$/, ""), "subagents");
  for (const name of await readdir(subagents).catch(() => [] as string[]))
    if (name.endsWith(".jsonl")) files.push(path.join(subagents, name));
  let newest: number | null = null;
  for (const file of files) {
    const t = await tailTimestamp(file);
    if (t !== null && (newest === null || t > newest)) newest = t;
  }
  return newest;
}

/** Everything the decision rests on, gathered for one window. */
export interface Evidence {
  clients: number;
  /** When the window was last logged in to, or null if not since startup. */
  loginAt: number | null;
  /** What the screen shows, undefined when it is not being watched. */
  activity: Activity | undefined;
  /** Text at the prompt; null when no prompt line is on screen. */
  draft: string | null;
  /** How many processes in the session are Claude, by the registry. */
  claudes: number;
  registry: Registry | null;
  /** How long the Claude process has been running, in ms. */
  claudeAge: number;
  /** Whether its transcript was found. */
  transcript: boolean;
  /** The newest of every activity signal, in ms since the epoch. */
  lastActivityAt: number | null;
  /** Processes that started well after Claude, by argv. */
  lateChildren: string[];
}

/**
 * Whether to hibernate a window: null to go ahead, or why not.
 *
 * Pure, so every rule is testable without a box.
 */
export function verdict(
  e: Evidence,
  now: number,
  afterMs: number,
): string | null {
  if (e.clients > 0) return "something is attached";
  if (e.loginAt !== null && now - e.loginAt < LOGIN_GRACE_MS)
    return "it was just opened";
  if (e.claudes !== 1) return `${e.claudes} Claude processes, not one`;
  if (!e.registry) return "no registry entry for its Claude";
  if (e.registry.status !== "idle") return `Claude is ${e.registry.status}`;
  if (e.activity === undefined) return "its screen is not being watched";
  if (e.activity !== "idle") return `its screen is ${e.activity}`;
  if (e.draft === null) return "no prompt line on screen";
  if (e.draft !== "") return "something is typed at the prompt";
  if (!e.transcript) return "its transcript is missing";
  if (e.claudeAge < afterMs) return "Claude started too recently";
  if (e.lastActivityAt === null) return "no activity on record";
  if (now - e.lastActivityAt < afterMs) return "active too recently";
  if (e.lateChildren.length > 0)
    return `a background job is running: ${e.lateChildren[0]}`;
  return null;
}

/** The processes of one session that started well after its Claude. */
export function lateChildren(
  procs: ProcInfo[],
  claude: ProcInfo,
  lateMs = LATE_CHILD_MS,
): string[] {
  return (
    procs
      .filter((p) => p.pid !== claude.pid)
      .filter((p) => (claude.age - p.age) * 1000 >= lateMs)
      .filter((p) => !/\bdtach\b/.test(p.args.split(" ")[0] ?? ""))
      .filter((p) => !/mcp/i.test(p.args))
      // Claude's own helpers are Claude, not a job it is waiting on.
      .filter((p) => path.basename(p.args.split(" ")[0] ?? "") !== "claude")
      .map((p) => p.args)
  );
}

/** Whether a window is hibernated: its marker is there and its session is not. */
export function isAsleep(config: Config, session: string): boolean {
  const sock = socketPath(config, session);
  return existsSync(resumeMarker(sock)) && !existsSync(sock);
}

/** What a hibernated window last showed, its last `lines` lines. */
export async function asleepText(
  config: Config,
  session: string,
  lines: number,
): Promise<string> {
  const text = await readFile(
    savedScreen(socketPath(config, session)),
    "utf8",
  ).catch(() => "");
  return text.split("\n").slice(-lines).join("\n");
}

/** What is left of a session after a kill, once the dying have had a moment. */
async function settled(sock: string, waitMs = 3_000): Promise<number[]> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const left = await sessionProcesses(sock);
    if (left.length === 0 || Date.now() > deadline) return left;
    await Bun.sleep(200);
  }
}

async function writeAtomic(file: string, text: string): Promise<void> {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, text, { mode: 0o600 });
  await rename(tmp, file);
}

/**
 * Runs `fn` holding the window's session lock, the one every login takes
 * before it probes and creates (see `windowCommand`). Null if the lock could
 * not be had in time. A box without flock runs `fn` unlocked, as logins there
 * do.
 */
async function withSessionLock<T>(
  sock: string,
  fn: () => Promise<T>,
): Promise<T | null> {
  const child = spawn(
    "flock",
    ["-w", String(LOCK_WAIT_S), `${sock}.lock`, "sh", "-c", "echo; exec cat"],
    { stdio: ["pipe", "pipe", "ignore"] },
  );
  const held = await new Promise<"held" | "failed" | "missing">((resolve) => {
    child.stdout.once("data", () => resolve("held"));
    child.once("exit", () => resolve("failed"));
    child.once("error", (err) =>
      resolve(
        (err as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "failed",
      ),
    );
  });
  if (held === "failed") return null;
  try {
    return await fn();
  } finally {
    if (held === "held") child.stdin.end();
  }
}

export class Hibernator {
  private timer: ReturnType<typeof setInterval> | null = null;
  private sweeping = false;

  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly screens: Screens,
  ) {}

  start(): void {
    const after = this.config.hibernateAfterMs;
    if (!after || !this.config.sessions) return;
    // The registry, the session marker and process ages all come from /proc.
    if (process.platform !== "linux") {
      log.warn("--hibernate-after needs Linux; windows will not hibernate");
      return;
    }
    log.info(
      `hibernating Claude windows idle for ${Math.round(after / 60_000)}m with nothing attached`,
    );
    this.timer = setInterval(() => void this.sweep(), SWEEP_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One pass: every eligible window that qualifies is hibernated. */
  async sweep(): Promise<void> {
    const after = this.config.hibernateAfterMs;
    if (!after || this.sweeping) return;
    this.sweeping = true;
    try {
      const live = await liveSessions(this.config);
      const targets = listTargets(this.db).filter((t) => {
        if (!live.has(t.session) || !t.profileId) return false;
        const profile = getProfile(this.db, t.profileId);
        return (
          profile?.harness === "claude" &&
          !profile.args.some(
            (a) =>
              REMOTE_FLAGS.has(a.split("=")[0]) ||
              PINNED_FLAGS.has(a.split("=")[0]),
          )
        );
      });
      if (targets.length === 0) return;

      const bySock = new Map<string, ProcInfo[]>();
      for (const p of await scanProcesses())
        if (p.sock) bySock.set(p.sock, [...(bySock.get(p.sock) ?? []), p]);

      for (const t of targets) {
        try {
          await this.consider(t.session, bySock, after);
        } catch (err) {
          log.warn(`could not check ${t.session}: ${describeError(err)}`);
        }
      }
    } finally {
      this.sweeping = false;
    }
  }

  private async consider(
    session: string,
    bySock: Map<string, ProcInfo[]>,
    after: number,
  ): Promise<void> {
    const sock = socketPath(this.config, session);
    const procs = bySock.get(sock) ?? [];
    const registries = await Promise.all(
      procs.map(async (p) => ({ p, r: await readRegistry(p.pid) })),
    );
    const claudes = registries.filter((x) => x.r !== null);
    const claude = claudes.length === 1 ? claudes[0] : undefined;
    const screen = this.screens.get(session);
    const transcript = claude?.r
      ? await findTranscript(claude.r.sessionId, claude.r.cwd)
      : null;
    // Not the screen's last output: a status line that redraws on its own
    // would keep an idle window awake forever. The screen is asked only
    // whether it is busy right now.
    const signals = [
      transcript ? await lastActivity(transcript) : null,
      claude?.r?.statusUpdatedAt ?? null,
    ].filter((t): t is number => t !== null);

    const evidence: Evidence = {
      clients: (await clientsOn(this.config, session)).length,
      loginAt: logins.get(session) ?? null,
      activity: screen?.activity(),
      draft: screen ? screen.draft() : null,
      claudes: claudes.length,
      registry: claude?.r ?? null,
      claudeAge: (claude?.p.age ?? 0) * 1000,
      transcript: transcript !== null,
      lastActivityAt: signals.length > 0 ? Math.max(...signals) : null,
      lateChildren: claude ? lateChildren(procs, claude.p) : [],
    };
    const now = Date.now();
    const why = verdict(evidence, now, after);
    if (why) {
      log.debug(`not hibernating ${session}: ${why}`);
      return;
    }
    if (!claude?.r || !screen) return;
    const sessionId = claude.r.sessionId;
    const idle = Math.round((now - (evidence.lastActivityAt ?? now)) / 60_000);
    const text = screen.text(SAVED_LINES);

    const freed = await withSessionLock(sock, async () => {
      // Looked at again under the lock: a login may have arrived, or Claude
      // may have been given something to do, since the evidence was gathered.
      if ((await clientsOn(this.config, session)).length > 0) return null;
      const login = logins.get(session);
      if (login !== undefined && Date.now() - login < LOGIN_GRACE_MS)
        return null;
      const again = await readRegistry(claude.p.pid);
      if (again?.sessionId !== sessionId || again.status !== "idle")
        return null;
      // A send that typed without submitting lands on the screen only.
      const now = this.screens.get(session);
      if (now?.activity() !== "idle" || now.draft() !== "") return null;

      const bytes = (await sessionMemory([sock])).get(sock)?.bytes ?? null;
      await writeAtomic(savedScreen(sock), text);
      await writeAtomic(resumeMarker(sock), sessionId);
      await terminate(await sessionProcesses(sock));
      /*
       * A Claude that outlived the kill is still holding the conversation.
       * Removing the socket would orphan it, and the next login would start a
       * second Claude writing the same transcript, so the window is left as it
       * was. Anything else still there is a straggler: it gets another kill,
       * and the window hibernates.
       */
      const left = await settled(sock);
      if (left.includes(claude.p.pid)) {
        await rm(resumeMarker(sock), { force: true });
        await rm(savedScreen(sock), { force: true });
        log.warn(`could not hibernate ${session}: Claude outlived the kill`);
        return null;
      }
      if (left.length > 0) {
        log.warn(
          `hibernating ${session}: ${left.length} processes outlived the kill (${left.join(", ")}); killing them again`,
        );
        await terminate(left);
      }
      // Not the lock file: it is held right now, and a login waiting on it
      // must find this one when it gets its turn.
      await rm(sock, { force: true });
      return { bytes };
    });
    if (!freed) {
      log.debug(`not hibernating ${session}: it changed under the lock`);
      return;
    }
    log.info(
      `hibernated ${session} after ${idle}m idle` +
        (freed.bytes !== null ? `, freeing ${formatBytes(freed.bytes)}` : "") +
        `; it resumes ${sessionId} when next opened`,
    );
  }
}
