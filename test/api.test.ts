import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type ApiDeps, createApi } from "../server/api.ts";
import type { Config } from "../server/config.ts";
import { newId, openDb, projects, windows, workspaces } from "../server/db.ts";
import type { SshCa } from "../server/ssh-ca.ts";
import { WallpaperStore } from "../server/wallpapers.ts";

/**
 * The routing table's behaviour, pinned.
 *
 * `handleApi` dispatches fourteen routes by hand, and the id-validation, the
 * 405 and the body parsing are written out at nearly every one of them. These
 * exist so that collapsing that repetition is a refactor with a safety net
 * rather than a rewrite you hope is equivalent — every assertion here describes
 * behaviour that predates the change.
 */
let handle: (req: Request, url: URL) => Promise<Response | null>;
let ids: { project: string; workspace: string; window: string };

async function build() {
  const dir = await mkdtemp(path.join(tmpdir(), "vibe-os-api-"));
  const d = openDb(dir);
  const now = Date.now();
  ids = { project: newId(), workspace: newId(), window: newId() };

  d.insert(projects)
    .values({
      id: ids.project,
      name: "demo",
      path: "/tmp/demo",
      branch: "main",
      remote: null,
      createdAt: now,
    })
    .run();
  d.insert(workspaces)
    .values({
      id: ids.workspace,
      projectId: ids.project,
      name: "brisk-copper-vole",
      branch: "brisk-copper-vole",
      path: "/tmp/demo/wt",
      createdAt: now,
      lastOpenedAt: now,
    })
    .run();
  d.insert(windows)
    .values({
      id: ids.window,
      workspaceId: ids.workspace,
      idx: 1,
      col: 0,
      row: 0,
      colSpan: 11,
      rowSpan: 8,
      z: 1,
      minimized: 0,
      profileId: null,
      promptDone: 0,
      createdAt: now,
    })
    .run();

  const config = {
    user: "vibe",
    workspace: "/tmp/demo",
    sessions: false,
    memory: { high: null, max: null, swapMax: null },
    token: null,
    themeColor: "#1c2128",
    stateDir: dir,
  } as unknown as Config;

  const deps: ApiDeps = {
    config,
    ca: {} as SshCa,
    hostKey: null,
    wallpapers: new WallpaperStore(dir),
    db: d,
  };
  return createApi(deps);
}

/** Every /api/ route must answer; a null means dispatch did not match it. */
async function answered(res: Promise<Response | null>): Promise<Response> {
  const r = await res;
  if (!r) throw new Error("handleApi returned null — the route did not match");
  return r;
}

/** The parsed body of a response that must exist. */
const bodyOf = async <T>(res: Promise<Response | null>): Promise<T> =>
  (await (await answered(res)).json()) as T;

