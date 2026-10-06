import { beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { interruptedWindows } from "../server/attach.ts";
import type { Config } from "../server/config.ts";
import {
  type Db,
  newId,
  openDb,
  projects,
  windows,
  workspaces,
} from "../server/db.ts";
import { harnessCommand } from "../server/session.ts";
import {
  getWindow,
  markInterrupted,
  restoreWindow,
  takeResume,
} from "../server/windows.ts";

describe("harnessCommand resuming", () => {
  const profile = (harness: string, args: string[] = []) =>
    ({
      id: "p",
      projectId: "x",
      color: "cyan",
      name: "R",
      harness,
      command: harness === "custom" ? "aider" : null,
      args,
      prompt: "",
      memoryHigh: null,
      memoryMax: null,
      position: 0,
      createdAt: 0,
    }) as Parameters<typeof harnessCommand>[0];

  const where = { cwd: "/w", stateDir: "/s" };

  test("asks every agent harness for its last conversation", () => {
    expect(
      harnessCommand(profile("claude", ["--model", "opus"]), where, true),
    ).toEndWith("exec 'claude' '--model' 'opus' '--continue'");
    expect(harnessCommand(profile("hermes"), where, true)).toEndWith(
      "exec 'hermes' 'chat' '--continue'",
    );
    expect(harnessCommand(profile("cursor"), where, true)).toEndWith(
      "exec 'cursor-agent' '--continue'",
    );
  });

  test("leaves a fresh start alone", () => {
    expect(harnessCommand(profile("claude"), where)).toEndWith("exec 'claude'");
  });

  test("adds nothing to a custom command", () => {
    expect(harnessCommand(profile("custom"), where, true)).toEndWith(
      "exec 'aider'",
    );
  });

  test("does not add a second pick when the profile already makes one", () => {
    for (const args of [
      ["--continue"],
      ["-c"],
      ["--resume", "abc"],
      ["--resume=abc"],
    ]) {
      const cmd = harnessCommand(
        profile("claude", args),
        where,
        true,
      ) as string;
      expect(cmd.match(/--continue/g)?.length ?? 0).toBeLessThanOrEqual(1);
      expect(cmd).toEndWith(args.map((a) => `'${a}'`).join(" "));
    }
  });
});

describe("interrupted windows", () => {
  let db: Db;
  let dir: string;
  let ids: string[];

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "vibe-os-restore-"));
    db = openDb(dir);
    const now = Date.now();
    const project = newId();
    const workspace = newId();
    db.insert(projects)
      .values({ id: project, name: "demo", path: "/tmp/demo", createdAt: now })
      .run();
    db.insert(workspaces)
      .values({
        id: workspace,
        projectId: project,
        name: "brisk-copper-vole",
        branch: "brisk-copper-vole",
        path: "/tmp/demo/wt",
        createdAt: now,
        lastOpenedAt: now,
      })
      .run();
    ids = [newId(), newId()];
    ids.forEach((id, i) => {
      db.insert(windows)
        .values({
          id,
          workspaceId: workspace,
          idx: i + 1,
          col: 0,
          row: 0,
          colSpan: 11,
          rowSpan: 8,
          z: i + 1,
          createdAt: now,
        })
        .run();
    });
  });

  test("a socket nothing answers on names its window", async () => {
    // A plain file in the socket's place is as dead as a socket left by a
    // reboot: `dtach -p` fails on both. Window 2 has no socket at all, which is
    // a harness that exited and took its socket with it.
    await mkdir(`${dir}/sessions`);
    await writeFile(`${dir}/sessions/vibe-brisk-copper-vole-1.sock`, "");
    const config = { sessions: true, stateDir: dir } as Config;
    expect(await interruptedWindows(db, config)).toEqual([ids[0]]);
  });

  test.skipIf(!Bun.which("dtach"))(
    "a session that is still running is not interrupted",
    async () => {
      await mkdir(`${dir}/sessions`);
      const sock = `${dir}/sessions/vibe-brisk-copper-vole-1.sock`;
      Bun.spawnSync(["dtach", "-n", sock, "-E", "sleep", "30"]);
      try {
        const config = { sessions: true, stateDir: dir } as Config;
        expect(await interruptedWindows(db, config)).toEqual([]);
      } finally {
        Bun.spawnSync(["pkill", "-f", `^dtach -n ${sock}`]);
      }
    },
  );

  test("finds nothing when the server runs without sessions", async () => {
    await mkdir(`${dir}/sessions`);
    await writeFile(`${dir}/sessions/vibe-brisk-copper-vole-1.sock`, "");
    const config = { sessions: false, stateDir: dir } as Config;
    expect(await interruptedWindows(db, config)).toEqual([]);
  });

  test("a flagged window resumes once, then starts fresh", () => {
    expect(markInterrupted(db, [ids[0]])).toBe(1);
    expect(getWindow(db, ids[0])?.restore).toBe("ask");
    expect(getWindow(db, ids[1])?.restore).toBe(null);

    expect(takeResume(db, ids[0])).toBe(true);
    expect(takeResume(db, ids[0])).toBe(false);
    expect(takeResume(db, ids[1])).toBe(false);
  });

  test("the answer decides what the next session does", () => {
    markInterrupted(db, ids);
    expect(restoreWindow(db, ids[0], true)?.restore).toBe("resume");
    expect(restoreWindow(db, ids[1], false)?.restore).toBe(null);
    expect(takeResume(db, ids[0])).toBe(true);
    expect(takeResume(db, ids[1])).toBe(false);
  });

  test("a second restart keeps an answer already given", () => {
    markInterrupted(db, [ids[0]]);
    restoreWindow(db, ids[0], true);
    expect(markInterrupted(db, [ids[0]])).toBe(0);
    expect(getWindow(db, ids[0])?.restore).toBe("resume");
  });
});
