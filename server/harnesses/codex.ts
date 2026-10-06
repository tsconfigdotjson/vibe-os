// OpenAI's Codex CLI.
//
// The flag list is verbatim from `codex --help` on codex-cli 0.160.1. Models
// come from `codex debug models`, which renders the CLI's own catalog as JSON
// and works logged out and offline, so the dropdown is real on any box that
// has the binary.
//
// Codex sets its thinking level through a config override rather than a flag
// of its own, `-c model_reasoning_effort=high`, and resumes with a subcommand,
// `codex resume --last`, rather than a flag. The spec says both as data.

import { readFile } from "node:fs/promises";
import type { ChoiceOption } from "../../shared/harness.ts";
import { log } from "../log.ts";
import { type HarnessAdapter, home, looksLikeLadder, run } from "./util.ts";

export const CODEX_INSTALL = "npm install -g @openai/codex";

const EFFORT = "model_reasoning_effort=";

/** What every model in the catalog supported as of writing. */
const KNOWN_EFFORT = ["low", "medium", "high", "xhigh"];

/**
 * Models out of `codex debug models`, in the CLI's own order.
 *
 * Only `visibility: "list"` entries: the hidden ones are internal (the
 * auto-review model) or previews the picker in Codex itself does not show.
 * Sorted by `priority`, which is the order Codex's own `/model` picker uses.
 *
 * The thinking ladder is the longest one any listed model supports. Every
 * model's list is a prefix of the same scale, so the longest is the scale, in
 * order; a union would have to guess where a new level goes.
 */
export function parseCodexModels(stdout: string): {
  models: ChoiceOption[];
  effort: string[];
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { models: [], effort: [] };
  }
  const list = (parsed as { models?: unknown })?.models;
  if (!Array.isArray(list)) return { models: [], effort: [] };

  const listed = list
    .filter(
      (m): m is Record<string, unknown> =>
        Boolean(m) &&
        typeof m === "object" &&
        typeof (m as { slug?: unknown }).slug === "string" &&
        (m as { visibility?: unknown }).visibility === "list",
    )
    .sort(
      (a, b) =>
        (typeof a.priority === "number" ? a.priority : 999) -
        (typeof b.priority === "number" ? b.priority : 999),
    );

  let effort: string[] = [];
  for (const m of listed) {
    const levels = Array.isArray(m.supported_reasoning_levels)
      ? m.supported_reasoning_levels
          .map((l: unknown) => (l as { effort?: unknown })?.effort)
          .filter((e: unknown): e is string => typeof e === "string")
      : [];
    if (levels.length > effort.length && looksLikeLadder(levels))
      effort = levels;
  }

  return {
    models: listed.map((m) => ({
      value: m.slug as string,
      label:
        typeof m.display_name === "string" && m.display_name !== m.slug
          ? `${m.display_name} (${m.slug})`
          : (m.slug as string),
    })),
    effort,
  };
}

/**
 * Top-level string settings from `config.toml`, the ones a profile's empty
 * fields fall back to.
 *
 * Only keys above the first `[table]`: the same key inside `[profiles.x]` is
 * not what a bare `codex` uses. Not a TOML parser, and does not need to be:
 * a value this cannot read just means no "Default — …" label.
 */
export function codexDefaults(toml: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of toml.split("\n")) {
    if (/^\s*\[/.test(line)) break;
    const match = /^\s*(model|model_reasoning_effort)\s*=\s*"([^"]*)"/.exec(
      line,
    );
    if (match?.[2]) out[match[1] === "model" ? "model" : "effort"] = match[2];
  }
  return out;
}

