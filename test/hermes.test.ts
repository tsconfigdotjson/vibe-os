import { describe, expect, test } from "bun:test";
import { hermes, reasoningLevels } from "../server/harnesses/hermes.ts";
import { versionToken as hermesVersion } from "../server/harnesses/util.ts";
import { tokenize } from "../server/profiles.ts";
import {
  buildArgs as build,
  type FlagSettings,
  parseArgs,
} from "../shared/harness.ts";

const parseSettings = (argv: string[]) => parseArgs(hermes.spec, argv);
const buildArgs = (settings: FlagSettings) => build(hermes.spec, settings);

/**
 * The contract this file exists to hold.
 *
 * A profile stores argv, the editor shows controls, and the two have to be the
 * same thing seen twice. Every save of an unmodified profile runs a full cycle:
 * stored tokens in, controls out, controls back to a string, and the server
 * tokenises that string again. Anything the controls do not recognise has to
 * survive all four steps in its original order, because that is where a
 * hand-written flag lives.
 */
const cycle = (argv: string[]): string[] =>
  tokenize(buildArgs(parseSettings(argv)));

describe("round trip", () => {
  const corpus: [name: string, argv: string[], expected?: string[]][] = [
    ["nothing at all", []],
    [
      "model and provider",
      ["--model", "deepseek-v4-flash", "--provider", "deepseek"],
    ],
    ["yolo alone", ["--yolo"]],
    [
      "every switch",
      [
        "--yolo",
        "--continue",
        "--ignore-rules",
        "--ignore-user-config",
        "--safe-mode",
        "--pass-session-id",
      ],
    ],
    ["a reasoning level", ["--reasoning", "xhigh"]],
    ["the full-screen interface", ["--tui"]],
    ["the classic interface", ["--cli"]],
    [
      "everything at once",
      [
        "--model",
        "deepseek-v4-flash",
        "--provider",
        "deepseek",
        "--reasoning",
        "high",
        "--tui",
        "--yolo",
        "--continue",
      ],
    ],
    // Short forms are understood on the way in and normalised on the way out,
    // so `-m opus` typed into the advanced field becomes a model selection.
    ["the short model form normalises", ["-m", "opus"], ["--model", "opus"]],
    ["bare -c is the continue switch", ["-c"], ["--continue"]],
    // Order is the composer's, not the input's: controls first, then extra.
    [
      "reordered to the composer's order",
      ["--yolo", "--provider", "nous", "--model", "hermes-4"],
      ["--model", "hermes-4", "--provider", "nous", "--yolo"],
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
    expect(cycle(["--dev"])).toEqual(["--dev"]);
  });

  test("an unknown valued flag keeps its value", () => {
    expect(cycle(["--append-system-prompt", "be terse"])).toEqual([
      "--append-system-prompt",
      "be terse",
    ]);
  });

  /**
   * `-c mine` resumes a named session, which no control here can express. The
   * pair has to stay together: splitting it would leave `mine` as a bare
   * positional, which Hermes would read as the first prompt of the session.
   */
  test("-c with a session name stays a pair in extra", () => {
    const parsed = parseSettings(["-c", "mine"]);
    expect(parsed.toggles["--continue"]).toBeUndefined();
    expect(cycle(["-c", "mine"])).toEqual(["-c", "mine"]);
  });

  test("a known flag and an unknown one both survive", () => {
    expect(cycle(["--yolo", "--dev", "--model", "opus"])).toEqual([
      "--model",
      "opus",
      "--yolo",
      "--dev",
    ]);
  });

  /**
   * A valued flag with nothing after it is malformed. It goes to the advanced
   * field so it can be seen and fixed, rather than swallowing whatever followed
   * or disappearing into a control that cannot show it.
   */
  test("a trailing --model is kept, not swallowed", () => {
    const parsed = parseSettings(["--yolo", "--model"]);
    expect(parsed.values.model).toBeUndefined();
    expect(parsed.extra).toBe("--model");
  });

  test("--model followed by a flag does not eat it", () => {
    const parsed = parseSettings(["--model", "--yolo"]);
    expect(parsed.values.model).toBeUndefined();
    expect(parsed.toggles["--yolo"]).toBe(true);
  });
});

