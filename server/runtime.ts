/**
 * Whether we are running inside a `bun build --compile` binary.
 *
 * Bun rewrites module paths to a virtual `/$bunfs/` root in standalone
 * executables. That matters because a compiled binary carries the web assets
 * inside it: there is no package directory to read from, nothing to fetch, and
 * the preflight checks that make sense from a git checkout would all fail.
 */
export const IS_COMPILED = import.meta.url.includes('$bunfs') || import.meta.url.includes('B:/~BUN');

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
