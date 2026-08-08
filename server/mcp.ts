// Which MCP servers this box has, and how to hand one of them to a profile.
//
// Claude has no "use only these servers" flag that takes names. What it has is
// `--mcp-config`, which takes definitions, and `--strict-mcp-config`, which
// says to ignore everything else. So picking servers per profile means writing
// definitions somewhere and pointing at them.
//
// Copying a definition into the profile's arguments would work and is wrong for
// two reasons: it puts whatever the server needs to authenticate — an API key
// in `env`, a bearer token in `headers` — into a command line that shows up in
// `ps`, and it freezes a copy that stops matching the box the moment the URL
// changes. So the profile stores a *path* and the file behind it is regenerated
// from the box's own config, the same way the model list is read off the
// installed binary rather than hardcoded. Change a server with `claude mcp add`
// and every profile using it follows.

import { createHash } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
/**
 * Where Claude keeps a server definition, which decides how long it lives.
 *
 * - `user` is `mcpServers` in `~/.claude.json` — the whole machine, permanent.
 * - `project` is a `.mcp.json` checked into the repo — shared with whoever
 *   clones it.
 * - `local` is `projects."<dir>".mcpServers` in `~/.claude.json`, which is what
 *   a bare `claude mcp add` writes. It is keyed by the directory it was run in,
 *   so one added inside a workspace is gone with the worktree. Surfaced anyway,
 *   labelled with that directory, because otherwise the answer to "I added it,
 *   where is it?" is nowhere.
 */
import type { McpScope, McpServer } from "../shared/wire.ts";
import { log } from "./log.ts";

export type { McpScope, McpServer };

/** Directories to look in. Kept separate because they mean different things. */
export interface McpScan {
  /** Project roots, whose `.mcp.json` is the project scope. */
  roots: string[];
  /** Directories that may hold local-scope servers: roots and their worktrees. */
  dirs: string[];
}

interface Definition {
  type?: string;
  transport?: string;
  url?: string;
  command?: string;
  args?: string[];
}

/**
 * `~/.claude.json` for the account the sessions run as.
 *
 * `$HOME` first, `os.homedir()` after: the environment is what a service unit
 * sets and what an operator can override, while the passwd entry is the right
 * answer when nothing set it at all. This assumes the server and the SSH
 * sessions are the same user, which is what the deployment instructions set up
 * and what `harness.ts` already assumes when it looks for the binary.
 */
const claudeConfigPath = (): string =>
  path.join(process.env.HOME || os.homedir(), ".claude.json");

/** Where the generated single-server files live. Under the state dir, 0700. */
export const mirrorDir = (stateDir: string): string =>
  path.join(stateDir, "mcp");

/**
 * A stable filename for one server.
 *
 * Stable is the whole requirement: a profile stores this path, so it cannot
 * change because some unrelated server appeared or went away. A plain
 * `linear.json` is worth having for the common case — it is what the Advanced
 * preview shows — so a user-scope server with a filename-safe name gets it, and
 * everything else is disambiguated by a hash of what identifies it.
 */
function mirrorName(scope: McpScope, source: string, name: string): string {
  if (scope === "user" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/.test(name))
    return `${name}.json`;
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 32) || "server";
  const hash = createHash("sha256")
    .update(`${scope}\0${source}\0${name}`)
    .digest("hex")
    .slice(0, 8);
  return `${slug}-${hash}.json`;
}

/** `http`/`sse` when there is a URL, `stdio` otherwise. Claude's own default. */
function transportOf(def: Definition): string {
  return def.type ?? def.transport ?? (def.url ? "http" : "stdio");
}

function detailOf(def: Definition): string {
  if (def.url) return def.url;
  return [def.command ?? "", ...(def.args ?? [])].join(" ").trim();
}

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  } catch {
    // Absent is the common case and not worth a line; malformed is the box's
    // problem to fix and would be reported by Claude itself.
    return null;
  }
}

const asServers = (value: unknown): Record<string, Definition> =>
  value && typeof value === "object"
    ? (value as Record<string, Definition>)
    : {};

/**
 * `~/.claude.json`, parsed at most once per change.
 *
 * It is a hundred-odd kilobytes on a machine that has been used, and this is
 * read on every window attach as well as by the editor, so it is cached against
 * the file's size and mtime rather than re-parsed each time.
 */
let cache: { key: string; data: Record<string, unknown> | null } | null = null;

async function claudeConfig(): Promise<Record<string, unknown> | null> {
  const file = claudeConfigPath();
  let key = "missing";
  try {
    const info = await stat(file);
    key = `${info.size}:${info.mtimeMs}`;
  } catch {
    // fall through with the sentinel; a missing file still caches as "nothing"
  }
  if (cache?.key === key) return cache.data;
  const data = key === "missing" ? null : await readJson(file);
  cache = { key, data };
  return data;
}

