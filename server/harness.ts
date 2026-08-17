// What the agent CLIs on this machine can be told to do.
//
// The profile editor offers models and permission modes as dropdowns, which
// means something has to know what the valid values are. Hardcoding them would
// be wrong within a release or two — Claude ships new models faster than this
// project ships anything — so they are read off the binary that is actually
// installed. Update Claude Code and the dropdowns follow.
//
// Hermes answers a narrower version of the same question. It has no listing
// mode at all (`hermes model` is an interactive wizard), so what is discoverable
// is its own configuration: which providers it has been set up with, what it
// would use by default, and where its browser tools will land.
//
// Cursor sits between the two. `cursor-agent models` is a real listing mode,
// but it lists the account's models rather than the binary's — so the answer
// exists only while the box is logged in, and an empty list means "could not
// read" rather than "nothing to offer".

import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { CHROME_UNIT_PATH, cdpUrlMatches, portsFromUnits } from "./browser.ts";
import { log } from "./log.ts";

const run = promisify(execFile);

import type { CursorInfo, HarnessInfo, HermesInfo } from "../shared/wire.ts";

export type { CursorInfo, HarnessInfo, HermesInfo };

/**
 * The effort ladder as of writing, used only when the binary cannot be read.
 *
 * Unlike the model aliases, this is not merged with what was discovered. Effort
 * is ordinal — the list *is* the scale, low to max — so a union of two sources
 * would put a newly-added level in the wrong place and quietly mislabel how
 * hard a role thinks. Either the binary's order or this one, never a blend.
 */
const KNOWN_EFFORT = ["low", "medium", "high", "xhigh", "max"];

const EMPTY: HarnessInfo = {
  available: false,
  version: null,
  aliases: [],
  models: [],
  permissionModes: [],
  effortLevels: KNOWN_EFFORT,
};

/**
 * Aliases the CLI documents but which do not appear as model ids.
 *
 * Kept as a floor rather than the source of truth: whatever is found in the
 * binary is merged over the top, so a new tier appears on its own.
 */
const KNOWN_ALIASES = [
  "default",
  "opus",
  "sonnet",
  "haiku",
  "fable",
  "opusplan",
];

/**
 * Where the native installers put things, when PATH does not say so.
 *
 * A login shell picks `~/.local/bin` up from `.profile`; a systemd service does
 * not, and vibe-os is meant to run as one. Without this the server cannot find
 * a Claude that the harness will happily launch a moment later, because the
 * harness runs under a login shell and the server does not — so the dropdowns
 * come up empty on exactly the deployment the docs recommend.
 */
const CLAUDE_PATHS = [
  `${process.env.HOME ?? ""}/.local/bin/claude`,
  "/usr/local/bin/claude",
  "/opt/claude/.local/bin/claude",
];

/**
 * The same problem for Hermes, whose installer offers two layouts.
 *
 * `/usr/local/bin/hermes` is its FHS default, chosen to match Claude Code and
 * the Codex CLI; `~/.local/bin` is what it uses when it cannot write there.
 */
const HERMES_PATHS = [
  `${process.env.HOME ?? ""}/.local/bin/hermes`,
  "/usr/local/bin/hermes",
];

/**
 * And again for the two commands that make Browser Use mode engage.
 *
 * `uv`'s installer writes to `~/.local/bin` and nowhere else, which is the same
 * directory that neither a systemd service nor an `ssh host 'command'` has on
 * PATH. Without this the check reported a missing uvx on a box that had one, and
 * offered to install what was already installed.
 */
const home = process.env.HOME ?? "";
const BROWSER_USE_PATHS = [
  `${home}/.local/bin/browser-use`,
  "/usr/local/bin/browser-use",
];
const UVX_PATHS = [`${home}/.local/bin/uvx`, "/usr/local/bin/uvx"];

/**
 * The commands that install what Hermes needs, named where they are checked.
 *
 * doctor prints them under a failed check and `connect-hermes` prints the first
 * one when there is nothing to configure. Both used to be about to grow their
 * own copy of a URL that has to be right.
 */
export const HERMES_INSTALL =
  "curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash";
export const UV_INSTALL = "curl -LsSf https://astral.sh/uv/install.sh | sh";

