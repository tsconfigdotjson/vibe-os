#!/usr/bin/env node
// Precompresses large static assets after `vite build`.
//
// ssh.wasm is ~20MB and every first-time visitor pays for it. Compressing at
// build time (rather than per-request) lets the server hand out a ~5MB body
// with zero CPU cost at serve time.

import { readdir, stat, readFile, writeFile } from 'node:fs/promises';
import { brotliCompress, gzip, constants } from 'node:zlib';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const br = promisify(brotliCompress);
const gz = promisify(gzip);

const WEB = path.resolve(fileURLToPath(new URL('../dist/web', import.meta.url)));
const COMPRESSIBLE = /\.(wasm|js|css|html|json|svg)$/;
const MIN_SIZE = 4096;

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

const t0 = Date.now();
let count = 0;
let saved = 0;

for await (const file of walk(WEB)) {
  if (!COMPRESSIBLE.test(file) || /\.(br|gz)$/.test(file)) continue;
  const size = (await stat(file)).size;
  if (size < MIN_SIZE) continue;

  const raw = await readFile(file);
  // Quality 5 rather than the default 11: on a 20MB wasm the top setting costs
  // minutes of build time for a few percent of size.
  const [brotli, gzipped] = await Promise.all([
    br(raw, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: 5,
        [constants.BROTLI_PARAM_SIZE_HINT]: size,
      },
    }),
    gz(raw, { level: 6 }),
  ]);
  await writeFile(`${file}.br`, brotli);
  await writeFile(`${file}.gz`, gzipped);
  count += 1;
  saved += size - brotli.length;
}

console.log(
  `vibe-os: precompressed ${count} asset(s), saving ${(saved / 1024 / 1024).toFixed(1)} MB on the wire (${((Date.now() - t0) / 1000).toFixed(1)}s)`,
);
