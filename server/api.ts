import os from "node:os";
import pkg from "../package.json" with { type: "json" };
import type {
  ClientConfig,
  MemoryReport,
  SendInput,
  WindowEvent,
} from "../shared/wire.ts";
import {
  attachInfo,
  publicHost,
  reapStaleHandoffs,
  sessionName,
  setHandoff,
} from "./attach.ts";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import { ID_PATTERN } from "./db.ts";
import { discover, specs } from "./harness.ts";
import { isAsleep, noteLogin } from "./hibernate.ts";
import {
  badId,
  IMMUTABLE_CACHE_CONTROL,
  json,
  methodNotAllowed,
  readJson,
} from "./http.ts";
import { describeError, log } from "./log.ts";
import { discoverMcp } from "./mcp.ts";
import { capacityWarning, readBoxMemory, sessionMemory } from "./memory.ts";
import {
  createOps,
  DEFAULT_OUTPUT_LINES,
  MAX_OUTPUT_LINES,
  MAX_WAIT_S,
  mcpScan,
  NO_SESSIONS,
  OpError,
  type OpenInput,
  type Ops,
  refreshMcpMirrors,
  UNTIL,
  type Until,
} from "./ops.ts";
import {
  createProfile,
  deleteProfile,
  getProfile,
  listProfiles,
  PALETTE,
  updateProfile,
} from "./profiles.ts";
import {
  getWorkspace,
  listProjects,
  listWorkspaces,
  reconcileWorkspaces,
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
  getWindow,
  listWindows,
  restoreWindow,
  sessionNameFor,
  takeResume,
  updateWindow,
} from "./windows.ts";

/** How often an event stream says it is still there. */
const HEARTBEAT_MS = 15_000;
/** Default and most messages a transcript read returns. */
const DEFAULT_MESSAGES = 20;
const MAX_MESSAGES = 500;
/** Default wait, in seconds. */
const DEFAULT_WAIT_S = 60;
/** Most windows one wait can watch. */
const MAX_WAIT_WINDOWS = 32;

/** An `OpError` as the JSON error response it stands for. */
function failed(err: unknown): Response {
  if (err instanceof OpError)
    return json({ error: err.message, ...err.extra }, err.status);
  throw err;
}

/** A whole number query parameter in a range, or a 400 saying so. */
function intParam(
  url: URL,
  name: string,
  min: number,
  max: number,
  fallback: number,
): number {
  const given = url.searchParams.get(name);
  const n = given === null ? fallback : Number(given);
  if (!Number.isInteger(n) || n < min || n > max)
    throw new OpError(
      `${name} must be a whole number from ${min} to ${max}`,
      400,
    );
  return n;
}

/** A yes/no query parameter: `1`, `true`, `0`, `false`, or absent. */
function boolParam(url: URL, name: string): boolean {
  const given = url.searchParams.get(name);
  if (given === null || given === "0" || given === "false") return false;
  if (given === "" || given === "1" || given === "true") return true;
  throw new OpError(`${name} must be 1 or 0`, 400);
}

/** The query of a wait route, read and checked. */
function waitQuery(url: URL, signal: AbortSignal) {
  const until = (url.searchParams.get("until") ?? "settled") as Until;
  if (!UNTIL.includes(until))
    throw new OpError(`until must be one of ${UNTIL.join(", ")}`, 400);
  return {
    until,
    timeoutMs: intParam(url, "timeout", 1, MAX_WAIT_S, DEFAULT_WAIT_S) * 1000,
    turn: boolParam(url, "turn"),
    lines: intParam(url, "lines", 0, MAX_OUTPUT_LINES, 0),
    signal,
  };
}

/**
 * `GET /api/events`: window events as a server-sent event stream.
 *
 * Each event is one `data:` line of JSON, with its type inside it rather than
 * in an `event:` field, so that `onmessage` and a line reader both see all of
 * them. A comment goes out every 15 seconds so that proxies, and Bun's own idle
 * timeout, see the stream is alive.
 */
function eventStream(
  ops: Ops,
  req: Request,
  keep: (e: WindowEvent) => boolean,
): Response {
  const encoder = new TextEncoder();
  let stop = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (text: string) => {
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          stop();
        }
      };
      const off = ops.subscribe((e) => {
        if (keep(e)) write(`data: ${JSON.stringify(e)}\n\n`);
      });
      const beat = setInterval(() => write(": ping\n\n"), HEARTBEAT_MS);
      stop = () => {
        off();
        clearInterval(beat);
        req.signal.removeEventListener("abort", stop);
        try {
          controller.close();
        } catch {
          // Already closed by the other side.
        }
      };
      req.signal.addEventListener("abort", stop);
      write(": vibe-os events\n\n");
    },
    cancel() {
      stop();
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    },
  });
}

export interface ApiDeps {
  config: Config;
  ca: SshCa;
  hostKey: string | null;
  wallpapers: WallpaperStore;
  db: Db;
  /** Every running window's screen. One that is never started if absent. */
  screens?: Screens;
  /** The operations the API wraps. Built from the rest if absent. */
  ops?: Ops;
}

