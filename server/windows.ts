// Window layout, stored per workspace.
//
// This lives on the server rather than in localStorage so a desktop follows you
// between browsers and machines, and so switching workspaces can restore an
// arrangement rather than rebuild one.

import { eq, and, sql } from 'drizzle-orm';
import { type Db, windows, workspaces, newId } from './db.ts';

export const GRID_COLS = 24;
export const GRID_ROWS = 14;
const MIN_COLS = 5;
const MIN_ROWS = 4;

export interface Geometry {
  col: number;
  row: number;
  colSpan: number;
  rowSpan: number;
  z?: number;
  minimized?: boolean;
}

const clampInt = (v: unknown, lo: number, hi: number, fallback: number): number => {
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
export function sanitize(input: Partial<Geometry>, current?: Geometry): Geometry {
  const colSpan = clampInt(input.colSpan ?? current?.colSpan, MIN_COLS, GRID_COLS, 11);
  const rowSpan = clampInt(input.rowSpan ?? current?.rowSpan, MIN_ROWS, GRID_ROWS, 8);
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
    .map((w) => ({ ...w, minimized: Boolean(w.minimized) }));
}

export function getWindow(db: Db, id: string) {
  const row = db.select().from(windows).where(eq(windows.id, id)).get();
  return row ? { ...row, minimized: Boolean(row.minimized) } : undefined;
}

/**
 * Places a new window without landing exactly on an existing one.
 *
 * A plain cascade walks off the bottom-right after a few windows, so this wraps
 * back and nudges sideways instead.
 */
function placement(index: number): Geometry {
  const colSpan = 11;
  const rowSpan = 8;
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

export function createWindow(db: Db, workspaceId: string) {
  const existing = listWindows(db, workspaceId);

  // Lowest unused index: it becomes part of the tmux session name, which people
  // read in `tmux ls`, so it should stay short and get reused.
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
      createdAt: Date.now(),
    })
    .run();

  return getWindow(db, id)!;
}

export function updateWindow(db: Db, id: string, patch: Partial<Geometry> & { raise?: boolean }) {
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
      z: geometry.z!,
      minimized: geometry.minimized ? 1 : 0,
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
 * The tmux session name for a window.
 *
 * Built from the workspace name and the window index so `tmux ls` reads as
 * something a person recognises: `vibe-quiet-amber-otter-1`.
 */
export function sessionNameFor(db: Db, windowId: string): { session: string; cwd: string } | undefined {
  const row = db
    .select({ idx: windows.idx, name: workspaces.name, path: workspaces.path })
    .from(windows)
    .innerJoin(workspaces, eq(windows.workspaceId, workspaces.id))
    .where(and(eq(windows.id, windowId)))
    .get();
  if (!row) return undefined;
  return { session: `vibe-${row.name}-${row.idx}`, cwd: row.path };
}
