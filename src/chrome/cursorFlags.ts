import { detokenize } from "../../shared/args";

/**
 * The same job `claudeFlags.ts` and `hermesFlags.ts` do, for the third CLI.
 *
 * Mirrored rather than shared, for the reason `hermesFlags.ts` gives: the three
 * files have the same shape and the same contract — read stored argv into
 * controls, write it back out, hand every unrecognised token to the advanced
 * field in its original order — but almost no flags in common, and a generic
 * flag-descriptor table is more machinery than three harnesses justify.
 *
 * The flag list is verbatim from `cursor-agent --help` on a real install —
 * the lesson the Hermes file learned the hard way when the docs listed a flag
 * argparse rejected. Notable absences are deliberate: there is no `-m` short
 * form for `--model` (it is accepted on the way in anyway, and normalised to
 * the spelling the CLI does take), and `--print`/`--output-format` belong to
 * scripting rather than to a terminal window, so they pass through untouched.
 */

/**
 * Flags whose value is the next token, for the ones that fall through to
 * `extra`.
 *
 * `--model` is absent for the reason it is absent in the other two files: it
 * has its own branch, which always `continue`s. `--resume` and `--worktree`
 * take an *optional* value, handled like Hermes' `-c` below rather than listed
 * here.
 */
const VALUED = new Set([
  "--output-format",
  "--workspace",
  "--api-key",
  "--mode",
  "--sandbox",
  "--header",
  "-H",
  "--endpoint",
  "-e",
  "--add-dir",
  "--plugin-dir",
  "--worktree-base",
]);

export interface CursorSettings {
  /** Model id as `cursor-agent models` spells it. Empty for Cursor's default. */
  model: string;
  toggles: Record<string, boolean>;
  /** Everything the controls above do not own, as the user typed it. */
  extra: string;
}

/**
 * Boolean flags the editor offers as switches.
 *
 * `--force` is first and reads as the dangerous one because it is: edits and
 * commands run without confirmation, the Cursor spelling of Claude's
 * `--dangerously-skip-permissions` and Hermes' `--yolo`. The same argument
 * applies — reasonable on a box that is already a sandbox, and nowhere else.
 *
 * `--trust` exists because every vibe-os workspace is a freshly cut worktree,
 * which to Cursor is a directory it has never seen: without this, every new
 * workspace opens with the trust prompt where the conversation should be.
 *
 * `--approve-mcps` is the same argument one layer along. Cursor records which
 * MCP servers have been approved per directory, in the same per-worktree place
 * it keeps their credentials, so the approval given in one workspace is not the
 * approval the next one asks for. The credentials are shared by the link
 * `session.ts` makes; approvals are a flag because Cursor offers one.
 */
export const TOGGLES: {
  flag: string;
  label: string;
  hint: string;
}[] = [
  {
    flag: "--force",
    label: "Skip approvals",
    hint: "Edit files and run commands without asking. Same trade as Claude's skip-every-check.",
  },
  {
    flag: "--trust",
    label: "Trust the worktree",
    hint: "Skip the new-workspace trust prompt. Every vibe-os worktree is new to Cursor.",
  },
  {
    flag: "--approve-mcps",
    label: "Approve MCP servers",
    hint: "Skip the per-workspace approval prompt for the servers in ~/.cursor/mcp.json.",
  },
  {
    flag: "--continue",
    label: "Resume last conversation",
    hint: "Pick up the most recent session rather than starting a new one.",
  },
];

export { detokenize };

/**
 * Reads stored argv into the editor's controls.
 *
 * Both spellings of every flag are understood on the way in and one canonical
 * form is written on the way out: `-m` becomes `--model`, and `--yolo` — which
 * the CLI documents as the same switch — becomes `--force`.
 */
export function parseSettings(args: string[]): CursorSettings {
  const toggles: Record<string, boolean> = {};
  const known = new Set(TOGGLES.map((t) => t.flag));
  const leftovers: string[] = [];
  let model = "";

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];

    // The CLI's aliases for --force; folded in so the switch lights up.
    if (token === "--yolo" || token === "-f") {
      toggles["--force"] = true;
      continue;
    }
    if (known.has(token)) {
      toggles[token] = true;
      continue;
    }
    if (token === "--model" || token === "-m") {
      const value = args[i + 1];
      // A trailing valued flag with nothing after it is malformed; keep it in
      // `extra` rather than swallowing it, so the person can see and fix it.
      if (value === undefined || value.startsWith("-")) {
        leftovers.push(token);
        continue;
      }
      i += 1;
      model = value;
      continue;
    }
    // `--resume` takes an optional chat id, `-w`/`--worktree` an optional
    // name. Bare they mean "the latest" or "make one up"; with a value they
    // name one, which no control here can say — so the pair goes to the
    // advanced field whole, like Hermes' `-c mine`.
    if (token === "--resume" || token === "--worktree" || token === "-w") {
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        leftovers.push(token, next);
        i += 1;
      } else {
        leftovers.push(token);
      }
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
    toggles,
    extra: detokenize(leftovers),
  };
}

/** Composes the controls back into a command line for the server to tokenise. */
export function buildArgs(settings: CursorSettings): string {
  const tokens: string[] = [];

  if (settings.model) tokens.push("--model", settings.model);
  for (const { flag } of TOGGLES) {
    if (settings.toggles[flag]) tokens.push(flag);
  }

  const extra = settings.extra.trim();
  return [detokenize(tokens), extra].filter(Boolean).join(" ");
}
