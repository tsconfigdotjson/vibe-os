import { beforeEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { type Db, newId, openDb, projects } from "../server/db.ts";
import { createWorkspace } from "../server/projects.ts";

/**
 * Where a new workspace's branch starts.
 *
 * The interesting case is the ordinary one: a project checkout that has been
 * sitting on some old branch for a week. A workspace cut from *that* inherits
 * it, which is how you end up rebasing an agent's work before you can read it.
 * So these fetch origin and branch from its default, and the tests below are
 * written to fail if that ever silently goes back to HEAD.
 */
const run = promisify(execFile);

/*
 * Whoever runs this has a ~/.gitconfig, and some of them set `fetch.prune`,
 * `init.defaultBranch` or `core.sshCommand`. Those would reach both the git in
 * these helpers and the git that `createWorkspace` spawns, so a test could
 * pass on one machine and fail on the next, or worse, pass here on a setting
 * that CI does not have. Setting it on this process is what makes it stick for
 * the server code too, which inherits the environment it is given.
 */
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_SYSTEM = "/dev/null";
process.env.GIT_AUTHOR_NAME = "t";
process.env.GIT_AUTHOR_EMAIL = "t@example.com";
process.env.GIT_COMMITTER_NAME = "t";
process.env.GIT_COMMITTER_EMAIL = "t@example.com";

const git = async (cwd: string, args: string[]) =>
  (await run("git", ["-C", cwd, ...args])).stdout.trim();

let root: string;
let db: Db;

/** A bare "remote" with one commit on main, and a clone of it. */
async function withOrigin(): Promise<{ origin: string; clone: string }> {
  const origin = path.join(root, "origin.git");
  await run("git", ["init", "-q", "--bare", "-b", "main", origin]);

  const seed = path.join(root, "seed");
  await run("git", ["clone", "-q", origin, seed]);
  await git(seed, ["commit", "-q", "--allow-empty", "-m", "first"]);
  await git(seed, ["push", "-q", "origin", "main"]);

  const clone = path.join(root, "project");
  await run("git", ["clone", "-q", origin, clone]);
  return { origin, clone };
}

/** Adds a commit to origin's main, behind the project checkout's back. */
async function commitOnOrigin(origin: string, message: string) {
  const push = path.join(root, `push-${message}`);
  await run("git", ["clone", "-q", origin, push]);
  await git(push, ["commit", "-q", "--allow-empty", "-m", message]);
  await git(push, ["push", "-q", "origin", "main"]);
  return git(push, ["rev-parse", "HEAD"]);
}

function addProject(name: string, repo: string): string {
  const id = newId();
  db.insert(projects)
    .values({
      id,
      name,
      path: repo,
      branch: "main",
      remote: null,
      createdAt: Date.now(),
    })
    .run();
  return id;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "vibe-os-projects-"));
  db = openDb(await mkdtemp(path.join(tmpdir(), "vibe-os-state-")));
});

test("branches from origin's default, not from the checkout", async () => {
  const { origin, clone } = await withOrigin();
  // The checkout is left where a real one is left: on a stale local commit
  // that origin has never heard of, with newer work sitting on main.
  await git(clone, ["commit", "-q", "--allow-empty", "-m", "local-only"]);
  const latest = await commitOnOrigin(origin, "newer");

  const ws = await createWorkspace(db, root, addProject("demo", clone));

  expect(ws.base).toBe("origin/main");
  expect(ws.warning).toBeNull();
  expect(await git(ws.path, ["rev-parse", "HEAD"])).toBe(latest);
});

test("the new branch has no upstream, so the first push sets its own", async () => {
  const { clone } = await withOrigin();
  const ws = await createWorkspace(db, root, addProject("demo", clone));

  // An upstream of origin/main would make `git push` refuse: its name does not
  // match the branch's. Absent is what lets push.autoSetupRemote do the work.
  await expect(
    git(ws.path, ["rev-parse", "--abbrev-ref", `${ws.branch}@{upstream}`]),
  ).rejects.toThrow();
  expect(await git(clone, ["config", "--local", "push.autoSetupRemote"])).toBe(
    "true",
  );
});

