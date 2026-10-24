import { describe, expect, test } from "bun:test";
import {
  atLeast,
  modelOptions,
  parsePiModels,
  pi,
  piDefaults,
  thinkingLevels,
} from "../server/harnesses/pi.ts";
import { versionToken } from "../server/harnesses/util.ts";
import { tokenize } from "../server/profiles.ts";
import { harnessCommand } from "../server/session.ts";
import {
  buildArgs,
  type FlagSettings,
  type HarnessReport,
  initialSettings,
  parseArgs,
} from "../shared/harness.ts";

const spec = pi.spec;
const parse = (argv: string[]) => parseArgs(spec, argv);
const cycle = (argv: string[]) => tokenize(buildArgs(spec, parse(argv)));

const profile = (args: string[] = []) =>
  ({
    id: "p",
    projectId: "x",
    color: "cyan",
    name: "R",
    harness: "pi",
    command: null,
    args,
    prompt: "",
    memoryHigh: null,
    memoryMax: null,
    position: 0,
    createdAt: 0,
  }) as Parameters<typeof harnessCommand>[0];

const where = { cwd: "/w", stateDir: "/s" };

describe("pi flags", () => {
  test("a new profile starts in the regular interface, trusting the worktree", () => {
    expect(buildArgs(spec, initialSettings(spec))).toBe(
      "--tui-mode regular --approve",
    );
  });

  /** No `--thinking` is how a profile gets Pi's default level. */
  test("a new profile leaves thinking to Pi", () => {
    expect(initialSettings(spec).values.thinking).toBeUndefined();
    const settings: FlagSettings = {
      ...initialSettings(spec),
      values: { thinking: "" },
    };
    expect(tokenize(buildArgs(spec, settings))).not.toContain("--thinking");
  });

  test("a model and a thinking level are controls", () => {
    const argv = [
      "--model",
      "opencode-go/deepseek-v4.1-flash",
      "--thinking",
      "high",
    ];
    const parsed = parse(argv);
    expect(parsed.values.model).toBe("opencode-go/deepseek-v4.1-flash");
    expect(parsed.values.thinking).toBe("high");
    expect(parsed.extra).toBe("");
    expect(cycle(argv)).toEqual(argv);
  });

  test("short forms read as their switches", () => {
    const parsed = parse(["-a", "-c", "-nc"]);
    expect(parsed.toggles["--approve"]).toBe(true);
    expect(parsed.toggles["--continue"]).toBe(true);
    expect(parsed.toggles["--no-context-files"]).toBe(true);
    expect(parsed.extra).toBe("");
  });

  test("a valued flag keeps its value in the advanced field", () => {
    const parsed = parse([
      "--append-system-prompt",
      "be brief",
      "--tools",
      "read,bash",
      "--no-approve",
    ]);
    expect(tokenize(parsed.extra)).toEqual([
      "--append-system-prompt",
      "be brief",
      "--tools",
      "read,bash",
      "--no-approve",
    ]);
  });
});

describe("pi launch", () => {
  test("runs pi with the stored flags, after its setup", () => {
    const cmd = harnessCommand(
      profile(["--tui-mode", "regular"]),
      where,
    ) as string;
    expect(cmd).toContain("export PI_PROGRAM_STATUS=1 PI_CLIPBOARD_OSC52=1; ");
    expect(cmd.endsWith("exec 'pi' '--tui-mode' 'regular'")).toBe(true);
  });

  test("resumes with --continue after the flags", () => {
    const cmd = harnessCommand(profile(["--approve"]), where, true) as string;
    expect(cmd.endsWith("exec 'pi' '--approve' '--continue'")).toBe(true);
  });

  test("does not resume a profile that already picks a session", () => {
    for (const pick of [["--session-id", "abc"], ["-r"], ["--no-session"]]) {
      const cmd = harnessCommand(profile(pick), where, true) as string;
      expect(cmd).not.toContain("'--continue'");
    }
  });
});

/** `pi --list-models --offline` on Pi 1.4.0, abridged, with only an OpenCode key. */
const LISTED = `provider     model                        context  max-out  thinking  images
opencode     beam-free                    1.0M     131.1K   yes       no
opencode     deepseek-v4.1-flash          1M       384K     yes       yes
opencode     deepseek-v4.1-flash-free     200K     32K      yes       yes
opencode-go  deepseek-v4-pro              1M       384K     yes       no
opencode-go  deepseek-v4.1-flash          1M       384K     yes       yes
opencode-go  step-5-preview               1M       65.5K    yes       yes
`;

/** The same command on a box with no credentials, verbatim. */
const NONE = `No models available. Use /login to log into a provider via OAuth or API key. See:
  /home/ubuntu/.pi/agent/install/releases/1.4.0/node_modules/@earendil-works/pi-coding-agent/docs/providers.md
  /home/ubuntu/.pi/agent/install/releases/1.4.0/node_modules/@earendil-works/pi-coding-agent/docs/models.md
`;