describe("the interface segment", () => {
  /** One value, so there is no state in which both flags can be written. */
  test("never writes both", () => {
    const both = parseSettings(["--tui", "--cli"]);
    expect(both.values.interface).toBe("cli");
    expect(cycle(["--tui", "--cli"])).toEqual(["--cli"]);
  });

  test("empty writes neither", () => {
    const settings: FlagSettings = {
      values: {},
      suffixes: {},
      toggles: {},
      mcp: "all",
      mcpConfigs: [],
      extra: "",
    };
    expect(buildArgs(settings)).toBe("");
  });
});

describe("values that need quoting", () => {
  /**
   * A model id with a space in it is not something any provider ships, but the
   * advanced field is free text and the tokeniser is the only thing between it
   * and execve. The same corpus in profiles.test.ts covers the general case;
   * this covers it arriving through a control rather than through `extra`.
   */
  test("a spaced model id stays one token", () => {
    expect(cycle(["--model", "gpt 5.5"])).toEqual(["--model", "gpt 5.5"]);
  });

  test("an apostrophe survives", () => {
    expect(cycle(["--append-system-prompt", "don't guess"])).toEqual([
      "--append-system-prompt",
      "don't guess",
    ]);
  });
});

/**
 * `hermes --version` prints a block, not a line.
 *
 * The fixture is verbatim from the VPS. The first version of this took the last
 * token of the whole output and reported the agent as version "status.", which
 * is what the last line of that block ends with.
 */
describe("hermesVersion", () => {
  const REAL = `Hermes Agent v0.20.0 (2026.8.3)
Install directory: /home/ubuntu/.hermes/hermes-agent
Python: 3.11.15
OpenAI SDK: 2.24.0
Run 'hermes version' for update status.
`;

  test("reads the agent's own version, not the last thing printed", () => {
    expect(hermesVersion(REAL)).toBe("0.20.0");
  });

  test("ignores the Python and SDK versions below it", () => {
    expect(hermesVersion(REAL)).not.toBe("3.11.15");
    expect(hermesVersion(REAL)).not.toBe("2.24.0");
  });

  test("a bare version is still a version", () => {
    expect(hermesVersion("1.2.3\n")).toBe("1.2.3");
    expect(hermesVersion("v1.2.3")).toBe("1.2.3");
  });

  test("a prerelease suffix survives", () => {
    expect(hermesVersion("Hermes Agent v1.2.3-rc1 (x)")).toBe("1.2.3-rc1");
  });

  /** Better no version than a wrong one: the label falls back to "installed". */
  test("nothing version-shaped is null", () => {
    expect(hermesVersion("")).toBeNull();
    expect(hermesVersion("Hermes Agent\n1.2.3\n")).toBeNull();
  });
});

/**
 * `--reasoning` levels, read off the box rather than hardcoded.
 *
 * The fixture is verbatim from `hermes chat --help` on the VPS, wrapped exactly
 * as argparse wrapped it. That wrapping is the whole difficulty: the list spans
 * two lines and ends with "or ultra." rather than a comma.
 */
describe("reasoningLevels", () => {
  const REAL = `  -m MODEL, --model MODEL
                        Model to use (e.g., anthropic/claude-sonnet-4)
  --reasoning LEVEL     Reasoning effort for this session: none, minimal, low,
                        medium, high, xhigh, max, or ultra. Overrides
                        agent.reasoning_effort for this run only (same levels
                        as the /reasoning slash command).
  --provider PROVIDER   Inference provider (default: auto).
`;

  test("reads the ladder across a wrapped line", () => {
    expect(reasoningLevels(REAL)).toEqual([
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]);
  });

  /** The order is the scale, so it has to survive in the order it was written. */
  test("keeps them weakest first", () => {
    const levels = reasoningLevels(REAL);
    expect(levels[0]).toBe("none");
    expect(levels[levels.length - 1]).toBe("ultra");
  });

  test("no flag means no answer, and the caller uses its own ladder", () => {
    expect(reasoningLevels("")).toEqual([]);
    expect(reasoningLevels("  --model MODEL   Model to use\n")).toEqual([]);
  });

  /**
   * Half a list read out of a paragraph is worse than no list. If any token
   * fails to look like a level the whole match is discarded.
   */
  test("a sentence is discarded rather than half-parsed", () => {
    expect(
      reasoningLevels(
        "  --reasoning LEVEL   Set this however you like, it is your call.\n",
      ),
    ).toEqual([]);
  });

  test("a single token is not a ladder", () => {
    expect(reasoningLevels("  --reasoning LEVEL   Levels: high.\n")).toEqual(
      [],
    );
  });
});
