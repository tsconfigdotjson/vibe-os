import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import type { McpHttpHandler } from "@modelcontextprotocol/server";
import type { AttachTarget } from "../server/attach.ts";
import { createGate } from "../server/auth.ts";
import { type Db, newId, openDb, projects, workspaces } from "../server/db.ts";
import { frontDoor } from "../server/front-door.ts";
import {
  clip,
  createMcpEndpoint,
  MAX_RESULT_CHARS,
  mcpRoute,
} from "../server/mcp-server.ts";
import { bridgeServer, connectUpstream } from "../server/mcp-stdio.ts";
import { OpError, type Ops, type WaitOptions } from "../server/ops.ts";
import { createProfile } from "../server/profiles.ts";
import type {
  WaitResult,
  WindowSummary,
  WorkspaceSummary,
} from "../shared/wire.ts";

/**
 * The MCP endpoint, driven the way a client drives it: the official client
 * over `handler.fetch`, in process. The session layer under it is a stub, so
 * these pin what the tools do with what ops returns, not what windows do.
 */

const target = (ref: string): AttachTarget => ({
  windowId: `${ref}-id`,
  ref,
  session: `vibe-${ref}`,
  cwd: "/w",
  profileId: null,
  workspace: ref.replace(/-\d+$/, ""),
  project: "api",
  role: "QA",
  label: null,
});

const summary = (ref: string, over: Partial<WindowSummary> = {}) =>
  ({
    id: `${ref}-id`,
    ref,
    session: `vibe-${ref}`,
    workspace: ref.replace(/-\d+$/, ""),
    project: "api",
    role: "QA",
    label: null,
    live: true,
    state: "idle",
    lastOutputAt: 1,
    lastSendAt: null,
    turn: null,
    ...over,
  }) satisfies WindowSummary;

/** What the stub ops was called with, for the assertions. */
let calls: { name: string; args: unknown[] }[];
let db: Db;
let projectId: string;

function stubOps(over: Partial<Ops> = {}): Ops {
  const log =
    (name: string, fn: (...args: never[]) => unknown) =>
    (...args: unknown[]) => {
      calls.push({ name, args });
      return (fn as (...a: unknown[]) => unknown)(...args);
    };
  const ws: WorkspaceSummary = {
    id: "ws-id",
    name: "quiet-amber-otter",
    branch: "quiet-amber-otter",
    path: "/w",
    projectId,
    project: "api",
    lastOpenedAt: 0,
  };
  const base = {
    target: (name: string) => {
      if (name.startsWith("nope"))
        throw new OpError(
          `no window called ${name}. List them with GET /api/windows`,
          404,
        );
      return target(name);
    },
    summary: (t: AttachTarget) => summary(t.ref),
    windows: async () => [
      summary("quiet-amber-otter-1"),
      summary("quiet-amber-otter-2", { state: "busy", turn: "working" }),
    ],
    workspaces: () => [ws],
    output: async () => ({
      text: "line one\nline two",
      state: "idle" as const,
      lastOutputAt: 1,
      cursor: 7,
    }),
    send: async (t: AttachTarget) => ({
      started: false,
      delivered: true,
      state: "idle" as const,
      window: summary(t.ref, { turn: "pending" }),
    }),
    open: async () => ({
      status: 201,
      body: {
        id: "new-id",
        started: true,
        delivered: true,
        state: "idle",
        window: summary("quiet-amber-otter-3"),
      },
    }),
    wait: async (targets: AttachTarget[], opts: WaitOptions) => {
      opts.onEvent?.({
        type: "window.turn",
        ref: targets[0].ref,
        label: null,
        workspace: null,
        project: null,
        at: Date.now(),
        turn: "working",
      });
      for (const to of ["busy", "idle"] as const)
        opts.onEvent?.({
          type: "window.state",
          ref: targets[0].ref,
          label: null,
          workspace: null,
          project: null,
          at: Date.now(),
          from: null,
          to,
        });
      await Bun.sleep(20);
      return {
        ref: targets[0].ref,
        state: "idle",
        reached: true,
        waitedMs: 1200,
        lastOutputAt: 1,
        window: summary(targets[0].ref),
        text: "⏺ done",
        cursor: 3,
      } satisfies WaitResult;
    },
    messages: async () => [
      { role: "user" as const, text: "fix it", at: 1 },
      { role: "tool" as const, text: "Bash(bun test)", at: 2 },
      { role: "assistant" as const, text: "Fixed.", at: 3 },
    ],
    close: async () => true,
    removeWorkspace: async () => {},
    newWorkspace: async () => ({
      id: "w2",
      name: "brave-jade-lynx",
      branch: "brave-jade-lynx",
      path: "/w2",
      base: "origin/main",
      warning: null,
    }),
    ...over,
  };
  return Object.fromEntries(
    Object.entries(base).map(([k, fn]) => [
      k,
      log(k, fn as (...args: never[]) => unknown),
    ]),
  ) as unknown as Ops;
}

