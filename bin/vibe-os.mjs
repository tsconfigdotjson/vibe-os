#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = pathToFileURL(path.join(root, 'dist', 'server', 'cli.js'));

let main;
try {
  ({ main } = await import(entry.href));
} catch (err) {
  if (err?.code === 'ERR_MODULE_NOT_FOUND') {
    console.error('vibe-os: the server is not built.');
    console.error('vibe-os: from a git checkout, run `npm install && npm run build` first.');
    process.exit(1);
  }
  throw err;
}

const code = await main(process.argv.slice(2));
// -1 means "the server is running"; anything else is a one-shot command.
if (code >= 0) process.exit(code);
