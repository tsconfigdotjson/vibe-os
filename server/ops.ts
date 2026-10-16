// What a caller can do to windows and workspaces, apart from how it asked.
//
// The HTTP API and the MCP server both drive windows, and they have to behave
// the same: a prompt that waits for a question to be answered over HTTP must
// not be pasted into it over MCP. So the work lives here, as functions that
// return a value or throw an `OpError`, and each front end only translates.
// The MCP server calls these directly; it never goes back through HTTP.

import { fillBlanks } from "../shared/blanks.ts";
import type {
  Activity,
  SendInput,
  SendResult,
  TranscriptMessage,
  WaitResult,
  WindowEvent,
  WindowSummary,
  WorkspaceSummary,
} from "../shared/wire.ts";
import {
  type AttachTarget,
  killSession,
  listTargets,
  liveSessions,
  resolveTarget,
} from "./attach.ts";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import { harness } from "./harness.ts";
import {
  foregroundCommand,
  KEY_NAMES,
  keyBytes,
  paste,
  press,
  submit as pressEnter,
  startSession,
  waitForInput,
} from "./headless.ts";
import { asleepText, isAsleep } from "./hibernate.ts";
import { describeError, log } from "./log.ts";
import { discoverMcpWithDefs, type McpScan, syncMcpMirrors } from "./mcp.ts";
import { capacityWarning, effectiveLimits, readBoxMemory } from "./memory.ts";
import { getProfile, type Profile } from "./profiles.ts";
import {
  createWorkspace,
  getWorkspace,
  listProjects,
  listWorkspaces,
  removeWorkspace,
} from "./projects.ts";
import type { ScreenEvent, Screens } from "./screens.ts";
import { socketPath } from "./session.ts";
import type { SshCa } from "./ssh-ca.ts";
import {
  createWindow,
  deleteWindow,
  getWindow,
  listWindows,
  sessionNameFor,
  takeResume,
  updateWindow,
} from "./windows.ts";

/** A refusal with the HTTP status it maps to, and anything else to report. */
export class OpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** Ceiling on text sent to a window, matching a profile prompt's. */
const MAX_SEND_CHARS = 16_000;

/** Most keys one send can press. */
const MAX_KEYS = 32;

/** Longest label a window can be tagged with. */
const MAX_LABEL_CHARS = 200;
/**
 * How long a send waits for a window to stop drawing before it pastes anyway.
 *
 * A harness that has just started draws its startup and goes quiet in a few
 * seconds. One that is working never goes quiet, and a paste into a working
 * agent is queued rather than lost, so after this it goes in regardless.
 */
const SETTLE_WAIT_MS = 20_000;
/** How long after a paste the window has to draw something. */
const ECHO_WAIT_MS = 3_000;
/** Lines of output when the caller does not say, and the most it can ask for. */
export const DEFAULT_OUTPUT_LINES = 50;
export const MAX_OUTPUT_LINES = 2_000;
/** How long a first read waits for a window to redraw itself. */
const FIRST_PAINT_WAIT_MS = 1_000;
/**
 * The longest a wait may block, in seconds.
 *
 * Under Bun's idle timeout for a request (255s in index.ts), and under the five
 * minutes an MCP client gives a call that sends nothing.
 */
export const MAX_WAIT_S = 240;
/** How often a wait on background commands asks whether they are done. */
const BACKGROUND_POLL_MS = 3_000;

export const NO_SESSIONS =
  "this server runs plain login shells (--no-sessions)";

/** What a wait waits for. See `WaitOptions`. */
export const UNTIL = ["settled", "idle", "question", "change"] as const;
export type Until = (typeof UNTIL)[number];

export interface WaitOptions {
  /**
   * `settled` is anything but busy, `idle` and `question` are that state, and
   * `change` is any state other than the one at the start.
   */
  until: Until;
  timeoutMs: number;
  /** With `settled`, also wait for the turn after the last send to be done. */
  turn: boolean;
  /**
   * With `settled`, also wait for background commands the agent started to
   * finish. A server left running in the background never does.
   */
  background?: boolean;
  /** Lines of output to include, or 0 for none. */
  lines: number;
  signal?: AbortSignal;
  /** Every state or turn change in the windows waited on, as it happens. */
  onEvent?: (e: WindowEvent) => void;
}