/** What the client's transport hands its fetch, as one Request. */
const asRequest = (url: string | URL | Request, init?: RequestInit) =>
  url instanceof Request ? new Request(url, init) : new Request(`${url}`, init);

let handler: McpHttpHandler;
let client: Client;

async function connect(ops: Ops): Promise<Client> {
  handler = createMcpEndpoint({ ops, db });
  const transport = new StreamableHTTPClientTransport(
    new URL("http://test.local/mcp"),
    { fetch: (url, init) => handler.fetch(asRequest(url, init)) },
  );
  client = new Client(
    { name: "test", version: "1.0.0" },
    { versionNegotiation: { mode: "auto" } },
  );
  await client.connect(transport);
  return client;
}

const textOf = (r: Awaited<ReturnType<Client["callTool"]>>) =>
  (r.content as { type: string; text: string }[]).map((c) => c.text).join("\n");

beforeEach(async () => {
  calls = [];
  db = openDb(await mkdtemp(path.join(tmpdir(), "vibe-os-mcp-")));
  projectId = newId();
  db.insert(projects)
    .values({
      id: projectId,
      name: "api",
      path: "/w",
      branch: "main",
      remote: null,
      createdAt: 0,
    })
    .run();
  db.insert(workspaces)
    .values({
      id: "ws-id",
      projectId,
      name: "quiet-amber-otter",
      branch: "quiet-amber-otter",
      path: "/w",
      createdAt: 0,
      lastOpenedAt: 0,
    })
    .run();
  createProfile(db, projectId, {
    name: "QA",
    harness: "shell",
    prompt: "review {{ticket}} for {{owner}}",
  });
});

afterEach(async () => {
  await client?.close().catch(() => {});
  await handler?.close().catch(() => {});
});

