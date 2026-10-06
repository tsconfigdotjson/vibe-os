// Hermes.
//
// It has no listing mode at all (`hermes model` is an interactive wizard), so
// what is discoverable is its own configuration: which providers it has been
// set up with, what it would use by default, and where its browser tools will
// land. The model and provider fields stay free text with those as suggestions.
//
// No floor of well-known provider names. A Hermes provider id is account
// configuration, so offering one that is not on this box would suggest a choice
// that can only fail at launch.

import { readFile } from "node:fs/promises";
import { CHROME_UNIT_PATH, cdpUrlMatches, portsFromUnits } from "../browser.ts";
import { log } from "../log.ts";
import {
  type HarnessAdapter,
  home,
  looksLikeLadder,
  resolveBinary,
  run,
} from "./util.ts";

export const HERMES_INSTALL =
  "curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash";
export const UV_INSTALL = "curl -LsSf https://astral.sh/uv/install.sh | sh";

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

/** Where Hermes' browser tools will land, for its doctor checks. */
export interface HermesBrowser {
  /** `browser.cdp_url` as configured, or null when nothing is set. */
  cdpUrl: string | null;
  /** The port the installed Chrome unit actually opened, when there is one. */
  cdpPort: number | null;
  /** Whether `cdpUrl` names that port. */
  connected: boolean;
  /**
   * Whether the `browser-use` CLI could run, directly or through `uvx`.
   * Without it Hermes quietly keeps its twelve built-in browser tools.
   */
  browserUse: boolean;
}

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

/**
 * The CDP port the installed Chrome unit actually opened.
 *
 * Read from the unit rather than from a default: `install-browser` may have
 * been given `--cdp-port` months ago.
 */
async function installedCdpPort(): Promise<number | null> {
  const unit = await readFile(CHROME_UNIT_PATH, "utf8").catch(() => null);
  if (!unit) return null;
  return portsFromUnits({ chrome: unit }).cdpPort;
}

/** The note the editor shows about where the browser tools land. */
function browserNote(browser: HermesBrowser): {
  label: string;
  text: string;
  warn?: boolean;
} {
  const label = "Browser tools";
  if (!browser.connected)
    return {
      label,
      text: "Not pointed at this box's browser. Run `vibe-os connect-hermes` on the box.",
      warn: true,
    };
  return {
    label,
    text:
      `Driving the box's Chrome on \`127.0.0.1:${browser.cdpPort}\`. Watch it over VNC.` +
      (browser.browserUse
        ? ""
        : " No browser-use CLI, so this falls back to the twelve built-in tools."),
    warn: !browser.browserUse,
  };
}

export const hermes: HarnessAdapter<HermesBrowser> = {
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
    const [help, model, browser, providers, browserUse, cdpPort] =
      await Promise.all([
        // `chat`, not the bare command: `--reasoning` is a flag of that
        // subcommand, which is also the one a profile launches.
        run(binary, ["chat", "--help"], {
          timeout: 30_000,
          maxBuffer: 4 * 1024 * 1024,
        })
          .then(({ stdout }) => stdout)
          .catch(() => ""),
        hermesConfig(binary, "model"),
        hermesConfig(binary, "browser"),
        hermesConfig(binary, "providers"),
        // Presence, never a run. A cold `uvx browser-use` downloads the
        // package before it prints anything.
        Promise.all([
          resolveBinary("browser-use", [
            `${home}/.local/bin/browser-use`,
            "/usr/local/bin/browser-use",
          ]),
          resolveBinary("uvx", [
            `${home}/.local/bin/uvx`,
            "/usr/local/bin/uvx",
          ]),
        ]).then(([direct, viaUvx]) => Boolean(direct || viaUvx)),
        installedCdpPort(),
      ]);

    const defaultProvider = str(model, "provider");
    const defaultModel = str(model, "default");
    const names = [
      ...Object.keys(providers ?? {}).filter((n) => n.trim()),
      ...(defaultProvider ? [defaultProvider] : []),
    ];
    const cdpUrl = str(browser, "cdp_url");
    const reasoning = reasoningLevels(help);
    const state: HermesBrowser = {
      cdpUrl,
      cdpPort,
      connected: cdpPort !== null && cdpUrlMatches(cdpUrl, cdpPort),
      browserUse,
    };

    log.debug(
      `hermes: ${names.length} providers, ` +
        `${reasoning.length > 0 ? reasoning.join("/") : "no"} reasoning levels, ` +
        `browser ${cdpUrl ?? "unset"}, browser-use ${browserUse ? "runnable" : "missing"}`,
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
      notes: [browserNote(state)],
      detail: state,
    };
  },

  checks(report, browser) {
    if (!report.available || !browser) return [];
    // Without the CLI, Browser Use mode silently does not engage. Hermes keeps
    // working with its twelve built-in browser tools, so nothing looks wrong;
    // you just pay for a dozen tool schemas in every request.
    const checks = [
      browser.browserUse
        ? {
            label: "browser-use",
            ok: true,
            detail: "runnable — Hermes gets the single browser_exec tool",
          }
        : {
            label: "browser-use",
            ok: false,
            detail:
              "no browser-use or uvx on PATH — Hermes keeps its twelve built-in browser tools",
            fix: UV_INSTALL,
          },
    ];
    // Only worth asking when there is a browser here to be pointed at.
    if (browser.cdpPort !== null) {
      checks.push(
        browser.connected
          ? {
              label: "hermes browser",
              ok: true,
              detail: `driving this box's Chrome on 127.0.0.1:${browser.cdpPort}`,
            }
          : {
              label: "hermes browser",
              ok: false,
              detail: browser.cdpUrl
                ? `browser.cdp_url is ${browser.cdpUrl}, not this box's Chrome on ${browser.cdpPort}`
                : "browser.cdp_url is unset — Hermes will not use the browser running here",
              fix: "vibe-os connect-hermes",
            },
      );
    }
    return checks;
  },
};
