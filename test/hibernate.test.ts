import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Terminal } from "@xterm/headless";
import type { Config } from "../server/config.ts";
import {
  type Evidence,
  lateChildren,
  newestTimestamp,
  projectDirName,
  verdict,
} from "../server/hibernate.ts";
import type { ProcInfo } from "../server/reaper.ts";
import { Screen, Screens } from "../server/screens.ts";
import { harnessCommand, resumeMarker } from "../server/session.ts";

const MIN = 60_000;
const AFTER = 90 * MIN;
const NOW = 1_800_000_000_000;

const ready: Evidence = {
  clients: 0,
  loginAt: null,
  activity: "idle",
  draft: "",
  claudes: 1,
  registry: {
    sessionId: "1b33d7a0-24f3-4ae9-961c-de8e6f9aff84",
    status: "idle",
  },
  claudeAge: 3 * 60 * MIN,
  transcript: true,
  lastActivityAt: NOW - 2 * 60 * MIN,
  lateChildren: [],
};

describe("verdict", () => {
  test("hibernates a window that is idle in every way", () => {
    expect(verdict(ready, NOW, AFTER)).toBeNull();
  });

  const keeps: [string, Partial<Evidence>][] = [
    ["something is attached", { clients: 1 }],
    ["it was opened a moment ago", { loginAt: NOW - 5_000 }],
    ["no Claude is found", { claudes: 0 }],
    ["two Claudes share it", { claudes: 2 }],
    ["Claude has no registry entry", { registry: null }],
    [
      "Claude is working",
      {
        registry: { ...ready.registry, status: "busy" } as Evidence["registry"],
      },
    ],
    [
      "a background shell is running",
      {
        registry: {
          ...ready.registry,
          status: "shell",
        } as Evidence["registry"],
      },
    ],
    ["its screen is not watched", { activity: undefined }],
    ["its screen is drawing", { activity: "busy" }],
    ["it is stopped on a question", { activity: "question" }],
    ["no prompt line is on screen", { draft: null }],
    ["text is typed and not sent", { draft: "half a thought" }],
    ["its transcript is gone", { transcript: false }],
    ["it was woken recently", { claudeAge: 5 * MIN }],
    ["it has no activity on record", { lastActivityAt: null }],
    ["it was active recently", { lastActivityAt: NOW - 10 * MIN }],
    ["a background job outlives its turn", { lateChildren: ["npm run dev"] }],
  ];
  for (const [why, change] of keeps) {
    test(`keeps it when ${why}`, () => {
      expect(verdict({ ...ready, ...change }, NOW, AFTER)).toBeString();
    });
  }
});

describe("newestTimestamp", () => {
  test("is the latest of the transcript's timestamps", () => {
    const text = [
      '{"type":"user","timestamp":"2026-10-14T01:36:10.000Z"}',
      '{"type":"assistant","timestamp":"2026-10-14T01:37:02.512Z"}',
      '{"type":"last-prompt","sessionId":"x"}',
      '{"type":"user","timestamp":"2026-10-13T23:00:00.000Z"}',
    ].join("\n");
    expect(newestTimestamp(text)).toBe(Date.parse("2026-10-14T01:37:02.512Z"));
  });

  test("is null for lines that carry none, like Claude's bookkeeping", () => {
    expect(newestTimestamp('{"type":"last-prompt"}\n')).toBeNull();
  });

  test("survives a tail cut mid-line", () => {
    expect(
      newestTimestamp(
        'stamp":"2026-10-14T0\n{"timestamp":"2026-10-14T02:00:00Z"}',
      ),
    ).toBe(Date.parse("2026-10-14T02:00:00Z"));
  });
});

test("projectDirName files a worktree the way Claude does", () => {
  expect(
    projectDirName(
      "/home/ubuntu/workspace/.vibe-worktrees/instantdb-rust/hibernate-test",
    ),
  ).toBe(
    "-home-ubuntu-workspace--vibe-worktrees-instantdb-rust-hibernate-test",
  );
});

describe("lateChildren", () => {
  const proc = (pid: number, age: number, args: string): ProcInfo => ({
    pid,
    age,
    args,
    cwd: null,
    sock: "/s/x.sock",
  });
  const claude = proc(2, 3600, "claude --model opus");

  test("counts a job started well after Claude", () => {
    expect(lateChildren([claude, proc(3, 60, "sleep 300")], claude)).toEqual([
      "sleep 300",
    ]);
  });

  test("counts a dev server started in Claude's first minute", () => {
    expect(
      lateChildren([claude, proc(3, 3550, "node vite --port 5173")], claude),
    ).toEqual(["node vite --port 5173"]);
  });

  test("leaves out what starts with Claude, MCP servers, dtach and Claude itself", () => {
    expect(
      lateChildren(
        [
          proc(1, 3600, "/usr/bin/dtach -n /s/x.sock -E -z /bin/sh -c x"),
          claude,
          proc(4, 3590, "node git-helper.js"),
          proc(5, 60, "npx -y @upstash/context7-mcp"),
          proc(6, 60, "/home/u/.local/bin/claude --chrome-native-host"),
        ],
        claude,
      ),
    ).toEqual([]);
  });
});

