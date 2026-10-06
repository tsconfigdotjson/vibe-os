import os from "node:os";
import pkg from "../package.json" with { type: "json" };
import type { ClientConfig, MemoryReport } from "../shared/wire.ts";
import {
  attachInfo,
  killSession,
  publicHost,
  reapStaleHandoffs,
  setHandoff,
} from "./attach.ts";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import { ID_PATTERN } from "./db.ts";
import { discoverClaude, discoverCursor, discoverHermes } from "./harness.ts";
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

export interface ApiDeps {
  config: Config;
  ca: SshCa;
  hostKey: string | null;
  wallpapers: WallpaperStore;
  db: Db;
}

export function createApi(deps: ApiDeps) {
  const { ca, config, db, hostKey, wallpapers } = deps;

  return async function handleApi(
    req: Request,
    url: URL,
  ): Promise<Response | null> {
    const p = url.pathname;
    if (!p.startsWith("/api/")) return null;

    if (p === "/api/health") return json({ ok: true });

    // What the installed Claude CLI accepts, so the editor can offer it as
    // dropdowns rather than asking people to remember flag spellings.
    if (p === "/api/harness/claude" && req.method === "GET") {
      return json(await discoverClaude());
    }

    // The same question for Hermes, which answers a narrower version of it:
    // configured providers, its own defaults, and where its browser tools land.
    if (p === "/api/harness/hermes" && req.method === "GET") {
      return json(await discoverHermes());
    }

    // And for Cursor: the account's model list, and whether anyone is logged in.
    if (p === "/api/harness/cursor" && req.method === "GET") {
      return json(await discoverCursor());
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
          const body = await readJson<{ name?: string }>(req);
          const created = await createWorkspace(
            db,
            config.workspace,
            projectId,
            body.name,
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
        const body = await readJson<{ profileId?: unknown; force?: unknown }>(
          req,
        );
        let profileId: string | null = null;
        if (typeof body.profileId === "string" && body.profileId !== "") {
          const profile = getProfile(db, body.profileId);
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
        return json(createWindow(db, workspaceId, profileId), 201);
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