/** Resolves a command through any symlinks to the real executable. */
async function resolveBinary(
  command: string,
  extraPaths: string[],
): Promise<string | null> {
  const candidates: string[] = [];
  try {
    const { stdout } = await run(
      "/bin/sh",
      ["-c", 'command -v "$1"', "sh", command],
      { timeout: 5_000 },
    );
    if (stdout.trim()) candidates.push(stdout.trim());
  } catch {
    // not on PATH — the explicit locations below may still have it
  }
  candidates.push(...extraPaths.filter(Boolean));

  for (const candidate of candidates) {
    try {
      await stat(candidate);
      const { stdout: real } = await run(
        "/bin/sh",
        ["-c", `readlink -f ${JSON.stringify(candidate)}`],
        {
          timeout: 5_000,
        },
      );
      return real.trim() || candidate;
    } catch {
      // next
    }
  }
  return null;
}

/**
 * Model ids embedded in the executable.
 *
 * grep rather than reading the file in-process: the binary is ~270MB and the
 * answer is a few hundred bytes, so streaming it through a matcher costs
 * nothing while `readFile` would cost the whole thing in memory. Measured at
 * about 0.13s, which is why this is done once at startup rather than cached to
 * disk or fetched over the network.
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
    // something old, and a sorted-ascending list buries it.
    return [...seen].sort((a, b) =>
      b.localeCompare(a, "en", { numeric: true }),
    );
  } catch {
    return [];
  }
}

/**
 * `claude --help`, or empty if it cannot be run.
 *
 * Read once and handed to every parser below. Each `claude` invocation costs a
 * couple of seconds of its own startup, and the help text answers more than one
 * question — asking twice would double the slowest part of discovery to learn
 * nothing new.
 */
