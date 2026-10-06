// Cursor's CLI.
//
// `cursor-agent models` is a real listing mode, but it lists the account's
// models rather than the binary's: logged out, or offline, it cannot be read,
// so an empty list is "could not tell" and the field stays free text. No floor
// of well-known model names, because offering a model this account does not
// have would suggest a choice that can only fail after launch.
//
// The flag list is verbatim from `cursor-agent --help` on a real install.

import { log } from "../log.ts";
import { type Discovery, type HarnessAdapter, run } from "./util.ts";

export const CURSOR_INSTALL = "curl https://cursor.com/install -fsS | bash";

/** Single-quote for the shell the window's command runs in. */
const shellQuote = (value: string): string =>
  `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * Model ids out of `cursor-agent models`.
 *
 * The format is verbatim from a real box: an `Available models` header, then
 * one `id - Display Name` per line, then a `Tip:` sentence about `--model`. The
 * default is marked inside the display half: `auto - Auto (default)`.
 *
 * A line has to open with an id-shaped token followed by the ` - ` separator
 * (or nothing at all), which keeps the header and the tip out. Order is kept as
 * printed: Cursor leads with `auto` and its recommendations, which is a better
 * sort than alphabetical for a 200-entry list.
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
    // another `(current, default)`.
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
 * Cursor's name for a directory, as it spells it under `~/.cursor/projects`.
 *
 * Every run of anything that is not a letter or a digit becomes one dash, and
 * the leading one that a path always starts with is dropped. Case survives.
 * Read off a real install: `/home/ubuntu` is `home-ubuntu`, and
 * `/tmp/Cursor.Test_1 space/sub` is `tmp-Cursor-Test-1-space-sub`.
 */
export function cursorProjectSlug(dir: string): string {
  return dir.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * Shell that points this worktree's Cursor project at the box's MCP credentials.
 *
 * Cursor keeps MCP OAuth tokens per working directory, in
 * `~/.cursor/projects/<slug>/mcp-auth.json`, while the server list is global.
 * Every workspace here is a fresh worktree at a path Cursor has never seen, so
 * "log in once on this box" would mean "log in once per window".
 *
 * A symlink rather than a copy because Cursor writes through it: an access
 * token lasts a day, and the refresh that happens in whichever window is open
 * has to be the refresh every other window sees.
 *
 * The link is only created where there is nothing at all. An existing file is
 * somebody's real per-directory login; an existing link is this, already done.
 * The shared store may not exist yet: writing through a dangling symlink
 * creates the target, so `cursor-agent mcp login linear` in any window is the
 * one login the box needs.
 *
 * Failure is silent and inert. If Cursor changes how it names these
 * directories, the link lands somewhere Cursor does not read and windows behave
 * as they did before: a login prompt, not a broken window.
 */
export function cursorMcpLink(cwd: string, stateDir: string): string {
  const store = `${stateDir}/cursor/mcp-auth.json`;
  const storeDir = shellQuote(`${stateDir}/cursor`);
  // The slug is letters, digits and dashes by construction, so it needs no
  // quoting of its own; `$HOME` is left to the shell because the session runs
  // as the user whose credentials these are.
  const dir = `"$HOME/.cursor/projects/${cursorProjectSlug(cwd)}"`;
  const link = `"$HOME/.cursor/projects/${cursorProjectSlug(cwd)}/mcp-auth.json"`;
  return [
    `mkdir -p ${dir} ${storeDir} 2>/dev/null`,
    // Refresh tokens, so no wider than the state dir this sits in.
    `chmod 700 ${storeDir} 2>/dev/null`,
    `{ [ -e ${link} ] || [ -L ${link} ] || ln -s ${shellQuote(store)} ${link} 2>/dev/null; }`,
  ].join("; ");
}

export const cursor: HarnessAdapter = {
  spec: {
    id: "cursor",
    label: "Cursor",
    // The unambiguous one of the two names its installer symlinks. `agent` is
    // the other, and too generic to be the one a PATH lookup bets on.
    command: "cursor-agent",
    paths: ["~/.local/bin/cursor-agent", "/usr/local/bin/cursor-agent"],
    resume: { args: ["--continue"], unless: ["--continue", "--resume"] },
    install: CURSOR_INSTALL,
    login: { args: ["status"], fix: "cursor-agent login" },
    // --trust as well: every workspace is a fresh worktree, which to Cursor is
    // an untrusted directory, and a role window should open on the
    // conversation rather than on the trust prompt.
    defaults: ["--force", "--trust"],
    fields: [
      {
        kind: "select",
        key: "model",
        label: "Model",
        flag: "--model",
        aliases: ["-m"],
        none: "Default — whatever Cursor picks",
        placeholder: "Default — whatever Cursor picks",
        hint: "Read off `cursor-agent models`, so the list follows your account.",
        emptyHint:
          "Nothing to offer — `cursor-agent models` could not be read, which usually means the box is not logged in. Typed ids still work.",
      },
      {
        kind: "toggle",
        flag: "--force",
        // The CLI documents both as the same switch.
        aliases: ["--yolo", "-f"],
        label: "Skip approvals",
        hint: "Edit files and run commands without asking. Same trade as Claude's skip-every-check.",
        warn: "This session will not ask before editing or running anything. Reasonable on a box that is already a sandbox; think twice anywhere else.",
      },
      {
        kind: "toggle",
        flag: "--trust",
        label: "Trust the worktree",
        hint: "Skip the new-workspace trust prompt. Every vibe-os worktree is new to Cursor.",
      },
      {
        kind: "toggle",
        flag: "--approve-mcps",
        label: "Approve MCP servers",
        hint: "Skip the per-workspace approval prompt for the servers in ~/.cursor/mcp.json.",
      },
      {
        kind: "toggle",
        flag: "--continue",
        label: "Resume last conversation",
        hint: "Pick up the most recent session rather than starting a new one.",
      },
    ],
    valued: [
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
    ],
    // `--resume` takes an optional chat id and `-w`/`--worktree` an optional
    // name. With a value they name one, which no control here can say.
    optional: ["--resume", "--worktree", "-w"],
    extraPlaceholder: '--resume "…"',
  },

  async discover(binary): Promise<Discovery> {
    const listed = await run(binary, ["models"], {
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    })
      .then(({ stdout }) => parseCursorModels(stdout))
      // Logged out or offline it exits complaining; that is "could not read",
      // which the empty list already says.
      .catch(() => ({ models: [], defaultModel: null }));
    log.debug(`cursor-agent: ${listed.models.length} models`);
    return {
      options: { model: listed.models.map((value) => ({ value })) },
      defaults: listed.defaultModel
        ? { model: listed.defaultModel }
        : ({} as Record<string, string>),
    };
  },

  setup: ({ cwd, stateDir }) => cursorMcpLink(cwd, stateDir),
};
