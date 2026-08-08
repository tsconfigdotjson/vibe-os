// Window layout, stored per workspace.
//
// This lives on the server rather than in localStorage so a desktop follows you
// between browsers and machines, and so switching workspaces can restore an
// arrangement rather than rebuild one.

import { and, eq, sql } from "drizzle-orm";
import {
  DEFAULT_WINDOW_COLS,
  DEFAULT_WINDOW_ROWS,
  GRID_COLS,
  GRID_ROWS,
  MIN_WINDOW_COLS,
  MIN_WINDOW_ROWS,
} from "../shared/grid.ts";
import { sessionName } from "./attach.ts";
import { type Db, newId, windows, workspaces } from "./db.ts";

const MIN_COLS = MIN_WINDOW_COLS;
const MIN_ROWS = MIN_WINDOW_ROWS;

export interface Geometry {
  col: number;
  row: number;
  colSpan: number;
  rowSpan: number;
  z?: number;
  minimized?: boolean;
}

const clampInt = (
  v: unknown,
  lo: number,
  hi: number,
  fallback: number,
): number => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fallback;
};

/**
 * Server-side bounds check.
 *
 * The client already clamps, but geometry arrives over HTTP and a row that says
 * a window is 900 cells wide would break every later render. Same rule as the
 * client: size is honoured first, then position is pulled into range.
 */
export function sanitize(
  input: Partial<Geometry>,
  current?: Geometry,
): Required<Geometry> {
  const colSpan = clampInt(
    input.colSpan ?? current?.colSpan,
    MIN_COLS,
    GRID_COLS,
    DEFAULT_WINDOW_COLS,
  );
  const rowSpan = clampInt(
    input.rowSpan ?? current?.rowSpan,
    MIN_ROWS,
    GRID_ROWS,
    DEFAULT_WINDOW_ROWS,
  );
  return {
    colSpan,
    rowSpan,
    col: clampInt(input.col ?? current?.col, 0, GRID_COLS - colSpan, 0),
    row: clampInt(input.row ?? current?.row, 0, GRID_ROWS - rowSpan, 0),
    z: clampInt(input.z ?? current?.z, 0, Number.MAX_SAFE_INTEGER, 1),
    minimized: Boolean(input.minimized ?? current?.minimized),
  };
}

export function listWindows(db: Db, workspaceId: string) {
  return db
    .select()
    .from(windows)
    .where(eq(windows.workspaceId, workspaceId))
    .orderBy(windows.z)
    .all()
    .map(toRow);
}

export function getWindow(db: Db, id: string) {
  const row = db.select().from(windows).where(eq(windows.id, id)).get();
  return row ? toRow(row) : undefined;
}

/**
 * SQLite has no booleans, so the flags come back as 0 and 1.
 *
 * Concrete in its parameter rather than generic: a generic here produces
 * `T & { minimized: boolean }`, and intersecting `number` with `boolean` is
 * `never`, which makes every field of the result unreadable.
 */
function toRow(w: typeof windows.$inferSelect) {
  return {
    ...w,
    minimized: Boolean(w.minimized),
    promptDone: Boolean(w.promptDone),
    handoffSeen: Boolean(w.handoffSeen),
    handoff: (w.handoff as "ssh" | null) ?? null,
  };
}

/**
 * Places a new window without landing exactly on an existing one.
 *
 * A plain cascade walks off the bottom-right after a few windows, so this wraps
 * back and nudges sideways instead.
 */
function placement(index: number): Geometry {
  const colSpan = DEFAULT_WINDOW_COLS;
  const rowSpan = DEFAULT_WINDOW_ROWS;
  const step = 2;
  const slots = Math.max(1, Math.floor((GRID_COLS - colSpan) / step));
  const lane = index % slots;
  const wrap = Math.floor(index / slots);
  return sanitize({
    col: lane * step + wrap,
    row: (lane * step + wrap) % Math.max(1, GRID_ROWS - rowSpan),
    colSpan,
    rowSpan,
  });
}

export function createWindow(
  db: Db,
  workspaceId: string,
  profileId?: string | null,
) {
  const existing = listWindows(db, workspaceId);

  // Lowest unused index: it becomes part of the session name, which people read
  // when picking a window to attach to, so it should stay short and get reused.
  const used = new Set(existing.map((w) => w.idx));
  let idx = 1;
  while (used.has(idx)) idx += 1;

  const topZ = existing.reduce((max, w) => Math.max(max, w.z), 0);
  const geometry = placement(existing.length);
  const id = newId();

  db.insert(windows)
    .values({
      id,
      workspaceId,
      idx,
      col: geometry.col,
      row: geometry.row,
      colSpan: geometry.colSpan,
      rowSpan: geometry.rowSpan,
      z: topZ + 1,
      minimized: 0,
      profileId: profileId ?? null,
      promptDone: 0,
      createdAt: Date.now(),
    })
    .run();

  const created = getWindow(db, id);
  if (!created) throw new Error(`window ${id} vanished after insert`);
  return created;
}

export function updateWindow(
  db: Db,
  id: string,
  patch: Partial<Geometry> & { raise?: boolean; promptDone?: boolean },
) {
  const current = getWindow(db, id);
  if (!current) return undefined;

  let z = current.z;
  if (patch.raise) {
    const top = db
      .select({ max: sql<number>`coalesce(max(${windows.z}), 0)` })
      .from(windows)
      .where(eq(windows.workspaceId, current.workspaceId))
      .get();
    z = (top?.max ?? 0) + 1;
  }

  const geometry = sanitize({ ...patch, z: patch.z ?? z }, current);
  db.update(windows)
    .set({
      col: geometry.col,
      row: geometry.row,
      colSpan: geometry.colSpan,
      rowSpan: geometry.rowSpan,
      z: geometry.z,
      minimized: geometry.minimized ? 1 : 0,
      // One-way: the prompt band, once handed off, stays closed.
      promptDone: patch.promptDone || current.promptDone ? 1 : 0,
    })
    .where(eq(windows.id, id))
    .run();

  return getWindow(db, id);
}

export function deleteWindow(db: Db, id: string) {
  const row = getWindow(db, id);
  if (row) db.delete(windows).where(eq(windows.id, id)).run();
  return row;
}

/**
 * The session name for a window, with everything else needed to launch it.
 *
 * Built from the workspace name and the window index so the session list reads as
 * something a person recognises: `vibe-quiet-amber-otter-1`. The profile is
 * deliberately *not* folded into the name — renaming a role would then orphan
 * the session running it, for no gain a person would notice.
 */
export function sessionNameFor(
  db: Db,
  windowId: string,
): { session: string; cwd: string; profileId: string | null } | undefined {
  const row = db
    .select({
      idx: windows.idx,
      profileId: windows.profileId,
      name: workspaces.name,
      path: workspaces.path,
    })
    .from(windows)
    .innerJoin(workspaces, eq(windows.workspaceId, workspaces.id))
    .where(and(eq(windows.id, windowId)))
    .get();
  if (!row) return undefined;
  return {
    session: sessionName(row.name, row.idx),
    cwd: row.path,
    profileId: row.profileId,
  };
}
