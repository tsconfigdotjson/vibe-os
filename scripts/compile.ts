#!/usr/bin/env bun
// Compiles vibe-os into standalone executables.
//
// The output needs no Bun, no Node and no npm on the target machine — the whole
// web app, including the ~20MB ssh.wasm and its precompressed variants, is
// embedded. That makes the VPS install "download one file and run it".

import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const OUT = path.join(ROOT, 'dist', 'bin');
const ENTRY = path.join(ROOT, 'server', 'main.ts');

const TARGETS = [
  { target: 'bun-linux-x64', name: 'vibe-os-linux-x64' },
  { target: 'bun-linux-arm64', name: 'vibe-os-linux-arm64' },
  { target: 'bun-darwin-arm64', name: 'vibe-os-darwin-arm64' },
];

const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const selected = only.length > 0 ? TARGETS.filter((t) => only.some((o) => t.target.includes(o))) : TARGETS;

if (selected.length === 0) {
  console.error(`no target matched. known: ${TARGETS.map((t) => t.target).join(', ')}`);
  process.exit(1);
}

await mkdir(OUT, { recursive: true });

for (const { target, name } of selected) {
  const outfile = path.join(OUT, name);
  console.log(`vibe-os: compiling ${target}…`);
  const proc = Bun.spawn(
    [
      'bun',
      'build',
      '--compile',
      `--target=${target}`,
      // Stack traces would point at bundled output anyway, and the server code
      // is a rounding error next to the embedded wasm.
      '--minify',
      '--sourcemap=none',
      ENTRY,
      '--outfile',
      outfile,
    ],
    { cwd: ROOT, stdout: 'inherit', stderr: 'inherit' },
  );
  const code = await proc.exited;
  if (code !== 0) {
    console.error(`vibe-os: compiling ${target} failed`);
    process.exit(code);
  }
  const size = (await stat(outfile)).size;
  console.log(`vibe-os: ${name} — ${(size / 1024 / 1024).toFixed(1)} MB`);
}
