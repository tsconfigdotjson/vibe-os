/**
 * The shapes that cross the HTTP boundary, declared once.
 *
 * Every one of these used to exist twice — once in `server/`, once in `src/` —
 * kept in step by hand and by comments that said "mirrors the other one". That
 * held until it didn't: `ProfileInput` grew a `position` field on the server
 * that the client's copy never got, which quietly made profile reordering
 * unreachable from the only client there is.
 *
 * Types only, deliberately. Every import of this file is an `import type` and
 * erases at build time, so nothing here has to be packaged, compiled into the
 * standalone binary, or resolved at runtime by either side. Runtime values that
 * happen to describe the same things — `PALETTE`, the harness specs — stay on
 * the server, where they are used, and are shipped to the browser as data
 * rather than duplicated as a second literal.
 */

/**
 * Which program a profile launches: a harness id from `GET /api/harnesses`,
 * or `shell` or `custom`.
 */
export type Harness = string;

export type {
  ChoiceOption,
  Field,
  FlagSettings,
  HarnessReport,
  HarnessSpec,
  McpMode,
} from "./harness";

/** Whether a window has been handed off to a real terminal. */
export type Handoff = "ssh" | null;

/** `GET /api/config` — everything the browser needs before it can draw. */
export interface ClientConfig {
  version: string;
  hostname: string;
  user: string;
  workspaceRoot: string;
  /** Windows are dtach-backed and survive a reload. */
  sessions: boolean;
  authRequired: boolean;
  /** WebSocket endpoint, relative to the page so it follows http/https. */
  endpoint: { name: string; url: string };
  /** Host key to pin, or null to fall back to trust-on-first-use. */
  hostKey: string | null;
  /**
   * Computed server-side on purpose: the browser cannot do it on plain HTTP,
   * where `crypto.subtle` is unavailable because the origin is not secure.
   */
  hostKeyFingerprint: string | null;
  certificateEndpoint: string;
  maxWallpaperBytes: number;
  /** Window-chrome colour, so a tab matches the installed app. */
  themeColor: string;
  /** Colour tokens a profile may use; `--profile-<token>` resolves each one. */
  palette: readonly string[];
  /** The scope limits a window gets when its profile sets none. */
  memory: { high: string | null; max: string | null; swapMax: string | null };
}

/** `GET /api/workspaces/:id/memory` — what the box has and each window costs. */
export interface MemoryReport {
  box: {
    total: number;
    available: number;
    swapTotal: number;
    swapFree: number;
    pressure: { some10: number; full10: number } | null;
  } | null;
  /**
   * What opening another agent would be warned with right now, or null when
   * there is room. The dock shows it, so it never disagrees with the question.
   */
  warning: string | null;
  /** Keyed by window id. A window with no live session is absent. */
  windows: Record<
    string,
    { bytes: number; high: number | null; max: number | null; scoped: boolean }
  >;
}

/**
 * Where an MCP definition came from. `user` is machine-wide, `project` is the
 * repo's `.mcp.json`, `local` is one directory.
 */
export type McpScope = "user" | "project" | "local";

export interface McpServer {
  /** The name Claude knows it by, and the key inside the generated file. */
  name: string;
  scope: McpScope;
  /** The file or directory the definition came from, for the label. */
  source: string;
  /** `stdio`, `sse` or `http`. */
  transport: string;
  /** The URL, or the command it runs — enough to tell two servers apart. */
  detail: string;
  /** What a profile passes to `--mcp-config` to get exactly this one server. */
  configPath: string;
}

export interface SshEndpoint {
  user: string;
  host: string;
  port: number;
}

/** Everything the UI needs to offer an SSH handoff. */
export interface AttachInfo {
  ref: string;
  session: string;
  cwd: string;
  workspace: string;
  project: string;
  role: string | null;
  endpoint: SshEndpoint;
  /** The one command that gets you there. */
  command: string;
}

export interface Wallpaper {
  id: string;
  name: string;
  mime: string;
  size: number;
}

export interface DesktopPrefs {
  wallpaper: string | null;
  fit: "cover" | "contain" | "tile";
  /** 0…0.9 scrim over the wallpaper. Terminals have to stay readable. */
  dim: number;
}

export interface Profile {
  id: string;
  projectId: string;
  /** Palette token; `--profile-<color>` in the stylesheet resolves it. */
  color: string;
  name: string;
  harness: Harness;
  command: string | null;
  /** argv tokens, already split and validated by the server. */
  args: string[];
  prompt: string;
  /** systemd sizes (`2G`, `40%`, `infinity`), or null for the server default. */
  memoryHigh: string | null;
  memoryMax: string | null;
  position: number;
  createdAt: number;
}

