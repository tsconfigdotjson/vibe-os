// Projects (git repos on this machine) and workspaces (git worktrees of them).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, stat, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { eq, desc } from 'drizzle-orm';
import { type Db, projects, workspaces, windows, newId } from './db.ts';
import { deleteProjectProfiles } from './profiles.ts';
import type { Config } from './config.ts';
import { log } from './log.ts';

const run = promisify(execFile);

/** Where worktrees are created, kept out of the repos themselves. */
const WORKTREE_DIR = '.vibe-worktrees';

const NAME_PATTERN = /^[a-z][a-z0-9-]{1,60}$/;

// Three short wordlists. ~64^3 combinations is plenty to avoid collisions in a
// list a person actually reads, and every word is unambiguous when spoken.
const ADJECTIVES = [
  'quiet', 'brave', 'clever', 'bright', 'calm', 'eager', 'gentle', 'happy',
  'keen', 'lucky', 'merry', 'nimble', 'polite', 'proud', 'rapid', 'sharp',
  'shy', 'silly', 'smooth', 'solid', 'spry', 'steady', 'sunny', 'swift',
  'tidy', 'warm', 'wise', 'witty', 'zesty', 'bold', 'crisp', 'daring',
];
const COLOURS = [
  'amber', 'azure', 'cobalt', 'coral', 'cyan', 'emerald', 'garnet', 'indigo',
  'ivory', 'jade', 'lilac', 'maroon', 'mint', 'olive', 'onyx', 'opal',
  'pearl', 'plum', 'ruby', 'saffron', 'sage', 'scarlet', 'sienna', 'slate',
  'teal', 'topaz', 'umber', 'violet', 'wheat', 'bronze', 'copper', 'silver',
];
const ANIMALS = [
  'otter', 'falcon', 'lynx', 'heron', 'badger', 'marten', 'ibex', 'raven',
  'panda', 'tapir', 'gecko', 'osprey', 'puffin', 'stoat', 'vole', 'wombat',
  'yak', 'zebra', 'bison', 'crane', 'dingo', 'egret', 'ferret', 'gibbon',
  'hare', 'jackal', 'koala', 'lemur', 'mongoose', 'newt', 'quail', 'shrew',
];

const pick = <T>(list: T[]): T => list[Math.floor(Math.random() * list.length)];

export function threeWordName(): string {
  return `${pick(ADJECTIVES)}-${pick(COLOURS)}-${pick(ANIMALS)}`;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', cwd, ...args], { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim();
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function currentBranch(repo: string): Promise<string | null> {
  try {
    return await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
  } catch {
    return null;
  }
}

/** Directories that never contain a project you meant to open. */
const SKIP = new Set([
  'node_modules', '.git', '.cache', '.npm', '.bun', '.cargo', '.rustup', '.venv',
  'venv', '__pycache__', 'vendor', 'target', 'dist', 'build', '.next', '.nuxt',
  'Library', 'Applications', 'System', 'snap', 'proc', 'sys', 'dev', 'run',
  WORKTREE_DIR,
]);

const MAX_DEPTH = 4;
/** Hard ceiling on directories visited per scan, so a scan cannot run away. */
const MAX_VISITS = 20_000;
/** Collapses refresh clicks that land on top of each other. */
const SCAN_TTL_MS = 2_000;

let lastScan = 0;

async function remoteUrl(repo: string): Promise<string | null> {
  try {
    return await git(repo, ['config', '--get', 'remote.origin.url']);
  } catch {
    return null;
  }
}

/**
 * Walks a root looking for git repositories.
 *
 * Bounded in three ways — depth, a skip list, and a global visit budget —
 * because this runs on a poll and the alternative is a full filesystem crawl of
 * someone's home directory every minute. Descent stops at a repository: the
 * directories inside one are not separate projects.
 */
async function walkForRepos(root: string, found: Map<string, true>, budget: { visits: number }): Promise<void> {
  const queue: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];

  while (queue.length > 0) {
    const { dir, depth } = queue.shift()!;
    if (budget.visits >= MAX_VISITS) return;
    budget.visits += 1;

    if (await isDirectory(path.join(dir, '.git'))) {
      found.set(dir, true);
      continue; // a repo's subdirectories are not separate projects
    }
    if (depth >= MAX_DEPTH) continue;

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable (permissions, races) — not worth reporting
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (SKIP.has(entry.name)) continue;
      // Hidden directories are config, not code — except the roots themselves.
      if (entry.name.startsWith('.')) continue;
      queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
    }
  }
}

