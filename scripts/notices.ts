#!/usr/bin/env bun

// Generates THIRD_PARTY_NOTICES.md: the license of everything the binary and
// the web app carry that this repository did not write.
//
// Two sources. npm packages are read out of node_modules, walking runtime
// dependencies from the packages that actually ship: `dependencies`, which the
// compiled server embeds, and the browser packages Vite bundles. ssh.wasm is
// compiled Go, so it carries Go's standard library and the modules sshterm
// links; their texts are fetched from GitHub at the versions in sshterm's
// go.mod for the release `scripts/fetch-wasm.mjs` pins.
//
// Rerun after changing dependencies or moving the sshterm pin:
//   bun run notices

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const OUT = path.join(ROOT, "THIRD_PARTY_NOTICES.md");

/** devDependencies that end up in the browser bundle, not just the toolchain. */
const BUNDLED = [
  "react",
  "react-dom",
  "swr",
  "@xterm/xterm",
  "@xterm/addon-fit",
  "@xterm/addon-unicode11",
  "@xterm/addon-web-links",
];

/**
 * What ssh.wasm links, from sshterm v0.8.3's go/go.mod, keeping the modules
 * whose package paths appear in the compiled binary. Move these with the pin.
 */
const GO_MODULES: { name: string; repo: string; ref: string }[] = [
  {
    name: "Go (standard library, wasm_exec.js)",
    repo: "golang/go",
    ref: "go1.26.0",
  },
  { name: "sshterm", repo: "c2FmZQ/sshterm", ref: "v0.8.3" },
  { name: "golang.org/x/crypto", repo: "golang/crypto", ref: "v0.49.0" },
  {
    name: "github.com/fxamacker/cbor/v2",
    repo: "fxamacker/cbor",
    ref: "v2.9.1",
  },
  { name: "github.com/x448/float16", repo: "x448/float16", ref: "v0.8.4" },
  { name: "github.com/urfave/cli/v2", repo: "urfave/cli", ref: "v2.27.7" },
  {
    name: "github.com/russross/blackfriday/v2",
    repo: "russross/blackfriday",
    ref: "v2.1.0",
  },
  {
    name: "github.com/cpuguy83/go-md2man/v2",
    repo: "cpuguy83/go-md2man",
    ref: "v2.0.7",
  },
  {
    name: "github.com/xrash/smetrics",
    repo: "xrash/smetrics",
    ref: "55b8f293f342",
  },
  { name: "github.com/pkg/sftp", repo: "pkg/sftp", ref: "v1.13.10" },
  { name: "github.com/kr/fs", repo: "kr/fs", ref: "v0.1.0" },
];

const LICENSE_FILE = /^(licen[sc]e|copying|notice)(\.(md|txt))?$/i;
const LICENSE_NAMES = ["LICENSE", "LICENSE.md", "LICENSE.txt", "COPYING"];

type Entry = { name: string; version: string; license: string; text: string };

function readPackage(name: string): Record<string, unknown> | null {
  const file = path.join(ROOT, "node_modules", name, "package.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
}

function repoOf(pkg: Record<string, unknown>): string | null {
  const repo = pkg.repository;
  const url = typeof repo === "string" ? repo : (repo as { url?: string })?.url;
  const match = url && /github\.com[/:]([^/]+\/[^/.#]+)/.exec(url);
  return match ? match[1] : null;
}

async function fetchLicense(repo: string, ref: string): Promise<string | null> {
  for (const name of LICENSE_NAMES) {
    const res = await fetch(
      `https://raw.githubusercontent.com/${repo}/${ref}/${name}`,
    );
    if (res.ok) return (await res.text()).trim();
  }
  return null;
}

/** A README's "License" section, through to the end of the file. */
function readmeLicense(dir: string): string | null {
  const file = path.join(dir, "README.md");
  if (!existsSync(file)) return null;
  const match = /^(?:#+ *License\s*$|License\n-+$)([\s\S]+)/im.exec(
    readFileSync(file, "utf8"),
  );
  return match ? match[1].trim() : null;
}

async function npmEntries(): Promise<Entry[]> {
  const root = JSON.parse(
    readFileSync(path.join(ROOT, "package.json"), "utf8"),
  );
  const roots = [
    ...Object.keys((root.dependencies as Record<string, string>) ?? {}),
    ...BUNDLED,
  ];
  const seen = new Map<string, Entry>();
  const queue = [...roots];
  while (queue.length > 0) {
    const name = queue.shift() as string;
    if (seen.has(name)) continue;
    const pkg = readPackage(name);
    if (!pkg) throw new Error(`${name} is not installed; run bun install`);
    const dir = path.join(ROOT, "node_modules", name);
    const file = readdirSync(dir).find((f) => LICENSE_FILE.test(f));
    // A few packages publish without their license file. Older ones keep the
    // text as the README's last section; otherwise the repository has it, at
    // HEAD rather than the version, which is the best a tarball that omitted
    // it allows.
    const repo = repoOf(pkg);
    const text = file
      ? readFileSync(path.join(dir, file), "utf8").trim()
      : (readmeLicense(dir) ??
        (repo ? await fetchLicense(repo, "HEAD") : null));
    if (!text) throw new Error(`no license text found for ${name}`);
    seen.set(name, {
      name,
      version: String(pkg.version),
      license: String(pkg.license ?? "see text"),
      text,
    });
    queue.push(...Object.keys((pkg.dependencies as object) ?? {}));
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function goEntries(): Promise<Entry[]> {
  return Promise.all(
    GO_MODULES.map(async ({ name, repo, ref }) => {
      const text = await fetchLicense(repo, ref);
      if (!text) throw new Error(`no license text found for ${repo}@${ref}`);
      return { name, version: ref, license: "see text", text };
    }),
  );
}

const section = (entries: Entry[]) =>
  entries
    .map(
      (e) =>
        `### ${e.name} ${e.version}\n\nLicense: ${e.license}\n\n\`\`\`\n${e.text}\n\`\`\`\n`,
    )
    .join("\n");

const [npm, go] = await Promise.all([npmEntries(), goEntries()]);

writeFileSync(
  OUT,
  `# Third-party notices

vibe-os is MIT licensed (see LICENSE). The binary and the web app also carry
the software below, under its own terms. This file is generated by
\`bun run notices\`.

Where a package offers a choice of licenses, vibe-os uses it under the first
one that is not copyleft: node-forge under BSD-3-Clause.

## ssh.wasm and wasm_exec.js

From [c2FmZQ/sshterm](https://github.com/c2FmZQ/sshterm), compiled Go.

${section(go)}
## npm packages

${section(npm)}`,
);

console.log(
  `vibe-os: wrote ${path.relative(ROOT, OUT)} (${go.length} Go, ${npm.length} npm)`,
);
