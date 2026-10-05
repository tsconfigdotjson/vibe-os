#!/usr/bin/env node

// Fetches ssh.wasm + wasm_exec.js from an upstream c2FmZQ/sshterm release into
// public/.
//
// The two files are a matched pair: wasm_exec.js is the host half of the Go
// WASM ABI and is version-locked to the compiler that produced the .wasm, so
// they always come from the same release tarball. Building from source instead
// would require a Go toolchain on the target machine, which a VPS running
// the npm package will not have.
//
// Flags:
//   --if-missing   no-op when public/ssh.wasm already exists
//   --soft-fail    warn and exit 0 on failure (used from postinstall, where a
//                  hard failure would break `npm install` on an offline box;
//                  the server retries this at startup)

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const PUBLIC = path.join(ROOT, "public");
const REPO = "c2FmZQ/sshterm";

/**
 * The release this project is built and tested against, with the checksum of
 * its docroot tarball.
 *
 * Pinned rather than tracking `latest` because this file becomes the SSH client
 * that generates and holds every user's private key in the browser, and it is
 * fetched automatically by `postinstall`. Tracking `latest` meant whatever
 * upstream tagged most recently became that code, unverified — so an install
 * today and an install tomorrow could differ with nothing recording it.
 *
 * To move it: set SSHTERM_VERSION to the new tag, run this script, and copy the
 * sha256 it prints into `sha256` below.
 */
const PINNED = {
  tag: "v0.8.3",
  sha256: "77af7cb2582ff43588d866277019351695c23880133929136532340937dba87c",
};

const args = new Set(process.argv.slice(2));
const ifMissing = args.has("--if-missing");
const softFail = args.has("--soft-fail");

// Local rather than shared with server/fsx.ts: this asks a different question
// (non-empty, because a half-written 0-byte ssh.wasm must not count as present)
// and this script has to keep running under plain node, with no .ts imports.
async function exists(p) {
  try {
    const s = await stat(p);
    return s.size > 0;
  } catch {
    return false;
  }
}

async function resolveAsset() {
  const override = process.env.SSHTERM_VERSION;
  const tag = override ?? PINNED.tag;
  const url = `https://api.github.com/repos/${REPO}/releases/tags/${tag}`;
  const res = await fetch(url, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "vibe-os-installer",
      ...(process.env.GITHUB_TOKEN
        ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
        : {}),
    },
  });
  if (!res.ok)
    throw new Error(`GitHub API ${res.status} ${res.statusText} for ${url}`);
  const release = await res.json();
  const asset = release.assets?.find((a) =>
    /^sshterm-docroot-.*\.tar\.gz$/.test(a.name),
  );
  if (!asset) {
    throw new Error(
      `release ${release.tag_name} has no sshterm-docroot tarball`,
    );
  }
  return {
    tag: release.tag_name,
    name: asset.name,
    url: asset.browser_download_url,
    // Only the pinned tag has a checksum recorded here; an override is by
    // definition something this file has never seen.
    sha256: override ? null : PINNED.sha256,
  };
}

async function sha256Of(file) {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
}

function untar(tarball, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", ["-xzf", tarball, "-C", cwd], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`tar exited ${code}: ${stderr.trim()}`)),
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
    } else if (entry.isFile() && entry.name === name) {
      // isFile() excludes symlinks, which a tarball can carry and which would
      // otherwise let an entry point anywhere on the filesystem.
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
    for (const dir of [PUBLIC, path.join(ROOT, "dist", "web")]) {
      if (
        (await exists(path.join(dir, "ssh.wasm"))) &&
        (await exists(path.join(dir, "wasm_exec.js")))
      )
        return;
    }
  }

  const asset = await resolveAsset();
  console.log(`vibe-os: fetching ssh.wasm from ${REPO} ${asset.tag}`);

  // mkdtemp, not a name we compose ourselves: it creates the directory
  // atomically with an unpredictable suffix, so nothing in a world-writable
  // /tmp can pre-create the path (or a symlink at it) and have the extracted
  // contents land somewhere of its choosing. Same reasoning as server/ssh-ca.ts.
  const tmp = await mkdtemp(path.join(os.tmpdir(), "vibe-os-wasm-"));
  try {
    const tarball = path.join(tmp, asset.name);
    const res = await fetch(asset.url, {
      headers: { "user-agent": "vibe-os-installer" },
      redirect: "follow",
    });
    if (!res.ok || !res.body)
      throw new Error(`download ${asset.url}: HTTP ${res.status}`);
    await pipeline(res.body, createWriteStream(tarball));

    const digest = await sha256Of(tarball);
    if (asset.sha256 && digest !== asset.sha256) {
      throw new Error(
        `checksum mismatch for ${asset.name}\n` +
          `  expected ${asset.sha256}\n` +
          `  received ${digest}\n` +
          "Refusing to install: this file becomes the SSH client that handles " +
          "your private keys.",
      );
    }
    if (!asset.sha256) {
      console.warn(
        `vibe-os: SSHTERM_VERSION=${asset.tag} is not the pinned release — ` +
          "skipping checksum verification.",
      );
      console.warn(`vibe-os: sha256 of ${asset.name} is ${digest}`);
    }

    await untar(tarball, tmp);

    // Resolve both halves before moving either. They are a matched pair, and a
    // failure between two moves would leave a new ssh.wasm beside the previous
    // wasm_exec.js — which --if-missing then treats as "already have it", so the
    // mismatch would be permanent and would surface only as an opaque failure
    // in the browser.
    const staged = [];
    for (const name of ["ssh.wasm", "wasm_exec.js"]) {
      const found = await findFile(tmp, name);
      if (!found) throw new Error(`${asset.name} does not contain ${name}`);
      staged.push([name, found]);
    }

    for (const [name, found] of staged) {
      await rename(found, path.join(PUBLIC, name)).catch(async (err) => {
        // rename fails across devices; fall back to a copy.
        if (err.code !== "EXDEV") throw err;
        const { copyFile } = await import("node:fs/promises");
        await copyFile(found, path.join(PUBLIC, name));
      });
    }

    const size = (await stat(path.join(PUBLIC, "ssh.wasm"))).size;
    console.log(
      `vibe-os: ssh.wasm ready (${(size / 1024 / 1024).toFixed(1)} MB)`,
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  if (softFail) {
    console.warn(`vibe-os: could not fetch ssh.wasm (${err.message}).`);
    console.warn(
      "vibe-os: it will be fetched on first start, or run `vibe-os fetch-wasm`.",
    );
    process.exit(0);
  }
  console.error(`vibe-os: ${err.message}`);
  process.exit(1);
});
