# Development

```bash
bun install          # also fetches ssh.wasm from the upstream release
bun run build        # web app + precompressed assets + embedded manifest
bun run dev          # Vite on :5173, proxying to a vibe-os on :7681
bun run dev:server   # the server with --hot, on :7681
bun run compile      # standalone binaries into dist/bin

bun run check        # lint + typecheck + tests, the same three CI runs
bun test             # specs in test/ and beside the code
```

Biome with the recommended rule set and Prettier's defaults. Nothing is switched
off in `biome.json`. The server is TypeScript run directly by Bun, with no build
step of its own.

| | |
| --- | --- |
| server | Bun, TypeScript run directly, `Bun.serve`, no framework |
| storage | SQLite (`bun:sqlite`) via drizzle-orm, idempotent DDL at startup |
| browser | React 19, Vite, xterm.js v6, SWR for polling |
| ssh | `ssh.wasm` in the tab, `ssh-keygen` and `ssh-keyscan` on the host |
| shared | `shared/`: wire types, the grid, the argv tokeniser |

`ssh.wasm` comes prebuilt from
[c2FmZQ/sshterm](https://github.com/c2FmZQ/sshterm) releases, pinned by tag with
its SHA-256 verified before extraction. To move it, set `SSHTERM_VERSION`, run
`bun run fetch-wasm`, and copy the checksum it prints into `PINNED`.

## Building from source

```bash
bun install && bun run build
bun scripts/compile.ts linux-x64     # or linux-arm64, darwin-arm64; none for all
scp dist/bin/vibe-os-linux-x64 you@host:/tmp/vibe-os
ssh you@host 'sudo install -m 0755 /tmp/vibe-os /usr/local/bin/vibe-os'
```

## Releasing

Bump `version` in `package.json`, merge, then tag the merge commit:

```bash
git tag v0.2.0 && git push origin v0.2.0
```

The tag must match `package.json`. The workflow publishes the binaries with
`SHA256SUMS` as a GitHub Release, pushes `ghcr.io/tsconfigdotjson/vibe-os`, and
publishes `@tsconfigdotjson/vibe-os` to npm with provenance, through npm's
[trusted publishing](https://docs.npmjs.com/trusted-publishers). A hyphenated
tag such as `v0.2.0-rc.1` is a prerelease: the installer skips it, and npm gets
it under the `next` dist-tag rather than `latest`.

## Icons

App icons are generated from `public/icon.svg`:

```bash
rsvg-convert -w 192 -h 192 public/icon-app.svg -o public/icon-192.png
rsvg-convert -w 512 -h 512 public/icon-app.svg -o public/icon-512.png
rsvg-convert -w 180 -h 180 public/icon-app.svg -o public/apple-touch-icon.png
rsvg-convert -w 512 -h 512 public/icon-maskable.svg -o public/icon-maskable-512.png
```
