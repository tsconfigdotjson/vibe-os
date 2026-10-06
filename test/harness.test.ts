import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  harness,
  harnessProblems,
  isHarness,
  loadHarnesses,
  validateSpec,
} from "../server/harness.ts";
import { claude } from "../server/harnesses/claude.ts";
import {
  codex,
  codexDefaults,
  parseCodexModels,
} from "../server/harnesses/codex.ts";
import { loggedIn, output } from "../server/harnesses/util.ts";
import { tokenize } from "../server/profiles.ts";
import { harnessCommand } from "../server/session.ts";
import {
  buildArgs,
  type HarnessSpec,
  initialSettings,
  parseArgs,
} from "../shared/harness.ts";

/** Stored tokens in, controls out, controls back to a string, tokenised again. */
const cycle = (spec: HarnessSpec, argv: string[]): string[] =>
  tokenize(buildArgs(spec, parseArgs(spec, argv)));

const profile = (harness: string, args: string[] = []) =>
  ({
    id: "p",
    projectId: "x",
    color: "cyan",
    name: "R",
    harness,
    command: null,
    args,
    prompt: "",
    memoryHigh: null,
    memoryMax: null,
    position: 0,
    createdAt: 0,
  }) as Parameters<typeof harnessCommand>[0];

const where = { cwd: "/w", stateDir: "/s" };

describe("claude flags", () => {
  const spec = claude.spec;

  test("the context-window suffix is its own control", () => {
    const parsed = parseArgs(spec, ["--model", "opus[1m]"]);
    expect(parsed.values.model).toBe("opus");
    expect(parsed.suffixes.model).toBe(true);
    expect(cycle(spec, ["--model", "opus[1m]"])).toEqual([
      "--model",
      "opus[1m]",
    ]);
  });

  test("skipping every check beats a permission mode, in either order", () => {
    for (const argv of [
      ["--dangerously-skip-permissions", "--permission-mode", "plan"],
      ["--permission-mode", "plan", "--dangerously-skip-permissions"],
    ]) {
      expect(parseArgs(spec, argv).values.permission).toBe("skip");
      expect(cycle(spec, argv)).toEqual(["--dangerously-skip-permissions"]);
    }
  });

  test("the three MCP states", () => {
    expect(parseArgs(spec, []).mcp).toBe("all");
    expect(parseArgs(spec, ["--strict-mcp-config"]).mcp).toBe("none");
    const pick = parseArgs(spec, [
      "--strict-mcp-config",
      "--mcp-config",
      "/a.json",
      "/b.json",
    ]);
    expect(pick.mcp).toBe("pick");
    expect(pick.mcpConfigs).toEqual(["/a.json", "/b.json"]);
  });

  /** "The box's servers and also these" is not a state the control can show. */
  test("a config without the strict flag goes to extra untouched", () => {
    const parsed = parseArgs(spec, ["--mcp-config", "/a.json"]);
    expect(parsed.mcp).toBe("all");
    expect(parsed.extra).toBe("--mcp-config /a.json");
  });

  test("a new profile starts with the spec's defaults", () => {
    expect(buildArgs(spec, initialSettings(spec))).toBe(
      "--dangerously-skip-permissions",
    );
  });
});

/**
 * Codex, the harness that landed as the proof that a new one is one file.
 *
 * Its thinking level is a config override, `-c model_reasoning_effort=high`,
 * sharing `-c` with every other override, and it resumes with a subcommand.
 */
