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

import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { CHROME_UNIT_PATH, cdpUrlMatches, portsFromUnits } from "./browser.ts";
import { log } from "./log.ts";

const run = promisify(execFile);

import type { HarnessInfo, HermesInfo } from "../shared/wire.ts";

export type { HarnessInfo, HermesInfo };

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

const NO_HERMES: HermesInfo = {
  available: false,
  version: null,
  providers: [],
  defaultProvider: null,
  defaultModel: null,
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
    const [version, model, browser, providers, browserUse, cdpPort] =
      await Promise.all([
        run(binary, ["--version"], { timeout: 30_000 })
          .then(({ stdout }) => stdout.trim().split(/\s+/).pop() ?? null)
          .catch(() => null),
        hermesConfig(binary, "model"),
        hermesConfig(binary, "browser"),
        hermesConfig(binary, "providers"),
        // Presence, never a run. A cold `uvx browser-use` downloads the package
        // before it prints anything, which would hold up startup for minutes on
        // the one box where the answer matters least.
        Promise.all([
          resolveBinary("browser-use", []),
          resolveBinary("uvx", []),
        ]).then(([direct, viaUvx]) => Boolean(direct || viaUvx)),
        installedCdpPort(),
      ]);

    const defaultProvider = str(model, "provider");
    const names = [
      ...Object.keys(providers ?? {}).filter((n) => n.trim()),
      ...(defaultProvider ? [defaultProvider] : []),
    ];
    const cdpUrl = str(browser, "cdp_url");

    log.debug(
      `hermes ${version ?? "?"}: ${names.length} providers, ` +
        `browser ${cdpUrl ?? "unset"}, browser-use ${browserUse ? "runnable" : "missing"}`,
    );

    return {
      available: true,
      version,
      providers: [...new Set(names)].sort(),
      defaultProvider,
      defaultModel: str(model, "default"),
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
