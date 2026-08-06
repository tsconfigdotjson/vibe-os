import { access, copyFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from './log.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** dist/server -> package root */
const PKG_ROOT = path.resolve(HERE, '..', '..');

const WASM_FILES = ['ssh.wasm', 'wasm_exec.js'];

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

function runFetchScript(): Promise<void> {
  const script = path.join(PKG_ROOT, 'scripts', 'fetch-wasm.mjs');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, '--if-missing'], { stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`fetch-wasm exited ${code}`))));
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
  const missing = [];
  for (const name of WASM_FILES) {
    if (!(await isFile(path.join(webRoot, name)))) missing.push(name);
  }
  if (missing.length === 0) return;

  const publicDir = path.join(PKG_ROOT, 'public');
  const stillMissing = [];
  for (const name of missing) {
    if (!(await isFile(path.join(publicDir, name)))) stillMissing.push(name);
  }

  if (stillMissing.length > 0) {
    log.info(`fetching ${stillMissing.join(' and ')}…`);
    await runFetchScript();
  }

  for (const name of missing) {
    const from = path.join(publicDir, name);
    if (await isFile(from)) {
      await copyFile(from, path.join(webRoot, name));
    } else {
      throw new Error(`${name} is missing from ${webRoot} and could not be fetched`);
    }
  }
}

export async function ensureWebRoot(webRoot: string): Promise<void> {
  try {
    await access(path.join(webRoot, 'index.html'), constants.R_OK);
  } catch {
    throw new Error(
      `no built web app at ${webRoot}\n` +
        '  If you are running from a git checkout, build it first:  npm run build',
    );
  }
}
