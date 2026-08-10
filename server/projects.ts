// Projects (git repos on this machine) and workspaces (git worktrees of them).

import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { desc, eq } from "drizzle-orm";
import { killWorkspaceSessions } from "./attach.ts";
import type { Config } from "./config.ts";
import { type Db, newId, projects, windows, workspaces } from "./db.ts";
import { isDirectory } from "./fsx.ts";
import { describeError, log } from "./log.ts";
import { deleteProjectProfiles } from "./profiles.ts";

const run = promisify(execFile);

/** Where worktrees are created, kept out of the repos themselves. */
const WORKTREE_DIR = ".vibe-worktrees";

const NAME_PATTERN = /^[a-z][a-z0-9-]{1,60}$/;

// Three short wordlists. ~64^3 combinations is plenty to avoid collisions in a
// list a person actually reads, and every word is unambiguous when spoken.
const ADJECTIVES = [
  "quiet",
  "brave",
  "clever",
  "bright",
  "calm",
  "eager",
  "gentle",
  "happy",
  "keen",
  "lucky",
  "merry",
  "nimble",
  "polite",
  "proud",
  "rapid",
  "sharp",
  "shy",
  "silly",
  "smooth",
  "solid",
  "spry",
  "steady",
  "sunny",
  "swift",
  "tidy",
  "warm",
  "wise",
  "witty",
  "zesty",
  "bold",
  "crisp",
  "daring",
];
const COLOURS = [
  "amber",
  "azure",
  "cobalt",
  "coral",
  "cyan",
  "emerald",
  "garnet",
  "indigo",
  "ivory",
  "jade",
  "lilac",
  "maroon",
  "mint",
  "olive",
  "onyx",
  "opal",
  "pearl",
  "plum",
  "ruby",
  "saffron",
  "sage",
  "scarlet",
  "sienna",
  "slate",
  "teal",
  "topaz",
  "umber",
  "violet",
  "wheat",
  "bronze",
  "copper",
  "silver",
];
const ANIMALS = [
  "otter",
  "falcon",
  "lynx",
  "heron",
  "badger",
  "marten",
  "ibex",
  "raven",
  "panda",
  "tapir",
  "gecko",
  "osprey",
  "puffin",
  "stoat",
  "vole",
  "wombat",
  "yak",
  "zebra",
  "bison",
  "crane",
  "dingo",
  "egret",
  "ferret",
  "gibbon",
  "hare",
  "jackal",
  "koala",
  "lemur",
  "mongoose",
  "newt",
  "quail",
  "shrew",
];

const pick = <T>(list: T[]): T => list[Math.floor(Math.random() * list.length)];

export function threeWordName(): string {
  return `${pick(ADJECTIVES)}-${pick(COLOURS)}-${pick(ANIMALS)}`;
}

/**
 * Ceilings on the two things that touch the network, in milliseconds.
 *
 * They are what the server's request timeout is sized around, so raising one
 * without the other is how a workspace comes into being on a request the
 * browser was already told had failed. See REQUEST_IDLE_TIMEOUT_S in index.ts.
 */
const FETCH_TIMEOUT_MS = 120_000;
const ASK_TIMEOUT_MS = 30_000;

