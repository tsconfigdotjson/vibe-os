import os from "node:os";
import pkg from "../package.json" with { type: "json" };
import { fillBlanks } from "../shared/blanks.ts";
import type {
  ClientConfig,
  MemoryReport,
  SendInput,
  SendResult,
  WindowSummary,
  WorkspaceSummary,
} from "../shared/wire.ts";
import {
  type AttachTarget,
  attachInfo,
  killSession,
  listTargets,
  liveSessions,
  publicHost,
  reapStaleHandoffs,
  resolveTarget,
  setHandoff,
} from "./attach.ts";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import { ID_PATTERN } from "./db.ts";
import { discover, specs } from "./harness.ts";
import {
  KEY_NAMES,
  keyBytes,
  paste,
  press,
  submit as pressEnter,
  startSession,
  waitForInput,
} from "./headless.ts";
import {
  badId,
  IMMUTABLE_CACHE_CONTROL,
  json,
  methodNotAllowed,
  readJson,
} from "./http.ts";
import { describeError, log } from "./log.ts";
import {
  discoverMcp,
  discoverMcpWithDefs,
  type McpScan,
  syncMcpMirrors,
} from "./mcp.ts";
import {
  capacityWarning,
  effectiveLimits,
  readBoxMemory,
  sessionMemory,
} from "./memory.ts";
import {
  createProfile,
  deleteProfile,
  getProfile,
  listProfiles,
  PALETTE,
  type Profile,
  updateProfile,
} from "./profiles.ts";
import {
  createWorkspace,
  getWorkspace,
  listProjects,
  listWorkspaces,
  reconcileWorkspaces,
  removeWorkspace,
  scanProjects,
  touchWorkspace,
} from "./projects.ts";
import { Screens } from "./screens.ts";
import { socketPath, windowCommand } from "./session.ts";
import type { SshCa } from "./ssh-ca.ts";
import { fingerprint, MAX_PUBKEY_BYTES } from "./ssh-ca.ts";
import {
  type DesktopPrefs,
  MAX_WALLPAPER_BYTES,
  type WallpaperStore,
} from "./wallpapers.ts";
import {
  createWindow,
  deleteWindow,
  getWindow,
  listWindows,
  restoreWindow,
  sessionNameFor,
  takeResume,
  updateWindow,
} from "./windows.ts";

/**
 * Where to look for MCP servers, for one project or for all of them.
 *
 * A worktree is a copy of the repo, so its `.mcp.json` is the project's and is
 * read once from the root. Local-scope servers are the opposite — they are
 * keyed by the exact directory `claude mcp add` ran in, so every worktree is
 * its own place to look.
 */
function mcpScan(db: Db, projectId?: string): McpScan {
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
 * Brings the generated per-server files back in step with the box.
 *
 * Always over every project, never just the one being asked about: the sync
 * deletes files that no longer have a server behind them, and a partial view
 * would read another project's servers as gone.
 */
/**
 * Re-scans every project and rewrites the mirror files.
 *
 * Returns nothing: both call sites discarded the list, which made the discovery
 * work look reusable when it was not.
 */
async function refreshMcpMirrors(db: Db, stateDir: string): Promise<void> {
  await syncMcpMirrors(
    stateDir,
    await discoverMcpWithDefs(stateDir, mcpScan(db)),
  );
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
const DEFAULT_OUTPUT_LINES = 50;
const MAX_OUTPUT_LINES = 2_000;
/** How long a first read waits for a window to redraw itself. */
const FIRST_PAINT_WAIT_MS = 1_000;

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
      throw new Error(
        'text must be a non-empty string. To press Enter alone, send keys: ["Enter"]',
      );
    if (body.blanks !== undefined)
      throw new Error(
        "blanks fill the profile prompt; leave out text to use it",
      );
    if (body.text.length > MAX_SEND_CHARS)
      throw new Error(`text must be under ${MAX_SEND_CHARS} characters`);
    return body.text;
  }
  if (!profile || profile.prompt.trim() === "")
    throw new Error("this window has no profile prompt; send text instead");

  const blanks = body.blanks ?? {};
  if (
    typeof blanks !== "object" ||
    blanks === null ||
    Array.isArray(blanks) ||
    Object.values(blanks).some((v) => typeof v !== "string")
  )
    throw new Error("blanks must be an object of strings");
  const filled = fillBlanks(profile.prompt, blanks);
  if (filled.unknown.length > 0)
    throw new Error(
      `the prompt has no blank called ${filled.unknown.join(", ")}`,
    );
  if (filled.missing.length > 0)
    throw new Error(`fill every blank: ${filled.missing.join(", ")}`);
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
    throw new Error(`keys must be a list of 1 to ${MAX_KEYS} key names`);
  const unknown = keys.find((k) => keyBytes(k) === null);
  if (unknown !== undefined)
    throw new Error(
      `unknown key ${JSON.stringify(unknown)}. A key is one character or one of ${KEY_NAMES.join(", ")}`,
    );
  if (body.text !== undefined || body.blanks !== undefined)
    throw new Error("send text or keys, not both");
  if (body.submit !== undefined)
    throw new Error('submit is for text; put "Enter" in keys instead');
  return keys;
}

