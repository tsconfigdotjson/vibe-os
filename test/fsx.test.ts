import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { serialise, writeAtomic } from "../server/fsx.ts";

const scratch = () => mkdtemp(path.join(tmpdir(), "vibe-os-fsx-"));

describe("writeAtomic", () => {
  test("writes the contents", async () => {
    const dir = await scratch();
    const target = path.join(dir, "f.json");
    await writeAtomic(target, '{"a":1}', 0o600);
    expect(await readFile(target, "utf8")).toBe('{"a":1}');
  });

  test("leaves no temp file behind", async () => {
    const dir = await scratch();
    await writeAtomic(path.join(dir, "f.json"), "x", 0o600);
    expect(await readdir(dir)).toEqual(["f.json"]);
  });

  test("enforces the mode when the file already exists", async () => {
    // writeFile's own `mode` is ignored on an existing path, which is the whole
    // reason this helper chmods before renaming.
    const dir = await scratch();
    const target = path.join(dir, "key");
    await writeAtomic(target, "first", 0o644);
    await writeAtomic(target, "second", 0o600);
    const mode = (await stat(target)).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(await readFile(target, "utf8")).toBe("second");
  });
});

describe("serialise", () => {
  test("runs jobs one at a time, in order", async () => {
    const queue = serialise();
    const events: string[] = [];
    const job = (name: string, ms: number) => async () => {
      events.push(`start ${name}`);
      await Bun.sleep(ms);
      events.push(`end ${name}`);
    };
    // Slow first: unserialised, B would finish before A and interleave.
    await Promise.all([queue(job("a", 20)), queue(job("b", 1))]);
    expect(events).toEqual(["start a", "end a", "start b", "end b"]);
  });

  test("a rejected job does not stall the chain", async () => {
    const queue = serialise();
    const boom = queue(() => Promise.reject(new Error("boom")));
    await expect(boom).rejects.toThrow("boom");
    expect(await queue(() => Promise.resolve("after"))).toBe("after");
  });

  test("read-modify-write does not lose an update", async () => {
    const dir = await scratch();
    const target = path.join(dir, "index.json");
    await writeAtomic(target, "{}", 0o600);
    const queue = serialise();

    const put = (key: string) =>
      queue(async () => {
        const map = JSON.parse(await readFile(target, "utf8")) as Record<
          string,
          string
        >;
        await Bun.sleep(5); // widen the window a real filesystem would give
        map[key] = key;
        await writeAtomic(target, JSON.stringify(map), 0o600);
      });

    await Promise.all([put("one"), put("two"), put("three")]);
    const final = JSON.parse(await readFile(target, "utf8")) as object;
    expect(Object.keys(final).sort()).toEqual(["one", "three", "two"]);
  });
});
