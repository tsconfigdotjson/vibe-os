import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { createApi } from "../server/api.ts";
import { killSession } from "../server/attach.ts";
import type { Config } from "../server/config.ts";
import {
  type Db,
  newId,
  openDb,
  projects,
  windows,
  workspaces,
} from "../server/db.ts";
import type { Profile } from "../server/profiles.ts";
import { Screens } from "../server/screens.ts";
import { windowCommand } from "../server/session.ts";
import type { SshCa } from "../server/ssh-ca.ts";
import { WallpaperStore } from "../server/wallpapers.ts";
import type { WaitResult, WindowEvent, WindowSummary } from "../shared/wire.ts";

/**
 * Waiting, turns, cursors and events, against real dtach sessions.
 *
 * Nothing here logs in over SSH: the sessions are started directly, and the API
 * finds them running, which is all `send` with keys and the reads need.
 */
const hasDtach =
  spawnSync("sh", ["-c", "command -v dtach"]).status === 0 &&
  process.platform !== "win32";

const WORKSPACE = "brisk-copper-vole";

/**
 * Reads one key at a time with the terminal raw, as a harness does, and
 * answers each 2.5 seconds later: long enough to look idle in between.
 */
const ANSWERS =
  "stty raw -echo; printf 'ready\\r\\n'; while :; do c=$(dd bs=1 count=1 2>/dev/null); sleep 2.5; printf 'got %s\\r\\n' \"$c\"; done";
/** Never stops drawing. */
const BUSY = "while :; do printf .; sleep 0.2; done";

