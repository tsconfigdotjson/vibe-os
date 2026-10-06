// Claude Code.
//
// The editor offers models and permission modes as dropdowns, so something has
// to know what the valid values are. Hardcoding them would be wrong within a
// release or two, so they are read off the binary that is actually installed.
// Update Claude Code and the dropdowns follow.

import type { ChoiceOption } from "../../shared/harness.ts";
import { log } from "../log.ts";
import { type HarnessAdapter, looksLikeLadder, run } from "./util.ts";

export const CLAUDE_INSTALL = "curl -fsSL https://claude.ai/install.sh | bash";

/**
 * Aliases the CLI documents but which do not appear as model ids.
 *
 * A floor rather than the source of truth: whatever is found in the binary is
 * merged over the top, so a new tier appears on its own. These are the right
 * default for a profile because they do not pin: a role called "Backend
 * Manager" wants the best Opus, not the one that was current the day it was
 * written.
 */
const KNOWN_ALIASES = ["opus", "sonnet", "haiku", "fable", "opusplan"];

/**
 * The effort ladder as of writing, used only when the binary cannot be read.
 *
 * Not merged with what was discovered. Effort is ordinal, so a union of two
 * sources would put a newly added level in the wrong place. Either the binary's
 * order or this one, never a blend.
 */
const KNOWN_EFFORT = ["low", "medium", "high", "xhigh", "max"];

/** Readable names for the effort ladder. Unknown levels show raw. */
const EFFORT_LABELS: Record<string, string> = {
  low: "Low — quick and cheap",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Maximum — slowest, most thorough",
};

/** Plain-English names for the modes the CLI reports. Unknown ones show raw. */
const MODE_LABELS: Record<string, string> = {
  acceptEdits: "Accept edits automatically",
  plan: "Plan first, then ask",
  auto: "Decide automatically",
  manual: "Ask every time",
  dontAsk: "Never ask",
  bypassPermissions: "Bypass permission checks",
};

const LATEST = "Latest of its tier";
const PINNED = "Pinned to one version";

const aliasOptions = (aliases: string[]): ChoiceOption[] =>
  aliases
    .filter((a) => a !== "default")
    .map((a) => ({
      value: a,
      label: a[0].toUpperCase() + a.slice(1),
      group: LATEST,
    }));

const effortOptions = (levels: string[]): ChoiceOption[] =>
  levels.map((l) => ({ value: l, label: EFFORT_LABELS[l] ?? l }));

/**
 * Model ids embedded in the executable.
 *
 * grep rather than reading the file in-process: the binary is ~270MB and the
 * answer is a few hundred bytes, so streaming it through a matcher costs
 * nothing while `readFile` would cost the whole thing in memory.
 */
async function embeddedModels(binary: string): Promise<string[]> {
  try {
    const { stdout } = await run(
      "grep",
      ["-aoE", "claude-(opus|sonnet|haiku|fable)-[0-9]+(-[0-9]+)?", binary],
      { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
    );
    const seen = new Set(
      stdout
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean),
    );
    // Newest first: people reach for the latest far more often than a pin to
    // something old.
    return [...seen].sort((a, b) =>
      b.localeCompare(a, "en", { numeric: true }),
    );
  } catch {
    return [];
  }
}