const call = (method: string, p: string, body?: unknown) =>
  handle(
    new Request(`http://x${p}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    new URL(`http://x${p}`),
  );

beforeEach(async () => {
  handle = await build();
});

describe("dispatch", () => {
  test("anything outside /api/ is not ours", async () => {
    expect(await call("GET", "/")).toBeNull();
    expect(await call("GET", "/assets/app.js")).toBeNull();
  });

  test("an unknown /api/ path falls through to a 404", async () => {
    const res = await call("GET", "/api/nope");
    expect(res?.status).toBe(404);
  });

  test("health needs no method check", async () => {
    for (const m of ["GET", "POST", "PUT"]) {
      expect((await call(m, "/api/health"))?.status).toBe(200);
    }
  });

  test("every JSON response carries no-store", async () => {
    for (const p of ["/api/health", "/api/config", "/api/projects"]) {
      const res = await call("GET", p);
      expect(res?.headers.get("cache-control")).toBe("no-store");
    }
  });
});

describe("method handling", () => {
  const wrongMethod: [string, string][] = [
    ["DELETE", "/api/config"],
    ["DELETE", "/api/projects"],
    ["GET", "/api/projects/scan"],
  ];

  for (const [method, p] of wrongMethod) {
    test(`${method} ${p} is not allowed`, async () => {
      const res = await call(method, p);
      expect(res?.status).toBeGreaterThanOrEqual(400);
    });
  }

  test("a bad method on a matched id route says so", async () => {
    const res = await call("PUT", `/api/profiles/${newId()}`);
    expect(res?.status).toBe(405);
    expect(await res?.json()).toEqual({ error: "method not allowed" });
  });
});

describe("id validation", () => {
  const routes = (id: string) => [
    `/api/projects/${id}/mcp`,
    `/api/projects/${id}/workspaces`,
    `/api/projects/${id}/profiles`,
    `/api/workspaces/${id}/windows`,
    `/api/workspaces/${id}/memory`,
  ];

  test("a malformed id is rejected before anything is looked up", async () => {
    for (const p of routes("bad!id")) {
      const res = await answered(call("GET", p));
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(
        /invalid .* id/,
      );
    }
  });

  test("an over-long id is rejected", async () => {
    for (const p of routes("x".repeat(65))) {
      expect((await call("GET", p))?.status).toBe(400);
    }
  });

  /**
   * A well-formed id is a different thing from a known one. Listing the
   * children of a project that does not exist answers with an empty list
   * rather than an error — the distinction that matters to the client is
   * "your id was malformed" (400) versus "there is nothing there" (200, []).
   */
  test("a well-formed but unknown id lists nothing, and does not error", async () => {
    const res = await call("GET", `/api/projects/${newId()}/workspaces`);
    expect(res?.status).toBe(200);
    expect(await res?.json()).toEqual([]);
  });
});

describe("reads", () => {
  test("config carries the fields the browser boots from", async () => {
    const body = await bodyOf<Record<string, unknown>>(
      call("GET", "/api/config"),
    );
    for (const key of [
      "version",
      "hostname",
      "user",
      "workspaceRoot",
      "sessions",
      "authRequired",
      "endpoint",
      "certificateEndpoint",
      "maxWallpaperBytes",
      "themeColor",
      "palette",
      "memory",
    ]) {
      expect(body).toHaveProperty(key);
    }
  });

  test("projects, workspaces and windows come back", async () => {
    const list = await bodyOf<{ id: string }[]>(call("GET", "/api/projects"));
    expect(list.map((p) => p.id)).toContain(ids.project);

    const ws = await bodyOf<{ id: string }[]>(
      call("GET", `/api/projects/${ids.project}/workspaces`),
    );
    expect(ws.map((w) => w.id)).toContain(ids.workspace);

    const wins = await bodyOf<{ id: string }[]>(
      call("GET", `/api/workspaces/${ids.workspace}/windows`),
    );
    expect(wins.map((w) => w.id)).toContain(ids.window);
  });

  test("the memory report answers in its shape", async () => {
    // Whatever the platform: no /proc gives a null box and no windows, a Linux
    // runner gives real numbers. A window with no session is never listed.
    const report = await bodyOf<{
      box: unknown;
      warning: unknown;
      windows: Record<string, unknown>;
    }>(call("GET", `/api/workspaces/${ids.workspace}/memory`));
    expect(report).toHaveProperty("box");
    expect(report).toHaveProperty("warning");
    expect(report.windows).toEqual({});
  });
});

describe("writes", () => {
  test("a profile round-trips through create and patch", async () => {
    const created = await bodyOf<{ id: string; args: string[] }>(
      call("POST", `/api/projects/${ids.project}/profiles`, {
        name: "Reviewer",
        color: "cyan",
        harness: "claude",
        args: "--append-system-prompt 'don''t guess'",
      }),
    );
    expect(created.args[0]).toBe("--append-system-prompt");

    const patched = await bodyOf<{ position: number }>(
      call("PATCH", `/api/profiles/${created.id}`, { position: 3 }),
    );
    expect(patched.position).toBe(3);
  });

  test("a rejected profile reports why", async () => {
    const res = await answered(
      call("POST", `/api/projects/${ids.project}/profiles`, { name: "" }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "a profile needs a name",
    );
  });

  test("a body not labelled JSON is treated as no body", async () => {
    // text/plain is what a page on another site can POST without a preflight.
    const p = `/api/projects/${ids.project}/profiles`;
    const res = await answered(
      handle(
        new Request(`http://x${p}`, {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body: JSON.stringify({ name: "Planted", harness: "custom" }),
        }),
        new URL(`http://x${p}`),
      ),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "a profile needs a name",
    );
  });

  test("a malformed body is a 400, not a crash", async () => {
    const res = await handle(
      new Request(`http://x/api/projects/${ids.project}/profiles`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      }),
      new URL(`http://x/api/projects/${ids.project}/profiles`),
    );
    expect(res?.status).toBeGreaterThanOrEqual(400);
  });

  test("bringing a window back records the answer", async () => {
    const row = await bodyOf<{ restore: string | null }>(
      call("POST", `/api/windows/${ids.window}/restore`, { resume: true }),
    );
    expect(row.restore).toBe("resume");

    const bad = await answered(
      call("POST", `/api/windows/${ids.window}/restore`, { resume: "yes" }),
    );
    expect(bad.status).toBe(400);

    const missing = await answered(
      call("POST", `/api/windows/${newId()}/restore`, { resume: false }),
    );
    expect(missing.status).toBe(404);
  });

  test("window geometry is clamped server-side", async () => {
    const res = await bodyOf<{ col: number; colSpan: number }>(
      call("PATCH", `/api/windows/${ids.window}`, {
        col: 999,
        row: 999,
        colSpan: 999,
        rowSpan: 999,
      }),
    );
    expect(res.col + res.colSpan).toBeLessThanOrEqual(24);
  });

  test("desktop prefs are sanitised on the way in and out", async () => {
    const put = await bodyOf<{ fit: string; dim: number }>(
      call("PUT", "/api/desktop", {
        wallpaper: null,
        fit: "nonsense",
        dim: 99,
      }),
    );
    expect(put.fit).toBe("cover");
    expect(put.dim).toBe(0.9);

    const get = await bodyOf<{ dim: number }>(call("GET", "/api/desktop"));
    expect(get.dim).toBe(0.9);
  });
});