/**
 * Every MCP server visible to the given directories.
 *
 * Project scope reads only the roots: a worktree is a copy of the repo, so
 * scanning worktrees too would list the same `.mcp.json` once per workspace.
 */
/**
 * A discovered server together with the definition it was parsed from.
 *
 * The definition carries API keys and bearer tokens, so it deliberately does
 * not travel on `McpServer`, which is a wire type the browser receives.
 */
export interface DiscoveredMcp {
  server: McpServer;
  def: Definition;
}

/** Discovery that keeps the parsed definitions, for the mirror writer. */
export async function discoverMcpWithDefs(
  stateDir: string,
  scan: McpScan,
): Promise<DiscoveredMcp[]> {
  const found: DiscoveredMcp[] = [];
  const add = (
    scope: McpScope,
    source: string,
    name: string,
    def: Definition,
  ) => {
    found.push({
      def,
      server: {
        name,
        scope,
        source,
        transport: transportOf(def),
        detail: detailOf(def),
        configPath: path.join(
          mirrorDir(stateDir),
          mirrorName(scope, source, name),
        ),
      },
    });
  };

  const config = await claudeConfig();
  if (config) {
    for (const [name, def] of Object.entries(asServers(config.mcpServers))) {
      add("user", claudeConfigPath(), name, def);
    }
    const projects = asServers(config.projects) as unknown as Record<
      string,
      { mcpServers?: unknown }
    >;
    for (const dir of new Set(scan.dirs)) {
      for (const [name, def] of Object.entries(
        asServers(projects[dir]?.mcpServers),
      )) {
        add("local", dir, name, def);
      }
    }
  }

  for (const root of new Set(scan.roots)) {
    const file = path.join(root, ".mcp.json");
    const data = await readJson(file);
    if (!data) continue;
    for (const [name, def] of Object.entries(asServers(data.mcpServers)))
      add("project", file, name, def);
  }

  return found;
}

/** Just the wire shape, for the API and the profile editor. */
export async function discoverMcp(
  stateDir: string,
  scan: McpScan,
): Promise<McpServer[]> {
  return (await discoverMcpWithDefs(stateDir, scan)).map((d) => d.server);
}

const NOTE = `Generated by vibe-os. One file per MCP server on this box, each holding just
that server, so a profile can ask for exactly the ones it wants with
--mcp-config. Rewritten from ~/.claude.json and each project's .mcp.json
whenever the list is read or a window starts, so edit those, not these.
`;

/**
 * Writes one file per server and removes the ones that no longer have a server.
 *
 * Pruning is deliberate: a profile pointing at a server that has been deleted
 * should fail visibly at launch, not keep working from a copy nobody can see.
 * Files are only rewritten when the contents actually differ, so this stays
 * cheap enough to run on every window attach.
 */
/**
 * Writes one file per MCP server, so a profile can point `--mcp-config` at
 * exactly the ones it wants.
 *
 * Takes the definitions discovery already parsed rather than looking each one
 * up again: the previous version re-read and re-parsed the source file once per
 * server, so a project with five servers in one `.mcp.json` read that file five
 * times — on every certificate request.
 */
export async function syncMcpMirrors(
  stateDir: string,
  discovered: DiscoveredMcp[],
): Promise<void> {
  const dir = mirrorDir(stateDir);

  await mkdir(dir, { recursive: true, mode: 0o700 });

  const wanted = new Set<string>();
  for (const { server, def } of discovered) {
    if (!def) continue;
    wanted.add(path.basename(server.configPath));
    const body = `${JSON.stringify({ mcpServers: { [server.name]: def } }, null, 2)}\n`;
    // Definitions carry API keys and bearer tokens, so 0600 and never anywhere
    // the web root can reach.
    if (
      (await readFile(server.configPath, "utf8").catch(() => null)) !== body
    ) {
      await writeFile(server.configPath, body, { mode: 0o600 });
      log.debug(`wrote mcp config for ${server.name} (${server.scope})`);
    }
  }

  // Compared first, like the json files beside it: this runs on every
  // certificate request, and rewriting an unchanged file each time is a write
  // for nothing.
  const readmePath = path.join(dir, "README");
  if ((await readFile(readmePath, "utf8").catch(() => null)) !== NOTE)
    await writeFile(readmePath, NOTE, { mode: 0o600 }).catch(() => {});

  for (const entry of await readdir(dir).catch(() => [] as string[])) {
    if (!entry.endsWith(".json") || wanted.has(entry)) continue;
    await unlink(path.join(dir, entry)).catch(() => {});
    log.debug(`removed stale mcp config ${entry}`);
  }
}
