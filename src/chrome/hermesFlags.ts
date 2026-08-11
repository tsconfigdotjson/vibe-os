import { detokenize } from "../../shared/args";

/**
 * The same job `claudeFlags.ts` does, for a CLI that answers different questions.
 *
 * Mirrored rather than shared. The two files have the same shape and the same
 * contract — read stored argv into controls, write it back out, hand every
 * unrecognised token to the advanced field in its original order — but not one
 * flag in common. Folding them together would mean a table of flag descriptors
 * and a generic renderer, which is more machinery than two harnesses justify and
 * would have to be unpicked the moment a third one wants a control neither of
 * these has.
 *
 * What is genuinely shared lives in `shared/args.ts`: the tokeniser the server
 * uses, so neither side has to agree with the other about what a quote means.
 */

/**
 * Flags whose value is the next token, for the ones that fall through to
 * `extra`.
 *
 * Taken from `hermes chat --help` on a real install rather than from the
 * documentation, which lists a `-p/--profile` that the CLI does not accept:
 * `profile` is a subcommand there, not a flag, and a control offering it built
 * a command line argparse rejects before the session ever started.
 *
 * `--model`, `--provider` and `--reasoning` are absent for the same reason they
 * are in the Claude file: they have their own branch, which always `continue`s.
 */
const VALUED = new Set([
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
]);

/** Which terminal interface Hermes puts up. Empty means whatever it defaults to. */
export type Interface = "" | "cli" | "tui";

export interface HermesSettings {
  /** Model id as the provider spells it. Empty for whatever Hermes is set to. */
  model: string;
  /** Provider id, which is Hermes' own configuration rather than a fixed list. */
  provider: string;
  /** How hard the session thinks. Empty for whatever Hermes defaults to. */
  reasoning: string;
  interface: Interface;
  toggles: Record<string, boolean>;
  /** Everything the controls above do not own, as the user typed it. */
  extra: string;
}

/**
 * Boolean flags the editor offers as switches.
 *
 * `--yolo` is first and reads as the dangerous one because it is: it is the
 * Hermes equivalent of `--dangerously-skip-permissions`, and the same argument
 * applies — reasonable on a box that is already a sandbox, and nowhere else.
 */
export const TOGGLES: {
  flag: string;
  label: string;
  hint: string;
}[] = [
  {
    flag: "--yolo",
    label: "Skip approvals",
    hint: "Run dangerous commands without asking. Same trade as Claude's skip-every-check.",
  },
  {
    flag: "--continue",
    label: "Resume last conversation",
    hint: "Pick up the most recent session rather than starting a new one.",
  },
  {
    flag: "--ignore-rules",
    label: "Ignore rules and memory",
    hint: "Skip AGENTS.md, SOUL.md and the memory directory for this session.",
  },
  {
    flag: "--ignore-user-config",
    label: "Ignore user config",
    hint: "Use defaults instead of ~/.hermes/config.yaml. Credentials still load.",
  },
  {
    flag: "--safe-mode",
    label: "Safe mode",
    hint: "Disable every customisation at once. The reproducible-run switch.",
  },
  {
    flag: "--checkpoints",
    label: "Checkpoints",
    hint: "Snapshot files before destructive edits, so /rollback can undo them.",
  },
  {
    flag: "--verbose",
    label: "Verbose output",
    hint: "Show full tool output rather than the collapsed form.",
  },
  {
    flag: "--pass-session-id",
    label: "Pass session id",
    hint: "Put the session id in the system prompt, so the agent can name its own session.",
  },
];

export const TUI = "--tui";
export const CLI = "--cli";

export { detokenize };

/** Readable names for the two interfaces, and what each is for. */
const INTERFACE_LABELS: Record<Interface, string> = {
  "": "Default — whatever Hermes picks",
  cli: "Classic — a plain REPL",
  tui: "Full screen — overlays and mouse selection",
};

export const interfaceLabel = (value: Interface): string =>
  INTERFACE_LABELS[value] ?? value;

/**
 * Reads stored argv into the editor's controls.
 *
 * Both spellings of every flag are understood on the way in and the long one is
 * always written on the way out, so `-m opus` typed into the advanced field
 * comes back as a model selection rather than as text nothing recognises.
 */
export function parseSettings(args: string[]): HermesSettings {
  const toggles: Record<string, boolean> = {};
  const known = new Set(TOGGLES.map((t) => t.flag));
  const leftovers: string[] = [];
  let model = "";
  let provider = "";
  let reasoning = "";
  let iface: Interface = "";

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];

    if (token === TUI) {
      iface = "tui";
      continue;
    }
    if (token === CLI) {
      iface = "cli";
      continue;
    }
    // `-c` is the short form of --continue and takes an optional session name.
    // Only the bare form is a switch; `-c mine` names a session, which is not
    // something a control here can say, so it goes to the advanced field whole.
    if (token === "-c") {
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        leftovers.push(token, next);
        i += 1;
      } else {
        toggles["--continue"] = true;
      }
      continue;
    }
    if (known.has(token)) {
      toggles[token] = true;
      continue;
    }
    if (
      token === "--model" ||
      token === "-m" ||
      token === "--provider" ||
      token === "--reasoning"
    ) {
      const value = args[i + 1];
      // A trailing valued flag with nothing after it is malformed; keep it in
      // `extra` rather than swallowing it, so the person can see and fix it.
      if (value === undefined || value.startsWith("-")) {
        leftovers.push(token);
        continue;
      }
      i += 1;
      if (token === "--model" || token === "-m") model = value;
      else if (token === "--provider") provider = value;
      else reasoning = value;
      continue;
    }
    leftovers.push(token);
    // Keep a value attached to the flag it belongs to.
    if (
      VALUED.has(token) &&
      args[i + 1] !== undefined &&
      !args[i + 1].startsWith("-")
    ) {
      leftovers.push(args[i + 1]);
      i += 1;
    }
  }

  return {
    model,
    provider,
    reasoning,
    interface: iface,
    toggles,
    extra: detokenize(leftovers),
  };
}

/** Composes the controls back into a command line for the server to tokenise. */
export function buildArgs(settings: HermesSettings): string {
  const tokens: string[] = [];

  if (settings.model) tokens.push("--model", settings.model);
  if (settings.provider) tokens.push("--provider", settings.provider);
  if (settings.reasoning) tokens.push("--reasoning", settings.reasoning);
  // The two are mutually exclusive by construction: `interface` holds one value,
  // so there is no state in which both flags can be written.
  if (settings.interface === "tui") tokens.push(TUI);
  else if (settings.interface === "cli") tokens.push(CLI);

  for (const { flag } of TOGGLES) {
    if (settings.toggles[flag]) tokens.push(flag);
  }

  const extra = settings.extra.trim();
  return [detokenize(tokens), extra].filter(Boolean).join(" ");
}
