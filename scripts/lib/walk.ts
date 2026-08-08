import { readdir } from "node:fs/promises";
import path from "node:path";

/**
 * Every file under `dir`, depth-first.
 *
 * Both build scripts walk `dist/web` in the same `bun run build` pipeline, and
 * had a byte-identical copy of this each. Symlinks come back as files rather
 * than being followed, which is what you want for a build output tree — the
 * caller stats them anyway.
 */
export async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}