/** `GET /api/windows/:window/output`, as returned. */
export interface OutputResult {
  text: string;
  state: Activity | "asleep";
  lastOutputAt: number | null;
  cursor: number;
  /** With `after`: the screen as it is now, apart from the new history. */
  screen?: string;
  truncated?: boolean;
}

/** `POST /api/workspaces/:workspace/windows`, in the API's own terms. */
export interface OpenInput {
  profileId?: unknown;
  force?: unknown;
  label?: unknown;
  start?: unknown;
  prompt?: unknown;
  blanks?: unknown;
  submit?: unknown;
  reuse?: unknown;
}

/**
 * What to paste for a send: the text given, or the profile prompt with its
 * blanks filled. Throws with a message for the caller when neither works.
 */
function textToSend(
  body: SendInput,
  profile: { prompt: string } | undefined,
): string {
  if (body.text !== undefined) {
    if (typeof body.text !== "string" || body.text === "")
      throw new OpError(
        'text must be a non-empty string. To press Enter alone, send keys: ["Enter"]',
        400,
      );
    if (body.blanks !== undefined)
      throw new OpError(
        "blanks fill the profile prompt; leave out text to use it",
        400,
      );
    if (body.text.length > MAX_SEND_CHARS)
      throw new OpError(`text must be under ${MAX_SEND_CHARS} characters`, 400);
    return body.text;
  }
  if (!profile || profile.prompt.trim() === "")
    throw new OpError(
      "this window has no profile prompt; send text instead",
      400,
    );

  const blanks = body.blanks ?? {};
  if (
    typeof blanks !== "object" ||
    blanks === null ||
    Array.isArray(blanks) ||
    Object.values(blanks).some((v) => typeof v !== "string")
  )
    throw new OpError("blanks must be an object of strings", 400);
  const filled = fillBlanks(profile.prompt, blanks);
  if (filled.unknown.length > 0)
    throw new OpError(
      `the prompt has no blank called ${filled.unknown.join(", ")}`,
      400,
    );
  if (filled.missing.length > 0)
    throw new OpError(`fill every blank: ${filled.missing.join(", ")}`, 400);
  return filled.text;
}

/**
 * The keys a send presses instead of pasting. Throws with a message for the
 * caller when they are not keys, or come with something a key send ignores.
 */
function keysToPress(body: SendInput): string[] {
  const { keys } = body;
  if (
    !Array.isArray(keys) ||
    keys.length === 0 ||
    keys.length > MAX_KEYS ||
    keys.some((k) => typeof k !== "string")
  )
    throw new OpError(`keys must be a list of 1 to ${MAX_KEYS} key names`, 400);
  const unknown = keys.find((k) => keyBytes(k) === null);
  if (unknown !== undefined)
    throw new OpError(
      `unknown key ${JSON.stringify(unknown)}. A key is one character or one of ${KEY_NAMES.join(", ")}`,
      400,
    );
  if (body.text !== undefined || body.blanks !== undefined)
    throw new OpError("send text or keys, not both", 400);
  if (body.submit !== undefined)
    throw new OpError('submit is for text; put "Enter" in keys instead', 400);
  return keys;
}

/**
 * Where to look for MCP servers, for one project or for all of them.
 *
 * A worktree is a copy of the repo, so its `.mcp.json` is the project's and is
 * read once from the root. Local-scope servers are the opposite — they are
 * keyed by the exact directory `claude mcp add` ran in, so every worktree is
 * its own place to look.
 */
export function mcpScan(db: Db, projectId?: string): McpScan {
  const roots: string[] = [];
  const dirs: string[] = [];
  for (const project of listProjects(db)) {
    if (projectId !== undefined && project.id !== projectId) continue;
    roots.push(project.path);
    dirs.push(
      project.path,
      ...listWorkspaces(db, project.id).map((w) => w.path),
    );
  }
  return { roots, dirs };
}

/**
 * Re-scans every project and rewrites the mirror files.
 *
 * Always over every project, never just the one being asked about: the sync
 * deletes files that no longer have a server behind them, and a partial view
 * would read another project's servers as gone.
 */
export async function refreshMcpMirrors(
  db: Db,
  stateDir: string,
): Promise<void> {
  await syncMcpMirrors(
    stateDir,
    await discoverMcpWithDefs(stateDir, mcpScan(db)),
  );
}