describe("codex flags", () => {
  const spec = codex.spec;

  test("the thinking level reads out of -c and back into it", () => {
    const parsed = parseArgs(spec, ["-c", "model_reasoning_effort=high"]);
    expect(parsed.values.effort).toBe("high");
    expect(parsed.extra).toBe("");
    expect(cycle(spec, ["-c", "model_reasoning_effort=high"])).toEqual([
      "-c",
      "model_reasoning_effort=high",
    ]);
  });

  test("any other -c stays a pair in extra, exactly as written", () => {
    const parsed = parseArgs(spec, ["-c", 'model="o3"']);
    expect(parsed.values.effort).toBeUndefined();
    expect(cycle(spec, ["-c", 'model="o3"'])).toEqual(["-c", 'model="o3"']);
  });

  test("short forms normalise", () => {
    expect(
      cycle(spec, ["-m", "gpt-5.5", "-s", "read-only", "-a", "never"]),
    ).toEqual([
      "--model",
      "gpt-5.5",
      "--sandbox",
      "read-only",
      "--ask-for-approval",
      "never",
    ]);
  });

  test("an unknown valued flag keeps its value", () => {
    expect(cycle(spec, ["--profile", "work"])).toEqual(["--profile", "work"]);
  });

  test("launches codex with the stored flags", () => {
    const cmd = harnessCommand(profile("codex", ["--search"]), where) as string;
    expect(cmd.endsWith("exec 'codex' '--search'")).toBe(true);
  });

  /** `codex resume --last` takes the root command's flags after it. */
  test("resumes with the subcommand, ahead of the flags", () => {
    const cmd = harnessCommand(
      profile("codex", ["--model", "gpt-5.5"]),
      where,
      true,
    ) as string;
    expect(cmd).toContain("exec 'codex' 'resume' '--last' '--model' 'gpt-5.5'");
  });
});

describe("resume", () => {
  test("a flag-style resume goes after the profile's flags", () => {
    const cmd = harnessCommand(profile("claude", ["--verbose"]), where, true);
    expect(cmd).toContain("exec 'claude' '--verbose' '--continue'");
  });

  test("not twice, when the profile already picks a conversation", () => {
    const cmd = harnessCommand(profile("claude", ["-c"]), where, true);
    expect(cmd?.match(/--continue/g) ?? []).toEqual([]);
  });

  test("Hermes resumes after its subcommand and the flags", () => {
    const cmd = harnessCommand(profile("hermes", ["--yolo"]), where, true);
    expect(cmd).toContain("exec 'hermes' 'chat' '--yolo' '--continue'");
  });
});

/**
 * `codex debug models`, abridged from codex-cli 0.160.1: two listed models out
 * of priority order, and a hidden internal one that must stay hidden.
 */
describe("parseCodexModels", () => {
  const REAL = JSON.stringify({
    models: [
      {
        slug: "gpt-6-astra",
        display_name: "GPT-6-Astra",
        visibility: "list",
        priority: 2,
        supported_reasoning_levels: [
          { effort: "low" },
          { effort: "medium" },
          { effort: "high" },
          { effort: "xhigh" },
          { effort: "max" },
          { effort: "ultra" },
        ],
      },
      {
        slug: "gpt-6.1-sol",
        display_name: "GPT-6.1-Sol",
        visibility: "list",
        priority: 1,
        supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }],
      },
      {
        slug: "codex-auto-review",
        display_name: "Codex Auto Review",
        visibility: "hide",
        priority: 43,
        supported_reasoning_levels: [{ effort: "low" }],
      },
    ],
  });

  test("lists the visible models in Codex's own order", () => {
    expect(parseCodexModels(REAL).models.map((m) => m.value)).toEqual([
      "gpt-6.1-sol",
      "gpt-6-astra",
    ]);
  });

  test("labels a model with its display name and its id", () => {
    expect(parseCodexModels(REAL).models[0].label).toBe(
      "GPT-6.1-Sol (gpt-6.1-sol)",
    );
  });

  test("the ladder is the longest one, in order", () => {
    expect(parseCodexModels(REAL).effort).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]);
  });

  test("anything else is nothing, not a crash", () => {
    expect(parseCodexModels("")).toEqual({ models: [], effort: [] });
    expect(parseCodexModels("{}")).toEqual({ models: [], effort: [] });
  });
});

describe("codexDefaults", () => {
  test("reads the top-level model and effort", () => {
    expect(
      codexDefaults(
        'model = "gpt-6-sol"\nmodel_reasoning_effort = "high"\n\n[profiles.fast]\nmodel = "gpt-6-luna"\n',
      ),
    ).toEqual({ model: "gpt-6-sol", effort: "high" });
  });

  test("a key inside a table is not the default", () => {
    expect(codexDefaults('[profiles.x]\nmodel = "o3"\n')).toEqual({});
  });
});

/**
 * Login status, which is an answer whatever the exit code.
 *
 * `codex login status` on a logged-out box prints "Not logged in" to stderr
 * and exits 1, verbatim from codex-cli 0.160.1.
 */