/**
 * The write shape. Every field is optional because a PATCH may carry one.
 *
 * `args` is free text as typed in the editor, not the split array — the server
 * is the only tokeniser, so the browser never has to agree with it about what
 * a quote means.
 */
export interface ProfileInput {
  name?: string;
  color?: string;
  harness?: Harness;
  command?: string | null;
  args?: string;
  prompt?: string;
  /** Empty or null goes back to the server default. */
  memoryHigh?: string | null;
  memoryMax?: string | null;
  position?: number;
}

/** `GET /api/workspaces` — every workspace on the box, with its project. */
export interface WorkspaceSummary {
  id: string;
  name: string;
  branch: string;
  path: string;
  projectId: string;
  project: string;
  lastOpenedAt: number;
}

/** `GET /api/windows` — every window on the box, and whether it is running. */
export interface WindowSummary {
  id: string;
  /** What `vibe-os attach` takes: `quiet-amber-otter-1`. */
  ref: string;
  session: string;
  workspace: string;
  project: string;
  /** The profile it was opened as, or null for a plain terminal. */
  role: string | null;
  /** Its session is running. Always false with `--no-sessions`. */
  live: boolean;
  /**
   * What the program in it is doing. `asleep` when it was hibernated: the next
   * start, send or view brings it back. Null when it is not running.
   */
  state: Activity | "asleep" | null;
  /** When it last drew anything, in ms since the epoch, if seen since the server started. */
  lastOutputAt: number | null;
  /** The caller's own tag for the window, set when it was opened. */
  label: string | null;
  /**
   * When a send that submitted text, or pressed keys, last went in. Null if
   * none has since the server started.
   */
  lastSendAt: number | null;
  /** How the window's answer to that send is going. Null with no send. */
  turn: Turn | null;
}

/**
 * Where a window is with the last thing sent to it.
 *
 * `pending` is sent and nothing drawn since, `working` is drawing since the
 * send, and `done` is quiet again after working: idle or on a question.
 */
export type Turn = "pending" | "working" | "done";

/** One event on `GET /api/events`. */
export interface WindowEvent {
  type:
    | "window.state"
    | "window.turn"
    | "window.opened"
    | "window.closed"
    | "window.asleep"
    | "window.woke";
  ref: string;
  /** Null for a window this server no longer knows. */
  label: string | null;
  workspace: string | null;
  project: string | null;
  at: number;
  /** `window.state` only. Null is not running. */
  from?: Activity | null;
  to?: Activity | null;
  /** `window.turn` only. */
  turn?: Turn;
}

/** `GET /api/windows/:window/wait` */
export interface WaitResult {
  /** The window that met the condition, or the first one asked about. */
  ref: string;
  state: Activity | "asleep" | null;
  /** False when the wait timed out, or the window is not running. */
  reached: boolean;
  waitedMs: number;
  lastOutputAt: number | null;
  window: WindowSummary;
  /** With `lines`: the window's last lines, as `output` returns them. */
  text?: string;
  cursor?: number;
  /** With more than one window: where each of them is. */
  windows?: {
    ref: string;
    state: Activity | "asleep" | null;
    turn: Turn | null;
  }[];
}

/** `GET /api/windows/:window/messages`: one turn of a conversation. */
export interface TranscriptMessage {
  /** `tool` is a tool call the assistant made, in short form. */
  role: "user" | "assistant" | "tool";
  text: string;
  /** When it was written, in ms since the epoch, if the transcript says. */
  at: number | null;
}

/**
 * What the program in a window is doing.
 *
 * `busy` is drawing right now, `question` is stopped on a dialog or a yes/no
 * question, and `idle` is quiet at its prompt or finished.
 */
export type Activity = "busy" | "idle" | "question";

/** `POST /api/windows/:id/send` */
export interface SendInput {
  /** The text to paste. Absent means the window's profile prompt. */
  text?: string;
  /** Values for the profile prompt's `{{blanks}}`, by label. */
  blanks?: Record<string, string>;
  /** Press Enter after the paste. */
  submit?: boolean;
  /** Paste even when the window is stopped on a question. */
  force?: boolean;
  /** Instead of text: keys to press, like `["Enter"]` or `["Escape"]`. */
  keys?: string[];
}

/** What a send did. */
export interface SendResult {
  /** The session was started for this send. */
  started: boolean;
  /** The text went in and the window drew it, or the keys were pressed. */
  delivered: boolean;
  /** What the window was doing when the text went in, or why it did not. */
  state: Activity;
  /** Why it was not delivered. */
  reason?: string;
}
