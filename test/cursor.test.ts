import { describe, expect, test } from "bun:test";
import {
  cursorLoggedIn,
  cursorVersion,
  parseCursorModels,
} from "../server/harness.ts";
import { tokenize } from "../server/profiles.ts";
import { cursorProjectSlug, harnessCommand } from "../server/session.ts";
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
    ["the mcp approval switch", ["--approve-mcps"]],
    [
      "everything at once",
      ["--model", "gpt-5.5", "--force", "--trust", "--approve-mcps"],
    ],
    // Short forms are understood on the way in and normalised on the way out,
    // so `-m gpt-5.5` typed into the advanced field becomes a model selection.
    [
      "the short model form normalises",
      ["-m", "gpt-5.5"],
      ["--model", "gpt-5.5"],
    ],
    // The CLI documents --yolo and -f as the same switch as --force, so they
    // light the same toggle rather than sitting in extra as text nothing
    // recognises.
    ["--yolo is the force switch", ["--yolo"], ["--force"]],
    ["-f is the force switch", ["-f"], ["--force"]],
    ["the continue switch", ["--continue"]],
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

  /** `-w` behaves like `--resume`: bare means "make one up", valued names one. */
  test("-w with a name stays a pair in extra", () => {
    expect(cycle(["-w", "scratch"])).toEqual(["-w", "scratch"]);
    expect(parseSettings(["-w", "--force"]).extra).toBe("-w");
  });

  test("a valued mode flag keeps its pair", () => {
    expect(cycle(["--mode", "plan"])).toEqual(["--mode", "plan"]);
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
  const profile = (args: string[], harness = "cursor") =>
    ({
      id: "p",
      projectId: "x",
      color: "cyan",
      name: "R",
      harness,
      command: null,
      args,
      prompt: "",
      position: 0,
      createdAt: 0,
    }) as Parameters<typeof harnessCommand>[0];

  const where = {
    cwd: "/home/ubuntu/workspace/.vibe-worktrees/jooba/bold-coral-lemur",
    stateDir: "/home/ubuntu/.vibe-os",
  };

  test("launches cursor-agent with the stored flags", () => {
    const cmd = harnessCommand(profile(["--model", "auto", "--force"]), where);
    expect(cmd).toContain("exec 'cursor-agent' '--model' 'auto' '--force'");
  });

  test("prepends no subcommand", () => {
    const cmd = harnessCommand(profile([]), where) as string;
    expect(cmd.endsWith("exec 'cursor-agent'")).toBe(true);
  });
});

/**
 * The directory name Cursor derives from a working directory.
 *
 * Both fixtures are observed rather than documented: the slug appeared under
 * `~/.cursor/projects` on a real box after running `cursor-agent` in each of
 * these directories. Getting it wrong is not fatal — the link lands where
 * Cursor does not look, and a window asks for a login as it did before — but it
 * is the whole point of the exercise, so it is pinned.
 */
describe("cursorProjectSlug", () => {
  test("dashes a worktree path and drops the leading slash", () => {
    expect(
      cursorProjectSlug(
        "/home/ubuntu/workspace/.vibe-worktrees/jooba/bold-coral-lemur",
      ),
    ).toBe("home-ubuntu-workspace-vibe-worktrees-jooba-bold-coral-lemur");
  });

  test("keeps case and collapses every run of anything else to one dash", () => {
    expect(cursorProjectSlug("/tmp/Cursor.Test_1 space/sub")).toBe(
      "tmp-Cursor-Test-1-space-sub",
    );
  });

  test("a trailing slash leaves no trailing dash", () => {
    expect(cursorProjectSlug("/home/ubuntu/")).toBe("home-ubuntu");
  });
});

/**
 * The link that makes one MCP login serve every workspace.
 *
 * Cursor keeps MCP tokens in `~/.cursor/projects/<slug>/mcp-auth.json`, so a
 * freshly cut worktree starts logged out of every server the box is logged into.
 * These assert the shape of the fix rather than its effect, which only a real
 * install can show: the link goes in the directory Cursor will read, points at
 * one store under the state dir, and refuses to replace anything already there.
 */
describe("the Cursor MCP credential link", () => {
  const profile = (harness: string) =>
    ({
      id: "p",
      projectId: "x",
      color: "cyan",
      name: "R",
      harness,
      command: harness === "custom" ? "vim" : null,
      args: [],
      prompt: "",
      position: 0,
      createdAt: 0,
    }) as Parameters<typeof harnessCommand>[0];

  const where = {
    cwd: "/home/ubuntu/workspace/.vibe-worktrees/jooba/bold-coral-lemur",
    stateDir: "/home/ubuntu/.vibe-os",
  };
  const link =
    '"$HOME/.cursor/projects/home-ubuntu-workspace-vibe-worktrees-jooba-bold-coral-lemur/mcp-auth.json"';

  test("links the worktree's project dir at the box's one store", () => {
    const cmd = harnessCommand(profile("cursor"), where) as string;
    expect(cmd).toContain(
      `ln -s '/home/ubuntu/.vibe-os/cursor/mcp-auth.json' ${link}`,
    );
  });

  test("creates both directories, since neither is certain to exist", () => {
    const cmd = harnessCommand(profile("cursor"), where) as string;
    expect(cmd).toContain(
      "mkdir -p \"$HOME/.cursor/projects/home-ubuntu-workspace-vibe-worktrees-jooba-bold-coral-lemur\" '/home/ubuntu/.vibe-os/cursor'",
    );
  });

  /** Refresh tokens live in there, so it is no wider than the state dir. */
  test("keeps the store private", () => {
    const cmd = harnessCommand(profile("cursor"), where) as string;
    expect(cmd).toContain("chmod 700 '/home/ubuntu/.vibe-os/cursor'");
  });

  /**
   * A file already there is somebody's real login for that directory, and a
   * link already there is this, done. `ln -sf` would quietly discard the first.
   */
  test("leaves an existing file or link alone", () => {
    const cmd = harnessCommand(profile("cursor"), where) as string;
    expect(cmd).toContain(`[ -e ${link} ] || [ -L ${link} ] || ln -s`);
  });

  test("runs before the harness, which never returns", () => {
    const cmd = harnessCommand(profile("cursor"), where) as string;
    expect(cmd.indexOf("ln -s")).toBeLessThan(cmd.indexOf("exec"));
  });

  test("nothing else pays for it", () => {
    for (const harness of ["claude", "hermes", "custom"]) {
      const cmd = harnessCommand(profile(harness), where) as string;
      expect(cmd).not.toContain("mcp-auth.json");
    }
  });
});

