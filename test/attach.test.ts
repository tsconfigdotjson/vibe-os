import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { listTargets, resolveTarget, sessionName } from "../server/attach.ts";
import {
  type Db,
  newId,
  openDb,
  projects,
  windows,
  workspaces,
} from "../server/db.ts";

/**
 * `resolveTarget` and `listTargets` were the same five-table join and the same
 * seven-field mapping, written twice. They are one query and one mapper now, so
 * these check the two entry points still agree — and that lookup by id, by ref
 * and by session name all land on the same row.
 */
let db: Db;
let windowId: string;

async function seed() {
  const dir = await mkdtemp(path.join(tmpdir(), "vibe-os-attach-"));
  const d = openDb(dir);
  const projectId = newId();
  const workspaceId = newId();
  windowId = newId();
  const now = Date.now();

  d.insert(projects)
    .values({
      id: projectId,
      name: "demo",
      path: "/tmp/demo",
      branch: "main",
      remote: null,
      createdAt: now,
    })
    .run();
  d.insert(workspaces)
    .values({
      id: workspaceId,
      projectId,
      name: "brisk-copper-vole",
      branch: "brisk-copper-vole",
      path: "/tmp/demo/wt",
      createdAt: now,
      lastOpenedAt: now,
    })
    .run();
  d.insert(windows)
    .values({
      id: windowId,
      workspaceId,
      idx: 3,
      col: 0,
      row: 0,
      colSpan: 11,
      rowSpan: 8,
      z: 1,
      minimized: 0,
      profileId: null,
      promptDone: 0,
      createdAt: now,
    })
    .run();
  return d;
}

beforeEach(async () => {
  db = await seed();
});

describe("attach targets", () => {
  test("listTargets returns the window", () => {
    const all = listTargets(db);
    expect(all).toHaveLength(1);
    expect(all[0].windowId).toBe(windowId);
    expect(all[0].ref).toBe("brisk-copper-vole-3");
    expect(all[0].session).toBe("vibe-brisk-copper-vole-3");
    expect(all[0].project).toBe("demo");
    expect(all[0].cwd).toBe("/tmp/demo/wt");
  });

  test("session name is composed one way", () => {
    expect(sessionName("brisk-copper-vole", 3)).toBe(
      listTargets(db)[0].session,
    );
  });

  test("resolving by id, ref and session name all agree with the list", () => {
    const listed = listTargets(db)[0];
    for (const key of [listed.windowId, listed.ref, listed.session]) {
      expect(resolveTarget(db, key)).toEqual(listed);
    }
  });

  test("whitespace around a ref is tolerated", () => {
    expect(resolveTarget(db, "  brisk-copper-vole-3  ")?.windowId).toBe(
      windowId,
    );
  });

  test("an unknown ref resolves to nothing", () => {
    expect(resolveTarget(db, "no-such-workspace-1")).toBeUndefined();
    expect(resolveTarget(db, "brisk-copper-vole-99")).toBeUndefined();
    expect(resolveTarget(db, "")).toBeUndefined();
  });

  /**
   * A UUID's last group is twelve hex digits that are sometimes all decimal, so
   * an id can also parse as a ref. Ids are tried first for exactly this reason.
   */
  test("an id that also looks like a ref resolves as an id", () => {
    const listed = listTargets(db)[0];
    expect(resolveTarget(db, listed.windowId)?.windowId).toBe(windowId);
  });
});
