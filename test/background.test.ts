import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { killSession } from "../server/attach.ts";
import type { Config } from "../server/config.ts";
import { claudeBackground } from "../server/harnesses/claude-transcript.ts";
import type { Profile } from "../server/profiles.ts";
import { sessionProcesses } from "../server/reaper.ts";
import { socketPath, windowCommand } from "../server/session.ts";

/**
 * Reading whether a Claude window has a background command, without Claude.
 *
 * A real dtach session stands in for the window, and a session file of the
 * kind Claude writes to `<CLAUDE_CONFIG_DIR>/sessions/<pid>.json` stands in for
 * Claude's own report. What is under test is the path from the window's socket
 * to its processes to that file.
 */
const hasDtach =
  spawnSync("sh", ["-c", "command -v dtach"]).status === 0 &&
  process.platform !== "win32";

describe.skipIf(!hasDtach)("claudeBackground", () => {
  let dir = "";
  let config: Config;
  const session = "vibe-background-test-1";
  const saved = process.env.CLAUDE_CONFIG_DIR;

  afterAll(async () => {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
    if (!dir) return;
    await killSession(config, session).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });

  /** Writes the session file Claude would, for `pid`, with `status`. */
  const report = (pid: number, status: string) =>
    writeFile(
      path.join(dir, "claude", "sessions", `${pid}.json`),
      JSON.stringify({
        pid,
        sessionId: "0b6f6a2e-3c1d-4e5f-8a9b-0c1d2e3f4a5b",
        cwd: dir,
        status,
        statusUpdatedAt: Date.now(),
      }),
    );

  test("shell is a background command, idle and busy are not", async () => {
    // Under /tmp: a unix socket path has to fit in about a hundred bytes.
    dir = await mkdtemp("/tmp/vos-bg-");
    config = {
      sessions: true,
      stateDir: dir,
      memory: { high: null, max: null, swapMax: null },
    } as Config;
    await mkdir(path.join(dir, "claude", "sessions"), { recursive: true });
    process.env.CLAUDE_CONFIG_DIR = path.join(dir, "claude");

    const profile = {
      harness: "custom",
      command: "sh",
      args: ["-c", "exec sleep 60"],
    } as unknown as Profile;
    const cmd = windowCommand(session, dir, config, profile, {
      detached: true,
    }) as string;
    expect(spawnSync("/bin/sh", ["-c", cmd]).status).toBe(0);

    const sock = socketPath(config, session);
    const window = { sock, cwd: dir };
    // No session file yet: nothing says there is a background command.
    expect(await claudeBackground(window)).toBe(false);

    let pids: number[] = [];
    for (let i = 0; i < 20 && pids.length < 2; i++) {
      pids = await sessionProcesses(sock);
      if (pids.length < 2) await Bun.sleep(100);
    }
    // The dtach master and what runs under it; the file names the latter.
    const claude = Math.max(...pids);
    expect(pids.length).toBeGreaterThanOrEqual(1);

    await report(claude, "shell");
    expect(await claudeBackground(window)).toBe(true);
    await report(claude, "idle");
    expect(await claudeBackground(window)).toBe(false);
    await report(claude, "busy");
    expect(await claudeBackground(window)).toBe(false);

    // A file for some other process does not count for this window.
    await rm(path.join(dir, "claude", "sessions", `${claude}.json`));
    await report(process.pid, "shell");
    expect(await claudeBackground(window)).toBe(false);
  }, 20_000);
});
