import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createGate } from "../server/auth.ts";
import { frontDoor } from "../server/front-door.ts";

/**
 * The front door, which every request passes before a route is chosen.
 *
 * The routes here are a spy, so each test can say both what came back and
 * whether any route ran at all. A refused request must never reach one.
 */
const TOKEN = "s3cret-token-value";

function door(
  options: { token?: string | null; unguarded?: () => Response | null } = {},
) {
  const token = options.token === undefined ? TOKEN : options.token;
  const reached: string[] = [];
  const handle = frontDoor(
    {
      gate: createGate(token),
      token: Boolean(token),
      hosts: new Set(["box.example.com"]),
      unguarded: options.unguarded,
    },
    async (req, url) => {
      reached.push(`${req.method} ${url.pathname}`);
      return new Response("route", { status: 200 });
    },
  );
  const send = async (
    path: string,
    init: RequestInit & { headers?: Record<string, string> } = {},
  ) =>
    (await handle(
      new Request(`http://box.example.com${path}`, {
        ...init,
        headers: { host: "box.example.com", ...init.headers },
      }),
      { secure: false },
    )) as Response;
  return { send, reached };
}

/** Every kind of route the server has, and some it does not. */
const PATHS = [
  "/",
  "/index.html",
  "/desk/some/deep/link",
  "/assets/index-AbCdEf12.js",
  "/ssh.wasm",
  "/manifest.webmanifest",
  "/icon-192.png",
  "/websocket",
  "/mcp",
  "/mcp/",
  "/api",
  "/api/",
  "/api/windows",
  "/api/windows/w1/send",
  "/api/windows/wait?refs=a,b",
  "/api/events",
  "/api/projects/p1/workspaces",
  "/api/sign",
  "/api/wallpapers/abc.jpg",
  "/API/windows",
  "//api/windows",
  "/api/../api/windows",
  "/%61pi/windows",
  "/api%2fwindows",
  "/.well-known/acme-challenge/abc",
  "/no-such-thing.txt",
];

const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

/** Credentials that are not the token, each sent alone. */
const WRONG: Record<string, Record<string, string>> = {
  nothing: {},
  "a wrong bearer": { authorization: "Bearer nope" },
  "an empty bearer": { authorization: "Bearer " },
  "a bearer with only the scheme": { authorization: "Bearer" },
  "the token as a prefix": { authorization: `Bearer ${TOKEN}x` },
  "a truncated token": { authorization: `Bearer ${TOKEN.slice(0, -1)}` },
  "the token with a space before it": { authorization: `Bearer  ${TOKEN}` },
  "the token with no scheme": { authorization: TOKEN },
  "the token as Basic": { authorization: `Basic ${TOKEN}` },
  "the token as Basic base64": {
    authorization: `Basic ${btoa(`user:${TOKEN}`)}`,
  },
  "the token in another header": { "x-api-key": TOKEN, "x-token": TOKEN },
  "a wrong cookie": { cookie: "vibe_os_session=nope" },
  "a wrong __Host- cookie": { cookie: "__Host-vibe_os_session=nope" },
  "the token under another cookie name": {
    cookie: `vibe_os_sessions=${TOKEN}`,
  },
  "the token under a cookie name prefix": { cookie: `os_session=${TOKEN}` },
  "an empty cookie": { cookie: "vibe_os_session=" },
  "a cookie that does not decode": { cookie: "vibe_os_session=%E0%A4%A" },
};