describe("the gate in front of /mcp", () => {
  const endpoint = {
    fetch: async () => new Response("served"),
  } as unknown as McpHttpHandler;
  const door = frontDoor(
    { gate: createGate("secret"), token: true, hosts: new Set() },
    async (req, url) =>
      url.pathname === "/mcp" ? mcpRoute(endpoint)(req) : undefined,
  );
  const serve = async (req: Request) =>
    (await door(req, { secure: false })) as Response;

  test("no token is a 401 that says how to authenticate", async () => {
    const res = await serve(
      new Request("http://x/mcp", { method: "POST", body: "{}" }),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toStartWith("Bearer");
    expect(((await res.json()) as { error: string }).error).toContain("token");
  });

  test("a token in the query string counts for nothing", async () => {
    const res = await serve(
      new Request("http://x/mcp?token=secret", { method: "POST", body: "{}" }),
    );
    expect(res.status).toBe(401);
  });

  test("the bearer token and the desktop's cookie both get in", async () => {
    const bearer = await serve(
      new Request("http://x/mcp", {
        method: "POST",
        headers: { authorization: "Bearer secret" },
      }),
    );
    expect(await bearer.text()).toBe("served");
    const cookie = await serve(
      new Request("http://x/mcp", {
        method: "POST",
        headers: { cookie: "vibe_os_session=secret" },
      }),
    );
    expect(await cookie.text()).toBe("served");
  });
});

describe("tools", () => {
  test("are listed in a fixed order, every one prefixed", async () => {
    const { tools } = await (await connect(stubOps())).listTools();
    expect(tools.map((t) => t.name)).toEqual([
      "vibe_list_windows",
      "vibe_list_workspaces",
      "vibe_list_projects",
      "vibe_create_workspace",
      "vibe_open_window",
      "vibe_send",
      "vibe_read_output",
      "vibe_wait",
      "vibe_read_messages",
      "vibe_close_window",
      "vibe_delete_workspace",
    ]);
    for (const tool of tools) expect(tool.outputSchema).toBeDefined();
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect(byName.get("vibe_wait")?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get("vibe_close_window")?.annotations?.destructiveHint).toBe(
      true,
    );
    expect(byName.get("vibe_open_window")?.annotations?.idempotentHint).toBe(
      false,
    );
  });

  test("a 2025-era client is served too", async () => {
    handler = createMcpEndpoint({ ops: stubOps(), db });
    client = new Client({ name: "legacy", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL("http://test.local/mcp"), {
        fetch: (url, init) => handler.fetch(asRequest(url, init)),
      }),
    );
    expect(client.getProtocolEra()).toBe("legacy");
    const r = await client.callTool({
      name: "vibe_list_windows",
      arguments: {},
    });
    expect(textOf(r)).toContain("quiet-amber-otter-1");
    const progress: unknown[] = [];
    await client.callTool(
      { name: "vibe_wait", arguments: { windows: "quiet-amber-otter-1" } },
      { onprogress: (p) => progress.push(p) },
    );
    expect(progress).toHaveLength(3);
  });

  test("list_windows filters by state and names the turn", async () => {
    const c = await connect(stubOps());
    const r = await c.callTool({
      name: "vibe_list_windows",
      arguments: { state: "busy" },
    });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toBe(
      "quiet-amber-otter-2  busy  turn working  QA  api/quiet-amber-otter",
    );
    expect(
      (r.structuredContent as { windows: WindowSummary[] }).windows,
    ).toHaveLength(1);
  });

  test("list_projects carries each profile's blanks", async () => {
    const c = await connect(stubOps());
    const r = await c.callTool({ name: "vibe_list_projects", arguments: {} });
    expect(r.structuredContent).toMatchObject({
      projects: [
        {
          name: "api",
          profiles: [
            { name: "QA", harness: "shell", blanks: ["ticket", "owner"] },
          ],
        },
      ],
    });
  });

  test("create_workspace takes project/name", async () => {
    const c = await connect(stubOps());
    const r = await c.callTool({
      name: "vibe_create_workspace",
      arguments: { project: "api/brave-jade-lynx" },
    });
    expect(textOf(r)).toContain("created api/brave-jade-lynx");
    const made = calls.find((x) => x.name === "newWorkspace");
    expect(made?.args).toEqual([projectId, { name: "brave-jade-lynx" }]);
  });

  test("open_window resolves the profile by name and submits", async () => {
    const c = await connect(stubOps());
    const r = await c.callTool({
      name: "vibe_open_window",
      arguments: {
        workspace: "api/quiet-amber-otter",
        profile: "qa",
        blanks: { ticket: "#12", owner: "me" },
        label: "triage",
        reuse: true,
      },
    });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toContain("call vibe_wait");
    const [wsId, body] = (calls.find((x) => x.name === "open")?.args ?? []) as [
      string,
      Record<string, unknown>,
    ];
    expect(wsId).toBe("ws-id");
    expect(body).toMatchObject({
      label: "triage",
      reuse: true,
      submit: true,
      start: true,
      blanks: { ticket: "#12", owner: "me" },
    });
    expect(typeof body.profileId).toBe("string");
  });

  test("send presses keys, and defaults text to submitted", async () => {
    const c = await connect(stubOps());
    await c.callTool({
      name: "vibe_send",
      arguments: { window: "quiet-amber-otter-1", keys: ["2"] },
    });
    await c.callTool({
      name: "vibe_send",
      arguments: { window: "quiet-amber-otter-1", text: "go" },
    });
    const sends = calls.filter((x) => x.name === "send").map((x) => x.args[2]);
    expect(sends[0]).toMatchObject({ keys: ["2"] });
    expect(sends[1]).toMatchObject({ text: "go", submit: true });
  });

  test("read_output and read_messages return text and structure", async () => {
    const c = await connect(stubOps());
    const out = await c.callTool({
      name: "vibe_read_output",
      arguments: { window: "quiet-amber-otter-1" },
    });
    expect(textOf(out)).toContain("cursor 7");
    expect(textOf(out)).toContain("line two");
    expect(out.structuredContent).toMatchObject({ cursor: 7 });

    const msgs = await c.callTool({
      name: "vibe_read_messages",
      arguments: { window: "quiet-amber-otter-1", last: 3 },
    });
    expect(textOf(msgs)).toContain("assistant: Fixed.");
    expect(textOf(msgs)).toContain("→ Bash(bun test)");

    // Reading on from a cursor takes every new line unless told otherwise.
    await c.callTool({
      name: "vibe_read_output",
      arguments: { window: "quiet-amber-otter-1", after: 7 },
    });
    const reads = calls
      .filter((x) => x.name === "output")
      .map((x) => x.args[1]);
    expect(reads).toEqual([{ lines: 50 }, { lines: undefined, after: 7 }]);
  });

  test("close_window and delete_workspace", async () => {
    const c = await connect(stubOps());
    const closed = await c.callTool({
      name: "vibe_close_window",
      arguments: { window: "quiet-amber-otter-1" },
    });
    expect(closed.structuredContent).toEqual({ closed: "quiet-amber-otter-1" });
    const deleted = await c.callTool({
      name: "vibe_delete_workspace",
      arguments: { workspace: "quiet-amber-otter" },
    });
    expect(textOf(deleted)).toContain("branch is kept");
    expect(calls.find((x) => x.name === "removeWorkspace")?.args).toEqual([
      "ws-id",
    ]);
  });

  test("wait reports progress on every change when asked", async () => {
    const c = await connect(stubOps());
    const progress: unknown[] = [];
    const r = await c.callTool(
      {
        name: "vibe_wait",
        arguments: { windows: "quiet-amber-otter-1" },
      },
      { onprogress: (p) => progress.push(p) },
    );
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toContain("quiet-amber-otter-1 is idle");
    expect(textOf(r)).toContain("⏺ done");
    // Each message says the window's state and its turn, so an idle shell
    // still running a command does not read as finished.
    expect(progress).toEqual([
      expect.objectContaining({
        progress: 1,
        message: "quiet-amber-otter-1: idle, turn working",
      }),
      expect.objectContaining({
        progress: 2,
        message: "quiet-amber-otter-1: busy, turn working",
      }),
      expect.objectContaining({
        progress: 3,
        message: "quiet-amber-otter-1: idle, turn working",
      }),
    ]);
    const [, opts] = (calls.find((x) => x.name === "wait")?.args ?? []) as [
      unknown,
      WaitOptions,
    ];
    expect(opts).toMatchObject({
      until: "settled",
      timeoutMs: 120_000,
      turn: true,
      lines: 30,
    });
  });

  test("wait says when a background command is still running", async () => {
    const c = await connect(
      stubOps({
        wait: (async (targets: AttachTarget[]) => ({
          ref: targets[0].ref,
          state: "idle",
          reached: true,
          waitedMs: 10,
          lastOutputAt: 1,
          window: summary(targets[0].ref),
          background: true,
        })) as Ops["wait"],
      }),
    );
    const r = await c.callTool({
      name: "vibe_wait",
      arguments: { windows: "quiet-amber-otter-1" },
    });
    expect(textOf(r)).toContain("background: true");
    const [, opts] = (calls.find((x) => x.name === "wait")?.args ?? []) as [
      unknown,
      WaitOptions,
    ];
    expect(opts.background).toBe(false);
  });

  test("wait refuses a timeout past four minutes", async () => {
    const c = await connect(stubOps());
    const r = await c.callTool({
      name: "vibe_wait",
      arguments: { windows: ["quiet-amber-otter-1"], timeout: 600 },
    });
    expect(r.isError).toBe(true);
  });
});

describe("errors", () => {
  test("a question says how to answer it", async () => {
    const c = await connect(
      stubOps({
        send: (async (t: AttachTarget) => ({
          started: false,
          delivered: false,
          state: "question",
          reason: "the window is waiting on a question",
          window: summary(t.ref),
        })) as Ops["send"],
      }),
    );
    const r = await c.callTool({
      name: "vibe_send",
      arguments: { window: "quiet-amber-otter-1", text: "go" },
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("quiet-amber-otter-1 is waiting on a question");
    expect(textOf(r)).toContain("vibe_read_output");
    expect(textOf(r)).toContain("vibe_send keys");
  });

  test("short of memory says to force or close", async () => {
    const c = await connect(
      stubOps({
        open: (async () => {
          throw new OpError("the box has 300MB free", 409, { capacity: true });
        }) as Ops["open"],
      }),
    );
    const r = await c.callTool({
      name: "vibe_open_window",
      arguments: { workspace: "quiet-amber-otter", prompt: "hi" },
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("force: true");
    expect(textOf(r)).toContain("vibe_close_window");
  });

  test("an unknown window points at the list", async () => {
    const c = await connect(stubOps());
    const r = await c.callTool({
      name: "vibe_read_output",
      arguments: { window: "nope-1" },
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toBe(
      "no window called nope-1. vibe_list_windows lists the windows and their refs.",
    );
  });

  test("a window that is not running says how to start it", async () => {
    const c = await connect(
      stubOps({
        output: (async () => {
          throw new OpError("the window is not running", 409);
        }) as Ops["output"],
      }),
    );
    const r = await c.callTool({
      name: "vibe_read_output",
      arguments: { window: "quiet-amber-otter-1" },
    });
    expect(textOf(r)).toContain("vibe_send starts it");
  });
});

describe("clip", () => {
  test("keeps the end and says how much went", () => {
    const long = "x".repeat(MAX_RESULT_CHARS + 10);
    const out = clip(long);
    expect(out.startsWith("[10 earlier characters cut")).toBe(true);
    expect(out.endsWith("x".repeat(MAX_RESULT_CHARS))).toBe(true);
    expect(clip("short")).toBe("short");
  });
});

describe("the stdio bridge", () => {
  test("lists and calls the server's tools, progress included", async () => {
    handler = createMcpEndpoint({ ops: stubOps(), db });
    const upstream = await connectUpstream(
      { url: "http://test.local", token: "t" },
      (async (url: string | URL | Request, init?: RequestInit) => {
        const req = asRequest(url, init);
        expect(req.headers.get("authorization")).toBe("Bearer t");
        return handler.fetch(req);
      }) as typeof fetch,
    );
    // The bridge's own stdio side, paired with a client in memory.
    const { InMemoryTransport } = await import("@modelcontextprotocol/client");
    const [left, right] = InMemoryTransport.createLinkedPair();
    const server = bridgeServer(upstream);
    await server.connect(right);
    client = new Client({ name: "stdio-client", version: "1.0.0" });
    await client.connect(left);

    const { tools } = await client.listTools();
    expect(tools[0].name).toBe("vibe_list_windows");
    const progress: unknown[] = [];
    const r = await client.callTool(
      { name: "vibe_wait", arguments: { windows: "quiet-amber-otter-1" } },
      { onprogress: (p) => progress.push(p) },
    );
    expect(textOf(r)).toContain("quiet-amber-otter-1 is idle");
    expect(progress.length).toBe(3);
    await server.close();
    await upstream.close();
  });
});