/**
 * Finds every git repository on the host, not just the ones under the workspace
 * root, so a repo cloned anywhere shows up in the project picker.
 */
export async function scanProjects(db: Db, config: Config, opts: { force?: boolean } = {}): Promise<void> {
  if (!opts.force && Date.now() - lastScan < SCAN_TTL_MS) return;
  lastScan = Date.now();

  await mkdir(config.workspace, { recursive: true }).catch(() => {});

  // Deduplicated because these overlap: the workspace root is usually inside
  // home, and /root is home when running as root.
  const roots = [...new Set([config.workspace, os.homedir(), '/srv', '/opt', '/var/www'])];
  const found = new Map<string, true>();
  const budget = { visits: 0 };

  for (const root of roots) {
    if (!(await isDirectory(root))) continue;
    await walkForRepos(root, found, budget);
  }
  if (budget.visits >= MAX_VISITS) {
    log.warn(`project scan hit its ${MAX_VISITS} directory budget — some repos may be missing`);
  }

  for (const repo of found.keys()) {
    // Our own worktrees are checkouts of a project, not projects themselves.
    if (repo.includes(`${path.sep}${WORKTREE_DIR}${path.sep}`)) continue;

    const name = path.basename(repo);
    const branch = await currentBranch(repo);
    const existing = db.select().from(projects).where(eq(projects.path, repo)).get();
    if (existing) {
      db.update(projects).set({ branch, name }).where(eq(projects.id, existing.id)).run();
    } else {
      const remote = await remoteUrl(repo);
      db.insert(projects)
        .values({ id: newId(), name, path: repo, branch, remote, createdAt: Date.now() })
        .run();
      log.info(`found project ${name} at ${repo}${remote ? ` (${remote})` : ''}`);
    }
  }

  // Forget projects whose directory is gone, and everything hanging off them.
  for (const project of db.select().from(projects).all()) {
    if (!(await isDirectory(project.path))) {
      for (const ws of db.select().from(workspaces).where(eq(workspaces.projectId, project.id)).all()) {
        db.delete(windows).where(eq(windows.workspaceId, ws.id)).run();
      }
      db.delete(workspaces).where(eq(workspaces.projectId, project.id)).run();
      deleteProjectProfiles(db, project.id);
      db.delete(projects).where(eq(projects.id, project.id)).run();
      log.info(`project ${project.name} disappeared — removed`);
    }
  }
}

export function listProjects(db: Db) {
  return db.select().from(projects).orderBy(projects.name).all();
}

export function listWorkspaces(db: Db, projectId: string) {
  return db
    .select()
    .from(workspaces)
    .where(eq(workspaces.projectId, projectId))
    .orderBy(desc(workspaces.lastOpenedAt))
    .all();
}

export function getWorkspace(db: Db, id: string) {
  return db.select().from(workspaces).where(eq(workspaces.id, id)).get();
}

/**
 * Makes the first `git push` out of a new worktree work on its own.
 *
 * A branch created with `worktree add -b` has no upstream, so pushing it stops
 * with "the current branch has no upstream branch" and a command to copy. That
 * is a papercut on every single workspace, which is most of them.
 *
 * The tempting fix — writing `branch.<name>.remote` and `branch.<name>.merge`
 * at creation — does make push work, but it points the branch at a ref that
 * does not exist yet, so until the first push `git status` reads
 * `## name...origin/name [gone]`. "Gone" is what git says about an upstream
 * that was deleted, and it is alarming for something that was simply never
 * created. `push.autoSetupRemote` gets the same outcome by letting push set the
 * upstream when it actually creates the branch, and status stays clean.
 *
 * Worktrees share their repository's config, so this is set once on the project
 * and applies to every workspace cut from it. Two things keep that polite: it
 * is skipped when there is no remote to track, and an explicit existing value
 * is left alone rather than overwritten.
 */
