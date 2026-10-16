import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import type net from "node:net";
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
  Screen,
  Screens,
} from "../server/screens.ts";
import { windowCommand } from "../server/session.ts";
import type { Activity } from "../shared/wire.ts";

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

  // Claude's input line, as it draws it: the prompt, then a faint suggestion.
  const suggestion = '❯ \x1b[2mTry "fix lint errors"\x1b[22m';

  test("leaves out a faint suggestion on the cursor's line", async () => {
    const term = new Terminal({ rows: 4, cols: 40, allowProposedApi: true });
    // The cursor is parked back at the start of the input, after the status.
    await write(term, `answer\r\n${suggestion}\r\n\x1b[2mstatus\x1b[2;3H`);
    expect(bufferText(term, 10)).toBe("answer\n❯\nstatus");
    term.dispose();
  });

  test("keeps what was typed", async () => {
    const term = new Terminal({ rows: 4, cols: 40, allowProposedApi: true });
    await write(term, `${suggestion}\x1b[1;3Hfix it\x1b[K`);
    expect(bufferText(term, 10)).toBe("❯ fix it");
    term.dispose();
  });

  test("keeps faint text on every other line", async () => {
    const term = new Terminal({ rows: 4, cols: 40, allowProposedApi: true });
    await write(term, `${suggestion}\r\n$ `);
    expect(bufferText(term, 10)).toBe('❯ Try "fix lint errors"\n$');
    term.dispose();
  });
});

/** A screen with no session behind it, fed by hand. */
function detached(
  onState?: (from: Activity | null, to: Activity | null) => void,
) {
  const socket = { destroy() {}, write() {}, destroyed: false };
  const screen = new Screen(
    "/nonexistent.sock",
    socket as unknown as net.Socket,
    onState,
  );
  // No pty to ask the size of.
  (screen as unknown as { sizeCheckedAt: number }).sizeCheckedAt =
    Number.MAX_SAFE_INTEGER;
  return screen;
}

/** Feeds a screen and waits until xterm has parsed it. */
const feed = (screen: Screen, data: string) => {
  screen.feed(Buffer.from(data));
  return write(screen.term, "");
};

describe("state events", () => {
  test("output is busy at once, and quiet becomes idle after QUIET_MS", async () => {
    const seen: [Activity | null, Activity | null][] = [];
    const screen = detached((from, to) => seen.push([from, to]));
    await feed(screen, "working...\r\n");
    expect(seen).toEqual([["idle", "busy"]]);
    await feed(screen, "more\r\n");
    expect(seen).toHaveLength(1);
    await Bun.sleep(QUIET_MS + 200);
    expect(seen).toEqual([
      ["idle", "busy"],
      ["busy", "idle"],
    ]);
    screen.close();
  });

  test("quiet on a question is a question", async () => {
    const seen: (Activity | null)[] = [];
    const screen = detached((_, to) => seen.push(to));
    await feed(screen, "Overwrite it? (y/n) ");
    await Bun.sleep(QUIET_MS + 200);
    expect(seen).toEqual(["busy", "question"]);
    expect(screen.state).toBe("question");
    screen.close();
  });

  test("closing stops the quiet timer", async () => {
    const seen: (Activity | null)[] = [];
    const screen = detached((_, to) => seen.push(to));
    await feed(screen, "x");
    screen.close();
    await Bun.sleep(QUIET_MS + 200);
    expect(seen).toEqual(["busy"]);
  });

  test("the next output after a send is announced once", async () => {
    const screen = detached();
    let calls = 0;
    screen.onOutput = () => calls++;
    await feed(screen, "a");
    await feed(screen, "b");
    expect(calls).toBe(1);
    screen.close();
  });
});

describe("turns", () => {
  test("a closed window's turn is forgotten, for the next one at its index", () => {
    const screens = new Screens({ stateDir: "/nonexistent" } as Config);
    screens.noteSend("vibe-w-1", Date.now());
    expect(screens.turnOf("vibe-w-1")?.turn).toBe("pending");
    screens.forget("vibe-w-1");
    expect(screens.turnOf("vibe-w-1")).toBeUndefined();
  });
});

describe("output cursor", () => {
  const numbered = (from: number, n: number) =>
    Array.from({ length: n }, (_, i) => `line ${from + i}`).join("\r\n");

  test("only what scrolled into the history after the cursor", async () => {
    const screen = detached();
    await feed(screen, numbered(0, 100));
    const first = screen.since(0);
    expect(first.truncated).toBe(false);
    expect(first.text.split("\n")[0]).toBe("line 0");
    await feed(screen, `\r\n${numbered(100, 5)}`);
    const next = screen.since(first.cursor);
    expect(next.cursor).toBe(first.cursor + 5);
    // Five rows scrolled off the top of the screen: the five oldest it showed.
    expect(next.text.split("\n")).toHaveLength(5);
    expect(next.screen.split("\n").at(-1)).toBe("line 104");
    expect(screen.since(next.cursor).text).toBe("");
    screen.close();
  });

  test("stays monotonic as the history is trimmed past 1000 lines", async () => {
    const screen = detached();
    let last = screen.cursor();
    for (let i = 0; i < 6; i++) {
      await feed(screen, `${numbered(i * 500, 500)}\r\n`);
      const now = screen.cursor();
      expect(now).toBeGreaterThan(last);
      last = now;
    }
    expect(last).toBeGreaterThan(2_000);
    screen.close();
  });

  test("a cursor older than the history held is truncated", async () => {
    const screen = detached();
    await feed(screen, numbered(0, 50));
    const old = screen.since(0).cursor;
    await feed(screen, `\r\n${numbered(50, 2_000)}`);
    const since = screen.since(old);
    expect(since.truncated).toBe(true);
    expect(since.text.split("\n")).toHaveLength(1_000);
    screen.close();
  });

  test("a cursor from before a restart reads everything as new", async () => {
    const screen = detached();
    await feed(screen, numbered(0, 80));
    const since = screen.since(1_000_000);
    expect(since.truncated).toBe(true);
    expect(since.text.split("\n")[0]).toBe("line 0");
    screen.close();
  });

  test("a resize does not move the cursor", async () => {
    const screen = detached();
    await feed(screen, numbered(0, 300));
    const before = screen.cursor();
    screen.resize(20, 10);
    expect(screen.cursor()).toBe(before);
    screen.resize(200, 50);
    expect(screen.cursor()).toBe(before);
    screen.close();
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
