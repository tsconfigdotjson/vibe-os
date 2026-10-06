import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  findProfile,
  findWindow,
  findWorkspace,
  parseBlanks,
  request,
  resolveRemote,
} from "../server/client.ts";
import { savePersisted } from "../server/config.ts";
import type {
  Profile,
  WindowSummary,
  WorkspaceSummary,
} from "../shared/wire.ts";

const ws = (name: string, project: string): WorkspaceSummary => ({
  id: `${project}-${name}-id`,
  name,
  branch: name,
  path: `/w/${project}/${name}`,
  projectId: `${project}-id`,
  project,
  lastOpenedAt: 0,
});

describe("findWorkspace", () => {
  const all = [ws("quiet-amber-otter", "api"), ws("brave-jade-lynx", "api")];

  test("by name, by id, and by project/name", () => {
    expect(findWorkspace(all, "brave-jade-lynx").name).toBe("brave-jade-lynx");
    expect(findWorkspace(all, "api-quiet-amber-otter-id").name).toBe(
      "quiet-amber-otter",
    );
    expect(findWorkspace(all, "api/quiet-amber-otter").name).toBe(
      "quiet-amber-otter",
    );
  });

  test("asks for the project when a name is in two", () => {
    const twice = [...all, ws("brave-jade-lynx", "web")];
    expect(() => findWorkspace(twice, "brave-jade-lynx")).toThrow(
      "api/brave-jade-lynx, web/brave-jade-lynx",
    );
    expect(findWorkspace(twice, "web/brave-jade-lynx").project).toBe("web");
  });

  test("says so when there is none", () => {
    expect(() => findWorkspace(all, "nope")).toThrow(
      "no workspace called nope",
    );
  });
});

describe("findProfile", () => {
  const profiles = [{ id: "p1", name: "QA Engineer" }] as Profile[];

  test("ignores case, and lists the choices when it misses", () => {
    expect(findProfile(profiles, "qa engineer").id).toBe("p1");
    expect(() => findProfile(profiles, "dev")).toThrow("Profiles: QA Engineer");
  });
});

describe("findWindow", () => {
  const windows = [{ id: "w1", ref: "quiet-amber-otter-2" }] as WindowSummary[];

  test("takes an id, a ref, or the session name", () => {
    expect(findWindow(windows, "w1").ref).toBe("quiet-amber-otter-2");
    expect(findWindow(windows, "quiet-amber-otter-2").id).toBe("w1");
    expect(findWindow(windows, "vibe-quiet-amber-otter-2").id).toBe("w1");
  });
});

describe("parseBlanks", () => {
  test("splits on the first equals sign", () => {
    expect(parseBlanks(["ticket=#12", "query=a=b"])).toEqual({
      ticket: "#12",
      query: "a=b",
    });
  });

  test("refuses a pair with no label", () => {
    expect(() => parseBlanks(["=x"])).toThrow("label=value");
    expect(() => parseBlanks(["x"])).toThrow("label=value");
  });
});

describe("resolveRemote", () => {
  let dir = "";
  afterAll(() => rm(dir, { recursive: true, force: true }));

  test("on the box, uses the port and the remembered token", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "vibe-os-client-"));
    await savePersisted(dir, { token: "remembered" });
    const saved = process.env.VIBE_OS_TOKEN;
    delete process.env.VIBE_OS_TOKEN;
    try {
      expect(await resolveRemote({}, { port: 80, stateDir: dir })).toEqual({
        url: "http://127.0.0.1:80",
        token: "remembered",
      });
      // The address start recorded wins over the default port, not over --port.
      await savePersisted(dir, { localUrl: "http://127.0.0.1:7681" });
      expect((await resolveRemote({}, { port: 80, stateDir: dir })).url).toBe(
        "http://127.0.0.1:7681",
      );
      expect(
        (await resolveRemote({ port: "9000" }, { port: 9000, stateDir: dir }))
          .url,
      ).toBe("http://127.0.0.1:9000");
      // Another box's URL does not get this box's token.
      expect(
        await resolveRemote(
          { url: "https://box.example/" },
          { port: 80, stateDir: dir },
        ),
      ).toEqual({ url: "https://box.example", token: null });
    } finally {
      if (saved !== undefined) process.env.VIBE_OS_TOKEN = saved;
    }
  });

  test("refuses a URL that is not http", async () => {
    await expect(
      resolveRemote({ url: "box:80" }, { port: 80, stateDir: "/nonexistent" }),
    ).rejects.toThrow("--url must start with http");
  });
});

describe("request", () => {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      if (req.headers.get("authorization") !== "Bearer t")
        return Response.json({ error: "missing token" }, { status: 401 });
      if (new URL(req.url).pathname === "/api/bad")
        return Response.json({ error: "no such thing" }, { status: 404 });
      return Response.json({ ok: true });
    },
  });
  afterAll(() => server.stop(true));
  const url = `http://127.0.0.1:${server.port}`;

  test("sends the token as a bearer", async () => {
    expect(
      await request<unknown>({ url, token: "t" }, "GET", "/api/x"),
    ).toEqual({
      ok: true,
    });
  });

  test("turns a 401 into what to do about it", async () => {
    await expect(
      request({ url, token: null }, "GET", "/api/x"),
    ).rejects.toThrow("pass --token or set VIBE_OS_TOKEN");
  });

  test("passes the server's error through", async () => {
    await expect(
      request({ url, token: "t" }, "GET", "/api/bad"),
    ).rejects.toThrow("no such thing");
  });
});