describe("parsePiModels", () => {
  test("reads every row under the header, in Pi's order", () => {
    const { models, none } = parsePiModels(LISTED);
    expect(none).toBe(false);
    expect(models.map((m) => `${m.provider}/${m.id}`)).toEqual([
      "opencode/beam-free",
      "opencode/deepseek-v4.1-flash",
      "opencode/deepseek-v4.1-flash-free",
      "opencode-go/deepseek-v4-pro",
      "opencode-go/deepseek-v4.1-flash",
      "opencode-go/step-5-preview",
    ]);
  });

  test("offers provider/model, grouped under the provider's name", () => {
    const options = modelOptions(parsePiModels(LISTED).models);
    expect(options[4]).toEqual({
      value: "opencode-go/deepseek-v4.1-flash",
      label: "deepseek-v4.1-flash",
      group: "OpenCode Go",
    });
    expect(options[0].group).toBe("OpenCode Zen");
  });

  test("no credentials is a definite none", () => {
    expect(parsePiModels(NONE)).toEqual({ models: [], none: true });
  });

  test("a provider from models.json can be named anything", () => {
    const { models } = parsePiModels(
      "provider  model  context  max-out  thinking  images\nMy_LLM.local  qwen2.5-coder:7b  32K  8K  no  no\n",
    );
    expect(models).toEqual([
      { provider: "My_LLM.local", id: "qwen2.5-coder:7b" },
    ]);
  });

  test("anything else is could-not-tell", () => {
    expect(parsePiModels("")).toEqual({ models: [], none: false });
    expect(parsePiModels("env: 'node': No such file or directory\n")).toEqual({
      models: [],
      none: false,
    });
  });
});

/** The `--thinking` line of `pi --help` on Pi 1.4.0, with its neighbours. */
const HELP = `  --model <pattern>              Model pattern or ID (supports "provider/id" and optional ":<thinking>")
  --thinking <level>             Set thinking level: off, minimal, low, medium, high, xhigh, max
  --list-models [search]         List available models (with optional fuzzy search)
`;

describe("thinkingLevels", () => {
  test("reads the ladder off the help", () => {
    expect(thinkingLevels(HELP)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  test("help without the flag is nothing", () => {
    expect(thinkingLevels("Usage: pi [options]\n")).toEqual([]);
  });
});

describe("piDefaults", () => {
  const PI_OWN = { thinking: "medium", interface: "fullscreen" };

  test("names Pi's own defaults when nothing is set", () => {
    expect(piDefaults("")).toEqual(PI_OWN);
    expect(piDefaults("{}")).toEqual(PI_OWN);
    expect(piDefaults("not json")).toEqual(PI_OWN);
  });

  test("a level Pi does not know is not shown", () => {
    expect(piDefaults('{"defaultThinkingLevel":"bogus"}')).toEqual(PI_OWN);
  });

  test("reads the startup model and level", () => {
    expect(
      piDefaults(
        JSON.stringify({
          defaultProvider: "opencode-go",
          defaultModel: "deepseek-v4.1-flash",
          defaultThinkingLevel: "high",
          tuiMode: "regular",
        }),
      ),
    ).toEqual({
      model: "opencode-go/deepseek-v4.1-flash",
      thinking: "high",
      interface: "regular",
    });
  });
});

describe("pi version", () => {
  test("is the bare line Pi prints", () => {
    expect(versionToken("1.4.0\n")).toBe("1.4.0");
  });

  test("atLeast compares numerically", () => {
    expect(atLeast("1.4.0", [1, 3, 0])).toBe(true);
    expect(atLeast("1.3.0", [1, 3, 0])).toBe(true);
    expect(atLeast("0.99.2", [1, 3, 0])).toBe(false);
    expect(atLeast("v22.23.2", [22, 19, 0])).toBe(true);
    expect(atLeast("v22.9.0", [22, 19, 0])).toBe(false);
    expect(atLeast(null, [1, 0, 0])).toBe(false);
  });
});

describe("pi checks", () => {
  const report: HarnessReport = {
    id: "pi",
    available: true,
    version: "1.4.0",
    loggedIn: null,
    options: {},
    defaults: {},
    notes: [],
  };
  const checks = pi.checks as NonNullable<typeof pi.checks>;

  test("no provider with credentials is a finding, with the login as its fix", () => {
    const found = checks(report, { providers: [], node: "v22.23.2" });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ label: "pi login", ok: false });
    expect(found[0].fix).toContain("/login opencode-go");
  });

  test("a provider with credentials is said", () => {
    expect(
      checks(report, { providers: ["opencode-go"], node: "v22.23.2" }),
    ).toEqual([
      { label: "pi login", ok: true, detail: "credentials for opencode-go" },
    ]);
  });

  test("an unreadable list is silent", () => {
    expect(checks(report, { providers: null, node: "v22.23.2" })).toEqual([]);
  });

  /** The installer can keep a node of its own that only its launcher sees. */
  test("a Pi that ran says nothing about node, whatever node is on PATH", () => {
    for (const node of [null, "v18.19.1"])
      expect(checks(report, { providers: null, node })).toEqual([]);
  });

  test("a Pi that did not run points at node", () => {
    const found = checks(
      { ...report, version: null },
      { providers: null, node: "v18.19.1" },
    );
    expect(found[0]).toMatchObject({ label: "pi node", ok: false });
    expect(found[0].detail).toContain("found v18.19.1");
  });

  test("a Pi from before OpenCode's endpoints moved is a finding", () => {
    const found = checks(
      { ...report, version: "0.99.2" },
      { providers: null, node: "v22.23.2" },
    );
    expect(found[0]).toMatchObject({ label: "pi version", ok: false });
  });
});
