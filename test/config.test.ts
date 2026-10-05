import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseCliArgs,
  resolveConfig,
  savePersisted,
} from "../server/config.ts";

/**
 * The token default, which decides whether a fresh install hands out shells to
 * anyone who can reach it.
 */
const ENV = ["VIBE_OS_TOKEN", "VIBE_OS_NO_TOKEN", "VIBE_OS_ALLOWED_HOSTS"];
let dir: string;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "vibe-os-config-"));
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

// --sessions skips probing for dtach, which this file has no interest in.
const resolve = (...argv: string[]) =>
  resolveConfig(
    parseCliArgs(["start", "--state-dir", dir, "--sessions", ...argv]).values,
  );

describe("the token", () => {
  test("is on with no flags at all", async () => {
    const { token } = await resolve();
    expect(token).toMatch(/^[\w-]{32}$/);
  });

  test("is the remembered one when there is one", async () => {
    await savePersisted(dir, { token: "remembered" });
    expect((await resolve()).token).toBe("remembered");
  });

  test("a bare --token behaves the same as none", async () => {
    await savePersisted(dir, { token: "remembered" });
    expect((await resolve("--token")).token).toBe("remembered");
  });

  test("an explicit one wins over the remembered one", async () => {
    await savePersisted(dir, { token: "remembered" });
    expect((await resolve("--token", "chosen")).token).toBe("chosen");
  });

  test("--no-token turns it off", async () => {
    await savePersisted(dir, { token: "remembered" });
    expect((await resolve("--no-token")).token).toBeNull();
  });

  test("VIBE_OS_NO_TOKEN turns it off, and 0 does not", async () => {
    process.env.VIBE_OS_NO_TOKEN = "1";
    expect((await resolve()).token).toBeNull();
    process.env.VIBE_OS_NO_TOKEN = "0";
    expect((await resolve()).token).not.toBeNull();
  });
});

describe("allowed hosts", () => {
  test("come from every --allowed-host and the environment, lower-cased", async () => {
    process.env.VIBE_OS_ALLOWED_HOSTS = "a.example, B.example,";
    const { allowedHosts } = await resolve(
      "--allowed-host",
      "Box.lan",
      "--allowed-host",
      "other",
    );
    expect(allowedHosts).toEqual([
      "box.lan",
      "other",
      "a.example",
      "b.example",
    ]);
  });

  test("are empty by default", async () => {
    expect((await resolve()).allowedHosts).toEqual([]);
  });
});
