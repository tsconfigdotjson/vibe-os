// Hermes.
//
// It has no listing mode at all (`hermes model` is an interactive wizard), so
// what is discoverable is its own configuration: which providers it has been
// set up with and what it would use by default. The model and provider fields
// stay free text with those as suggestions.
//
// No floor of well-known provider names. A Hermes provider id is account
// configuration, so offering one that is not on this box would suggest a choice
// that can only fail at launch.

import { log } from "../log.ts";
import { type HarnessAdapter, looksLikeLadder, run } from "./util.ts";

export const HERMES_INSTALL =
  "curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash";

/**
 * The reasoning ladder as of writing, used only when the help cannot be read.
 * Not merged with what was discovered, because the list is the scale.
 */
const KNOWN_REASONING = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
];

/**
 * One `hermes config get <key> --json`, parsed, or null.
 *
 * Null is "could not tell", never "not set": a key never written, a build that
 * spells it differently and a Python traceback all arrive here the same way.
 */
async function hermesConfig(
  binary: string,
  key: string,
): Promise<Record<string, unknown> | null> {
  try {
    const { stdout } = await run(binary, ["config", "get", key, "--json"], {
      timeout: 20_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const parsed: unknown = JSON.parse(stdout);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * The levels `--reasoning` lists in its own help output.
 *
 * Hermes writes "Reasoning effort for this session: none, minimal, low, medium,
 * high, xhigh, max, or ultra." across two wrapped lines, so the anchor is the
 * first colon after the flag and the terminator is the full stop.
 */
export function reasoningLevels(help: string): string[] {
  const section = /--reasoning[\s\S]{0,200}?:\s*([\s\S]{0,200}?)\./.exec(help);
  if (!section) return [];
  const levels = section[1]
    .split(/,|\bor\b/)
    .map((s) => s.trim())
    .filter(Boolean);
  return looksLikeLadder(levels) ? levels : [];
}

/** A field of a config block, when it is a non-empty string. */
function str(
  block: Record<string, unknown> | null,
  key: string,
): string | null {
  const value = block?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export const hermes: HarnessAdapter = {
  spec: {
    id: "hermes",
    label: "Hermes",
    command: "hermes",
    // `/usr/local/bin` is its FHS default; `~/.local/bin` is what it uses when
    // it cannot write there.
    paths: ["~/.local/bin/hermes", "/usr/local/bin/hermes"],
    // `--model` and `--provider` belong to the `chat` subcommand, so a profile
    // that picks a model has to name it. Prepended rather than stored, because
    // it is not a flag anyone should be able to delete in the editor.
    leading: ["chat"],
    resume: {
      args: ["--continue"],
      unless: ["--continue", "-c", "--resume", "-r"],
    },
    install: HERMES_INSTALL,
    defaults: ["--yolo"],
    fields: [
      {
        kind: "select",
        key: "model",
        label: "Model",
        flag: "--model",
        aliases: ["-m"],
        free: true,
        placeholder: "Default — whatever Hermes is set to",
      },
      {
        kind: "select",
        key: "provider",
        label: "Provider",
        flag: "--provider",
        free: true,
        placeholder: "Default — whatever Hermes is set to",
        hint: "Providers this box is set up with. Add one with `hermes model` on the box and it appears here.",
      },
      {
        kind: "select",
        key: "reasoning",
        label: "Thinking",
        flag: "--reasoning",
        options: KNOWN_REASONING.map((value) => ({ value })),
        none: "Default — whatever Hermes picks",
        hint: "Read off `hermes chat --help` on the box, so the ladder follows Hermes' releases.",
      },
      {
        kind: "select",
        key: "interface",
        label: "Interface",
        none: "Default — whatever Hermes picks",
        specials: [
          { value: "cli", label: "Classic — a plain REPL", flag: "--cli" },
          {
            value: "tui",
            label: "Full screen — overlays and mouse selection",
            flag: "--tui",
          },
        ],
      },
      {
        kind: "toggle",
        flag: "--yolo",
        label: "Skip approvals",
        hint: "Run dangerous commands without asking. Same trade as Claude's skip-every-check.",
        warn: "This session will not ask before running anything. Reasonable on a box that is already a sandbox; think twice anywhere else.",
      },
      {
        kind: "toggle",
        flag: "--continue",
        // `-c` is the short form and takes an optional session name. Only the
        // bare form is this switch; `-c mine` is listed under `optional`.
        aliases: ["-c"],
        label: "Resume last conversation",
        hint: "Pick up the most recent session rather than starting a new one.",
      },
      {
        kind: "toggle",
        flag: "--ignore-rules",
        label: "Ignore rules and memory",
        hint: "Skip AGENTS.md, SOUL.md and the memory directory for this session.",
      },
      {
        kind: "toggle",
        flag: "--ignore-user-config",
        label: "Ignore user config",
        hint: "Use defaults instead of ~/.hermes/config.yaml. Credentials still load.",
      },
      {
        kind: "toggle",
        flag: "--safe-mode",
        label: "Safe mode",
        hint: "Disable every customisation at once. The reproducible-run switch.",
      },
      {
        kind: "toggle",
        flag: "--checkpoints",
        label: "Checkpoints",
        hint: "Snapshot files before destructive edits, so /rollback can undo them.",
      },
      {
        kind: "toggle",
        flag: "--verbose",
        label: "Verbose output",
        hint: "Show full tool output rather than the collapsed form.",
      },
      {
        kind: "toggle",
        flag: "--pass-session-id",
        label: "Pass session id",
        hint: "Put the session id in the system prompt, so the agent can name its own session.",
      },
    ],
    // From `hermes chat --help` on a real install rather than the docs, which
    // list a `-p/--profile` the CLI does not accept.
    valued: [
      "--in",
      "--resume",
      "-r",
      "--toolsets",
      "-t",
      "--skills",
      "-s",
      "--max-turns",
      "--source",
      "--image",
      "--query",
      "-q",
    ],
    optional: ["-c"],
    extraPlaceholder: '--append-system-prompt "…"',
  },

  async discover(binary) {
    // Concurrently: `hermes` is Python, so each invocation costs seconds of
    // interpreter and import time before it does anything.
    const [help, model, providers] = await Promise.all([
      // `chat`, not the bare command: `--reasoning` is a flag of that
      // subcommand, which is also the one a profile launches.
      run(binary, ["chat", "--help"], {
        timeout: 30_000,
        maxBuffer: 4 * 1024 * 1024,
      })
        .then(({ stdout }) => stdout)
        .catch(() => ""),
      hermesConfig(binary, "model"),
      hermesConfig(binary, "providers"),
    ]);

    const defaultProvider = str(model, "provider");
    const defaultModel = str(model, "default");
    const names = [
      ...Object.keys(providers ?? {}).filter((n) => n.trim()),
      ...(defaultProvider ? [defaultProvider] : []),
    ];
    const reasoning = reasoningLevels(help);

    log.debug(
      `hermes: ${names.length} providers, ` +
        `${reasoning.length > 0 ? reasoning.join("/") : "no"} reasoning levels`,
    );

    return {
      options: {
        model: defaultModel ? [{ value: defaultModel }] : [],
        provider: [...new Set(names)].sort().map((value) => ({ value })),
        ...(reasoning.length > 0
          ? { reasoning: reasoning.map((value) => ({ value })) }
          : {}),
      },
      defaults: {
        ...(defaultModel ? { model: defaultModel } : {}),
        ...(defaultProvider ? { provider: defaultProvider } : {}),
      },
    };
  },
};
