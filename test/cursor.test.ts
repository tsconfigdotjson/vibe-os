import { describe, expect, test } from "bun:test";
import {
  cursorLoggedIn,
  cursorVersion,
  parseCursorModels,
} from "../server/harness.ts";
import { tokenize } from "../server/profiles.ts";
import { harnessCommand } from "../server/session.ts";
import {
  buildArgs,
  type CursorSettings,
  parseSettings,
} from "../src/chrome/cursorFlags.ts";

/**
 * The same contract hermes.test.ts holds, for the third harness.
 *
 * A profile stores argv, the editor shows controls, and the two have to be the
 * same thing seen twice. Every save of an unmodified profile runs a full cycle:
 * stored tokens in, controls out, controls back to a string, and the server
 * tokenises that string again. Anything the controls do not recognise has to
 * survive all four steps in its original order.
 */
const cycle = (argv: string[]): string[] =>
  tokenize(buildArgs(parseSettings(argv)));

describe("round trip", () => {
  const corpus: [name: string, argv: string[], expected?: string[]][] = [
    ["nothing at all", []],
    ["a model", ["--model", "composer-2.5"]],
    ["force alone", ["--force"]],
    ["both switches", ["--force", "--trust"]],
    ["everything at once", ["--model", "gpt-5.5", "--force", "--trust"]],
    // Short forms are understood on the way in and normalised on the way out,
    // so `-m gpt-5.5` typed into the advanced field becomes a model selection.
    [
      "the short model form normalises",
      ["-m", "gpt-5.5"],
      ["--model", "gpt-5.5"],
    ],
    // The CLI documents --yolo as the same switch as --force, so it lights the
    // same toggle rather than sitting in extra as text nothing recognises.
    ["--yolo is the force switch", ["--yolo"], ["--force"]],
    // Order is the composer's, not the input's: controls first, then extra.
    [
      "reordered to the composer's order",
      ["--trust", "--model", "auto"],
      ["--model", "auto", "--trust"],
    ],
  ];

  for (const [name, argv, expected] of corpus) {
    test(name, () => {
      expect(cycle(argv)).toEqual(expected ?? argv);
    });
  }
});

describe("flags the controls do not own", () => {
  test("an unknown flag survives", () => {
    expect(cycle(["--fullscreen"])).toEqual(["--fullscreen"]);
  });

  test("an unknown valued flag keeps its value", () => {
    expect(cycle(["--output-format", "stream-json"])).toEqual([
      "--output-format",
      "stream-json",
    ]);
  });

  /**
   * `--resume abc123` names a chat, which no control here can express. The
   * pair has to stay together: splitting it would leave the id as a bare
   * positional, which cursor-agent would read as the first prompt.
   */
  test("--resume with a chat id stays a pair in extra", () => {
    const parsed = parseSettings(["--resume", "abc123"]);
    expect(parsed.extra).toBe("--resume abc123");
    expect(cycle(["--resume", "abc123"])).toEqual(["--resume", "abc123"]);
  });

  test("bare --resume survives without eating the next flag", () => {
    const parsed = parseSettings(["--resume", "--force"]);
    expect(parsed.extra).toBe("--resume");
    expect(parsed.toggles["--force"]).toBe(true);
  });

  test("a known flag and an unknown one both survive", () => {
    expect(cycle(["--force", "-p", "--model", "auto"])).toEqual([
      "--model",
      "auto",
      "--force",
      "-p",
    ]);
  });

  /**
   * A valued flag with nothing after it is malformed. It goes to the advanced
   * field so it can be seen and fixed, rather than swallowing whatever
   * followed or disappearing into a control that cannot show it.
   */
  test("a trailing --model is kept, not swallowed", () => {
    const parsed = parseSettings(["--force", "--model"]);
    expect(parsed.model).toBe("");
    expect(parsed.extra).toBe("--model");
  });

  test("--model followed by a flag does not eat it", () => {
    const parsed = parseSettings(["--model", "--force"]);
    expect(parsed.model).toBe("");
    expect(parsed.toggles["--force"]).toBe(true);
  });
});

describe("values that need quoting", () => {
  test("a spaced model id stays one token", () => {
    expect(cycle(["--model", "gpt 5.5"])).toEqual(["--model", "gpt 5.5"]);
  });

  test("an apostrophe survives", () => {
    expect(cycle(["--workspace", "it's here"])).toEqual([
      "--workspace",
      "it's here",
    ]);
  });

  test("empty settings write nothing", () => {
    const settings: CursorSettings = { model: "", toggles: {}, extra: "" };
    expect(buildArgs(settings)).toBe("");
  });
});

