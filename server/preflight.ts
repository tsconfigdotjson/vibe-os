import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, copyFile } from "node:fs/promises";
import path from "node:path";
import { isFile } from "./fsx.ts";
import { log } from "./log.ts";
import { FETCH_WASM, IS_COMPILED, PKG_ROOT } from "./runtime.ts";

const WASM_FILES = ["ssh.wasm", "wasm_exec.js"];

/**
 * Downloads the pair unconditionally.
 *
 * Deliberately without `--if-missing`: that flag answers "is the pair in
 * public/ *or* in the package's own dist/web", and the only caller has already
 * established that public/ does not have them. With a custom --web-root and a
 * populated dist/web, the flag made the script exit successfully having copied
 * nothing, and ensureWasm then reported the files as unfetchable on a machine
 * that had them.
 */
function runFetchScript(): Promise<void> {
  const script = FETCH_WASM;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`fetch-wasm exited ${code}`)),
    );
  });
}

/**
 * Makes sure the WASM pair is present in the served directory.
 *
 * These are the only two files that are not built from this repo, so they can
 * legitimately be missing on a fresh checkout or after a failed (soft-failing)
 * postinstall. Fetching here rather than erroring means the first run of
 * `vibe-os start` on a blank VPS still works.
 */
export async function ensureWasm(webRoot: string): Promise<void> {
  // A compiled binary carries every asset inside it; there is no directory to
  // check and nothing to fetch.
  if (IS_COMPILED) return;

  const missing = [];
  for (const name of WASM_FILES) {
    if (!(await isFile(path.join(webRoot, name)))) missing.push(name);
  }
  if (missing.length === 0) return;

  const publicDir = path.join(PKG_ROOT, "public");
  const stillMissing = [];
  for (const name of missing) {
    if (!(await isFile(path.join(publicDir, name)))) stillMissing.push(name);
  }

  if (stillMissing.length > 0) {
    log.info(`fetching ${stillMissing.join(" and ")}…`);
    await runFetchScript();
  }

  for (const name of missing) {
    const from = path.join(publicDir, name);
    if (await isFile(from)) {
      await copyFile(from, path.join(webRoot, name));
    } else {
      throw new Error(
        `${name} is missing from ${webRoot} and could not be fetched`,
      );
    }
  }
}

export async function ensureWebRoot(webRoot: string): Promise<void> {
  if (IS_COMPILED) return;

  try {
    await access(path.join(webRoot, "index.html"), constants.R_OK);
  } catch {
    throw new Error(
      `no built web app at ${webRoot}\n` +
        "  If you are running from a git checkout, build it first:  bun run build",
    );
  }
}
