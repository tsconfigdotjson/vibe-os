// Pi, the coding agent from Earendil Works.
//
// The flag list is verbatim from `pi --help` on Pi 1.4.0. Models come from
// `pi --list-models`, which lists only the providers this box has credentials
// for, so the dropdown is what a window can actually use. Pi has many
// providers and no single login, so a missing credential is said as a note and
// a doctor check rather than as the spec's `login`.
//
// Pi never asks before running a tool, so there is no skip-approvals switch.
// What it does ask about is project trust, for a repo with a `.pi` folder, and
// every workspace is a worktree Pi has never seen: new profiles start with
// `--approve`. They also start in the regular interface, because the
// fullscreen one captures the mouse and xterm.js then cannot select text.

import { readFile } from "node:fs/promises";
import type { ChoiceOption } from "../../shared/harness.ts";
import { log } from "../log.ts";
import {
  expandHome,
  type HarnessAdapter,
  type HarnessCheck,
  home,
  looksLikeLadder,
  run,
} from "./util.ts";

export const PI_INSTALL = "curl -fsSL https://pi.dev/install.sh | sh";

/** Pi's thinking ladder as of writing, used only when the help cannot be read. */
const KNOWN_THINKING = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** What Pi starts at when nothing chooses a level. */
const DEFAULT_THINKING = "medium";

/** Node the installer insists on, which Pi's launcher runs as `env node`. */
const NODE_FLOOR = [22, 19, 0];

/** The first Pi that sends OpenCode Zen and Go requests where they are served. */
const OPENCODE_FLOOR = [1, 3, 0];

/** Names for the provider groups. Unknown providers show their id. */
const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  deepseek: "DeepSeek",
  google: "Google Gemini",
  openai: "OpenAI",
  "openai-codex": "ChatGPT",
  opencode: "OpenCode Zen",
  "opencode-go": "OpenCode Go",
  openrouter: "OpenRouter",
};

/** Detail the doctor checks need beyond the report. */
interface PiDetail {
  /** Providers with credentials. Null when the list could not be read. */
  providers: string[] | null;
  /** `node --version` on the window's PATH, or null when there is none. */
  node: string | null;
}

/**
 * Models out of `pi --list-models`, in Pi's own order (provider, then id).
 *
 * The format is verbatim from Pi 1.4.0: a header row of `provider  model
 * context  max-out  thinking  images`, then one padded row per model. With no
 * credentials anywhere it prints one sentence, "No models available. Use
 * /login …", which is a definite answer: `none` is true.
 */
export function parsePiModels(stdout: string): {
  models: { provider: string; id: string }[];
  none: boolean;
} {
  const none = /no models available/i.test(stdout);
  const models: { provider: string; id: string }[] = [];
  let header = false;
  for (const line of stdout.split("\n")) {
    const cells = line.trim().split(/\s+/);
    if (cells[0] === "provider" && cells[1] === "model") {
      header = true;
      continue;
    }
    if (!header || cells.length < 2) continue;
    // Any token: a provider from `models.json` can be named anything.
    const [provider, id] = cells;
    models.push({ provider, id });
  }
  return { models, none: none && models.length === 0 };
}

/** One option per model, `provider/id`, grouped under its provider. */
export const modelOptions = (
  models: { provider: string; id: string }[],
): ChoiceOption[] =>
  models.map((m) => ({
    value: `${m.provider}/${m.id}`,
    label: m.id,
    group: PROVIDER_LABELS[m.provider] ?? m.provider,
  }));

/**
 * The levels `--thinking` lists in `pi --help`: "Set thinking level: off,
 * minimal, low, medium, high, xhigh, max", on one line.
 */
export function thinkingLevels(help: string): string[] {
  const section = /--thinking\b[^\n]*?:\s*([^\n]+)/.exec(help);
  if (!section) return [];
  const levels = section[1].split(",").map((s) => s.trim());
  return looksLikeLadder(levels) ? levels : [];
}

/**
 * What an empty model or thinking field falls back to, from Pi's settings.
 *
 * `defaultThinkingLevel` when it is set, and Pi's own medium when it is not,
 * so the editor can name the level a profile without `--thinking` starts at.
 * A per-model level (`modelThinkingLevels`) and a model's own range can still
 * move it; the field's hint says so.
 */