export interface OpsDeps {
  config: Config;
  ca: SshCa;
  hostKey: string | null;
  db: Db;
  screens: Screens;
}

export type Ops = ReturnType<typeof createOps>;

export function createOps(deps: OpsDeps) {
  const { ca, config, db, hostKey, screens } = deps;
  const listeners = new Set<(e: WindowEvent) => void>();

  const summarise = (t: AttachTarget, live: Set<string>): WindowSummary => {
    const running = live.has(t.session);
    const screen = running ? screens.get(t.session) : undefined;
    const turn = screens.turnOf(t.session);
    return {
      id: t.windowId,
      ref: t.ref,
      session: t.session,
      workspace: t.workspace,
      project: t.project,
      role: t.role,
      label: t.label,
      live: running,
      state: running
        ? (screen?.activity() ?? "idle")
        : isAsleep(config, t.session)
          ? "asleep"
          : null,
      lastOutputAt: screen?.lastOutputAt ?? null,
      lastSendAt: turn?.lastSendAt ?? null,
      turn: turn?.turn ?? null,
    };
  };

  /** A window's summary, as running if its screen is open. */
  const summary = (t: AttachTarget): WindowSummary =>
    summarise(
      t,
      screens.get(t.session) ? new Set([t.session]) : new Set<string>(),
    );

  const requireSessions = () => {
    if (!config.sessions) throw new OpError(NO_SESSIONS, 409);
  };

  // ── events ──────────────────────────────────────────────────────────────

  /** Who a session belongs to, remembered so a closed window can be named. */
  const known = new Map<string, AttachTarget | null>();
  const whose = (session: string): AttachTarget | undefined => {
    const hit = known.get(session);
    if (hit !== undefined) return hit ?? undefined;
    for (const t of listTargets(db)) known.set(t.session, t);
    // A session with no window behind it: not looked up on every event.
    if (!known.has(session)) known.set(session, null);
    return known.get(session) ?? undefined;
  };

  const toWire = (
    type: WindowEvent["type"],
    session: string,
    at: number,
    extra: Partial<WindowEvent> = {},
  ): WindowEvent => {
    const t = whose(session);
    return {
      type,
      ref: t?.ref ?? session.replace(/^vibe-/, ""),
      label: t?.label ?? null,
      workspace: t?.workspace ?? null,
      project: t?.project ?? null,
      at,
      ...extra,
    };
  };

  const fromScreen = (e: ScreenEvent): WindowEvent => {
    switch (e.type) {
      case "state":
        return toWire("window.state", e.session, e.at, {
          from: e.from,
          to: e.to,
        });
      case "turn":
        return toWire("window.turn", e.session, e.at, { turn: e.turn });
      case "asleep":
        return toWire("window.asleep", e.session, e.at);
      case "woke":
        return toWire("window.woke", e.session, e.at);
    }
  };

  const emit = (e: WindowEvent) => {
    for (const fn of [...listeners]) {
      try {
        fn(e);
      } catch (err) {
        log.warn(`an event listener failed: ${describeError(err)}`);
      }
    }
  };

  /** Every window event, until the returned function is called. */
  function subscribe(fn: (e: WindowEvent) => void): () => void {
    listeners.add(fn);
    const off = screens.subscribe((e) => fn(fromScreen(e)));
    return () => {
      listeners.delete(fn);
      off();
    };
  }

  // A shell's turn is the command it was given: it lasts until the shell has
  // the terminal back, however quiet the command is meanwhile.
  screens.setTurnHold(async (session) => {
    const t = whose(session);
    if (!t) return false;
    const profile = t.profileId ? getProfile(db, t.profileId) : undefined;
    if (t.profileId && profile?.harness !== "shell") return false;
    return (await foregroundCommand(socketPath(config, session))) === true;
  });

  const opened = (t: AttachTarget) => {
    known.set(t.session, t);
    emit(toWire("window.opened", t.session, Date.now()));
  };

  const closed = (t: AttachTarget) => {
    known.set(t.session, t);
    emit(toWire("window.closed", t.session, Date.now()));
    known.delete(t.session);
    // The next window in this workspace may get the same index, and so the
    // same session name: it starts with no turn of its own.
    screens.forget(t.session);
  };

  // ── starting and typing ─────────────────────────────────────────────────

  /** Starts a window's session if it is not running, and watches its screen. */
  async function start(
    target: AttachTarget,
    profile: Profile | undefined,
  ): Promise<boolean> {
    if (profile?.harness === "claude")
      await refreshMcpMirrors(db, config.stateDir).catch((err: unknown) => {
        log.warn(`could not refresh mcp configs: ${describeError(err)}`);
      });
    const started = await startSession(
      { config, ca, hostKey },
      target,
      profile,
      () => takeResume(db, target.windowId),
    );
    await screens.watch(target.session, { fresh: started });
    return started;
  }

  /**
   * Starts a window if need be, waits until it is ready for text, and pastes.
   *
   * Ready is three things in turn: the program has the terminal in raw mode,
   * it has stopped drawing (a harness draws its startup, then goes quiet at its
   * prompt), and what it stopped on is not a question. A paste into a question,
   * such as Claude asking whether to trust a new folder, is lost, and the Enter
   * after it answers the question. So that is reported rather than done, unless
   * the caller says `force`. After the paste, the window has to draw something,
   * which is the paste arriving; Enter is pressed only once it has.
   */
  async function deliver(
    target: AttachTarget,
    profile: Profile | undefined,
    text: string,
    opts: { submit: boolean; force: boolean },
  ): Promise<SendResult> {
    const { session } = target;
    const started = await start(target, profile);
    await waitForInput(config, session);
    const watched = (await screens.watch(session)) !== undefined;
    const state = watched
      ? await screens.settle(session, SETTLE_WAIT_MS)
      : "idle";
    if (state === "question" && !opts.force)
      return {
        started,
        delivered: false,
        state,
        reason:
          "the window is waiting on a question, so nothing was pasted. Read it with GET /api/windows/:window/output, or send with force to paste anyway",
      };

    const before = Date.now();
    await paste(config, session, text);
    if (watched && !(await screens.drewSince(session, before, ECHO_WAIT_MS)))
      return {
        started,
        delivered: false,
        state: screens.get(session)?.activity() ?? state,
        reason: "the window did not show the paste, so Enter was not pressed",
      };
    if (opts.submit) {
      // The turn starts with Enter, not the paste: the echo is not an answer.
      const at = Date.now();
      await pressEnter(config, session);
      screens.noteSend(session, at);
    }
    // The window has its instructions, so the band has nothing to offer.
    updateWindow(db, target.windowId, { promptDone: true });
    log.info(
      `delivered ${text.length} characters to ${session}${opts.submit ? " and submitted" : ""}`,
    );
    return { started, delivered: true, state };
  }

  /**
   * Starts a window if need be, and presses keys in it once it reads them.
   *
   * No wait for quiet and no refusal on a question, unlike `deliver`: keys are
   * how a question is answered, and an Escape is how a busy agent is stopped.
   */
  async function pressKeys(
    target: AttachTarget,
    profile: Profile | undefined,
    keys: string[],
  ): Promise<SendResult> {
    const { session } = target;
    const started = await start(target, profile);
    await waitForInput(config, session);
    const state = screens.get(session)?.activity() ?? "idle";
    const at = Date.now();
    await press(config, session, keys);
    screens.noteSend(session, at);
    return { started, delivered: true, state };
  }

  // ── reads ───────────────────────────────────────────────────────────────

  /** A window by id or ref. */
  function target(refOrId: string): AttachTarget {
    const found = resolveTarget(db, refOrId);
    if (!found)
      throw new OpError(
        `no window called ${refOrId}. List them with GET /api/windows`,
        404,
      );
    return found;
  }

  /** Every window on the box, or those with one label. */
  async function windows(label?: string | null): Promise<WindowSummary[]> {
    const live = config.sessions
      ? await liveSessions(config)
      : new Set<string>();
    // A session started by a login rather than by this server is picked up
    // within a few seconds anyway; this saves a caller the wait.
    await Promise.all([...live].map((s) => screens.watch(s)));
    return listTargets(db)
      .filter((t) => label == null || t.label === label)
      .map((t) => summarise(t, live));
  }

  /** Every workspace with its project, most recently opened first. */
  function workspaces(): WorkspaceSummary[] {
    const all: WorkspaceSummary[] = [];
    for (const project of listProjects(db)) {
      for (const w of listWorkspaces(db, project.id))
        all.push({
          id: w.id,
          name: w.name,
          branch: w.branch,
          path: w.path,
          projectId: project.id,
          project: project.name,
          lastOpenedAt: w.lastOpenedAt,
        });
    }
    return all.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
  }

  /**
   * What a window shows: its last `lines` lines, or with `after`, the history
   * added since that cursor and the screen.
   */
  async function output(
    t: AttachTarget,
    opts: { lines?: number; after?: number } = {},
  ): Promise<OutputResult> {
    requireSessions();
    const lines = opts.lines ?? DEFAULT_OUTPUT_LINES;
    const screen = await screens.watch(t.session);
    // Hibernated: what it showed when it went to sleep, without waking it.
    if (!screen && isAsleep(config, t.session)) {
      const text = await asleepText(config, t.session, lines);
      return opts.after === undefined
        ? { text, state: "asleep", lastOutputAt: null, cursor: 0 }
        : {
            text: "",
            screen: text,
            state: "asleep",
            lastOutputAt: null,
            // Kept, so the caller's place survives the nap.
            cursor: opts.after,
            truncated: false,
          };
    }
    if (!screen) throw new OpError("the window is not running", 409);
    // Just attached to: its repaint is on the way, and blank until it lands.
    if (screen.lastOutputAt === null)
      await screens.drewSince(t.session, 0, FIRST_PAINT_WAIT_MS);
    if (opts.after === undefined)
      return {
        text: screen.text(lines),
        state: screen.activity(),
        lastOutputAt: screen.lastOutputAt,
        cursor: screen.cursor(),
      };
    const since = screen.since(opts.after);
    const all = since.text === "" ? [] : since.text.split("\n");
    const kept = opts.lines === undefined ? all : all.slice(-lines);
    return {
      text: kept.join("\n"),
      screen: since.screen,
      state: screen.activity(),
      lastOutputAt: screen.lastOutputAt,
      cursor: since.cursor,
      truncated: since.truncated || kept.length < all.length,
    };
  }

  /**
   * Whether the agent in a window has a command running in the background,
   * by its harness's own account. False for a harness that cannot say.
   */
  async function hasBackground(t: AttachTarget): Promise<boolean> {
    const profile = t.profileId ? getProfile(db, t.profileId) : undefined;
    const probe = profile ? harness(profile.harness)?.background : undefined;
    if (!probe) return false;
    return probe({ sock: socketPath(config, t.session), cwd: t.cwd }).catch(
      () => false,
    );
  }

  /**
   * Blocks until one of the windows meets `until`, or the time runs out.
   *
   * Driven by the screens' state events, not by polling: a busy window goes
   * quiet when its quiet timer fires, and that is an event. A window that is
   * not running answers at once, and nothing here starts one, so waiting on a
   * hibernated window leaves it asleep.
   */
  async function wait(
    targets: AttachTarget[],
    opts: WaitOptions,
  ): Promise<WaitResult> {
    requireSessions();
    const begun = Date.now();
    // A screen just attached to has not seen its repaint yet, and blank reads
    // as idle. Give it the moment `output` gives it.
    await Promise.all(
      targets.map(async (t) => {
        const screen = await screens.watch(t.session);
        if (screen?.lastOutputAt === null)
          await screens.drewSince(t.session, 0, FIRST_PAINT_WAIT_MS);
      }),
    );

    const stateOf = (t: AttachTarget): Activity | "asleep" | null => {
      const screen = screens.get(t.session);
      if (screen) return screen.activity();
      return isAsleep(config, t.session) ? "asleep" : null;
    };
    const initial = new Map(targets.map((t) => [t.session, stateOf(t)]));

    /** Null while still waiting; otherwise whether the condition was met. */
    const verdict = (t: AttachTarget): boolean | null => {
      const state = stateOf(t);
      if (opts.until === "change" && state !== initial.get(t.session))
        return true;
      // Not running: nothing will change it while we wait.
      if (state === null || state === "asleep")
        return opts.until === "settled" && state === "asleep";
      switch (opts.until) {
        case "settled": {
          if (state === "busy") return null;
          const turn = screens.turnOf(t.session)?.turn;
          if (opts.turn && (turn === "pending" || turn === "working"))
            return null;
          return true;
        }
        case "idle":
        case "question":
          return state === opts.until ? true : null;
        case "change":
          return null;
      }
    };

    /**
     * The first window to meet the condition. One that is not running cannot
     * meet it, and only ends the wait when none of them can. With
     * `background`, a settled window whose agent still has a background
     * command running does not count yet.
     */
    const first = async (): Promise<{
      t: AttachTarget;
      reached: boolean;
    } | null> => {
      const verdicts = targets.map(verdict);
      for (const [i, v] of verdicts.entries()) {
        if (v !== true) continue;
        const t = targets[i];
        const waitsOnBackground =
          opts.background &&
          opts.until === "settled" &&
          stateOf(t) !== "asleep" &&
          (await hasBackground(t));
        if (!waitsOnBackground) return { t, reached: true };
      }
      if (verdicts.every((v) => v === false))
        return { t: targets[0], reached: false };
      return null;
    };

    const sessions = new Set(targets.map((t) => t.session));
    const outcome =
      (await first()) ??
      (await new Promise<{ t: AttachTarget; reached: boolean } | null>(
        (resolve) => {
          let finished = false;
          let checking = false;
          let again = false;
          const finish = (v: { t: AttachTarget; reached: boolean } | null) => {
            if (finished) return;
            finished = true;
            off();
            clearTimeout(timer);
            if (poll) clearInterval(poll);
            opts.signal?.removeEventListener("abort", aborted);
            resolve(v);
          };
          // One check at a time; a change during one is looked at after it.
          const check = async () => {
            if (checking) {
              again = true;
              return;
            }
            checking = true;
            try {
              do {
                again = false;
                const v = await first();
                if (v) finish(v);
              } while (again && !finished);
            } finally {
              checking = false;
            }
          };
          const off = screens.subscribe((e) => {
            if (!sessions.has(e.session)) return;
            if (e.type === "state" || e.type === "turn")
              opts.onEvent?.(fromScreen(e));
            void check();
          });
          // Nothing announces a background command finishing, so while one
          // is waited on, its harness is asked again every few seconds.
          const poll = opts.background
            ? setInterval(() => void check(), BACKGROUND_POLL_MS)
            : null;
          const timer = setTimeout(() => finish(null), opts.timeoutMs);
          const aborted = () => finish(null);
          if (opts.signal?.aborted) finish(null);
          else opts.signal?.addEventListener("abort", aborted);
        },
      ));

    const chosen = outcome?.t ?? targets[0];
    const screen = screens.get(chosen.session);
    const result: WaitResult = {
      ref: chosen.ref,
      state: stateOf(chosen),
      reached: outcome?.reached ?? false,
      waitedMs: Date.now() - begun,
      lastOutputAt: screen?.lastOutputAt ?? null,
      window: summary(chosen),
    };
    if (result.state === "idle" || result.state === "question")
      result.background = await hasBackground(chosen);
    if (opts.lines > 0 && (screen || isAsleep(config, chosen.session))) {
      const out = await output(chosen, { lines: opts.lines });
      result.text = out.text;
      result.cursor = out.cursor;
    }
    if (targets.length > 1)
      result.windows = targets.map((t) => ({
        ref: t.ref,
        state: stateOf(t),
        turn: screens.turnOf(t.session)?.turn ?? null,
      }));
    return result;
  }

  /** The last `last` messages of a window's conversation, from its harness. */
  async function messages(
    t: AttachTarget,
    last: number,
  ): Promise<TranscriptMessage[]> {
    const profile = t.profileId ? getProfile(db, t.profileId) : undefined;
    const reader = profile ? harness(profile.harness)?.messages : undefined;
    if (!reader)
      throw new OpError(
        `${t.ref} runs ${profile ? profile.harness : "a plain terminal"}, which has no transcript vibe-os can read; read its output instead`,
        409,
      );
    const found = await reader(
      { sock: socketPath(config, t.session), cwd: t.cwd },
      last,
    );
    if (found === null)
      throw new OpError(
        `could not find ${t.ref}'s transcript: it is not running, or has not started a conversation yet`,
        409,
      );
    return found;
  }

  // ── writes ──────────────────────────────────────────────────────────────

  /**
   * Starts a window, sends to it, or presses keys in it, as `body` says.
   * `verb` is `start` for a start with no body.
   */
  async function send(
    t: AttachTarget,
    verb: "start" | "send",
    body: SendInput = {},
  ): Promise<Partial<SendResult> & { window: WindowSummary }> {
    requireSessions();
    const profile = t.profileId ? getProfile(db, t.profileId) : undefined;
    let text: string | undefined;
    let keys: string[] | undefined;
    let submit = false;
    let force = false;
    if (verb === "send") {
      for (const flag of ["submit", "force"] as const) {
        if (body[flag] !== undefined && typeof body[flag] !== "boolean")
          throw new OpError(`${flag} must be true or false`, 400);
      }
      submit = body.submit === true;
      force = body.force === true;
      if (body.keys !== undefined) keys = keysToPress(body);
      else text = textToSend(body, profile);
    }

    try {
      const result =
        keys !== undefined
          ? await pressKeys(t, profile, keys)
          : text !== undefined
            ? await deliver(t, profile, text, { submit, force })
            : { started: await start(t, profile) };
      return { ...result, window: summary(t) };
    } catch (err) {
      const message = describeError(err);
      log.warn(`${verb} ${t.session} failed: ${message}`);
      throw new OpError(message, 502);
    }
  }

  /**
   * Adds a window to a workspace, and starts it or sends to it if asked.
   *
   * With `reuse` and a label, a window already open under that label is
   * returned instead, so a retried call does not open a second one.
   */
  async function open(
    workspaceId: string,
    body: OpenInput,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const workspace = getWorkspace(db, workspaceId);
    if (!workspace) throw new OpError("unknown workspace", 404);

    let label: string | null = null;
    if (body.label !== undefined && body.label !== null) {
      if (typeof body.label !== "string")
        throw new OpError("label must be a string", 400);
      if (body.label.length > MAX_LABEL_CHARS)
        throw new OpError(
          `label must be under ${MAX_LABEL_CHARS} characters`,
          400,
        );
      label = body.label.trim() || null;
    }
    for (const flag of ["start", "submit", "reuse"] as const) {
      if (body[flag] !== undefined && typeof body[flag] !== "boolean")
        throw new OpError(`${flag} must be true or false`, 400);
    }
    if (body.reuse === true && label === null)
      throw new OpError("reuse needs a label to find the window by", 400);

    let profile: Profile | undefined;
    let profileId: string | null = null;
    if (typeof body.profileId === "string" && body.profileId !== "") {
      profile = getProfile(db, body.profileId);
      // A profile belongs to a project, so it may only open windows in that
      // project's workspaces — otherwise one project's flags and prompt
      // could be launched inside another project's worktree.
      if (!profile || profile.projectId !== workspace.projectId)
        throw new OpError("unknown profile for this workspace", 400);
      profileId = profile.id;
    }

    // A prompt or blanks mean start it and send; `start` alone means start.
    const sends = body.prompt !== undefined || body.blanks !== undefined;
    const textFor = (p: Profile | undefined) =>
      sends
        ? textToSend(
            {
              text: body.prompt as string | undefined,
              blanks: body.blanks as Record<string, string> | undefined,
            },
            p,
          )
        : undefined;
    if ((sends || body.start === true) && !config.sessions)
      throw new OpError(NO_SESSIONS, 409);

    /**
     * An agent is what fills a small box, so an agent is what asks first. 409
     * with `capacity` is the question; the browser asks the person and sends
     * `force` to go ahead anyway.
     */
    const checkCapacity = async (p: Profile | undefined) => {
      if (!p || p.harness === "shell" || body.force === true) return;
      const warning = capacityWarning(
        await readBoxMemory(),
        effectiveLimits(config.memory, p).high,
      );
      if (warning) throw new OpError(warning, 409, { capacity: true });
    };

    if (body.reuse === true) {
      const row = listWindows(db, workspaceId).find((w) => w.label === label);
      const t = row ? resolveTarget(db, row.id) : undefined;
      if (row && t) {
        if (profileId !== null && t.profileId !== profileId)
          throw new OpError(
            `the window labelled ${label} (${t.ref}) is open as ${t.role ?? "a plain terminal"}, not ${profile?.name}`,
            409,
          );
        const windowProfile = t.profileId
          ? getProfile(db, t.profileId)
          : undefined;
        const text = textFor(windowProfile);
        await screens.watch(t.session);
        const running =
          screens.get(t.session) !== undefined || isAsleep(config, t.session);
        // Running, or asleep with its conversation: it already had its
        // prompt, and a retry must not paste it twice.
        if (running || (!sends && body.start !== true))
          return {
            status: 200,
            body: { ...row, reused: true, window: summary(t) },
          };
        await checkCapacity(windowProfile);
        try {
          const result =
            text !== undefined
              ? await deliver(t, windowProfile, text, {
                  submit: body.submit === true,
                  force: false,
                })
              : { started: await start(t, windowProfile) };
          return {
            status: 200,
            body: {
              ...(getWindow(db, row.id) ?? row),
              ...result,
              reused: true,
              window: summary(t),
            },
          };
        } catch (err) {
          const message = describeError(err);
          log.warn(`open ${t.session} failed: ${message}`);
          throw new OpError(message, 502);
        }
      }
    }

    const text = textFor(profile);
    await checkCapacity(profile);

    const row = createWindow(db, workspaceId, profileId, label);
    const t = resolveTarget(db, row.id);
    if (t) opened(t);
    if (!sends && body.start !== true) return { status: 201, body: row };
    if (!t) throw new OpError("unknown window", 404);
    try {
      const result =
        text !== undefined
          ? await deliver(t, profile, text, {
              submit: body.submit === true,
              force: false,
            })
          : { started: await start(t, profile) };
      return {
        status: 201,
        body: {
          ...(getWindow(db, row.id) ?? row),
          ...result,
          window: summarise(t, new Set([t.session])),
        },
      };
    } catch (err) {
      // A window that could not start is a tile with nothing in it. Take it
      // back out rather than leave that on someone's desktop.
      const message = describeError(err);
      log.warn(`open ${t.session} failed: ${message}`);
      await killSession(config, t.session).catch(() => {});
      deleteWindow(db, row.id);
      closed(t);
      throw new OpError(message, 502);
    }
  }

  /** Ends a window's session and removes it. False if there was no window. */
  async function close(id: string): Promise<boolean> {
    // Closing a window is an explicit "I am done with this", so the session
    // goes too. Window indices are reused and `new-session -A` attaches, so
    // leaving it alive would silently resurrect it in the next window.
    const t = resolveTarget(db, id);
    const named = sessionNameFor(db, id);
    if (named && config.sessions) {
      await killSession(config, named.session)
        .then(() => log.info(`ended session ${named.session}`))
        .catch(() => {});
    }
    const gone = deleteWindow(db, id) !== undefined;
    if (gone && t) closed(t);
    return gone;
  }

  /** Ends a workspace's sessions and removes its worktree. */
  async function removeWorkspaceAndWindows(id: string): Promise<void> {
    // Every window here has a live session; removing the worktree without
    // ending them leaves shells sitting in a deleted directory.
    const gone: AttachTarget[] = [];
    for (const win of listWindows(db, id)) {
      const named = sessionNameFor(db, win.id);
      if (named && config.sessions)
        await killSession(config, named.session).catch(() => {});
      const t = resolveTarget(db, win.id);
      if (t) gone.push(t);
    }
    try {
      await removeWorkspace(db, config, id);
    } catch (err) {
      throw new OpError(describeError(err), 400);
    }
    for (const t of gone) closed(t);
  }

  /** Cuts a workspace, as `POST /api/projects/:project/workspaces` does. */
  async function newWorkspace(
    projectId: string,
    body: { name?: unknown; from?: unknown },
  ) {
    if (body.name !== undefined && typeof body.name !== "string")
      throw new OpError("name must be a string", 400);
    if (body.from !== undefined && typeof body.from !== "string")
      throw new OpError("from must be a string", 400);
    try {
      return await createWorkspace(
        db,
        config.workspace,
        projectId,
        body.name,
        body.from,
      );
    } catch (err) {
      const message = describeError(err);
      log.warn(`workspace creation failed: ${message}`);
      throw new OpError(message, 400);
    }
  }

  return {
    summarise,
    summary,
    subscribe,
    target,
    windows,
    workspaces,
    output,
    wait,
    messages,
    send,
    open,
    close,
    removeWorkspace: removeWorkspaceAndWindows,
    newWorkspace,
  };
}