async function git(
  cwd: string,
  args: string[],
  timeout = 60_000,
): Promise<string> {
  const { stdout } = await run("git", ["-C", cwd, ...args], {
    timeout,
    maxBuffer: 8 * 1024 * 1024,
    env: {
      ...process.env,
      // Nothing on this side can answer a credential prompt, so a remote that
      // asks for one has to fail rather than sit there holding the request
      // open. Only the prompt is disabled, not ssh: `GIT_SSH_COMMAND` would
      // take precedence over a repo's own `core.sshCommand`, and a project
      // cloned with a per-repo deploy key would stop being able to fetch at
      // all. A key that wants a passphrase is bounded by the timeout instead.
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  return stdout.trim();
}

/**
 * The one line of a failed git command worth showing a person.
 *
 * The rest is scaffolding: "Command failed: git -C /home/lee/src/api fetch
 * origin" names what we ran, which the reader already knows, while the line
 * git put on stderr is the part they can act on. An expired token says to go
 * and re-authenticate, and that is a different afternoon from being offline.
 */
function gitReason(err: unknown): string {
  const failure = err as { stderr?: unknown; killed?: boolean };
  const stderr = typeof failure?.stderr === "string" ? failure.stderr : "";
  const lines = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const best =
    lines.find(
      (line) => line.startsWith("fatal:") || line.startsWith("error:"),
    ) ?? lines[0];
  if (!best) {
    // A timeout is a kill, and it leaves nothing on stderr to quote.
    return failure?.killed ? "timed out" : describeError(err).split("\n")[0];
  }
  const reason = best.replace(/^(fatal|error):\s*/, "");
  // Capped because git will happily quote a whole remote URL, and this ends up
  // in a sidebar. The ellipsis is there so a cut does not read as a typo.
  return reason.length > 160 ? `${reason.slice(0, 159)}…` : reason;
}

async function hasOrigin(repo: string): Promise<boolean> {
  const remotes = await git(repo, ["remote"]).catch(() => "");
  return remotes.split("\n").some((r) => r.trim() === "origin");
}

async function currentBranch(repo: string): Promise<string | null> {
  try {
    return await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
  } catch {
    return null;
  }
}

/** Directories that never contain a project you meant to open. */
const SKIP = new Set([
  "node_modules",
  ".git",
  ".cache",
  ".npm",
  ".bun",
  ".cargo",
  ".rustup",
  ".venv",
  "venv",
  "__pycache__",
  "vendor",
  "target",
  "dist",
  "build",
  ".next",
  ".nuxt",
  "Library",
  "Applications",
  "System",
  "snap",
  "proc",
  "sys",
  "dev",
  "run",
  WORKTREE_DIR,
]);

const MAX_DEPTH = 4;
/** Hard ceiling on directories visited per scan, so a scan cannot run away. */
const MAX_VISITS = 20_000;
/**
 * The scan in flight, if there is one.
 *
 * This used to be a 2-second debounce whose every caller passed `force: true`,
 * so it never once ran — while the thing it was written to prevent, two refresh
 * clicks landing together, genuinely does start two full crawls of up to 20,000
 * directories with a serial `git rev-parse` per repo, against the same tables.
 * Sharing the in-flight promise is what the comment was reaching for: the
 * second caller waits for the first's results instead of duplicating them.
 */
let inFlight: Promise<void> | null = null;

async function remoteUrl(repo: string): Promise<string | null> {
  try {
    return await git(repo, ["config", "--get", "remote.origin.url"]);
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
async function walkForRepos(
  root: string,
  found: Set<string>,
  budget: { visits: number },
): Promise<void> {
  const queue: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];

  for (;;) {
    const next = queue.shift();
    if (!next) break;
    const { dir, depth } = next;
    if (budget.visits >= MAX_VISITS) return;
    budget.visits += 1;

    if (await isDirectory(path.join(dir, ".git"))) {
      found.add(dir);
      continue; // a repo's subdirectories are not separate projects
    }
    if (depth >= MAX_DEPTH) continue;

    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable (permissions, races) — not worth reporting
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (SKIP.has(entry.name)) continue;
      // Hidden directories are config, not code — except the roots themselves.
      if (entry.name.startsWith(".")) continue;
      queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
    }
  }
}

/**
 * Finds every git repository on the host, not just the ones under the workspace
 * root, so a repo cloned anywhere shows up in the project picker.
 */
export async function scanProjects(db: Db, config: Config): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = runScan(db, config).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function runScan(db: Db, config: Config): Promise<void> {
  await mkdir(config.workspace, { recursive: true }).catch(() => {});

  // Deduplicated because these overlap: the workspace root is usually inside
  // home, and /root is home when running as root.
  const roots = [
    ...new Set([config.workspace, os.homedir(), "/srv", "/opt", "/var/www"]),
  ];
  const found = new Set<string>();
  const budget = { visits: 0 };

  for (const root of roots) {
    if (!(await isDirectory(root))) continue;
    await walkForRepos(root, found, budget);
  }
  if (budget.visits >= MAX_VISITS) {
    log.warn(
      `project scan hit its ${MAX_VISITS} directory budget — some repos may be missing`,
    );
  }

  for (const repo of found) {
    // Our own worktrees are checkouts of a project, not projects themselves.
    if (repo.includes(`${path.sep}${WORKTREE_DIR}${path.sep}`)) continue;

    const name = path.basename(repo);
    const branch = await currentBranch(repo);
    const existing = db
      .select()
      .from(projects)
      .where(eq(projects.path, repo))
      .get();
    if (existing) {
      db.update(projects)
        .set({ branch, name })
        .where(eq(projects.id, existing.id))
        .run();
    } else {
      const remote = await remoteUrl(repo);
      db.insert(projects)
        .values({
          id: newId(),
          name,
          path: repo,
          branch,
          remote,
          createdAt: Date.now(),
        })
        .run();
      log.info(
        `found project ${name} at ${repo}${remote ? ` (${remote})` : ""}`,
      );
    }
  }

  // Forget projects whose directory is gone, and everything hanging off them.
  for (const project of db.select().from(projects).all()) {
    if (!(await isDirectory(project.path))) {
      for (const ws of db
        .select()
        .from(workspaces)
        .where(eq(workspaces.projectId, project.id))
        .all()) {
        await killWorkspaceSessions(db, config, ws.id);
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
async function enableAutoSetupRemote(
  repo: string,
  projectName: string,
): Promise<void> {
  try {
    if (!(await hasOrigin(repo))) return;

    // `config --get` exits non-zero when unset, which is the "not configured"
    // signal — a set value, including a deliberate false, means hands off.
    const existing = await git(repo, [
      "config",
      "--local",
      "--get",
      "push.autoSetupRemote",
    ]).catch(() => "");
    if (existing !== "") return;

    await git(repo, ["config", "--local", "push.autoSetupRemote", "true"]);
    log.info(
      `set push.autoSetupRemote in ${projectName} so a new workspace can push without --set-upstream`,
    );
  } catch (err) {
    // Never fatal: a workspace that exists but needs `git push -u` once is a
    // far better outcome than a workspace that failed to be created.
    log.debug(
      `could not set push.autoSetupRemote in ${repo}: ${describeError(err)}`,
    );
  }
}

/**
 * origin's default branch, as a ref that exists locally — "origin/main".
 *
 * Read from `refs/remotes/origin/HEAD`, which is only as good as the last time
 * something asked the remote — see `askOriginHead`, which is what keeps it
 * current. What it names is verified rather than trusted, because a symbolic
 * ref goes on naming a branch that has been deleted, and the two conventional
 * names are the last resort for a clone that never had one.
 */
async function originHead(repo: string): Promise<string | null> {
  // --verify exits non-zero for a ref that is not there, which is the question.
  const exists = (ref: string) =>
    git(repo, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).then(
      () => true,
      () => false,
    );

  const known = await git(repo, [
    "symbolic-ref",
    "--short",
    "refs/remotes/origin/HEAD",
  ]).catch(() => "");
  if (known && (await exists(known))) return known;

  for (const guess of ["origin/main", "origin/master"]) {
    if (await exists(guess)) return guess;
  }
  return null;
}

/**
 * Asks origin which branch it calls default, and writes down the answer.
 *
 * A round trip on top of the fetch, and worth it: nothing about a fetch tells
 * a clone that the default branch moved. `refs/remotes/origin/HEAD` is written
 * once at clone time and never again, so a repo cloned when the default was
 * `master` goes on reporting `origin/master` for as long as that branch exists
 * — which after a `master` to `main` switch is forever, since the old branch is
 * usually left behind rather than deleted. Verifying the ref cannot catch that:
 * the branch it names is real, it is just not the default any more.
 *
 * Best effort. It fails when origin is unreachable, and then the last known
 * answer is the one used.
 */
async function askOriginHead(repo: string): Promise<void> {
  await git(
    repo,
    ["remote", "set-head", "origin", "--auto"],
    ASK_TIMEOUT_MS,
  ).catch((err: unknown) => {
    log.debug(`could not ask origin for its default branch: ${gitReason(err)}`);
  });
}

/**
 * Where a new workspace's branch starts.
 *
 * Left alone, `worktree add -b` branches from the project checkout's HEAD —
 * whatever that clone was last left sitting on, which after a while is a stale
 * branch, a detached commit, or someone's abandoned merge. A workspace is
 * meant to start from the current state of the project, so origin is fetched
 * first and the branch is cut from origin's default branch.
 *
 * Every step degrades to the old behaviour instead of failing. No origin, an
 * unreachable one, a default branch that cannot be worked out: all of them end
 * at HEAD, because a workspace from a stale base is worth more than an error
 * where a workspace should have been. But every degradation that a person
 * would want to know about comes back as a warning for the sidebar, because
 * "branched from origin/main" and "branched from something I could not check"
 * are different claims and only one of them is safe to work on top of.
 *
 * What it deliberately does not do is prune. Pruning would make this the only
 * thing in the app that rewrites refs in the project's own checkout, and a
 * remote-tracking ref deleted from under a terminal open in that repo is a
 * `git rebase origin/topic` failing somewhere nobody would connect to having
 * clicked "+".
 */
async function baseForWorkspace(
  repo: string,
  projectName: string,
): Promise<{ ref: string; warning: string | null }> {
  if (!(await hasOrigin(repo))) return { ref: "HEAD", warning: null };

  let failure: string | null = null;
  try {
    await git(repo, ["fetch", "origin"], FETCH_TIMEOUT_MS);
    await askOriginHead(repo);
  } catch (err) {
    failure = gitReason(err);
    log.warn(`could not fetch origin for ${projectName}: ${failure}`);
  }

  const ref = (await originHead(repo)) ?? "HEAD";
  const where = ref === "HEAD" ? "the project checkout" : ref;
  if (ref === "HEAD") {
    log.warn(
      `no default branch on origin for ${projectName} — branching from the checkout`,
    );
  }

  if (failure) {
    return {
      ref,
      warning: `Could not fetch origin (${failure}). This branch starts from ${where} as it was at the last fetch.`,
    };
  }
  // Fetched fine and still no default branch: a single-branch clone, or one
  // whose default is named something nobody guesses. Silence here would be the
  // exact stale base this function exists to avoid, with nothing said about it.
  if (ref === "HEAD") {
    return {
      ref,
      warning:
        "Could not work out origin's default branch. This branch starts from the project checkout, which may be behind.",
    };
  }
  return { ref, warning: null };
}

/**
 * Creates a git worktree and records it as a workspace.
 *
 * The worktree gets its own branch named after the workspace, branched from a
 * freshly fetched origin — see `baseForWorkspace`.
 */
export async function createWorkspace(
  db: Db,
  workspaceRoot: string,
  projectId: string,
  requested?: string,
): Promise<{
  id: string;
  name: string;
  branch: string;
  path: string;
  base: string;
  warning: string | null;
}> {
  const project = db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .get();
  if (!project) throw new Error("unknown project");

  const taken = new Set(listWorkspaces(db, projectId).map((w) => w.name));
  let name = requested?.trim().toLowerCase() ?? "";
  if (name) {
    if (!NAME_PATTERN.test(name))
      throw new Error("name must be lowercase letters, digits and dashes");
    if (taken.has(name)) throw new Error(`workspace ${name} already exists`);
  } else {
    do {
      name = threeWordName();
    } while (taken.has(name));
  }

  const target = path.join(workspaceRoot, WORKTREE_DIR, project.name, name);
  await mkdir(path.dirname(target), { recursive: true });

  const base = await baseForWorkspace(project.path, project.name);

  // -b creates the branch; git refuses if it already exists, which is the
  // behaviour we want rather than silently reusing someone else's work.
  //
  // --no-track because branching from a remote-tracking ref otherwise makes
  // origin/main this branch's upstream, and then `git push` stops with "the
  // upstream branch of your current branch does not match the name of your
  // current branch" and a command to copy — the same papercut, on the same
  // first push, that `push.autoSetupRemote` below exists to remove. Leaving
  // the branch without an upstream is what lets push set the right one.
  await git(project.path, [
    "worktree",
    "add",
    "--no-track",
    "-b",
    name,
    target,
    base.ref,
  ]);
  await enableAutoSetupRemote(project.path, project.name);

  const now = Date.now();
  const id = newId();
  db.insert(workspaces)
    .values({
      id,
      projectId,
      name,
      branch: name,
      path: target,
      createdAt: now,
      lastOpenedAt: now,
    })
    .run();

  log.info(`created workspace ${project.name}/${name} from ${base.ref}`);
  return {
    id,
    name,
    branch: name,
    path: target,
    base: base.ref,
    warning: base.warning,
  };
}

export async function removeWorkspace(
  db: Db,
  config: Config,
  id: string,
): Promise<void> {
  const ws = getWorkspace(db, id);
  if (!ws) throw new Error("unknown workspace");
  const project = db
    .select()
    .from(projects)
    .where(eq(projects.id, ws.projectId))
    .get();

  if (project) {
    // --force because a worktree with uncommitted changes should still be
    // removable from the UI; the branch is deliberately left behind so the work
    // is recoverable with `git checkout`.
    await git(project.path, ["worktree", "remove", "--force", ws.path]).catch(
      (err: Error) => {
        log.warn(`git worktree remove failed for ${ws.path}: ${err.message}`);
      },
    );
  }
  await rm(ws.path, { recursive: true, force: true }).catch(() => {});

  await killWorkspaceSessions(db, config, id);
  db.delete(windows).where(eq(windows.workspaceId, id)).run();
  db.delete(workspaces).where(eq(workspaces.id, id)).run();
  log.info(`removed workspace ${ws.name} (branch ${ws.branch} kept)`);
}

export function touchWorkspace(db: Db, id: string): void {
  db.update(workspaces)
    .set({ lastOpenedAt: Date.now() })
    .where(eq(workspaces.id, id))
    .run();
}

/** Drops workspaces whose worktree directory has been deleted behind our back. */
export async function reconcileWorkspaces(
  db: Db,
  config: Config,
): Promise<void> {
  for (const ws of db.select().from(workspaces).all()) {
    if (!(await isDirectory(ws.path))) {
      await killWorkspaceSessions(db, config, ws.id);
      db.delete(windows).where(eq(windows.workspaceId, ws.id)).run();
      db.delete(workspaces).where(eq(workspaces.id, ws.id)).run();
      log.info(`workspace ${ws.name} no longer on disk — removed`);
    }
  }
}