export function piDefaults(settings: string): Record<string, string> {
  let parsed: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(settings);
    if (value && typeof value === "object" && !Array.isArray(value))
      parsed = value as Record<string, unknown>;
  } catch {
    // no file, or one Pi would reject too: Pi's own defaults apply
  }
  const str = (key: string) =>
    typeof parsed[key] === "string" && (parsed[key] as string).trim()
      ? (parsed[key] as string).trim()
      : null;
  const provider = str("defaultProvider");
  const model = str("defaultModel");
  // Pi ignores a level it does not know, so the label must not show one.
  const thinking = str("defaultThinkingLevel");
  return {
    ...(model ? { model: provider ? `${provider}/${model}` : model } : {}),
    thinking:
      thinking && KNOWN_THINKING.includes(thinking)
        ? thinking
        : DEFAULT_THINKING,
    // Pi reads anything but "regular" as fullscreen.
    interface: str("tuiMode") === "regular" ? "regular" : "fullscreen",
  };
}

/** Whether a dotted version is at least `floor`. False when it cannot be read. */
export function atLeast(version: string | null, floor: number[]): boolean {
  const parts = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(version ?? "");
  if (!parts) return false;
  const have = [Number(parts[1]), Number(parts[2]), Number(parts[3] ?? 0)];
  for (let i = 0; i < floor.length; i++)
    if (have[i] !== floor[i]) return have[i] > floor[i];
  return true;
}

const LOGIN_FIX = "run pi, then /login opencode-go (or another provider)";

