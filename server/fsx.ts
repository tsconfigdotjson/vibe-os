// Filesystem helpers that more than one module needs to get right.

import {
  access,
  chmod,
  constants,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";

/**
 * Write-then-rename, so an interrupted write cannot be observed.
 *
 * Two separate reasons this is not just `writeFile`:
 *
 * - `rename` is atomic within a filesystem, so a reader either sees the whole
 *   old file or the whole new one. A crash partway through leaves the temp file
 *   behind and the real one untouched, rather than a truncated JSON blob or a
 *   private key with no matching certificate.
 * - `writeFile`'s `mode` is only honoured when it *creates* the file. Writing
 *   over an existing path silently keeps whatever permissions were already
 *   there, which reads as if the mode were enforced on every write when it is
 *   not — hence the explicit `chmod` before the rename.
 */
export async function writeAtomic(
  target: string,
  contents: string | Uint8Array,
  mode: number,
): Promise<void> {
  const tmp = `${target}.tmp`;
  await writeFile(tmp, contents, { mode });
  await chmod(tmp, mode);
  await rename(tmp, target);
}

/**
 * Serialises async work onto a single chain.
 *
 * For read-modify-write on a file with no locking: without this, two callers
 * both read the old contents and the second write silently discards the first's
 * change. Each returned function queues behind the previous one.
 */
export function serialise(): <T>(job: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(job: () => Promise<T>): Promise<T> => {
    const next = tail.then(job, job);
    // Keep the chain alive even when a job rejects; the caller still sees it.
    tail = next.catch(() => {});
    return next;
  };
}

/**
 * Does this path exist at all, of any kind?
 *
 * These three predicates answer genuinely different questions, which is why
 * they are three named functions rather than one `exists` whose meaning depends
 * on the caller: the CA cares whether a key file is there, preflight cares that
 * the wasm is a file and not a directory, and the project scanner cares about
 * directories only. They were previously reimplemented once per module.
 */
export async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** Is this path a regular file? */
export async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

/** Is this path a directory? */
export async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}