/**
 * `cursor-agent --version` parsing.
 *
 * The fixture is verbatim from the VPS: one line, date-shaped —
 * `2026.08.11-e8db854` — which is still "digits and dots, then whatever" and
 * must survive whole, suffix included.
 */
describe("cursorVersion", () => {
  test("reads the date-shaped version a real install prints", () => {
    expect(cursorVersion("2026.08.11-e8db854\n")).toBe("2026.08.11-e8db854");
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
 * The fixture is verbatim from a logged-in VPS (abridged from 204 lines): an
 * `Available models` header, `id - Display Name` rows with the default marked
 * inside the display half, and a trailing `Tip:` sentence. The first version
 * of this parser expected bare ids and skipped any line containing a space —
 * which was every line, so a working box offered zero models.
 */
describe("parseCursorModels", () => {
  const REAL = `Available models

auto - Auto (default)
gpt-5.3-codex - Codex 5.3
gpt-5.3-codex-fast - Codex 5.3 Fast
composer-2.5 - Composer 2.5
claude-opus-5-thinking-high - Claude Opus 5 1M Thinking
claude-fable-5-thinking-high - Claude Fable 5 1M Thinking (NO ZDR)
cursor-grok-4.6-high - Cursor Grok 4.6
glm-5.2-max - GLM 5.2 Max

Tip: use --model <id> (or /model <id> in interactive mode) to switch. Parameterized models also accept quoted overrides, e.g. --model 'claude-opus-4-8[context=1m,effort=high,fast=false]'.
`;

  test("reads the ids and drops the display names", () => {
    expect(parseCursorModels(REAL).models).toEqual([
      "auto",
      "gpt-5.3-codex",
      "gpt-5.3-codex-fast",
      "composer-2.5",
      "claude-opus-5-thinking-high",
      "claude-fable-5-thinking-high",
      "cursor-grok-4.6-high",
      "glm-5.2-max",
    ]);
  });

  test("the (default) marker in the display half is the default", () => {
    expect(parseCursorModels(REAL).defaultModel).toBe("auto");
  });

  /** A second real account prints the marker as `(current, default)`. */
  test("a shared-parens marker still names the default", () => {
    const { defaultModel } = parseCursorModels(
      "auto - Auto (current, default)\ngpt-5.3-codex - Codex 5.3\n",
    );
    expect(defaultModel).toBe("auto");
  });

  /** A suffix like "(NO ZDR)" is a note, not a marker. */
  test("other parenthesised notes are not the default", () => {
    const { defaultModel } = parseCursorModels(
      "a - A (NO ZDR)\nb - B (default)\n",
    );
    expect(defaultModel).toBe("b");
  });

  test("the header and the tip are skipped, not half-read", () => {
    const { models } = parseCursorModels(REAL);
    expect(models).not.toContain("Available");
    expect(models).not.toContain("Tip");
  });

  test("keeps the printed order rather than sorting", () => {
    const { models } = parseCursorModels("auto - A\nzeta - Z\nalpha - B\n");
    expect(models).toEqual(["auto", "zeta", "alpha"]);
  });

  /** A bare id with no display half is still an id. */
  test("a bare id counts", () => {
    expect(parseCursorModels("auto\n").models).toEqual(["auto"]);
  });

  test("prose and prompts yield nothing", () => {
    const out = `You are not logged in.
Run cursor-agent login to see your models.
Error: Authentication required. Run 'agent login', pass --api-key/--auth-token, or set CURSOR_API_KEY/CURSOR_AUTH_TOKEN.
`;
    expect(parseCursorModels(out)).toEqual({ models: [], defaultModel: null });
  });

  test("duplicates collapse", () => {
    expect(parseCursorModels("auto - A\nauto - A\n").models).toEqual(["auto"]);
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

  /** Verbatim from the VPS: two words, exit code 0. */
  test("not logged in wins over its own substring", () => {
    expect(cursorLoggedIn("Not logged in\n")).toBe(false);
    expect(cursorLoggedIn("Not logged in. Run cursor-agent login.\n")).toBe(
      false,
    );
  });

  test("something unreadable is null, not false", () => {
    expect(cursorLoggedIn("Status: fine\n")).toBeNull();
    expect(cursorLoggedIn("")).toBeNull();
  });
});