export const pi: HarnessAdapter<PiDetail> = {
  spec: {
    id: "pi",
    label: "Pi",
    command: "pi",
    // Only where a window will find it: a window's PATH is `~/.local/bin`
    // ahead of sshd's. The installer falls back to `~/.pi/agent/bin` when
    // `~/.local/bin` is not on its PATH, and a `pi` only there would pass
    // doctor and then fail to launch, so doctor should call it missing.
    paths: ["~/.local/bin/pi", "/usr/local/bin/pi"],
    // With no earlier session, `--continue` starts a new one rather than
    // failing, so a restored window always opens.
    resume: {
      args: ["--continue"],
      unless: [
        "--continue",
        "-c",
        "--resume",
        "-r",
        "--session",
        "--session-id",
        "--fork",
        "--no-session",
      ],
    },
    install: PI_INSTALL,
    defaults: ["--tui-mode", "regular", "--approve"],
    fields: [
      {
        kind: "select",
        key: "model",
        label: "Model",
        flag: "--model",
        none: "Default — whatever Pi picks",
        placeholder: "Default — whatever Pi picks",
        hint: "Read off `pi --list-models`, which lists only the providers this box has credentials for.",
        emptyHint:
          "Nothing to offer — `pi --list-models` listed no models. If no provider is logged in, run `pi` on the box and `/login opencode-go` (or another provider). Typed `provider/model` ids still work.",
      },
      {
        kind: "select",
        key: "thinking",
        label: "Thinking",
        flag: "--thinking",
        options: KNOWN_THINKING.map((value) => ({ value })),
        none: `Default — ${DEFAULT_THINKING}`,
        hint: "Left out, Pi starts at `defaultThinkingLevel` from its settings, or medium. A level the model does not have moves up to the next one it does, so DeepSeek V4.1 Flash runs medium as high. A resumed conversation keeps the level it had.",
      },
      {
        kind: "select",
        key: "interface",
        label: "Interface",
        flag: "--tui-mode",
        options: [
          { value: "regular", label: "Regular — text stays selectable" },
          {
            value: "fullscreen",
            label:
              "Fullscreen — Pi takes the mouse, so text cannot be selected",
          },
        ],
        none: "Default — fullscreen",
      },
      {
        kind: "toggle",
        flag: "--approve",
        aliases: ["-a"],
        label: "Trust the worktree",
        hint: "Load the repo's `.pi` settings, extensions and MCP servers without the trust prompt. Every vibe-os worktree is a folder Pi has not seen.",
      },
      {
        kind: "toggle",
        flag: "--continue",
        aliases: ["-c"],
        label: "Resume last conversation",
        hint: "Pick up the most recent session in this directory.",
      },
      {
        kind: "toggle",
        flag: "--no-mcp",
        label: "No MCP servers",
        hint: "Connect none of the servers in `~/.pi/agent/mcp.json` for this session.",
      },
      {
        kind: "toggle",
        flag: "--no-context-files",
        aliases: ["-nc"],
        label: "Ignore AGENTS.md",
        hint: "Skip AGENTS.md and CLAUDE.md discovery.",
      },
      {
        kind: "toggle",
        flag: "--offline",
        label: "Offline startup",
        hint: "Skip the version check and the model catalog refresh at startup.",
      },
      {
        kind: "toggle",
        flag: "--verbose",
        label: "Verbose startup",
        hint: "Show the full startup information.",
      },
    ],
    valued: [
      "--provider",
      "--api-key",
      "--system-prompt",
      "--append-system-prompt",
      "--name",
      "-n",
      "--session",
      "--session-id",
      "--fork",
      "--session-dir",
      "--models",
      "--tools",
      "-t",
      "--exclude-tools",
      "-xt",
      "--extension",
      "-e",
      "--skill",
      "--prompt-template",
      "--theme",
      "--use-theme",
    ],
    extraPlaceholder: '--append-system-prompt "…"',
  },

  async discover(binary) {
    const agentDir = expandHome(
      process.env.PI_CODING_AGENT_DIR || `${home}/.pi/agent`,
    );
    const [listed, help, settings, node] = await Promise.all([
      // Offline: the bundled catalog and the cached one are what a window
      // starts from, and the network is not worth a slow editor.
      run(binary, ["--list-models", "--offline"], {
        timeout: 30_000,
        maxBuffer: 4 * 1024 * 1024,
      })
        .then(({ stdout }) => parsePiModels(stdout))
        .catch(() => null),
      run(binary, ["--help"], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 })
        .then(({ stdout }) => stdout)
        .catch(() => ""),
      readFile(`${agentDir}/settings.json`, "utf8").catch(() => ""),
      run("node", ["--version"], { timeout: 10_000 })
        .then(({ stdout }) => stdout.trim() || null)
        .catch(() => null),
    ]);
    const thinking = thinkingLevels(help);
    const providers = listed
      ? listed.none
        ? []
        : listed.models.length > 0
          ? [...new Set(listed.models.map((m) => m.provider))]
          : null
      : null;

    const notes: { label: string; text: string; warn?: boolean }[] = [];
    if (providers?.length === 0)
      notes.push({
        label: "Account",
        text: "No provider has credentials, so this profile opens Pi with no model. Run `pi` on the box and `/login opencode-go` (or another provider). A key exported in a shell profile does not reach windows; `/login` stores it where they look.",
        warn: true,
      });

    log.debug(
      `pi: ${listed?.models.length ?? 0} models from ${providers?.length ?? "unknown"} providers, ` +
        `${thinking.length > 0 ? thinking.join("/") : "no"} thinking levels`,
    );
    return {
      options: {
        model: modelOptions(listed?.models ?? []),
        ...(thinking.length > 0
          ? { thinking: thinking.map((value) => ({ value })) }
          : {}),
      },
      defaults: piDefaults(settings),
      notes,
      detail: { providers, node },
    };
  },

  // Program status tells the server whether Pi is working, waiting on a
  // dialog or done (see `programState` in screens.ts). Pi only sends it to a
  // terminal that answers its query, and a window started with nothing
  // attached has none. Copies go out as OSC 52 for the same reason: Pi does
  // that by itself only when it can see it is under SSH.
  setup: () => "export PI_PROGRAM_STATUS=1 PI_CLIPBOARD_OSC52=1",

  checks(report, detail) {
    const checks: HarnessCheck[] = [];
    if (!detail) return checks;
    // A version read means `pi` ran, so its launcher found a node, which may
    // be one the installer keeps for itself. Only a Pi that would not run says
    // anything about node.
    if (report.version === null)
      checks.push({
        label: "pi node",
        ok: false,
        detail: `pi --version did not run — Pi is a Node program and needs ${NODE_FLOOR.join(".")} or newer (${detail.node ? `found ${detail.node}` : "no node on PATH or in ~/.local/bin"})`,
        fix: "install Node.js 22.19 or newer",
      });
    if (report.version && !atLeast(report.version, OPENCODE_FLOOR))
      checks.push({
        label: "pi version",
        ok: false,
        detail: `${report.version} sends OpenCode Zen and Go requests to endpoints OpenCode no longer serves`,
        fix: "pi update",
      });
    if (detail.providers?.length === 0)
      checks.push({
        label: "pi login",
        ok: false,
        detail: "no provider has credentials — Pi windows open with no model",
        fix: LOGIN_FIX,
      });
    else if (detail.providers)
      checks.push({
        label: "pi login",
        ok: true,
        detail: `credentials for ${detail.providers.join(", ")}`,
      });
    return checks;
  },
};