describe("refused before any route runs", () => {
  for (const [what, headers] of Object.entries(WRONG)) {
    test(`with ${what}, every path and method is a 401`, async () => {
      const { send, reached } = door();
      for (const path of PATHS)
        for (const method of METHODS) {
          const res = await send(path, { method, headers });
          if (res.status !== 401)
            throw new Error(`${method} ${path} with ${what}: ${res.status}`);
        }
      expect(reached).toEqual([]);
    });
  }

  test("a wrong ?token= is a 403 everywhere but /mcp, which ignores it", async () => {
    const { send, reached } = door();
    for (const path of PATHS) {
      const sep = path.includes("?") ? "&" : "?";
      const res = await send(`${path}${sep}token=nope`);
      const bare = new URL(`http://x${path}`).pathname;
      expect([bare, res.status]).toEqual([bare, bare === "/mcp" ? 401 : 403]);
    }
    expect(reached).toEqual([]);
  });

  test("the right ?token= on /mcp still counts for nothing", async () => {
    const { send, reached } = door();
    for (const method of ["GET", "POST", "DELETE"]) {
      const res = await send(`/mcp?token=${TOKEN}`, { method });
      expect(res.status).toBe(401);
    }
    expect(reached).toEqual([]);
  });

  test("the right ?token= elsewhere sets the cookie and redirects, without running the route", async () => {
    const { send, reached } = door();
    const res = await send(`/api/windows?token=${TOKEN}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/api/windows");
    expect(reached).toEqual([]);
  });

  test("a page on another site is refused even with the token", async () => {
    const { send, reached } = door();
    for (const origin of [
      "https://evil.example",
      "https://vps-other.vps.ovh.ca",
      "http://box.example.com.evil.example",
      "null",
      "not a url",
    ]) {
      const res = await send("/api/windows", {
        method: "POST",
        headers: { origin, authorization: `Bearer ${TOKEN}` },
      });
      expect([origin, res.status]).toEqual([origin, 403]);
    }
    expect(reached).toEqual([]);
  });
});

describe("the 401 says how to authenticate, in each caller's shape", () => {
  test("/api is JSON", async () => {
    const res = await door().send("/api/windows");
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(((await res.json()) as { error: string }).error).toContain("token");
  });

  test("/mcp is JSON with WWW-Authenticate", async () => {
    const res = await door().send("/mcp", { method: "POST" });
    expect(res.headers.get("www-authenticate")).toBe('Bearer realm="vibe-os"');
    expect(((await res.json()) as { error: string }).error).toContain("token");
  });

  test("a page is the HTML that says a token is needed", async () => {
    const res = await door().send("/");
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("requires a token");
  });
});

describe("let in", () => {
  const RIGHT: Record<string, Record<string, string>> = {
    "the bearer token": { authorization: `Bearer ${TOKEN}` },
    "the cookie": { cookie: `vibe_os_session=${TOKEN}` },
    "the __Host- cookie": { cookie: `__Host-vibe_os_session=${TOKEN}` },
    "the cookie among others": {
      cookie: `a=1; vibe_os_session=planted; __Host-vibe_os_session=${TOKEN}; b=2`,
    },
  };
  for (const [what, headers] of Object.entries(RIGHT)) {
    test(`with ${what}, every path reaches its route`, async () => {
      const { send, reached } = door();
      for (const path of PATHS) {
        const res = await send(path, { headers });
        expect([path, res.status]).toEqual([path, 200]);
      }
      expect(reached.length).toBe(PATHS.length);
    });
  }

  test("a same-origin request with the token", async () => {
    const { send, reached } = door();
    const res = await send("/api/windows", {
      method: "POST",
      headers: {
        origin: "http://box.example.com",
        authorization: `Bearer ${TOKEN}`,
      },
    });
    expect(res.status).toBe(200);
    expect(reached).toEqual(["POST /api/windows"]);
  });
});

describe("unguarded answers", () => {
  test("only what unguarded returns gets out without a token", async () => {
    const { send, reached } = door({
      unguarded: () => new Response("challenge", { status: 200 }),
    });
    expect(await (await send("/anything")).text()).toBe("challenge");
    expect(reached).toEqual([]);
  });

  test("when it returns null, the gate applies as usual", async () => {
    const { send, reached } = door({ unguarded: () => null });
    expect((await send("/api/windows")).status).toBe(401);
    expect(reached).toEqual([]);
  });
});

describe("with no token", () => {
  test("a name the server does not answer to is refused", async () => {
    const { send, reached } = door({ token: null });
    const res = await send("/api/windows", {
      headers: { host: "rebound.evil.example" },
    });
    expect(res.status).toBe(403);
    expect(reached).toEqual([]);
  });

  test("its own name and an address get in", async () => {
    const { send, reached } = door({ token: null });
    expect((await send("/api/windows")).status).toBe(200);
    expect(
      (await send("/api/windows", { headers: { host: "54.39.97.232" } }))
        .status,
    ).toBe(200);
    expect(reached.length).toBe(2);
  });
});

/**
 * The server wires routes up in index.ts. Each one has to be inside the
 * function handed to frontDoor, or it would answer without the gate.
 */
describe("index.ts", () => {
  const src = readFileSync(
    new URL("../server/index.ts", import.meta.url),
    "utf8",
  );
  const start = src.indexOf("frontDoor<");
  const end = src.indexOf("const makeServer");
  const inside = src.slice(start, end);
  const outside = src.slice(0, start) + src.slice(end);

  test("hands its routes to frontDoor", () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
  });

  for (const call of [
    "handleApi(",
    "serveStatic(",
    "serveMcp(",
    "server.upgrade(",
    "webManifest(config",
  ])
    test(`calls ${call} only behind the gate`, () => {
      expect(inside).toContain(call);
      expect(outside).not.toContain(call);
    });

  test("never checks the token itself", () => {
    expect(src).not.toContain("gate.check(");
    expect(src).not.toContain("consumeTokenParam(");
  });

  test("serves every request through the front door", () => {
    const fetchBody = src.slice(src.indexOf("async fetch(req, server)"));
    expect(fetchBody.slice(0, 400)).toContain("await handle(req,");
  });
});
