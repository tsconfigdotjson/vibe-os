// What the Claude CLI on this machine can be told to do.
//
// The profile editor offers models and permission modes as dropdowns, which
// means something has to know what the valid values are. Hardcoding them would
// be wrong within a release or two — Claude ships new models faster than this
// project ships anything — so they are read off the binary that is actually
// installed. Update Claude Code and the dropdowns follow.

import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { log } from './log.ts';

const run = promisify(execFile);

export interface HarnessInfo {
  available: boolean;
  version: string | null;
  /**
   * Aliases like `opus`, which always resolve to the newest model of that tier.
   *
   * These are the right default for a profile precisely because they do not
   * pin: a role called "Backend Manager" wants the best Opus, not the one that
   * was current the day it was written.
   */
  aliases: string[];
  /** Full model ids, for pinning a profile to one exact model. */
  models: string[];
  /** Values `--permission-mode` accepts. */
  permissionModes: string[];
}

const EMPTY: HarnessInfo = {
  available: false,
  version: null,
  aliases: [],
  models: [],
  permissionModes: [],
};

/**
 * Aliases the CLI documents but which do not appear as model ids.
 *
 * Kept as a floor rather than the source of truth: whatever is found in the
 * binary is merged over the top, so a new tier appears on its own.
 */
const KNOWN_ALIASES = ['default', 'opus', 'sonnet', 'haiku', 'fable', 'opusplan'];

/**
 * Where the native installers put things, when PATH does not say so.
 *
 * A login shell picks `~/.local/bin` up from `.profile`; a systemd service does
 * not, and vibe-os is meant to run as one. Without this the server cannot find
 * a Claude that the harness will happily launch a moment later, because the
 * harness runs under a login shell and the server does not — so the dropdowns
 * come up empty on exactly the deployment the docs recommend.
 */
const EXTRA_PATHS = [
  `${process.env.HOME ?? ''}/.local/bin/claude`,
  '/usr/local/bin/claude',
  '/opt/claude/.local/bin/claude',
];

/** Resolves `claude` through any symlinks to the real executable. */
async function resolveBinary(): Promise<string | null> {
  const candidates: string[] = [];
  try {
    const { stdout } = await run('/bin/sh', ['-c', 'command -v claude'], { timeout: 5_000 });
    if (stdout.trim()) candidates.push(stdout.trim());
  } catch {
    // not on PATH — the explicit locations below may still have it
  }
  candidates.push(...EXTRA_PATHS.filter(Boolean));

  for (const candidate of candidates) {
    try {
      await stat(candidate);
      const { stdout: real } = await run('/bin/sh', ['-c', `readlink -f ${JSON.stringify(candidate)}`], {
        timeout: 5_000,
      });
      return real.trim() || candidate;
    } catch {
      // next
    }
  }
  return null;
}

/**
 * Model ids embedded in the executable.
 *
 * grep rather than reading the file in-process: the binary is ~270MB and the
 * answer is a few hundred bytes, so streaming it through a matcher costs
 * nothing while `readFile` would cost the whole thing in memory. Measured at
 * about 0.13s, which is why this is done once at startup rather than cached to
 * disk or fetched over the network.
 */
async function embeddedModels(binary: string): Promise<string[]> {
  try {
    const { stdout } = await run(
      'grep',
      ['-aoE', 'claude-(opus|sonnet|haiku|fable)-[0-9]+(-[0-9]+)?', binary],
      { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
    );
    const seen = new Set(stdout.split('\n').map((l) => l.trim()).filter(Boolean));
    // Newest first: people reach for the latest far more often than a pin to
    // something old, and a sorted-ascending list buries it.
    return [...seen].sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
  } catch {
    return [];
  }
}

/** The choices `--permission-mode` lists in its own help output. */
async function permissionModes(binary: string): Promise<string[]> {
  try {
    const { stdout } = await run(binary, ['--help'], { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });
    // Help text wraps, so the list is matched across newlines and whitespace.
    const section = /--permission-mode[\s\S]{0,400}?\(choices:([\s\S]{0,300}?)\)/.exec(stdout);
    if (!section) return [];
    return [...section[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  } catch {
    return [];
  }
}

let cached: Promise<HarnessInfo> | null = null;

/**
 * Everything the editor needs to offer, discovered once.
 *
 * Cached for the life of the process: it describes an installed binary, which
 * does not change under a running server, and a restart is already what
 * happens when someone upgrades it.
 */
export function discoverClaude(): Promise<HarnessInfo> {
  cached ??= (async (): Promise<HarnessInfo> => {
    const binary = await resolveBinary();
    if (!binary) {
      log.debug('claude is not on PATH — the profile editor will offer aliases only');
      return { ...EMPTY, aliases: KNOWN_ALIASES };
    }

    // Concurrently, because each `claude` invocation costs a couple of seconds
    // of its own startup and there is no reason to pay for them in series.
    const [version, models, modes] = await Promise.all([
      run(binary, ['--version'], { timeout: 15_000 })
        .then(({ stdout }) => stdout.trim().split(/\s+/)[0] ?? null)
        .catch(() => null),
      embeddedModels(binary),
      permissionModes(binary),
    ]);

    // A tier that shows up in the binary but not in the list above still gets
    // an alias, because that is how Claude names them.
    const tiers = new Set(models.map((m) => m.split('-')[1]).filter(Boolean));
    const aliases = [...new Set([...KNOWN_ALIASES, ...tiers])];

    log.debug(`claude ${version ?? '?'}: ${models.length} models, ${modes.length} permission modes`);
    return { available: true, version, aliases, models, permissionModes: modes };
  })();
  return cached;
}