test("a repo with no origin still gets a workspace, from HEAD", async () => {
  const solo = path.join(root, "solo");
  await run("git", ["init", "-q", "-b", "main", solo]);
  await git(solo, ["commit", "-q", "--allow-empty", "-m", "only"]);
  const head = await git(solo, ["rev-parse", "HEAD"]);

  const ws = await createWorkspace(db, root, addProject("solo", solo));

  expect(ws.base).toBe("HEAD");
  expect(ws.warning).toBeNull();
  expect(await git(ws.path, ["rev-parse", "HEAD"])).toBe(head);
});

test("an unreachable origin branches from the last fetch and says so", async () => {
  const { origin, clone } = await withOrigin();
  const known = await git(clone, ["rev-parse", "origin/main"]);
  // Committed upstream, then the remote is moved out from under the clone: the
  // fetch fails, and the newer commit is one this project cannot reach.
  await commitOnOrigin(origin, "unreachable");
  await run("git", [
    "-C",
    clone,
    "remote",
    "set-url",
    "origin",
    path.join(root, "gone.git"),
  ]);

  const ws = await createWorkspace(db, root, addProject("demo", clone));

  expect(ws.base).toBe("origin/main");
  expect(ws.warning).toContain("origin/main");
  // The reason git gave, not just "could not reach origin": an expired token
  // and an aeroplane are different problems with different fixes.
  expect(ws.warning).toContain("does not appear to be a git repository");
  expect(await git(ws.path, ["rev-parse", "HEAD"])).toBe(known);
});

test("a default branch that moved is followed, old branch or not", async () => {
  const { origin, clone } = await withOrigin();
  // The master-to-main switch as forges actually do it: a new default branch,
  // and the old one left behind rather than deleted. Nothing local can tell,
  // because refs/remotes/origin/HEAD still names a branch that really exists.
  await run("git", ["-C", origin, "branch", "next", "main"]);
  await run("git", ["-C", origin, "symbolic-ref", "HEAD", "refs/heads/next"]);
  const moved = path.join(root, "moved");
  await run("git", ["clone", "-q", "-b", "next", origin, moved]);
  await git(moved, ["commit", "-q", "--allow-empty", "-m", "on the new one"]);
  await git(moved, ["push", "-q", "origin", "next"]);
  const latest = await git(moved, ["rev-parse", "HEAD"]);

  // origin/main is still there and still resolves, so verifying the symbolic
  // ref proves nothing: only asking origin finds the move.
  expect(
    await git(clone, ["rev-parse", "--verify", "origin/main"]),
  ).toBeTruthy();

  const ws = await createWorkspace(db, root, addProject("demo", clone));

  expect(ws.base).toBe("origin/next");
  expect(await git(ws.path, ["rev-parse", "HEAD"])).toBe(latest);
});

test("a default branch nothing can resolve is admitted, not hidden", async () => {
  const { origin } = await withOrigin();
  // --single-branch on a branch that is not the default: the fetch succeeds,
  // but origin's default is never mirrored here, so no local ref answers for
  // it. The workspace is still created; the point is that it says so.
  const narrow = path.join(root, "narrow");
  await run("git", ["-C", origin, "branch", "release", "main"]);
  await run("git", [
    "clone",
    "-q",
    "--single-branch",
    "-b",
    "release",
    origin,
    narrow,
  ]);
  const head = await git(narrow, ["rev-parse", "HEAD"]);

  const ws = await createWorkspace(db, root, addProject("narrow", narrow));

  expect(ws.base).toBe("HEAD");
  expect(ws.warning).toContain("default branch");
  expect(await git(ws.path, ["rev-parse", "HEAD"])).toBe(head);
});

test("a renamed default branch is followed rather than guessed", async () => {
  const { origin, clone } = await withOrigin();
  // What a repo looks like after `main` is renamed on the forge: the clone's
  // origin/HEAD still points at a branch that is no longer there.
  await run("git", ["-C", origin, "branch", "-m", "main", "trunk"]);
  await run("git", ["-C", origin, "symbolic-ref", "HEAD", "refs/heads/trunk"]);

  const ws = await createWorkspace(db, root, addProject("demo", clone));

  expect(ws.base).toBe("origin/trunk");
});