/** The choices `--permission-mode` lists in its own help output. */
export function permissionModes(help: string): string[] {
  // Help text wraps, so the list is matched across newlines and whitespace.
  const section =
    /--permission-mode[\s\S]{0,400}?\(choices:([\s\S]{0,300}?)\)/.exec(help);
  if (!section) return [];
  return [...section[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/**
 * The levels `--effort` lists in its own help output.
 *
 * `--effort` prints a bare `(low, medium, high, xhigh, max)`, so the only
 * anchor is the first parenthesis after the flag. That is loose enough to catch
 * a sentence in some future release, which is what the shape check is for.
 */
export function effortLevels(help: string): string[] {
  const section = /--effort[\s\S]{0,400}?\(([^)]{0,200})\)/.exec(help);
  if (!section) return [];
  const levels = section[1].split(",").map((s) => s.trim());
  return looksLikeLadder(levels) ? levels : [];
}

export const claude: HarnessAdapter = {
  spec: {
    id: "claude",
    label: "Claude",
    command: "claude",
    paths: [
      "~/.local/bin/claude",
      "/usr/local/bin/claude",
      "/opt/claude/.local/bin/claude",
    ],
    resume: {
      args: ["--continue"],
      unless: ["--continue", "-c", "--resume", "-r"],
    },
    install: CLAUDE_INSTALL,
    defaults: ["--dangerously-skip-permissions"],
    fields: [
      {
        kind: "select",
        key: "model",
        label: "Model",
        flag: "--model",
        options: aliasOptions(KNOWN_ALIASES),
        none: "Default — whatever Claude picks",
        suffix: {
          token: "[1m]",
          label: "1M context",
          hint: "Ask for the million-token context window",
        },
      },
      {
        kind: "select",
        key: "effort",
        label: "Thinking",
        flag: "--effort",
        options: effortOptions(KNOWN_EFFORT),
        none: "Default — whatever the harness picks",
        hint: "How long the session reasons before it acts. Higher is slower and costs more tokens; it is worth it for work where being wrong is expensive.",
      },
      {
        kind: "select",
        key: "permission",
        label: "Permissions",
        flag: "--permission-mode",
        none: "Ask before each action",
        specials: [
          {
            value: "skip",
            label: "Skip every check — no prompts at all",
            flag: "--dangerously-skip-permissions",
            warn: "This session will not ask before editing, running or deleting anything. Reasonable on a box that is already a sandbox; think twice anywhere else.",
          },
        ],
      },
      {
        kind: "mcp",
        key: "mcp",
        label: "MCP servers",
        strict: "--strict-mcp-config",
        config: "--mcp-config",
        emptyHint:
          "Nothing configured yet. Add one on the box with `claude mcp add --scope user …` and it appears here. The scope matters: without it Claude files the server under whichever directory you ran the command in, and in a workspace that goes when the worktree does.",
      },
      {
        kind: "toggle",
        flag: "--remote-control",
        label: "Remote control",
        hint: "Drive this session from claude.ai. Needs nothing on the box beyond outbound network.",
      },
      {
        kind: "toggle",
        flag: "--chrome",
        label: "Browser tools",
        hint: "Claude in Chrome. Pairs with the extension on the machine you are browsing from.",
      },
      {
        kind: "toggle",
        flag: "--continue",
        label: "Resume last conversation",
        hint: "Pick up the most recent session in this directory.",
      },
      {
        kind: "toggle",
        flag: "--verbose",
        label: "Verbose output",
        hint: "Show full tool output rather than the collapsed form.",
      },
    ],
    valued: ["--agent", "--fallback-model", "--name"],
    extraPlaceholder: '--append-system-prompt "…"',
  },

  async discover(binary) {
    // Concurrently, because each `claude` invocation costs a couple of seconds
    // of its own startup. `--help` is read once and answers two questions.
    const [models, help] = await Promise.all([
      embeddedModels(binary),
      run(binary, ["--help"], { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 })
        .then(({ stdout }) => stdout)
        .catch(() => ""),
    ]);
    const modes = permissionModes(help);
    const effort = effortLevels(help);

    // A tier that shows up in the binary but not in the list above still gets
    // an alias, because that is how Claude names them.
    const tiers = models.map((m) => m.split("-")[1]).filter(Boolean);
    const aliases = [...new Set([...KNOWN_ALIASES, ...tiers])];

    log.debug(
      `claude: ${models.length} models, ${modes.length} permission modes, ` +
        `${effort.length > 0 ? effort.join("/") : "no"} effort levels`,
    );
    return {
      options: {
        model: [
          ...aliasOptions(aliases),
          ...models.map((m) => ({ value: m, group: PINNED })),
        ],
        permission: modes.map((m) => ({
          value: m,
          label: MODE_LABELS[m] ?? m,
        })),
        ...(effort.length > 0 ? { effort: effortOptions(effort) } : {}),
      },
    };
  },
};
