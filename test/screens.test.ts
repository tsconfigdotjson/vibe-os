import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { Terminal } from "@xterm/headless";
import { killSession } from "../server/attach.ts";
import type { Config } from "../server/config.ts";
import { paste } from "../server/headless.ts";
import type { Profile } from "../server/profiles.ts";
import {
  bufferText,
  classify,
  packet,
  parseSize,
  QUIET_MS,
  Screens,
} from "../server/screens.ts";
import { windowCommand } from "../server/session.ts";

const write = (term: Terminal, data: string) =>
  new Promise<void>((resolve) => term.write(data, resolve));

describe("packet", () => {
  test("is dtach's ten bytes: type, length, then the window size", () => {
    const buf = packet(4, 3, { rows: 40, cols: 120 });
    expect(buf.length).toBe(10);
    expect(buf[0]).toBe(4);
    expect(buf[1]).toBe(3);
    const read = os.endianness() === "LE" ? "readUInt16LE" : "readUInt16BE";
    expect(buf[read](2)).toBe(40);
    expect(buf[read](4)).toBe(120);
  });

  test("an attach carries no size", () => {
    expect([...packet(1)]).toEqual([1, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  });
});

describe("classify", () => {
  const now = 1_000_000;

  test("recent output is busy, whatever the screen says", () => {
    expect(classify(now - 100, now, "Enter to confirm")).toBe("busy");
  });

  test("quiet on a dialog is a question", () => {
    const trust = [
      " Quick safety check: Is this a project you created or one you trust?",
      " ❯ No, exit",
      "   Yes, I trust this folder",
      " Enter to confirm · Esc to cancel",
    ].join("\n");
    expect(classify(now - QUIET_MS - 1, now, trust)).toBe("question");
    expect(classify(null, now, " ❯ 1. Yes\n   2. No")).toBe("question");
    expect(classify(null, now, "Overwrite it? (y/n)")).toBe("question");
  });

  test("quiet at a prompt is idle", () => {
    expect(classify(null, now, '❯ Try "fix typecheck errors"')).toBe("idle");
    expect(classify(now - QUIET_MS - 1, now, "$ ")).toBe("idle");
  });
});

describe("parseSize", () => {
  test("reads rows then columns", () => {
    expect(parseSize("40 120\n")).toEqual({ rows: 40, cols: 120 });
  });

  test("is null for anything else", () => {
    expect(parseSize("")).toBe(null);
    expect(parseSize("0 0")).toBe(null);
    expect(parseSize("stty: not a tty")).toBe(null);
  });
});

describe("bufferText", () => {
  test("is the last lines, without colour or trailing blanks", async () => {
    const term = new Terminal({ rows: 5, cols: 20, allowProposedApi: true });
    await write(term, "one\r\n\x1b[31mtwo\x1b[0m\r\nthree\r\n\r\n");
    expect(bufferText(term, 10)).toBe("one\ntwo\nthree");
    expect(bufferText(term, 2)).toBe("two\nthree");
    term.dispose();
  });

  test("joins a line the terminal wrapped", async () => {
    const term = new Terminal({ rows: 5, cols: 10, allowProposedApi: true });
    await write(term, "abcdefghijklmno\r\nfive five next");
    expect(bufferText(term, 10)).toBe("abcdefghijklmno\nfive five next");
    term.dispose();
  });
});

const hasDtach =
  spawnSync("sh", ["-c", "command -v dtach"]).status === 0 &&
  process.platform !== "win32";

describe.skipIf(!hasDtach)("Screens, end to end", () => {
  // Under /tmp for the same reason as the sendText test: a unix socket path
  // has to fit in about a hundred bytes.
  let dir = "";
  let screens: Screens | undefined;
  const session = "vibe-screen-test-1";

  afterAll(async () => {
    screens?.stop();
    if (!dir) return;
    await killSession({ stateDir: dir } as Config, session);
    await rm(dir, { recursive: true, force: true });
  });

  test("reads a session's output and sees it stop on a question", async () => {
    dir = await mkdtemp("/tmp/vos-");
    const config = {
      sessions: true,
      stateDir: dir,
      memory: { high: null, max: null, swapMax: null },
    } as Config;
    // Draws for a moment, asks a question, then waits with the terminal
    // cooked, so whatever is typed is echoed back the way a prompt would.
    const profile = {
      harness: "custom",
      command: "sh",
      args: [
        "-c",
        "sleep 0.5; printf 'booting\\n'; sleep 0.3; printf 'Proceed? (y/n) '; exec cat",
      ],
    } as unknown as Profile;
    const cmd = windowCommand(session, dir, config, profile, {
      detached: true,
    }) as string;
    expect(spawnSync("/bin/sh", ["-c", cmd]).status).toBe(0);

    screens = new Screens(config);
    const screen = await screens.watch(session, { fresh: true });
    expect(screen).toBeDefined();
    expect(await screens.settle(session, 10_000)).toBe("question");
    expect(screen?.text(10)).toBe("booting\nProceed? (y/n)");

    const before = Date.now();
    await paste(config, session, "y");
    expect(await screens.drewSince(session, before, 3_000)).toBe(true);
    expect(screen?.activity()).toBe("busy");
  }, 20_000);

  test("a session that is not running has no screen", async () => {
    expect(await screens?.watch("vibe-nothing-here-1")).toBeUndefined();
  });
});
