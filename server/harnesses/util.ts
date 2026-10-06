// What every harness adapter needs to ask the box about a binary.
//
// Kept apart from the registry in `../harness.ts` so an adapter can import it
// without importing the list of adapters it is itself a member of.

import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";
import type { HarnessReport, HarnessSpec } from "../../shared/harness.ts";

export const home = process.env.HOME ?? "";

const execFileAsync = promisify(execFile);

/**
 * The PATH a window's harness gets, so discovery sees what a window will.
 *
 * A window exports `$HOME/.local/bin` ahead of everything (see `launch` in
 * `session.ts`). Without the same here, a CLI that is a Node script, like
 * Codex, resolves but cannot start when `node` itself lives in
 * `~/.local/bin`: `vibe-os doctor` over a plain `ssh host 'command'` called
 * it installed with no version and could not read its login.
 */
const env = {
  ...process.env,
  PATH: `${home}/.local/bin:${process.env.PATH ?? ""}`,
};

export const run = (
  file: string,
  args: string[],
  opts: { timeout?: number; maxBuffer?: number } = {},
) => execFileAsync(file, args, { ...opts, env, encoding: "utf8" });

/** `~/x` to `$HOME/x`, for the paths a spec lists. */
export const expandHome = (p: string): string =>
  p === "~" ? home : p.startsWith("~/") ? `${home}${p.slice(1)}` : p;

/**
 * Resolves a command through PATH, then the given locations, then symlinks.
 *
 * A login shell picks `~/.local/bin` up from `.profile`; a systemd service does
 * not, and vibe-os is meant to run as one. Without the extra locations the
 * server cannot find a binary the window will happily launch a moment later,
 * because the window runs under a login-ish shell with that PATH restored and
 * the server does not.
 */
export async function resolveBinary(
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
    // not on PATH; the explicit locations may still have it
  }
  candidates.push(...extraPaths.map(expandHome).filter(Boolean));

  for (const candidate of candidates) {
    try {
      await stat(candidate);
      const { stdout: real } = await run(
        "/bin/sh",
        ["-c", 'readlink -f "$1"', "sh", candidate],
        { timeout: 5_000 },
      );
      return real.trim() || candidate;
    } catch {
      // next
    }
  }
  return null;
}

/**
 * Runs a command and returns everything it printed, whatever it exited with.
 *
 * For the questions whose answer is the text either way: `codex login status`
 * prints "Not logged in" to stderr and exits 1, and that is an answer, not a
 * failure. Null only when nothing ran at all.
 */
export async function output(
  binary: string,
  args: string[],
  timeout = 30_000,
): Promise<string | null> {
  try {
    const { stdout, stderr } = await run(binary, args, {
      timeout,
      maxBuffer: 4 * 1024 * 1024,
    });
    return `${stdout}\n${stderr}`;
  } catch (err) {
    const e = err as { stdout?: unknown; stderr?: unknown; killed?: boolean };
    if (e.killed) return null;
    const text = `${typeof e.stdout === "string" ? e.stdout : ""}\n${typeof e.stderr === "string" ? e.stderr : ""}`;
    return text.trim() ? text : null;
  }
}

/**
 * The version-shaped token on the first line that has anything on it.
 *
 * Covers `2.1.3 (Claude Code)`, `codex-cli 0.160.1` and Cursor's date-shaped
 * `2026.08.11-e8db854` alike. Only the first line is a claim about the binary
 * itself; a wrapper or update notice printed after it must not become the
 * answer.
 */
export function versionToken(stdout: string): string | null {
  const first = stdout.split("\n").find((l) => l.trim()) ?? "";
  const match = /\bv?(\d+(?:\.\d+)+[^\s()]*)/.exec(first);
  return match ? match[1] : null;
}

/**
 * What a status command says about being logged in, when it says anything.
 *
 * "Not logged in" contains "logged in", so the negative is checked first. Text
 * this cannot read returns null rather than false: only a definite "no" should
 * make the editor warn that a window will sit at a login prompt.
 */
export function loggedIn(text: string): boolean | null {
  const lower = text.toLowerCase();
  if (
    /not\s+logged\s+in|logged\s+out|unauthenticated|no.*credentials/.test(lower)
  )
    return false;
  if (/logged\s+in|signed\s+in|authenticated/.test(lower)) return true;
  return null;
}

/**
 * Checks that read a ladder have to keep its order.
 *
 * A thinking level is ordinal, so the list is the scale, and anything that does
 * not look like a level means the parse caught a sentence. Half a list read out
 * of a paragraph would be worse than none, so the caller falls back to its own.
 */
export const looksLikeLadder = (levels: string[]): boolean =>
  levels.length >= 2 && levels.every((l) => /^[a-z][a-z0-9-]*$/.test(l));

/** A check doctor prints, without importing doctor. */
export interface HarnessCheck {
  label: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

/** What an adapter's own discovery adds to the generic version and login. */
export interface Discovery<D = unknown> {
  /** Overrides the generic `--version` read, for a harness that prints oddly. */
  version?: string | null;
  options?: HarnessReport["options"];
  defaults?: HarnessReport["defaults"];
  notes?: HarnessReport["notes"];
  /** Anything the adapter's own doctor checks need that the report does not carry. */
  detail?: D;
}

/**
 * A harness: a spec, plus whatever code it needs that data cannot say.
 *
 * Every hook is optional. A spec alone is a working harness, which is what a
 * `~/.vibe-os/harnesses/*.json` file is.
 */
export interface HarnessAdapter<D = unknown> {
  spec: HarnessSpec;
  /** Reads models and options off the installed binary. */
  discover?: (binary: string) => Promise<Discovery<D>>;
  /** Shell run in the window before the harness starts. */
  setup?: (where: { cwd: string; stateDir: string }) => string;
  /** Doctor checks beyond installed and logged in. */
  checks?: (report: HarnessReport, detail: D | undefined) => HarnessCheck[];
}