async function enableAutoSetupRemote(repo: string, projectName: string): Promise<void> {
  try {
    const remotes = (await git(repo, ['remote'])).split('\n').map((r) => r.trim());
    if (!remotes.includes('origin')) return;

    // `config --get` exits non-zero when unset, which is the "not configured"
    // signal — a set value, including a deliberate false, means hands off.
    const existing = await git(repo, ['config', '--local', '--get', 'push.autoSetupRemote']).catch(() => '');
    if (existing !== '') return;

    await git(repo, ['config', '--local', 'push.autoSetupRemote', 'true']);
    log.info(`set push.autoSetupRemote in ${projectName} so a new workspace can push without --set-upstream`);
  } catch (err) {
    // Never fatal: a workspace that exists but needs `git push -u` once is a
    // far better outcome than a workspace that failed to be created.
    log.debug(`could not set push.autoSetupRemote in ${repo}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Creates a git worktree and records it as a workspace.
 *
 * The worktree gets its own branch named after the workspace, branched from
 * wherever the project's main checkout currently is.
 */
export async function createWorkspace(
  db: Db,
  workspaceRoot: string,
  projectId: string,
  requested?: string,
): Promise<{ id: string; name: string; branch: string; path: string }> {
  const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project) throw new Error('unknown project');

  const taken = new Set(listWorkspaces(db, projectId).map((w) => w.name));
  let name = requested?.trim().toLowerCase() ?? '';
  if (name) {
    if (!NAME_PATTERN.test(name)) throw new Error('name must be lowercase letters, digits and dashes');
    if (taken.has(name)) throw new Error(`workspace ${name} already exists`);
  } else {
    do {
      name = threeWordName();
    } while (taken.has(name));
  }

  const target = path.join(workspaceRoot, WORKTREE_DIR, project.name, name);
  await mkdir(path.dirname(target), { recursive: true });

  // -b creates the branch; git refuses if it already exists, which is the
  // behaviour we want rather than silently reusing someone else's work.
  await git(project.path, ['worktree', 'add', '-b', name, target]);
  await enableAutoSetupRemote(project.path, project.name);

  const now = Date.now();
  const id = newId();
  db.insert(workspaces)
    .values({ id, projectId, name, branch: name, path: target, createdAt: now, lastOpenedAt: now })
    .run();

  log.info(`created workspace ${project.name}/${name}`);
  return { id, name, branch: name, path: target };
}

export async function removeWorkspace(db: Db, id: string): Promise<void> {
  const ws = getWorkspace(db, id);
  if (!ws) throw new Error('unknown workspace');
  const project = db.select().from(projects).where(eq(projects.id, ws.projectId)).get();

  if (project) {
    // --force because a worktree with uncommitted changes should still be
    // removable from the UI; the branch is deliberately left behind so the work
    // is recoverable with `git checkout`.
    await git(project.path, ['worktree', 'remove', '--force', ws.path]).catch((err: Error) => {
      log.warn(`git worktree remove failed for ${ws.path}: ${err.message}`);
    });
  }
  await rm(ws.path, { recursive: true, force: true }).catch(() => {});

  db.delete(windows).where(eq(windows.workspaceId, id)).run();
  db.delete(workspaces).where(eq(workspaces.id, id)).run();
  log.info(`removed workspace ${ws.name} (branch ${ws.branch} kept)`);
}

export function touchWorkspace(db: Db, id: string): void {
  db.update(workspaces).set({ lastOpenedAt: Date.now() }).where(eq(workspaces.id, id)).run();
}

/** Drops workspaces whose worktree directory has been deleted behind our back. */
export async function reconcileWorkspaces(db: Db): Promise<void> {
  for (const ws of db.select().from(workspaces).all()) {
    if (!(await isDirectory(ws.path))) {
      db.delete(windows).where(eq(windows.workspaceId, ws.id)).run();
      db.delete(workspaces).where(eq(workspaces.id, ws.id)).run();
      log.info(`workspace ${ws.name} no longer on disk — removed`);
    }
  }
}