async function helpText(binary: string): Promise<string> {
  try {
    const { stdout } = await run(binary, ["--help"], {
      timeout: 15_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return "";
  }
}

/** The choices `--permission-mode` lists in its own help output. */
function permissionModes(help: string): string[] {
  // Help text wraps, so the list is matched across newlines and whitespace.
  const section =
    /--permission-mode[\s\S]{0,400}?\(choices:([\s\S]{0,300}?)\)/.exec(help);
  if (!section) return [];
  return [...section[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/**
 * The levels `--effort` lists in its own help output.
 *
 * `--permission-mode` prints a `(choices: "a", "b")` block this can anchor on;
 * `--effort` prints a bare `(low, medium, high, xhigh, max)`, so the only
 * anchor available is "the first parenthesis after the flag". That is loose
 * enough to catch a sentence in some future release, which is what the shape
 * check is for: every token has to look like a level, or the whole match is
 * discarded and the caller falls back to the known ladder. Half a list read out
 * of a paragraph would be worse than not reading one at all.
 */
function effortLevels(help: string): string[] {
  const section = /--effort[\s\S]{0,400}?\(([^)]{0,200})\)/.exec(help);
  if (!section) return [];
  const levels = section[1].split(",").map((s) => s.trim());
  if (levels.length < 2 || !levels.every((l) => /^[a-z][a-z0-9-]*$/.test(l)))
    return [];
  return levels;
}

let cached: Promise<HarnessInfo> | null = null;

/**
 * Everything the editor needs to offer, discovered once.
 *
 * Cached for the life of the process: it describes an installed binary, which
 * does not change under a running server, and a restart is already what
 * happens when someone upgrades it.
 */
export function discoverClaude(): Promise<HarnessInfo> {
  cached ??= (async (): Promise<HarnessInfo> => {
    const binary = await resolveBinary("claude", CLAUDE_PATHS);
    if (!binary) {
      log.debug(
        "claude is not on PATH — the profile editor will offer aliases only",
      );
      return { ...EMPTY, aliases: KNOWN_ALIASES };
    }

    // Concurrently, because each `claude` invocation costs a couple of seconds
    // of its own startup and there is no reason to pay for them in series.
    const [version, models, help] = await Promise.all([
      run(binary, ["--version"], { timeout: 15_000 })
        .then(({ stdout }) => stdout.trim().split(/\s+/)[0] ?? null)
        .catch(() => null),
      embeddedModels(binary),
      helpText(binary),
    ]);

    const modes = permissionModes(help);
    const effort = effortLevels(help);

    // A tier that shows up in the binary but not in the list above still gets
    // an alias, because that is how Claude names them.
    const tiers = new Set(models.map((m) => m.split("-")[1]).filter(Boolean));
    const aliases = [...new Set([...KNOWN_ALIASES, ...tiers])];

    log.debug(
      `claude ${version ?? "?"}: ${models.length} models, ${modes.length} permission modes, ` +
        `${effort.length > 0 ? effort.join("/") : "no"} effort levels`,
    );
    return {
      available: true,
      version,
      aliases,
      models,
      permissionModes: modes,
      effortLevels: effort.length > 0 ? effort : KNOWN_EFFORT,
    };
  })();
  return cached;
}

// ── Hermes ───────────────────────────────────────────────────────────────────

/**
 * The reasoning ladder as of writing, used only when the help cannot be read.
 *
 * Not merged with what was discovered, for the reason `KNOWN_EFFORT` gives: the
 * list is the scale, so a union of two sources would put a newly-added level in
 * the wrong place and mislabel how hard a role thinks.
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

const NO_HERMES: HermesInfo = {
  available: false,
  version: null,
  providers: [],
  defaultProvider: null,
  defaultModel: null,
  reasoningLevels: KNOWN_REASONING,
  browser: {
    cdpUrl: null,
    backend: null,
    cdpPort: null,
    connected: false,
    browserUse: false,
  },
};

/**
 * One `hermes config get <key> --json`, parsed, or null.
 *
 * The one machine-readable read Hermes offers. Everything downstream treats a
 * null as "could not tell", never as "not set": a key that has never been
 * written, a build that spells it differently and a Python traceback all arrive
 * here the same way, and only the first of those is worth reporting as a fact.
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
 * The same job `effortLevels` does for Claude, against a different sentence:
 * Hermes writes "Reasoning effort for this session: none, minimal, low, medium,
 * high, xhigh, max, or ultra." across two wrapped lines, so the anchor is the
 * first colon after the flag and the terminator is the full stop.
 *
 * Same shape check, for the same reason. That anchor is loose enough to catch a
 * paragraph in some future release, so every token has to look like a level or
 * the whole match is discarded and the caller falls back to the known ladder.
 */
export function reasoningLevels(help: string): string[] {
  const section = /--reasoning[\s\S]{0,200}?:\s*([\s\S]{0,200}?)\./.exec(help);
  if (!section) return [];
  const levels = section[1]
    .split(/,|\bor\b/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (levels.length < 2 || !levels.every((l) => /^[a-z][a-z0-9-]*$/.test(l)))
    return [];
  return levels;
}

/**
 * The version out of `hermes --version`, which is not one line.
 *
 * Claude prints `1.2.3 (Claude Code)` and the first token is the answer. Hermes
 * prints a five-line block — its own version, the install directory, the Python
 * it built against, the OpenAI SDK, and a sentence suggesting `hermes version` —
 * so taking the last token of the whole thing yields "status." and taking the
 * first yields "Hermes". Only the first line is about the agent, and the answer
 * is the version-shaped token in it.
 */
export function hermesVersion(stdout: string): string | null {
  const first = stdout.split("\n")[0] ?? "";
  const match = /\bv?(\d+(?:\.\d+)+[^\s()]*)/.exec(first);
  return match ? match[1] : null;
}

/** A field of a config block, when it is a non-empty string. */
function str(
  block: Record<string, unknown> | null,
  key: string,
): string | null {
  const value = block?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * The CDP port the installed Chrome unit actually opened.
 *
 * Read from the unit rather than from a default, for the same reason doctor
 * does it: `install-browser` may have been given `--cdp-port` months ago, and
 * comparing a configured URL against a port nothing is listening on would call a
 * working box broken.
 */
async function installedCdpPort(): Promise<number | null> {
  const unit = await readFile(CHROME_UNIT_PATH, "utf8").catch(() => null);
  if (!unit) return null;
  return portsFromUnits({ chrome: unit }).cdpPort;
}

let hermesCached: Promise<HermesInfo> | null = null;

/**
 * Everything the Hermes side of the editor needs, discovered once.
 *
 * Deliberately thinner than the Claude side. There is no model list here and
 * there is not going to be one: `hermes model` is an interactive wizard, and a
 * hardcoded list would be a guess about somebody else's account. What is real is
 * what the box is configured for, so that is what is offered, and the model and
 * provider fields stay free text with the discovered values as suggestions.
 *
 * No floor of well-known provider names either, unlike `KNOWN_ALIASES` above.
 * A Claude alias works wherever Claude is installed; a Hermes provider id is
 * account configuration, so offering one that is not on this box would suggest a
 * choice that can only fail at launch.
 */
export function discoverHermes(): Promise<HermesInfo> {
  hermesCached ??= (async (): Promise<HermesInfo> => {
    const binary = await resolveBinary("hermes", HERMES_PATHS);
    if (!binary) {
      log.debug("hermes is not on PATH — Hermes profiles will not launch");
      return NO_HERMES;
    }

    // Concurrently: `hermes` is Python, so each invocation costs seconds of
    // interpreter and import time before it does anything.
    const [version, help, model, browser, providers, browserUse, cdpPort] =
      await Promise.all([
        run(binary, ["--version"], { timeout: 30_000 })
          .then(({ stdout }) => hermesVersion(stdout))
          .catch(() => null),
        // `chat`, not the bare command: `--reasoning` is a flag of that
        // subcommand, which is also the one a profile actually launches.
        run(binary, ["chat", "--help"], {
          timeout: 30_000,
          maxBuffer: 4 * 1024 * 1024,
        })
          .then(({ stdout }) => stdout)
          .catch(() => ""),
        hermesConfig(binary, "model"),
        hermesConfig(binary, "browser"),
        hermesConfig(binary, "providers"),
        // Presence, never a run. A cold `uvx browser-use` downloads the package
        // before it prints anything, which would hold up startup for minutes on
        // the one box where the answer matters least.
        Promise.all([
          resolveBinary("browser-use", BROWSER_USE_PATHS),
          resolveBinary("uvx", UVX_PATHS),
        ]).then(([direct, viaUvx]) => Boolean(direct || viaUvx)),
        installedCdpPort(),
      ]);

    const defaultProvider = str(model, "provider");
    const names = [
      ...Object.keys(providers ?? {}).filter((n) => n.trim()),
      ...(defaultProvider ? [defaultProvider] : []),
    ];
    const cdpUrl = str(browser, "cdp_url");
    const reasoning = reasoningLevels(help);

    log.debug(
      `hermes ${version ?? "?"}: ${names.length} providers, ` +
        `${reasoning.length > 0 ? reasoning.join("/") : "no"} reasoning levels, ` +
        `browser ${cdpUrl ?? "unset"}, browser-use ${browserUse ? "runnable" : "missing"}`,
    );

    return {
      available: true,
      version,
      providers: [...new Set(names)].sort(),
      defaultProvider,
      defaultModel: str(model, "default"),
      reasoningLevels: reasoning.length > 0 ? reasoning : KNOWN_REASONING,
      browser: {
        cdpUrl,
        backend: str(browser, "backend"),
        cdpPort,
        connected: cdpPort !== null && cdpUrlMatches(cdpUrl, cdpPort),
        browserUse,
      },
    };
  })();
  return hermesCached;
}

// ── Cursor ───────────────────────────────────────────────────────────────────

/**
 * Where Cursor's installer puts things, when PATH does not say so.
 *
 * `curl https://cursor.com/install | bash` unpacks a versioned bundle under
 * `~/.local/share/cursor-agent/versions/` and symlinks `cursor-agent` (and a
 * bare `agent`) into `~/.local/bin` — the same directory that neither a systemd
 * service nor an `ssh host 'command'` has on PATH, for the same reason the
 * Claude and Hermes lists above exist. `cursor-agent` is the name checked, not
 * `agent`: both point at the same binary, and only one of them is unambiguous.
 */
const CURSOR_PATHS = [
  `${home}/.local/bin/cursor-agent`,
  "/usr/local/bin/cursor-agent",
];

/** The command that installs it, named where doctor checks for it. */
export const CURSOR_INSTALL = "curl https://cursor.com/install -fsS | bash";

const NO_CURSOR: CursorInfo = {
  available: false,
  version: null,
  models: [],
  defaultModel: null,
  loggedIn: null,
};

/**
 * The version out of `cursor-agent --version`.
 *
 * Cursor's CLI versions are date-shaped — `2026.08.11-e8db854`, one line and
 * nothing else on a real install — rather than semver, which is still "digits,
 * dots, then whatever" and the same token shape
 * `hermesVersion` reads. Kept to the first line for the same reason as there:
 * only the first line is a claim about the binary itself, and a wrapper or
 * update notice printed after it must not become the answer.
 */
export function cursorVersion(stdout: string): string | null {
  const first = stdout.split("\n").find((l) => l.trim()) ?? "";
  const match = /\bv?(\d+(?:\.\d+)+[^\s()]*)/.exec(first);
  return match ? match[1] : null;
}

/**
 * Model ids out of `cursor-agent models`.
 *
 * The format is verbatim from a real box: an `Available models` header, then
 * one `id - Display Name` per line, then a `Tip:` sentence about `--model`.
 * The default is marked inside the display half — `auto - Auto (default)`.
 *
 * The id is the machine half and the only part kept: it is what `--model`
 * takes, and the display name repeats it in prose. A line has to open with an
 * id-shaped token followed by the ` - ` separator (or nothing at all), which
 * is what keeps the header and the tip out — both contain spaces where the
 * separator would have to be. Half-reading prose would put "Tip" in a model
 * dropdown, which is worse than missing a model.
 *
 * Order is kept as printed. Cursor leads with `auto` and its recommendations,
 * which is a better sort than alphabetical for a 200-entry list.
 */
export function parseCursorModels(stdout: string): {
  models: string[];
  defaultModel: string | null;
} {
  const models: string[] = [];
  let defaultModel: string | null = null;
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const match = /^([A-Za-z0-9][\w./-]*)(?:\s+-\s+(.*))?$/.exec(line);
    if (!match) continue;
    const [, id, label] = match;
    if (!models.includes(id)) models.push(id);
    // The marker word can share its parens: one account prints `(default)`,
    // another `(current, default)`, so the test is for the word, anchored
    // inside a parenthesised note rather than to the whole note.
    if (
      label &&
      /\([^)]*\b(default|current|selected)\b[^)]*\)/i.test(label) &&
      !defaultModel
    )
      defaultModel = id;
  }
  return { models, defaultModel };
}

/**
 * What `cursor-agent status` says about being logged in, when it says anything.
 *
 * "Not logged in" contains "logged in", so the negative is checked first. A
 * status this cannot read returns null rather than false: only a definite "no"
 * should make the editor warn that a window will sit at a login prompt.
 */
export function cursorLoggedIn(stdout: string): boolean | null {
  const text = stdout.toLowerCase();
  if (
    /not\s+logged\s+in|logged\s+out|unauthenticated|no.*credentials/.test(text)
  )
    return false;
  if (/logged\s+in|signed\s+in|authenticated/.test(text)) return true;
  return null;
}

let cursorCached: Promise<CursorInfo> | null = null;

/**
 * Everything the Cursor side of the editor needs, discovered once.
 *
 * Between the other two in what it can know. Unlike Hermes there is a listing
 * mode — `cursor-agent models` — so the model field gets real suggestions. But
 * the list is the account's rather than the binary's: logged out, or offline,
 * it cannot be read, so an empty list is "could not tell" and the field stays
 * free text. No floor of well-known model names, for the reason the Hermes
 * provider list has none: offering a model this account does not have would
 * suggest a choice that can only fail after launch.
 */
export function discoverCursor(): Promise<CursorInfo> {
  cursorCached ??= (async (): Promise<CursorInfo> => {
    const binary = await resolveBinary("cursor-agent", CURSOR_PATHS);
    if (!binary) {
      log.debug(
        "cursor-agent is not on PATH — Cursor profiles will not launch",
      );
      return NO_CURSOR;
    }

    // Concurrently, as ever: `models` and `status` may each go to the network,
    // and there is no reason to pay for the round trips in series.
    const [version, listed, loggedIn] = await Promise.all([
      run(binary, ["--version"], { timeout: 15_000 })
        .then(({ stdout }) => cursorVersion(stdout))
        .catch(() => null),
      run(binary, ["models"], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 })
        .then(({ stdout }) => parseCursorModels(stdout))
        // Logged out or offline it exits complaining; that is "could not
        // read", which the empty list already says.
        .catch(() => ({ models: [], defaultModel: null })),
      run(binary, ["status"], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 })
        .then(({ stdout }) => cursorLoggedIn(stdout))
        .catch(() => null),
    ]);

    log.debug(
      `cursor-agent ${version ?? "?"}: ${listed.models.length} models, ` +
        `logged ${loggedIn === null ? "in?" : loggedIn ? "in" : "out"}`,
    );

    return {
      available: true,
      version,
      models: listed.models,
      defaultModel: listed.defaultModel,
      loggedIn,
    };
  })();
  return cursorCached;
}