export interface ApiDeps {
  config: Config;
  ca: SshCa;
  hostKey: string | null;
  wallpapers: WallpaperStore;
  db: Db;
  /** Every running window's screen. One that is never started if absent. */
  screens?: Screens;
}

export function createApi(deps: ApiDeps) {
  const { ca, config, db, hostKey, wallpapers } = deps;
  const screens = deps.screens ?? new Screens(config);

  const summarise = (t: AttachTarget, live: Set<string>): WindowSummary => {
    const running = live.has(t.session);
    const screen = running ? screens.get(t.session) : undefined;
    return {
      id: t.windowId,
      ref: t.ref,
      session: t.session,
      workspace: t.workspace,
      project: t.project,
      role: t.role,
      label: t.label,
      live: running,
      state: running ? (screen?.activity() ?? "idle") : null,
      lastOutputAt: screen?.lastOutputAt ?? null,
    };
  };

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
    if (opts.submit) await pressEnter(config, session);
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
    await press(config, session, keys);
    return { started, delivered: true, state };
  }

  return async function handleApi(
    req: Request,
    url: URL,
  ): Promise<Response | null> {
    const p = url.pathname;
    if (!p.startsWith("/api/")) return null;

    if (p === "/api/health") return json({ ok: true });

    // Every harness a profile can launch, as the specs the editor renders.
    if (p === "/api/harnesses" && req.method === "GET") {
      return json(specs());
    }

    // What one harness found on the box: models and options read off the
    // installed binary, its defaults, whether it is logged in.
    const harnessMatch = /^\/api\/harness\/([a-z][a-z0-9-]*)$/.exec(p);
    if (harnessMatch && req.method === "GET") {
      const found = discover(harnessMatch[1]);
      if (!found) return json({ error: "unknown harness" }, 404);
      return json((await found).report);
    }

    if (p === "/api/config" && req.method === "GET") {
      const body: ClientConfig = {
        version: pkg.version,
        hostname: os.hostname(),
        user: config.user,
        workspaceRoot: config.workspace,
        sessions: config.sessions,
        authRequired: config.token !== null,
        endpoint: { name: "local", url: "./websocket" },
        hostKey,
        hostKeyFingerprint: hostKey ? fingerprint(hostKey) : null,
        certificateEndpoint: "/api/ssh/certificate",
        maxWallpaperBytes: MAX_WALLPAPER_BYTES,
        themeColor: config.themeColor,
        palette: PALETTE,
        memory: config.memory,
      };
      return json(body);
    }

    // ── projects ─────────────────────────────────────────────────────────────
    if (p === "/api/projects" && req.method === "GET") {
      // Reads the table only. Finding repos means walking the disk, which is
      // far too expensive to do on a poll — that is what the refresh button
      // (POST /api/projects/scan) is for, plus one scan at startup.
      return json(listProjects(db));
    }

    if (p === "/api/projects/scan" && req.method === "POST") {
      await scanProjects(db, config);
      await reconcileWorkspaces(db, config);
      return json(listProjects(db));
    }

    // The MCP servers a profile in this project could be given. Read from the
    // box's own config rather than a list of our own, so `claude mcp add` is
    // all it takes for one to appear here.
    const mcpMatch = /^\/api\/projects\/([^/]+)\/mcp$/.exec(p);
    if (mcpMatch && req.method === "GET") {
      const projectId = decodeURIComponent(mcpMatch[1]);
      if (!ID_PATTERN.test(projectId)) return badId("project");
      // Writes the files as a side effect of listing them, so that anything
      // offered in the editor is something a launch can actually point at.
      await refreshMcpMirrors(db, config.stateDir);
      return json(await discoverMcp(config.stateDir, mcpScan(db, projectId)));
    }

    const workspacesMatch = /^\/api\/projects\/([^/]+)\/workspaces$/.exec(p);
    if (workspacesMatch) {
      const projectId = decodeURIComponent(workspacesMatch[1]);
      if (!ID_PATTERN.test(projectId)) return badId("project");

      if (req.method === "GET") return json(listWorkspaces(db, projectId));

      if (req.method === "POST") {
        try {
          const body = await readJson<{ name?: unknown; from?: unknown }>(req);
          if (body.name !== undefined && typeof body.name !== "string")
            throw new Error("name must be a string");
          if (body.from !== undefined && typeof body.from !== "string")
            throw new Error("from must be a string");
          const created = await createWorkspace(
            db,
            config.workspace,
            projectId,
            body.name,
            body.from,
          );
          return json(created, 201);
        } catch (err) {
          const message = describeError(err);
          log.warn(`workspace creation failed: ${message}`);
          return json({ error: message }, 400);
        }
      }
      return methodNotAllowed();
    }

    if (p === "/api/workspaces" && req.method === "GET") {
      const projectNames = new Map(listProjects(db).map((x) => [x.id, x.name]));
      const all: WorkspaceSummary[] = [];
      for (const [projectId, project] of projectNames) {
        for (const w of listWorkspaces(db, projectId))
          all.push({
            id: w.id,
            name: w.name,
            branch: w.branch,
            path: w.path,
            projectId,
            project,
            lastOpenedAt: w.lastOpenedAt,
          });
      }
      return json(all.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt));
    }

    // ── profiles ─────────────────────────────────────────────────────────────
    const profilesMatch = /^\/api\/projects\/([^/]+)\/profiles$/.exec(p);
    if (profilesMatch) {
      const projectId = decodeURIComponent(profilesMatch[1]);
      if (!ID_PATTERN.test(projectId)) return badId("project");

      if (req.method === "GET") return json(listProfiles(db, projectId));

      if (req.method === "POST") {
        try {
          const body = await readJson<Record<string, unknown>>(req);
          return json(createProfile(db, projectId, body), 201);
        } catch (err) {
          return json({ error: describeError(err) }, 400);
        }
      }
      return methodNotAllowed();
    }

    const profileMatch = /^\/api\/profiles\/([^/]+)$/.exec(p);
    if (profileMatch) {
      const id = decodeURIComponent(profileMatch[1]);
      if (!ID_PATTERN.test(id)) return badId("profile");

      if (req.method === "PATCH") {
        try {
          const body = await readJson<Record<string, unknown>>(req);
          const updated = updateProfile(db, id, body);
          return updated
            ? json(updated)
            : json({ error: "unknown profile" }, 404);
        } catch (err) {
          return json({ error: describeError(err) }, 400);
        }
      }

      if (req.method === "DELETE") {
        // Windows opened as this profile keep running and become plain
        // terminals; ending live sessions is what the close button is for.
        return deleteProfile(db, id)
          ? json({ ok: true })
          : json({ error: "unknown profile" }, 404);
      }
      return methodNotAllowed();
    }

    const workspaceMatch = /^\/api\/workspaces\/([^/]+)$/.exec(p);
    if (workspaceMatch) {
      const id = decodeURIComponent(workspaceMatch[1]);
      if (!ID_PATTERN.test(id)) return badId("workspace");

      if (req.method === "DELETE") {
        // Every window here has a live session; removing the worktree
        // without ending them leaves shells sitting in a deleted directory.
        for (const win of listWindows(db, id)) {
          const target = sessionNameFor(db, win.id);
          if (target && config.sessions)
            await killSession(config, target.session).catch(() => {});
        }
        try {
          await removeWorkspace(db, config, id);
          return json({ ok: true });
        } catch (err) {
          return json({ error: describeError(err) }, 400);
        }
      }

      if (req.method === "POST") {
        touchWorkspace(db, id);
        return json({ ok: true });
      }
      return methodNotAllowed();
    }

    // ── windows ──────────────────────────────────────────────────────────────
    const windowsMatch = /^\/api\/workspaces\/([^/]+)\/windows$/.exec(p);
    if (windowsMatch) {
      const workspaceId = decodeURIComponent(windowsMatch[1]);
      if (!ID_PATTERN.test(workspaceId)) return badId("workspace");
      const workspace = getWorkspace(db, workspaceId);
      if (!workspace) return json({ error: "unknown workspace" }, 404);

      if (req.method === "GET") {
        // Cheap unless something is actually handed off, and it is what makes
        // closing an ssh session give the window back on its own.
        await reapStaleHandoffs(db, config).catch((err: unknown) => {
          log.warn(`could not check handoffs: ${describeError(err)}`);
        });
        return json(listWindows(db, workspaceId));
      }
      if (req.method === "POST") {
        const body = await readJson<{
          profileId?: unknown;
          force?: unknown;
          label?: unknown;
          start?: unknown;
          prompt?: unknown;
          blanks?: unknown;
          submit?: unknown;
        }>(req);
        let label: string | null = null;
        if (body.label !== undefined && body.label !== null) {
          if (typeof body.label !== "string")
            return json({ error: "label must be a string" }, 400);
          if (body.label.length > MAX_LABEL_CHARS)
            return json(
              { error: `label must be under ${MAX_LABEL_CHARS} characters` },
              400,
            );
          label = body.label.trim() || null;
        }
        for (const flag of ["start", "submit"] as const) {
          if (body[flag] !== undefined && typeof body[flag] !== "boolean")
            return json({ error: `${flag} must be true or false` }, 400);
        }
        let profile: Profile | undefined;
        let profileId: string | null = null;
        if (typeof body.profileId === "string" && body.profileId !== "") {
          profile = getProfile(db, body.profileId);
          // A profile belongs to a project, so it may only open windows in that
          // project's workspaces — otherwise one project's flags and prompt
          // could be launched inside another project's worktree.
          if (!profile || profile.projectId !== workspace.projectId) {
            return json({ error: "unknown profile for this workspace" }, 400);
          }
          // An agent is what fills a small box, so an agent is what asks
          // first. 409 with `capacity` is the question; the browser asks the
          // person and sends `force` to go ahead anyway.
          if (profile.harness !== "shell" && body.force !== true) {
            const warning = capacityWarning(
              await readBoxMemory(),
              effectiveLimits(config.memory, profile).high,
            );
            if (warning) return json({ error: warning, capacity: true }, 409);
          }
          profileId = profile.id;
        }

        // A prompt or blanks mean start it and send; `start` alone means start.
        const sends = body.prompt !== undefined || body.blanks !== undefined;
        let text: string | undefined;
        if (sends) {
          try {
            text = textToSend(
              {
                text: body.prompt as string | undefined,
                blanks: body.blanks as Record<string, string> | undefined,
              },
              profile,
            );
          } catch (err) {
            return json({ error: describeError(err) }, 400);
          }
        }
        if ((sends || body.start === true) && !config.sessions)
          return json(
            { error: "this server runs plain login shells (--no-sessions)" },
            409,
          );

        const row = createWindow(db, workspaceId, profileId, label);
        if (!sends && body.start !== true) return json(row, 201);

        const target = resolveTarget(db, row.id);
        if (!target) return json({ error: "unknown window" }, 404);
        try {
          const result =
            text !== undefined
              ? await deliver(target, profile, text, {
                  submit: body.submit === true,
                  force: false,
                })
              : { started: await start(target, profile) };
          return json(
            {
              ...(getWindow(db, row.id) ?? row),
              ...result,
              window: summarise(target, new Set([target.session])),
            },
            201,
          );
        } catch (err) {
          // A window that could not start is a tile with nothing in it. Take it
          // back out rather than leave that on someone's desktop.
          const message = describeError(err);
          log.warn(`open ${target.session} failed: ${message}`);
          await killSession(config, target.session).catch(() => {});
          deleteWindow(db, row.id);
          return json({ error: message }, 502);
        }
      }
      return methodNotAllowed();
    }

    // What the box has and what each of this workspace's windows costs, for
    // the dock. Linux only; elsewhere both halves come back empty.
    const memoryMatch = /^\/api\/workspaces\/([^/]+)\/memory$/.exec(p);
    if (memoryMatch && req.method === "GET") {
      const workspaceId = decodeURIComponent(memoryMatch[1]);
      if (!ID_PATTERN.test(workspaceId)) return badId("workspace");
      const sockets = new Map<string, string>();
      for (const win of listWindows(db, workspaceId)) {
        const target = sessionNameFor(db, win.id);
        if (target) sockets.set(socketPath(config, target.session), win.id);
      }
      const [box, usage] = await Promise.all([
        readBoxMemory(),
        sessionMemory([...sockets.keys()]),
      ]);
      const report: MemoryReport = {
        box,
        warning: capacityWarning(box, config.memory.high),
        windows: {},
      };
      for (const [sock, mem] of usage) {
        const id = sockets.get(sock);
        if (id) report.windows[id] = mem;
      }
      return json(report);
    }

    if (p === "/api/windows" && req.method === "GET") {
      const live = config.sessions
        ? await liveSessions(config)
        : new Set<string>();
      // A session started by a login rather than by this server is picked up
      // within a few seconds anyway; this saves a caller the wait.
      await Promise.all([...live].map((s) => screens.watch(s)));
      const label = url.searchParams.get("label");
      return json(
        listTargets(db)
          .filter((t) => label === null || t.label === label)
          .map((t) => summarise(t, live)),
      );
    }

    // What a window shows, as plain text: the screen and the history above it.
    const outputMatch = /^\/api\/windows\/([^/]+)\/output$/.exec(p);
    if (outputMatch && req.method === "GET") {
      const id = decodeURIComponent(outputMatch[1]);
      if (!ID_PATTERN.test(id)) return badId("window");
      if (!config.sessions)
        return json(
          { error: "this server runs plain login shells (--no-sessions)" },
          409,
        );
      const target = resolveTarget(db, id);
      if (!target || target.windowId !== id)
        return json({ error: "unknown window" }, 404);
      const given = url.searchParams.get("lines");
      const lines = given === null ? DEFAULT_OUTPUT_LINES : Number(given);
      if (!Number.isInteger(lines) || lines < 1 || lines > MAX_OUTPUT_LINES)
        return json(
          {
            error: `lines must be a whole number from 1 to ${MAX_OUTPUT_LINES}`,
          },
          400,
        );
      const screen = await screens.watch(target.session);
      if (!screen) return json({ error: "the window is not running" }, 409);
      // Just attached to: its repaint is on the way, and blank until it lands.
      if (screen.lastOutputAt === null)
        await screens.drewSince(target.session, 0, FIRST_PAINT_WAIT_MS);
      return json({
        text: screen.text(lines),
        state: screen.activity(),
        lastOutputAt: screen.lastOutputAt,
      });
    }

    // Starts a window's session with nothing attached, so it is running before
    // any browser opens it. Idempotent: a running session is left alone.
    const startMatch = /^\/api\/windows\/([^/]+)\/(start|send)$/.exec(p);
    if (startMatch && req.method === "POST") {
      const id = decodeURIComponent(startMatch[1]);
      if (!ID_PATTERN.test(id)) return badId("window");
      if (!config.sessions)
        return json(
          { error: "this server runs plain login shells (--no-sessions)" },
          409,
        );
      const target = resolveTarget(db, id);
      if (!target || target.windowId !== id)
        return json({ error: "unknown window" }, 404);
      const profile = target.profileId
        ? getProfile(db, target.profileId)
        : undefined;

      let text: string | undefined;
      let keys: string[] | undefined;
      let submit = false;
      let force = false;
      if (startMatch[2] === "send") {
        const body = await readJson<SendInput>(req);
        for (const flag of ["submit", "force"] as const) {
          if (body[flag] !== undefined && typeof body[flag] !== "boolean")
            return json({ error: `${flag} must be true or false` }, 400);
        }
        submit = body.submit === true;
        force = body.force === true;
        try {
          if (body.keys !== undefined) keys = keysToPress(body);
          else text = textToSend(body, profile);
        } catch (err) {
          return json({ error: describeError(err) }, 400);
        }
      }

      try {
        const result =
          keys !== undefined
            ? await pressKeys(target, profile, keys)
            : text !== undefined
              ? await deliver(target, profile, text, { submit, force })
              : { started: await start(target, profile) };
        return json({
          ...result,
          window: summarise(target, new Set([target.session])),
        });
      } catch (err) {
        const message = describeError(err);
        log.warn(`${startMatch[2]} ${target.session} failed: ${message}`);
        return json({ error: message }, 502);
      }
    }

    // How to reach this window from a real terminal. Read-only: it composes
    // strings a person can copy, and never runs anything itself.
    const attachMatch = /^\/api\/windows\/([^/]+)\/attach$/.exec(p);
    if (attachMatch && req.method === "GET") {
      const id = decodeURIComponent(attachMatch[1]);
      if (!ID_PATTERN.test(id)) return badId("window");
      if (!config.sessions)
        return json(
          { error: "this server runs plain login shells (--no-sessions)" },
          409,
        );
      const info = attachInfo(db, config, id, publicHost(req, url));
      return info ? json(info) : json({ error: "unknown window" }, 404);
    }

    // Hands the window's terminal to an ssh client, or takes it back — which
    // detaches whoever is attached, so there is never a second client.
    const handoffMatch = /^\/api\/windows\/([^/]+)\/handoff$/.exec(p);
    if (handoffMatch && req.method === "POST") {
      const id = decodeURIComponent(handoffMatch[1]);
      if (!ID_PATTERN.test(id)) return badId("window");
      const body = await readJson<{ mode?: unknown }>(req);
      if (body.mode !== "ssh" && body.mode !== null)
        return json({ error: 'mode must be "ssh" or null' }, 400);
      if (body.mode === "ssh" && !config.sessions) {
        return json(
          { error: "this server runs plain login shells (--no-sessions)" },
          409,
        );
      }
      const ok = await setHandoff(db, config, id, body.mode);
      if (!ok) return json({ error: "unknown window" }, 404);
      return json(getWindow(db, id) ?? { ok: true });
    }

    // The answer to "bring this window back?" after its session died under it.
    // Recorded here and acted on by the next certificate, which is what creates
    // the session.
    const restoreMatch = /^\/api\/windows\/([^/]+)\/restore$/.exec(p);
    if (restoreMatch && req.method === "POST") {
      const id = decodeURIComponent(restoreMatch[1]);
      if (!ID_PATTERN.test(id)) return badId("window");
      const body = await readJson<{ resume?: unknown }>(req);
      if (typeof body.resume !== "boolean")
        return json({ error: "resume must be true or false" }, 400);
      const row = restoreWindow(db, id, body.resume);
      return row ? json(row) : json({ error: "unknown window" }, 404);
    }

    const windowMatch = /^\/api\/windows\/([^/]+)$/.exec(p);
    if (windowMatch) {
      const id = decodeURIComponent(windowMatch[1]);
      if (!ID_PATTERN.test(id)) return badId("window");

      if (req.method === "PATCH") {
        const body = await readJson<Record<string, unknown>>(req);
        const updated = updateWindow(db, id, body);
        return updated ? json(updated) : json({ error: "unknown window" }, 404);
      }

      if (req.method === "DELETE") {
        // Closing a window is an explicit "I am done with this", so the session
        // goes too. Window indices are reused and `new-session -A` attaches, so
        // leaving it alive would silently resurrect it in the next window.
        const target = sessionNameFor(db, id);
        if (target && config.sessions) {
          await killSession(config, target.session)
            .then(() => log.info(`ended session ${target.session}`))
            .catch(() => {});
        }
        return deleteWindow(db, id)
          ? json({ ok: true })
          : json({ error: "unknown window" }, 404);
      }
      return methodNotAllowed();
    }

    // ── certificates ─────────────────────────────────────────────────────────
    if (p === "/api/ssh/certificate") {
      if (req.method !== "POST") return methodNotAllowed();

      const windowId = url.searchParams.get("window") ?? "";
      if (!ID_PATTERN.test(windowId)) return badId("window");

      const target = sessionNameFor(db, windowId);
      if (!target) return json({ error: "unknown window" }, 404);

      if (Number(req.headers.get("content-length") ?? 0) > MAX_PUBKEY_BYTES) {
        return json({ error: "public key too large" }, 413);
      }

      try {
        const publicKey = await req.text();
        if (publicKey.length > MAX_PUBKEY_BYTES)
          throw new Error("public key too large");

        // Read from the window row, never from the request: the browser asks
        // for a window, and the server decides what that window runs.
        const profile = target.profileId
          ? getProfile(db, target.profileId)
          : undefined;

        // A profile's `--mcp-config` paths are only as good as the files behind
        // them, and those are regenerated from the box's config. Doing it here
        // means a server edited with `claude mcp add` takes effect on the next
        // window rather than whenever the editor was last opened.
        if (profile?.harness === "claude") {
          await refreshMcpMirrors(db, config.stateDir).catch((err: unknown) => {
            log.warn(`could not refresh mcp configs: ${describeError(err)}`);
          });
        }

        const forceCommand = windowCommand(
          target.session,
          target.cwd,
          config,
          profile,
          { resume: takeResume(db, windowId) },
        );
        const cert = await ca.signUserCert({
          publicKey,
          principal: config.user,
          identity: `vibe-os/${target.session}`,
          forceCommand,
          ttlSeconds: config.certTtlSeconds,
        });

        log.info(
          `issued certificate for ${target.session} in ${target.cwd}${profile ? ` as ${profile.name}` : ""}`,
        );

        // sshterm compares this header for exact equality against "text/plain";
        // a "; charset=utf-8" suffix makes it reject the certificate.
        return new Response(cert, {
          status: 200,
          headers: {
            "content-type": "text/plain",
            "cache-control": "no-store",
          },
        });
      } catch (err) {
        const message = describeError(err);
        log.warn(`certificate request rejected: ${message}`);
        return json({ error: message }, 400);
      }
    }

    // ── desktop preferences ──────────────────────────────────────────────────
    if (p === "/api/desktop") {
      if (req.method === "GET") return json(await wallpapers.prefs());
      if (req.method === "PUT") {
        try {
          const body = (await req.json()) as DesktopPrefs;
          return json(await wallpapers.setPrefs(body));
        } catch (err) {
          return json({ error: describeError(err) }, 400);
        }
      }
      return methodNotAllowed();
    }

    // ── wallpapers ───────────────────────────────────────────────────────────
    if (p === "/api/wallpapers") {
      if (req.method === "GET") return json(await wallpapers.list());
      if (req.method === "POST") {
        if (
          Number(req.headers.get("content-length") ?? 0) > MAX_WALLPAPER_BYTES
        ) {
          return json({ error: "image too large" }, 413);
        }
        try {
          const name = url.searchParams.get("name") ?? "wallpaper";
          const bytes = new Uint8Array(await req.arrayBuffer());
          return json(await wallpapers.save(bytes, name), 201);
        } catch (err) {
          return json({ error: describeError(err) }, 400);
        }
      }
      return methodNotAllowed();
    }

    if (p.startsWith("/api/wallpapers/")) {
      const id = p.slice("/api/wallpapers/".length);
      if (req.method === "GET") {
        const found = await wallpapers.read(id);
        if (!found) return json({ error: "not found" }, 404);
        return new Response(found.file, {
          headers: {
            "content-type": found.mime,
            "cache-control": IMMUTABLE_CACHE_CONTROL,
            // Defence in depth: even if a hostile file slipped past the magic
            // byte check, the browser must not be talked into running it.
            "content-security-policy": "default-src 'none'; sandbox",
            "x-content-type-options": "nosniff",
          },
        });
      }
      if (req.method === "DELETE") {
        return (await wallpapers.remove(id))
          ? json({ ok: true })
          : json({ error: "not found" }, 404);
      }
      return methodNotAllowed();
    }

    return json({ error: "not found" }, 404);
  };
}
