#!/usr/bin/env node
// Fetches ssh.wasm + wasm_exec.js from an upstream c2FmZQ/sshterm release into
// public/.
//
// The two files are a matched pair: wasm_exec.js is the host half of the Go
// WASM ABI and is version-locked to the compiler that produced the .wasm, so
// they always come from the same release tarball. Building from source instead
// would require a Go toolchain on the target machine, which a VPS running
// `npx vibe-os` will not have.
//
// Flags:
//   --if-missing   no-op when public/ssh.wasm already exists
//   --soft-fail    warn and exit 0 on failure (used from postinstall, where a
//                  hard failure would break `npm install` on an offline box;
//                  the server retries this at startup)

import { createWriteStream } from 'node:fs';
import { mkdir, rm, stat, rename, readdir } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const PUBLIC = path.join(ROOT, 'public');
const REPO = 'c2FmZQ/sshterm';

const args = new Set(process.argv.slice(2));
const ifMissing = args.has('--if-missing');
const softFail = args.has('--soft-fail');

async function exists(p) {
  try {
    const s = await stat(p);
    return s.size > 0;
  } catch {
    return false;
  }
}

async function resolveAsset() {
  const pinned = process.env.SSHTERM_VERSION;
  const url = pinned
    ? `https://api.github.com/repos/${REPO}/releases/tags/${pinned}`
    : `https://api.github.com/repos/${REPO}/releases/latest`;
  const res = await fetch(url, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'vibe-os-installer',
      ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
    },
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status} ${res.statusText} for ${url}`);
  const release = await res.json();
  const asset = release.assets?.find((a) => /^sshterm-docroot-.*\.tar\.gz$/.test(a.name));
  if (!asset) {
    throw new Error(`release ${release.tag_name} has no sshterm-docroot tarball`);
  }
  return { tag: release.tag_name, name: asset.name, url: asset.browser_download_url };
}

function untar(tarball, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', ['-xzf', tarball, '-C', cwd], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`tar exited ${code}: ${stderr.trim()}`)),
    );
  });
}

// The tarball's internal layout is not part of any stability guarantee, so find
// the two files wherever they landed rather than assuming a path.
async function findFile(dir, name) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const hit = await findFile(full, name);
      if (hit) return hit;
    } else if (entry.name === name) {
      return full;
    }
  }
  return null;
}

async function main() {
  await mkdir(PUBLIC, { recursive: true });

  // Either location counts as "already have it": a git checkout keeps the pair
  // in public/, while the published tarball ships it already copied into
  // dist/web and does not include public/ at all. Checking only public/ would
  // re-download 19MB on every `npm install` of the published package.
  if (ifMissing) {
    for (const dir of [PUBLIC, path.join(ROOT, 'dist', 'web')]) {
      if ((await exists(path.join(dir, 'ssh.wasm'))) && (await exists(path.join(dir, 'wasm_exec.js')))) return;
    }
  }

  const asset = await resolveAsset();
  console.log(`vibe-os: fetching ssh.wasm from ${REPO} ${asset.tag}`);

  const tmp = path.join(os.tmpdir(), `vibe-os-wasm-${process.pid}`);
  await mkdir(tmp, { recursive: true });
  try {
    const tarball = path.join(tmp, asset.name);
    const res = await fetch(asset.url, {
      headers: { 'user-agent': 'vibe-os-installer' },
      redirect: 'follow',
    });
    if (!res.ok || !res.body) throw new Error(`download ${asset.url}: HTTP ${res.status}`);
    await pipeline(res.body, createWriteStream(tarball));

    await untar(tarball, tmp);

    for (const name of ['ssh.wasm', 'wasm_exec.js']) {
      const found = await findFile(tmp, name);
      if (!found) throw new Error(`${asset.name} does not contain ${name}`);
      await rename(found, path.join(PUBLIC, name)).catch(async (err) => {
        // rename fails across devices; fall back to a copy.
        if (err.code !== 'EXDEV') throw err;
        const { copyFile } = await import('node:fs/promises');
        await copyFile(found, path.join(PUBLIC, name));
      });
    }

    const size = (await stat(path.join(PUBLIC, 'ssh.wasm'))).size;
    console.log(`vibe-os: ssh.wasm ready (${(size / 1024 / 1024).toFixed(1)} MB)`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  if (softFail) {
    console.warn(`vibe-os: could not fetch ssh.wasm (${err.message}).`);
    console.warn('vibe-os: it will be fetched on first start, or run `npx vibe-os fetch-wasm`.');
    process.exit(0);
  }
  console.error(`vibe-os: ${err.message}`);
  process.exit(1);
});
