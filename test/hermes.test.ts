import { describe, expect, test } from "bun:test";
import { tokenize } from "../server/profiles.ts";
import {
  buildArgs,
  type HermesSettings,
  parseSettings,
} from "../src/chrome/hermesFlags.ts";

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
    ["a hermes profile", ["--profile", "deepseek"]],
    ["the full-screen interface", ["--tui"]],
    ["the classic interface", ["--cli"]],
    [
      "everything at once",
      [
        "--model",
        "deepseek-v4-flash",
        "--provider",
        "deepseek",
        "--profile",
        "work",
        "--tui",
        "--yolo",
        "--continue",
      ],
    ],
    // Short forms are understood on the way in and normalised on the way out,
    // so `-m opus` typed into the advanced field becomes a model selection.
    [
      "short forms normalise",
      ["-m", "opus", "-p", "work"],
      ["--model", "opus", "--profile", "work"],
    ],
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
    expect(parsed.model).toBe("");
    expect(parsed.extra).toBe("--model");
  });

  test("--model followed by a flag does not eat it", () => {
    const parsed = parseSettings(["--model", "--yolo"]);
    expect(parsed.model).toBe("");
    expect(parsed.toggles["--yolo"]).toBe(true);
  });
});

describe("the interface segment", () => {
  /** One value, so there is no state in which both flags can be written. */
  test("never writes both", () => {
    const both = parseSettings(["--tui", "--cli"]);
    expect(both.interface).toBe("cli");
    expect(cycle(["--tui", "--cli"])).toEqual(["--cli"]);
  });

  test("empty writes neither", () => {
    const settings: HermesSettings = {
      model: "",
      provider: "",
      hermesProfile: "",
      interface: "",
      toggles: {},
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