/**
 * The command a Cursor profile launches.
 *
 * `cursor-agent`, not `agent`: the installer symlinks both at the same binary
 * and only one of them is unambiguous. No leading subcommand either, unlike
 * Hermes — the flags belong to the root command.
 */
describe("harnessCommand", () => {
  const profile = (args: string[]) => ({
    id: "p",
    projectId: "x",
    color: "cyan",
    name: "R",
    harness: "cursor" as const,
    command: null,
    args,
    prompt: "",
    position: 0,
    createdAt: 0,
  });

  test("launches cursor-agent with the stored flags", () => {
    const cmd = harnessCommand(profile(["--model", "auto", "--force"]));
    expect(cmd).toContain("exec 'cursor-agent' '--model' 'auto' '--force'");
  });

  test("prepends no subcommand", () => {
    const cmd = harnessCommand(profile([])) as string;
    expect(cmd.endsWith("exec 'cursor-agent'")).toBe(true);
  });
});

/**
 * `cursor-agent --version` parsing.
 *
 * Cursor's versions are date-shaped — `2026.08.07-abc1234` — which is still
 * "digits and dots, then whatever" and must survive whole, suffix included.
 */
describe("cursorVersion", () => {
  test("reads a date-shaped version", () => {
    expect(cursorVersion("2026.08.07-abc1234\n")).toBe("2026.08.07-abc1234");
  });

  test("reads it out of a sentence on the first line", () => {
    expect(cursorVersion("cursor-agent version 2026.08.07-abc1234\n")).toBe(
      "2026.08.07-abc1234",
    );
  });

  test("skips leading blank lines but not later ones", () => {
    expect(
      cursorVersion("\n2026.08.07-x\nupdate available: 2026.09.01\n"),
    ).toBe("2026.08.07-x");
  });

  test("a semver is still a version", () => {
    expect(cursorVersion("v1.2.3")).toBe("1.2.3");
  });

  /** Better no version than a wrong one: the label falls back to "installed". */
  test("nothing version-shaped is null", () => {
    expect(cursorVersion("")).toBeNull();
    expect(cursorVersion("cursor-agent\n")).toBeNull();
  });
});

/**
 * `cursor-agent models` parsing.
 *
 * The layout is undocumented, so the parser reads shapes rather than
 * positions: model-shaped tokens count, prose does not, and a marker on a line
 * answers which model is the default.
 */
describe("parseCursorModels", () => {
  test("reads a plain indented list under a header", () => {
    const out = `Available models:
  auto
  composer-2.5
  gpt-5.5
  claude-sonnet-4.6
`;
    expect(parseCursorModels(out)).toEqual({
      models: ["auto", "composer-2.5", "gpt-5.5", "claude-sonnet-4.6"],
      defaultModel: null,
    });
  });

  test("keeps the printed order rather than sorting", () => {
    const { models } = parseCursorModels("auto\nzeta\nalpha\n");
    expect(models).toEqual(["auto", "zeta", "alpha"]);
  });

  test("a starred line is the default", () => {
    const out = "* composer-2.5\n- gpt-5.5\n";
    expect(parseCursorModels(out)).toEqual({
      models: ["composer-2.5", "gpt-5.5"],
      defaultModel: "composer-2.5",
    });
  });

  test("a (current) suffix is the default", () => {
    const out = "  auto (current)\n  gpt-5.5\n";
    expect(parseCursorModels(out)).toEqual({
      models: ["auto", "gpt-5.5"],
      defaultModel: "auto",
    });
  });

  test("prose and prompts are skipped, not half-read", () => {
    const out = `You are not logged in.
Run cursor-agent login to see your models.
`;
    expect(parseCursorModels(out)).toEqual({ models: [], defaultModel: null });
  });

  test("duplicates collapse", () => {
    expect(parseCursorModels("auto\nauto\n").models).toEqual(["auto"]);
  });
});

/**
 * `cursor-agent status` parsing, three-valued on purpose.
 *
 * "Not logged in" contains "logged in", which is exactly the trap the negative
 * check existing first is for. Anything unreadable is null — only a definite
 * "no" should make the editor warn.
 */
describe("cursorLoggedIn", () => {
  test("logged in", () => {
    expect(cursorLoggedIn("✓ Logged in as lee@example.com\n")).toBe(true);
  });

  test("not logged in wins over its own substring", () => {
    expect(cursorLoggedIn("Not logged in. Run cursor-agent login.\n")).toBe(
      false,
    );
  });

  test("something unreadable is null, not false", () => {
    expect(cursorLoggedIn("Status: fine\n")).toBeNull();
    expect(cursorLoggedIn("")).toBeNull();
  });
});