describe("login status", () => {
  test("stderr and a failing exit still count as the answer", async () => {
    const text = await output("/bin/sh", [
      "-c",
      "echo 'Not logged in' >&2; exit 1",
    ]);
    expect(text).not.toBeNull();
    expect(loggedIn(text as string)).toBe(false);
  });

  test("Codex's logged-in line", () => {
    expect(loggedIn("Logged in using ChatGPT\n")).toBe(true);
  });
});

describe("user harnesses", () => {
  const aider = {
    id: "aider",
    label: "Aider",
    command: "aider",
    paths: ["~/.local/bin/aider"],
    defaults: ["--yes-always"],
    fields: [
      {
        kind: "select",
        key: "model",
        label: "Model",
        flag: "--model",
        free: true,
        options: ["sonnet", "gpt-4o"],
      },
      { kind: "toggle", flag: "--yes-always", label: "Skip confirmations" },
    ],
    valued: ["--edit-format"],
  };

  // Back to built-ins only, so no other test sees a file from this one.
  afterEach(async () => {
    loadHarnesses(await mkdtemp(path.join(tmpdir(), "vibe-harness-")));
  });

  async function stateDirWith(files: Record<string, unknown>) {
    const dir = await mkdtemp(path.join(tmpdir(), "vibe-harness-"));
    await Bun.$`mkdir -p ${path.join(dir, "harnesses")}`.quiet();
    for (const [name, body] of Object.entries(files))
      await writeFile(
        path.join(dir, "harnesses", name),
        typeof body === "string" ? body : JSON.stringify(body),
      );
    return dir;
  }

  test("a JSON file is a harness: listed, launchable, editable", async () => {
    loadHarnesses(await stateDirWith({ "aider.json": aider }));
    expect(isHarness("aider")).toBe(true);
    const spec = harness("aider")?.spec as HarnessSpec;
    expect(cycle(spec, ["--model", "sonnet", "--yes-always"])).toEqual([
      "--model",
      "sonnet",
      "--yes-always",
    ]);
    expect(harnessCommand(profile("aider", ["--yes-always"]), where)).toContain(
      "exec 'aider' '--yes-always'",
    );
    expect(harnessProblems()).toEqual([]);
  });

  test("a bad file is skipped and reported, and the rest still load", async () => {
    loadHarnesses(
      await stateDirWith({
        "aider.json": aider,
        "broken.json": "{ not json",
        "claude.json": { ...aider, id: "claude" },
      }),
    );
    expect(isHarness("aider")).toBe(true);
    expect(harness("claude")?.spec.command).toBe("claude");
    const problems = harnessProblems();
    expect(problems.map((p) => path.basename(p.file))).toEqual([
      "broken.json",
      "claude.json",
    ]);
    expect(problems[1].error).toContain("taken");
  });

  test("shell and custom are always harnesses", () => {
    expect(isHarness("shell")).toBe(true);
    expect(isHarness("custom")).toBe(true);
    expect(isHarness("nope")).toBe(false);
  });

  describe("validateSpec", () => {
    test("accepts a minimal spec", () => {
      expect(
        validateSpec({ id: "amp", label: "Amp", command: "amp", fields: [] }),
      ).toMatchObject({ id: "amp", command: "amp", fields: [] });
    });

    const bad: [string, unknown, string][] = [
      ["a typo'd key", { ...aider, feilds: [] }, 'unknown key "feilds"'],
      ["an id with capitals", { ...aider, id: "Aider" }, "id must be"],
      ["no command", { ...aider, command: "" }, "command must be"],
      [
        "a flag without a dash",
        {
          ...aider,
          fields: [{ kind: "toggle", flag: "yes", label: "Yes" }],
        },
        "must start with -",
      ],
      [
        "a select with nothing to write",
        { ...aider, fields: [{ kind: "select", key: "m", label: "M" }] },
        "needs a flag",
      ],
      [
        "a field kind JSON cannot have",
        {
          ...aider,
          fields: [
            { kind: "mcp", key: "m", label: "M", strict: "-a", config: "-b" },
          ],
        },
        'must be "select" or "toggle"',
      ],
      [
        "an argument that spans lines",
        { ...aider, defaults: ["--a\nrm -rf"] },
        "cannot span lines",
      ],
    ];
    for (const [name, spec, message] of bad) {
      test(`rejects ${name}`, () => {
        expect(() => validateSpec(spec)).toThrow(message);
      });
    }
  });
});