describe.skipIf(!hasDtach)("waiting on windows", () => {
  let dir = "";
  let db: Db;
  let config: Config;
  let screens: Screens;
  let handle: (req: Request, url: URL) => Promise<Response | null>;
  const ids = { project: newId(), workspace: newId(), one: "", two: "" };

  const startSession = (idx: number, script: string) => {
    const profile = {
      harness: "custom",
      command: "sh",
      args: ["-c", script],
    } as unknown as Profile;
    const cmd = windowCommand(
      `vibe-${WORKSPACE}-${idx}`,
      dir,
      config,
      profile,
      {
        detached: true,
      },
    ) as string;
    expect(spawnSync("/bin/sh", ["-c", cmd]).status).toBe(0);
  };

  const addWindow = (idx: number, label: string | null) => {
    const id = newId();
    db.insert(windows)
      .values({
        id,
        workspaceId: ids.workspace,
        idx,
        col: 0,
        row: 0,
        colSpan: 11,
        rowSpan: 8,
        z: idx,
        minimized: 0,
        profileId: null,
        promptDone: 0,
        createdAt: Date.now(),
        label,
      })
      .run();
    return id;
  };

  const call = (
    method: string,
    p: string,
    body?: unknown,
    signal?: AbortSignal,
  ) =>
    handle(
      new Request(`http://x${p}`, {
        method,
        headers:
          body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      }),
      new URL(`http://x${p}`),
    );

  const bodyOf = async <T>(res: Promise<Response | null>) => {
    const r = await res;
    if (!r) throw new Error("no route");
    return { status: r.status, body: (await r.json()) as T };
  };

  beforeAll(async () => {
    // Under /tmp: a unix socket path has to fit in about a hundred bytes.
    dir = await mkdtemp("/tmp/vos-");
    db = openDb(await mkdtemp(path.join(tmpdir(), "vibe-os-wait-")));
    const now = Date.now();
    db.insert(projects)
      .values({
        id: ids.project,
        name: "demo",
        path: dir,
        branch: "main",
        remote: null,
        createdAt: now,
      })
      .run();
    db.insert(workspaces)
      .values({
        id: ids.workspace,
        projectId: ids.project,
        name: WORKSPACE,
        branch: WORKSPACE,
        path: dir,
        createdAt: now,
        lastOpenedAt: now,
      })
      .run();
    ids.one = addWindow(1, "triage");
    ids.two = addWindow(2, null);
    config = {
      user: "vibe",
      workspace: dir,
      sessions: true,
      memory: { high: null, max: null, swapMax: null },
      token: null,
      themeColor: "#1c2128",
      stateDir: dir,
    } as unknown as Config;
    startSession(1, ANSWERS);
    screens = new Screens(config);
    handle = createApi({
      config,
      ca: {} as SshCa,
      hostKey: null,
      wallpapers: new WallpaperStore(dir),
      db,
      screens,
    });
    await screens.watch(`vibe-${WORKSPACE}-1`, { fresh: true });
    expect(await screens.settle(`vibe-${WORKSPACE}-1`, 10_000)).toBe("idle");
  }, 20_000);

  afterEach(() => {
    expect(screens.subscribers).toBe(0);
  });

  afterAll(async () => {
    screens?.stop();
    for (const idx of [1, 2])
      await killSession(config, `vibe-${WORKSPACE}-${idx}`).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });

  test("returns at once when the window has already settled", async () => {
    const { status, body } = await bodyOf<WaitResult>(
      call("GET", `/api/windows/${ids.one}/wait?timeout=5`),
    );
    expect(status).toBe(200);
    expect(body.reached).toBe(true);
    expect(body.state).toBe("idle");
    expect(body.waitedMs).toBeLessThan(1_000);
    expect(body.window.ref).toBe(`${WORKSPACE}-1`);
  });

  test("a timeout is a 200 with reached false", async () => {
    const { status, body } = await bodyOf<WaitResult>(
      call("GET", `/api/windows/${ids.one}/wait?until=question&timeout=1`),
    );
    expect(status).toBe(200);
    expect(body.reached).toBe(false);
    expect(body.state).toBe("idle");
    expect(body.waitedMs).toBeGreaterThanOrEqual(1_000);
  });

  test("checks its query", async () => {
    for (const q of ["until=soon", "timeout=0", "timeout=241", "lines=-1"]) {
      const { status } = await bodyOf(
        call("GET", `/api/windows/${ids.one}/wait?${q}`),
      );
      expect(status).toBe(400);
    }
    const { status } = await bodyOf(
      call("GET", `/api/windows/${newId()}/wait`),
    );
    expect(status).toBe(404);
  });

  test("with turn, the idle before the answer does not count", async () => {
    const sent = await bodyOf<{ delivered: boolean; window: WindowSummary }>(
      call("POST", `/api/windows/${ids.one}/send`, { keys: ["x"] }),
    );
    expect(sent.body.delivered).toBe(true);
    expect(sent.body.window.turn).toBe("pending");
    expect(sent.body.window.lastSendAt).not.toBeNull();

    // Without turn, the quiet before the answer looks finished.
    const early = await bodyOf<WaitResult>(
      call("GET", `/api/windows/${ids.one}/wait?timeout=5`),
    );
    expect(early.body.reached).toBe(true);
    expect(early.body.waitedMs).toBeLessThan(1_000);

    const done = await bodyOf<WaitResult>(
      call("GET", `/api/windows/${ids.one}/wait?turn=1&timeout=15&lines=5`),
    );
    expect(done.body.reached).toBe(true);
    expect(done.body.waitedMs).toBeGreaterThan(1_500);
    expect(done.body.text).toContain("got x");
    expect(done.body.window.turn).toBe("done");

    const list = await bodyOf<WindowSummary[]>(call("GET", "/api/windows"));
    expect(list.body.find((w) => w.id === ids.one)?.turn).toBe("done");
  }, 20_000);

  test("several windows: the first to settle wins", async () => {
    startSession(2, BUSY);
    try {
      const { body } = await bodyOf<WaitResult>(
        call(
          "GET",
          `/api/windows/wait?refs=${WORKSPACE}-2,${WORKSPACE}-1&timeout=10`,
        ),
      );
      expect(body.reached).toBe(true);
      expect(body.ref).toBe(`${WORKSPACE}-1`);
      expect(body.windows?.map((w) => w.ref)).toEqual([
        `${WORKSPACE}-2`,
        `${WORKSPACE}-1`,
      ]);
      expect(body.windows?.[0].state).toBe("busy");

      // Only the busy one: time runs out.
      const busy = await bodyOf<WaitResult>(
        call("GET", `/api/windows/wait?refs=${WORKSPACE}-2&timeout=1`),
      );
      expect(busy.body.reached).toBe(false);
      expect(busy.body.state).toBe("busy");
    } finally {
      await killSession(config, `vibe-${WORKSPACE}-2`);
    }
  }, 20_000);

  test("a window that is not running answers at once", async () => {
    await Bun.sleep(300);
    const { body } = await bodyOf<WaitResult>(
      call("GET", `/api/windows/${ids.two}/wait?timeout=30`),
    );
    expect(body.reached).toBe(false);
    expect(body.state).toBeNull();
    expect(body.window.live).toBe(false);
  });

  test("an aborted wait leaves no listener behind", async () => {
    const abort = new AbortController();
    const pending = call(
      "GET",
      `/api/windows/${ids.one}/wait?until=question&timeout=30`,
      undefined,
      abort.signal,
    );
    await Bun.sleep(100);
    expect(screens.subscribers).toBe(1);
    abort.abort();
    const res = await pending;
    expect(res?.status).toBe(200);
    expect(screens.subscribers).toBe(0);
  });

  test("output hands out a cursor, and after reads on from it", async () => {
    const first = await bodyOf<{ text: string; cursor: number }>(
      call("GET", `/api/windows/${ids.one}/output`),
    );
    expect(typeof first.body.cursor).toBe("number");
    const next = await bodyOf<{
      text: string;
      screen: string;
      cursor: number;
      truncated: boolean;
    }>(
      call("GET", `/api/windows/${ids.one}/output?after=${first.body.cursor}`),
    );
    expect(next.body.text).toBe("");
    expect(next.body.screen).toContain("ready");
    expect(next.body.truncated).toBe(false);
    const bad = await bodyOf(
      call("GET", `/api/windows/${ids.one}/output?after=x`),
    );
    expect(bad.status).toBe(400);
  });

  test("the event stream sends state changes", async () => {
    const abort = new AbortController();
    const res = await call(
      "GET",
      `/api/events?refs=${WORKSPACE}-1`,
      undefined,
      abort.signal,
    );
    expect(res?.headers.get("content-type")).toBe("text/event-stream");
    const reader = (
      res as Response
    ).body?.getReader() as ReadableStreamDefaultReader<Uint8Array>;
    await call("POST", `/api/windows/${ids.one}/send`, { keys: ["y"] });
    const seen: WindowEvent[] = [];
    const decoder = new TextDecoder();
    let text = "";
    const deadline = Date.now() + 10_000;
    while (
      !seen.some((e) => e.type === "window.state" && e.to === "busy") &&
      Date.now() < deadline
    ) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
      for (const line of text.split("\n"))
        if (line.startsWith("data: ")) seen.push(JSON.parse(line.slice(6)));
      text = text.slice(text.lastIndexOf("\n") + 1);
    }
    abort.abort();
    await reader.cancel().catch(() => {});
    expect(seen.map((e) => e.type)).toContain("window.turn");
    const state = seen.find((e) => e.type === "window.state");
    expect(state).toMatchObject({
      ref: `${WORKSPACE}-1`,
      label: "triage",
      project: "demo",
      to: "busy",
    });
    // Let the answer land, so the next test starts from idle.
    await screens.settle(`vibe-${WORKSPACE}-1`, 10_000);
    await Bun.sleep(3_000);
    await screens.settle(`vibe-${WORKSPACE}-1`, 10_000);
  }, 30_000);

  test("reuse returns the open window and does not send again", async () => {
    const before = await bodyOf<WindowSummary[]>(call("GET", "/api/windows"));
    const { status, body } = await bodyOf<{
      id: string;
      reused: boolean;
      delivered?: boolean;
    }>(
      call("POST", `/api/workspaces/${ids.workspace}/windows`, {
        label: "triage",
        reuse: true,
        prompt: "do it again",
        submit: true,
      }),
    );
    expect(status).toBe(200);
    expect(body.reused).toBe(true);
    expect(body.id).toBe(ids.one);
    expect(body.delivered).toBeUndefined();
    const after = await bodyOf<WindowSummary[]>(call("GET", "/api/windows"));
    expect(after.body).toHaveLength(before.body.length);

    const unlabelled = await bodyOf<{ error: string }>(
      call("POST", `/api/workspaces/${ids.workspace}/windows`, { reuse: true }),
    );
    expect(unlabelled.status).toBe(400);
  });

  test("a plain terminal has no transcript to read", async () => {
    const { status, body } = await bodyOf<{ error: string }>(
      call("GET", `/api/windows/${ids.one}/messages`),
    );
    expect(status).toBe(409);
    expect(body.error).toContain("read its output instead");
  });

  test("closing a window says so on the event stream", async () => {
    const id = addWindow(3, null);
    const abort = new AbortController();
    const res = await call("GET", "/api/events", undefined, abort.signal);
    const reader = (
      res as Response
    ).body?.getReader() as ReadableStreamDefaultReader<Uint8Array>;
    await call("DELETE", `/api/windows/${id}`);
    let text = "";
    const decoder = new TextDecoder();
    while (!text.includes("window.closed")) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    abort.abort();
    await reader.cancel().catch(() => {});
    expect(text).toContain(`"ref":"${WORKSPACE}-3"`);
    expect(
      db.select().from(windows).where(eq(windows.id, id)).all(),
    ).toHaveLength(0);
  });
});