export const codex: HarnessAdapter = {
  spec: {
    id: "codex",
    label: "Codex",
    command: "codex",
    // Where `npm install -g` lands for a user-level npm prefix, which is what a
    // box without root has.
    paths: [
      "~/.local/bin/codex",
      "~/.npm-global/bin/codex",
      "/usr/local/bin/codex",
    ],
    // `resume` takes the same options as the root command, so the profile's
    // flags follow it unchanged.
    resume: { args: ["resume", "--last"], subcommand: true },
    install: CODEX_INSTALL,
    // Device auth, because the box usually has no browser for the redirect.
    login: { args: ["login", "status"], fix: "codex login --device-auth" },
    defaults: ["--dangerously-bypass-approvals-and-sandbox"],
    fields: [
      {
        kind: "select",
        key: "model",
        label: "Model",
        flag: "--model",
        aliases: ["-m"],
        none: "Default — whatever Codex picks",
        placeholder: "Default — whatever Codex picks",
        hint: "Read off `codex debug models`, so the list follows the installed CLI.",
        emptyHint:
          "Nothing to offer — `codex debug models` could not be read. Typed ids still work.",
      },
      {
        kind: "select",
        key: "effort",
        label: "Thinking",
        flag: "-c",
        aliases: ["--config"],
        prefix: EFFORT,
        options: KNOWN_EFFORT.map((value) => ({ value })),
        none: "Default — whatever Codex picks",
        hint: "Passed as `-c model_reasoning_effort=…`. Not every model takes every level.",
      },
      {
        kind: "select",
        key: "sandbox",
        label: "Sandbox",
        flag: "--sandbox",
        aliases: ["-s"],
        options: [
          { value: "read-only", label: "Read only" },
          { value: "workspace-write", label: "Write inside the worktree" },
          { value: "danger-full-access", label: "Full access — no sandbox" },
        ],
        none: "Default — whatever Codex is set to",
      },
      {
        kind: "select",
        key: "approval",
        label: "Approvals",
        flag: "--ask-for-approval",
        aliases: ["-a"],
        options: [
          { value: "on-request", label: "When the model asks" },
          { value: "never", label: "Never ask" },
        ],
        none: "Default — whatever Codex is set to",
      },
      {
        kind: "toggle",
        flag: "--dangerously-bypass-approvals-and-sandbox",
        label: "Skip approvals and sandbox",
        hint: "No prompts and no sandbox. Same trade as Claude's skip-every-check.",
        warn: "This session will not ask before running anything, and runs it unsandboxed. Reasonable on a box that is already a sandbox; think twice anywhere else.",
      },
      {
        kind: "toggle",
        flag: "--approve-for-me",
        label: "Auto-review approvals",
        hint: "Route approval requests through Codex's automatic reviewer, inside the workspace-write sandbox.",
      },
      {
        kind: "toggle",
        flag: "--search",
        label: "Web search",
        hint: "Give the model live web search, with no per-call approval.",
      },
      {
        kind: "toggle",
        flag: "--no-alt-screen",
        label: "Inline mode",
        hint: "Run without the alternate screen, so the terminal keeps its scrollback.",
      },
    ],
    valued: [
      "--enable",
      "--disable",
      "--remote",
      "--remote-auth-token-env",
      "-i",
      "--image",
      "--local-provider",
      "-p",
      "--profile",
      "-C",
      "--cd",
      "--add-dir",
    ],
    extraPlaceholder: "--profile work",
  },

  async discover(binary) {
    const codexHome = process.env.CODEX_HOME || `${home}/.codex`;
    const [catalog, toml] = await Promise.all([
      run(binary, ["debug", "models"], {
        timeout: 30_000,
        maxBuffer: 16 * 1024 * 1024,
      })
        .then(({ stdout }) => parseCodexModels(stdout))
        .catch(() => ({ models: [], effort: [] })),
      readFile(`${codexHome}/config.toml`, "utf8").catch(() => ""),
    ]);
    log.debug(
      `codex: ${catalog.models.length} models, ` +
        `${catalog.effort.length > 0 ? catalog.effort.join("/") : "no"} effort levels`,
    );
    return {
      options: {
        model: catalog.models,
        ...(catalog.effort.length > 0
          ? { effort: catalog.effort.map((value) => ({ value })) }
          : {}),
      },
      defaults: codexDefaults(toml),
    };
  },
};
