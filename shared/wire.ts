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
 * happen to describe the same things — `PALETTE`, `HARNESSES` — stay in
 * `server/profiles.ts`, where they are used, and are shipped to the browser as
 * data on `ClientConfig` rather than duplicated as a second literal.
 */

/** Which program a profile launches. */
export type Harness = "claude" | "shell" | "custom";

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
  /** Colour tokens a profile may use; `--profile-<token>` resolves each one. */
  palette: readonly string[];
}

/** `GET /api/harness/claude` — what the installed Claude CLI accepts. */
export interface HarnessInfo {
  available: boolean;
  version: string | null;
  /**
   * Aliases like `opus`, which always resolve to the newest model of that tier.
   *
   * These are the right default for a profile precisely because they do not
   * pin: a role called "Backend Manager" wants the best Opus, not the one that
   * was current the day it was written.
   */
  aliases: string[];
  /** Full model ids, for pinning a profile to one exact model. */
  models: string[];
  /** Values `--permission-mode` accepts. */
  permissionModes: string[];
  /** Values `--effort` accepts, weakest first — the order is the scale. */
  effortLevels: string[];
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
  position?: number;
}