export function createApi(deps: ApiDeps) {
  const { ca, config, db, hostKey, wallpapers } = deps;
  const screens = deps.screens ?? new Screens(config);
  const ops = deps.ops ?? createOps({ config, ca, hostKey, db, screens });

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

      if (req.method === "GET")
        return json(
          listWorkspaces(db, projectId).map((w) => ({
            ...w,
            // Hibernated windows, for the sidebar. A file check per window,
            // so cheap enough for a poll.
            asleep: listWindows(db, w.id).filter((win) =>
              isAsleep(config, sessionName(w.name, win.idx)),
            ).length,
          })),
        );

      if (req.method === "POST") {
        try {
          const body = await readJson<{ name?: unknown; from?: unknown }>(req);
          return json(await ops.newWorkspace(projectId, body), 201);
        } catch (err) {
          return failed(err);
        }
      }
      return methodNotAllowed();
    }

    if (p === "/api/workspaces" && req.method === "GET")
      return json(ops.workspaces());

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
        try {
          await ops.removeWorkspace(id);
          return json({ ok: true });
        } catch (err) {
          return failed(err);
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
        return json(
          listWindows(db, workspaceId).map((w) => ({
            ...w,
            asleep: isAsleep(config, sessionName(workspace.name, w.idx)),
          })),
        );
      }
      if (req.method === "POST") {
        try {
          const opened = await ops.open(
            workspaceId,
            await readJson<OpenInput>(req),
          );
          return json(opened.body, opened.status);
        } catch (err) {
          return failed(err);
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

    if (p === "/api/windows" && req.method === "GET")
      return json(await ops.windows(url.searchParams.get("label")));

    // Window events as they happen: state changes, turns, opens and closes.
    if (p === "/api/events" && req.method === "GET") {
      const refs = url.searchParams.get("refs");
      const wanted = refs
        ? new Set(refs.split(",").map((r) => r.trim().replace(/^vibe-/, "")))
        : null;
      const label = url.searchParams.get("label");
      return eventStream(
        ops,
        req,
        (e) =>
          (wanted === null || wanted.has(e.ref)) &&
          (label === null || e.label === label),
      );
    }

    // Blocks until one of several windows settles, or changes, or time is up.
    if (p === "/api/windows/wait" && req.method === "GET") {
      try {
        const refs = (url.searchParams.get("refs") ?? "")
          .split(",")
          .map((r) => r.trim())
          .filter(Boolean);
        if (refs.length === 0 || refs.length > MAX_WAIT_WINDOWS)
          throw new OpError(
            `refs must name 1 to ${MAX_WAIT_WINDOWS} windows, comma separated`,
            400,
          );
        const query = waitQuery(url, req.signal);
        return json(await ops.wait(refs.map(ops.target), query));
      } catch (err) {
        return failed(err);
      }
    }

    const waitMatch = /^\/api\/windows\/([^/]+)\/(wait|messages)$/.exec(p);
    if (waitMatch && req.method === "GET") {
      const id = decodeURIComponent(waitMatch[1]);
      if (!ID_PATTERN.test(id)) return badId("window");
      try {
        const target = ops.target(id);
        if (waitMatch[2] === "messages") {
          const last = intParam(url, "last", 1, MAX_MESSAGES, DEFAULT_MESSAGES);
          return json({ messages: await ops.messages(target, last) });
        }
        return json(await ops.wait([target], waitQuery(url, req.signal)));
      } catch (err) {
        return failed(err);
      }
    }

    // What a window shows, as plain text: the screen and the history above it.
    const outputMatch = /^\/api\/windows\/([^/]+)\/output$/.exec(p);
    if (outputMatch && req.method === "GET") {
      const id = decodeURIComponent(outputMatch[1]);
      if (!ID_PATTERN.test(id)) return badId("window");
      try {
        if (!config.sessions) throw new OpError(NO_SESSIONS, 409);
        const target = ops.target(id);
        if (target.windowId !== id)
          return json({ error: "unknown window" }, 404);
        const lines = intParam(
          url,
          "lines",
          1,
          MAX_OUTPUT_LINES,
          DEFAULT_OUTPUT_LINES,
        );
        const given = url.searchParams.get("after");
        const after = given === null ? undefined : Number(given);
        if (after !== undefined && (!Number.isInteger(after) || after < 0))
          throw new OpError("after must be a cursor from an earlier read", 400);
        return json(
          await ops.output(target, {
            lines: url.searchParams.has("lines") ? lines : undefined,
            after,
          }),
        );
      } catch (err) {
        return failed(err);
      }
    }

    // Starts a window's session with nothing attached, so it is running before
    // any browser opens it. Idempotent: a running session is left alone.
    const startMatch = /^\/api\/windows\/([^/]+)\/(start|send)$/.exec(p);
    if (startMatch && req.method === "POST") {
      const id = decodeURIComponent(startMatch[1]);
      if (!ID_PATTERN.test(id)) return badId("window");
      try {
        if (!config.sessions) throw new OpError(NO_SESSIONS, 409);
        const target = ops.target(id);
        if (target.windowId !== id)
          return json({ error: "unknown window" }, 404);
        const verb = startMatch[2] as "start" | "send";
        const body = verb === "send" ? await readJson<SendInput>(req) : {};
        return json(await ops.send(target, verb, body));
      } catch (err) {
        return failed(err);
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

      if (req.method === "DELETE")
        return (await ops.close(id))
          ? json({ ok: true })
          : json({ error: "unknown window" }, 404);
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
        noteLogin(target.session);
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