describe("Screen.draft", () => {
  const write = (term: Terminal, data: string) =>
    new Promise<void>((resolve) => term.write(data, resolve));
  const screen = () => new Screen("/s/x.sock", {} as net.Socket);

  test("is empty at an empty prompt, and ignores the faint suggestion", async () => {
    const s = screen();
    await write(s.term, "● HERON-77\r\n\r\n");
    await write(
      s.term,
      '──────\r\n❯ \x1b[2mTry "fix the build"\x1b[0m\r\n──────\r\n',
    );
    expect(s.draft()).toBe("");
  });

  test("is what was typed at the prompt", async () => {
    const s = screen();
    await write(
      s.term,
      "❯ an old prompt\r\n\r\n● OK\r\n──────\r\n❯ half a thought\r\n──────\r\n",
    );
    expect(s.draft()).toBe("half a thought");
  });

  test("is null when nothing on screen is a prompt", async () => {
    const s = screen();
    await write(s.term, "$ ls\r\nREADME.md\r\n");
    expect(s.draft()).toBeNull();
  });
});

test("a hibernated window has no screen to watch, and does not crash the server", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "vibe-hib-state-"));
  try {
    const sock = path.join(stateDir, "sessions", "vibe-w-1.sock");
    await mkdir(path.dirname(sock), { recursive: true });
    await writeFile(resumeMarker(sock), "1b33d7a0-24f3-4ae9-961c-de8e6f9aff84");
    await writeFile(`${sock}.lock`, "");
    const screens = new Screens({ stateDir } as Config);
    expect(await screens.watch("vibe-w-1")).toBeUndefined();
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

describe("the launch line of a hibernated window", () => {
  const ID = "1b33d7a0-24f3-4ae9-961c-de8e6f9aff84";
  const dirs: string[] = [];
  afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  const profile = (args: string[]) =>
    ({
      id: "p",
      projectId: "x",
      color: "cyan",
      name: "R",
      harness: "claude",
      command: null,
      args,
      prompt: "",
      memoryHigh: null,
      memoryMax: null,
      position: 0,
      createdAt: 0,
    }) as Parameters<typeof harnessCommand>[0];

  /** Runs the line with a `claude` that prints its arguments. */
  async function launch(opts: {
    args?: string[];
    marker?: string;
    transcript?: boolean;
    resume?: boolean;
  }) {
    const home = await mkdtemp(path.join(tmpdir(), "vibe-hib-"));
    dirs.push(home);
    await mkdir(path.join(home, ".local/bin"), { recursive: true });
    const fake = path.join(home, ".local/bin/claude");
    await writeFile(fake, '#!/bin/sh\nprintf "%s\\n" "$@"\n');
    await chmod(fake, 0o755);
    const projects = path.join(home, ".claude/projects/-w");
    await mkdir(projects, { recursive: true });
    if (opts.transcript)
      await writeFile(path.join(projects, `${ID}.jsonl`), "");
    const marker = resumeMarker(path.join(home, "s.sock"));
    if (opts.marker !== undefined) await writeFile(marker, opts.marker);

    const line = harnessCommand(
      profile(opts.args ?? ["--model", "opus"]),
      { cwd: "/w", stateDir: "/s", marker },
      opts.resume,
    ) as string;
    const proc = Bun.spawn(["/bin/sh", "-c", line], {
      env: { HOME: home, PATH: "/usr/bin:/bin" },
      stdout: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    return { argv: out.trim().split("\n"), markerLeft: existsSync(marker) };
  }

  test("resumes the exact conversation, and spends the marker", async () => {
    const r = await launch({ marker: ID, transcript: true });
    expect(r.argv).toEqual(["--model", "opus", "--resume", ID]);
    expect(r.markerLeft).toBe(false);
  });

  test("drops --continue in favour of the exact conversation", async () => {
    const r = await launch({
      args: ["--continue", "--model", "opus"],
      marker: ID,
      transcript: true,
    });
    expect(r.argv).toEqual(["--model", "opus", "--resume", ID]);
  });

  test("starts fresh when the transcript is gone", async () => {
    const r = await launch({ marker: ID, transcript: false });
    expect(r.argv).toEqual(["--model", "opus"]);
    expect(r.markerLeft).toBe(false);
  });

  test("ignores a marker that is not a conversation id", async () => {
    const r = await launch({ marker: "$(touch /tmp/x)", transcript: true });
    expect(r.argv).toEqual(["--model", "opus"]);
  });

  test("launches as before with no marker, restore included", async () => {
    expect((await launch({})).argv).toEqual(["--model", "opus"]);
    expect((await launch({ resume: true })).argv).toEqual([
      "--model",
      "opus",
      "--continue",
    ]);
  });
});
