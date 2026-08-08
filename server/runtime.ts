import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Whether we are running inside a `bun build --compile` binary.
 *
 * Bun rewrites module paths to a virtual `/$bunfs/` root in standalone
 * executables. That matters because a compiled binary carries the web assets
 * inside it: there is no package directory to read from, nothing to fetch, and
 * the preflight checks that make sense from a git checkout would all fail.
 */
export const IS_COMPILED =
  import.meta.url.includes("$bunfs") || import.meta.url.includes("B:/~BUN");

/**
 * Arguments passed to the CLI, independent of how it was launched.
 *
 * Bun keeps argv the same shape in both modes — [runtime, entry, ...args] —
 * where a compiled binary reports its entry as "/$bunfs/root/<name>". Verified
 * rather than assumed: it is tempting to think a standalone executable drops
 * the entry slot, and slicing 1 there silently turns the entry path into the
 * subcommand.
 */
export function cliArgs(): string[] {
  return process.argv.slice(2);
}

/**
 * The package root — one directory above `server/`.
 *
 * Both `cli.ts` and `preflight.ts` derived this the same way from their own
 * `import.meta.url`, which works only because both happen to live one level
 * down. Deriving it here makes that assumption a single fact.
 */
export const PKG_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/** The CLI entry point, for re-invoking ourselves from a checkout. */
export const ENTRY = path.join(PKG_ROOT, "server", "cli.ts");

/** The `fetch-wasm` script, spawned from both the CLI and preflight. */
export const FETCH_WASM = path.join(PKG_ROOT, "scripts", "fetch-wasm.mjs");

/** Directories on a default PATH, where a bare command name resolves. */
const DEFAULT_PATH = new Set([
  "/usr/local/sbin",
  "/usr/local/bin",
  "/usr/sbin",
  "/usr/bin",
  "/sbin",
  "/bin",
]);

/**
 * How to run vibe-os again — the string printed into ssh commands people copy,
 * and into the systemd unit. Both used to build it separately.
 */
export function invocation(): string {
  if (!IS_COMPILED) return `${process.execPath} ${ENTRY}`;
  const exe = process.execPath;
  return DEFAULT_PATH.has(path.dirname(exe)) ? path.basename(exe) : exe;
}
