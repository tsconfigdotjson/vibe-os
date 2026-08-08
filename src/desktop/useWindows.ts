import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SshStatus } from '../sshterm';
import { onRuntimeDead } from '../sshterm';
import { useWindowRows, windowApi, nudgeWindows, type WindowRow } from '../data';

/**
 * Window geometry lives in grid units, not pixels.
 *
 * That is what makes "free drag, snap to grid" cheap: dragging is a transient
 * pixel offset laid over a grid-anchored box, and letting go rounds to the
 * nearest cell. It also means a window keeps its proportions across screens of
 * different sizes, which pixel coordinates would not.
 */
export const MIN_WINDOW_COLS = 5;
export const MIN_WINDOW_ROWS = 4;

export const GRID_COLS = 24;
export const GRID_ROWS = 14;

const MIN_COLS = MIN_WINDOW_COLS;
const MIN_ROWS = MIN_WINDOW_ROWS;

export interface WindowState {
  id: string;
  /** Per-workspace index; forms the tmux session name with the workspace. */
  idx: number;
  /** Bumped to force a fresh SSH session without touching the tmux session. */
  generation: number;
  col: number;
  row: number;
  colSpan: number;
  rowSpan: number;
  z: number;
  minimized: boolean;
  /** The profile this window runs as, or null for a plain terminal. */
  profileId: string | null;
  /** The prompt band has been handed off; it stays closed from then on. */
  promptDone: boolean;
  /** 'ssh' while a real terminal holds this window's session. */
  handoff: 'ssh' | null;
  status: SshStatus;
  detail?: string;
  title?: string;
  readyAt?: number;
}

export interface Rect {
  col: number;
  row: number;
  colSpan: number;
  rowSpan: number;
}

export type DragMode = 'move' | 'resize';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(v)));

/**
 * Constrains a rect to the grid.
 *
 * The mode matters. Moving must preserve the window's size and only push its
 * position back in bounds. Resizing must preserve its *position* — clamping the
 * span first and deriving position from it means growing a window's right edge
 * silently drags its left edge inwards.
 */
export function clampRect(r: Rect, mode: DragMode = 'move'): Rect {
  if (mode === 'move') {
    const colSpan = clamp(r.colSpan, MIN_COLS, GRID_COLS);
    const rowSpan = clamp(r.rowSpan, MIN_ROWS, GRID_ROWS);
    return {
      colSpan,
      rowSpan,
      col: clamp(r.col, 0, GRID_COLS - colSpan),
      row: clamp(r.row, 0, GRID_ROWS - rowSpan),
    };
  }
  const col = clamp(r.col, 0, GRID_COLS - MIN_COLS);
  const row = clamp(r.row, 0, GRID_ROWS - MIN_ROWS);
  return {
    col,
    row,
    colSpan: clamp(r.colSpan, MIN_COLS, GRID_COLS - col),
    rowSpan: clamp(r.rowSpan, MIN_ROWS, GRID_ROWS - row),
  };
}

const HALF_COL = GRID_COLS / 2;
const HALF_ROW = GRID_ROWS / 2;

/**
 * The layouts the tile button can produce, indexed by how many windows are on
 * screen.
 *
 * Deliberately a short list. One filling the desktop, two across, two across
 * with a full-width one beneath, or the four corners — past that every tile is
 * narrower than a terminal wants to be, so five windows and up are left exactly
 * where they are rather than arranged into something nobody would work in.
 */
const TILINGS: Rect[][] = [
  [{ col: 0, row: 0, colSpan: GRID_COLS, rowSpan: GRID_ROWS }],
  [
    { col: 0, row: 0, colSpan: HALF_COL, rowSpan: GRID_ROWS },
    { col: HALF_COL, row: 0, colSpan: HALF_COL, rowSpan: GRID_ROWS },
  ],
  [
    { col: 0, row: 0, colSpan: HALF_COL, rowSpan: HALF_ROW },
    { col: HALF_COL, row: 0, colSpan: HALF_COL, rowSpan: HALF_ROW },
    { col: 0, row: HALF_ROW, colSpan: GRID_COLS, rowSpan: HALF_ROW },
  ],
  [
    { col: 0, row: 0, colSpan: HALF_COL, rowSpan: HALF_ROW },
    { col: HALF_COL, row: 0, colSpan: HALF_COL, rowSpan: HALF_ROW },
    { col: 0, row: HALF_ROW, colSpan: HALF_COL, rowSpan: HALF_ROW },
    { col: HALF_COL, row: HALF_ROW, colSpan: HALF_COL, rowSpan: HALF_ROW },
  ],
];

/** How many windows the tile button can arrange. */
export const MAX_TILED = TILINGS.length;

/**
 * Windows for the current workspace, backed by the API.
 *
 * Local state mirrors the server so dragging stays immediate; every mutation
 * applies locally first and PATCHes in the background. Switching workspaces
 * simply swaps the rows — the SSH sessions of the workspace you left are
 * detached, not killed, which is exactly what tmux is for.
 */
export function useWindows(workspaceId: string | null) {
  const { rows, mutate, isLoading } = useWindowRows(workspaceId);
  const [runtime, setRuntime] = useState<Record<string, Partial<WindowState>>>({});
  const [focused, setFocused] = useState<string | null>(null);
  const zCounter = useRef(1);

  // Transient per-session state (status, title, uptime) is keyed by window id
  // and deliberately not persisted — it describes a live connection, not layout.
  useEffect(() => {
    setRuntime({});
    setFocused(null);
  }, [workspaceId]);

  const windows = useMemo<WindowState[]>(() => {
    const list = (rows ?? []).map((r) => ({
      id: r.id,
      idx: r.idx,
      generation: 0,
      col: r.col,
      row: r.row,
      colSpan: r.colSpan,
      rowSpan: r.rowSpan,
      z: r.z,
      minimized: r.minimized,
      profileId: r.profileId,
      promptDone: r.promptDone,
      handoff: r.handoff ?? null,
      status: 'loading' as SshStatus,
      ...runtime[r.id],
    }));
    zCounter.current = list.reduce((max, w) => Math.max(max, w.z), 0);
    return list;
  }, [rows, runtime]);

  const ordered = useMemo(() => [...windows].sort((a, b) => a.z - b.z), [windows]);

  useEffect(() => {
    if (focused === null && ordered.length > 0) setFocused(ordered.at(-1)!.id);
  }, [focused, ordered]);

  const patchRuntime = useCallback((id: string, next: Partial<WindowState>) => {
    setRuntime((current) => ({ ...current, [id]: { ...current[id], ...next } }));
  }, []);

  /** Applies a row change locally, then persists it. */
  const applyRow = useCallback(
    (id: string, changes: Partial<WindowRow>, persist: () => Promise<unknown>) => {
      void mutate((current) => (current ?? []).map((r) => (r.id === id ? { ...r, ...changes } : r)), {
        revalidate: false,
      });
      void persist().catch(() => void mutate());
    },
    [mutate],
  );

  const raise = useCallback(
    (id: string) => {
      setFocused(id);
      const z = (zCounter.current += 1);
      applyRow(id, { z, minimized: false }, () => windowApi.patch(id, { raise: true, minimized: false }));
    },
    [applyRow],
  );

  const spawn = useCallback(
    async (profileId?: string | null) => {
      if (!workspaceId) return;
      const created = await windowApi.create(workspaceId, profileId);
      await mutate((current) => [...(current ?? []), created], { revalidate: false });
      setFocused(created.id);
      return created;
    },
    [workspaceId, mutate],
  );

  /**
   * Closes a window and ends the session behind it.
   *
   * Window indices are reused and each window attaches with
   * `tmux new-session -A`, so a lingering session would silently reappear in the
   * next window opened. Persistence across a reload is untouched; only an
   * explicit dismissal ends anything. Minimise puts one away and keeps it.
   */
  const close = useCallback(
    (id: string) => {
      const remaining = (rows ?? []).filter((r) => r.id !== id);
      void mutate(remaining, { revalidate: false });
      setFocused((f) => (f === id ? (remaining.at(-1)?.id ?? null) : f));
      void windowApi.remove(id).catch(() => void mutate());
    },
    [rows, mutate],
  );

  const restart = useCallback(
    (id: string) => {
      patchRuntime(id, {
        generation: (runtime[id]?.generation ?? 0) + 1,
        status: 'loading',
        detail: undefined,
        readyAt: undefined,
      });
    },
    [patchRuntime, runtime],
  );

  const move = useCallback(
    (id: string, rect: Rect, mode: DragMode = 'move') => {
      const clamped = clampRect(rect, mode);
      applyRow(id, clamped, () => windowApi.patch(id, clamped));
    },
    [applyRow],
  );

  const minimize = useCallback(
    (id: string) => applyRow(id, { minimized: true }, () => windowApi.patch(id, { minimized: true })),
    [applyRow],
  );

  const maximize = useCallback(
    (id: string) => {
      const current = (rows ?? []).find((r) => r.id === id);
      if (!current) return;
      const isFull = current.colSpan === GRID_COLS && current.rowSpan === GRID_ROWS;
      const rect = isFull
        ? { col: 2, row: 1, colSpan: 11, rowSpan: 8 }
        : { col: 0, row: 0, colSpan: GRID_COLS, rowSpan: GRID_ROWS };
      applyRow(id, rect, () => windowApi.patch(id, rect));
      raise(id);
    },
    [rows, applyRow, raise],
  );

  /**
   * Everything actually on screen. Minimised windows are put away on purpose,
   * so tiling neither counts them nor drags them back out.
   */
  const visible = useMemo(() => windows.filter((w) => !w.minimized), [windows]);

  /**
   * One local update for the whole layout, then a PATCH per window.
   *
   * Not `applyRow` in a loop: each of those hands SWR a function of the current
   * rows, and four of them fired back to back can each be handed the same
   * pre-tile rows — leaving three windows visibly where they were until a poll
   * corrects them. The rects are known up front, so the whole arrangement is a
   * single map over the list.
   */
  const tile = useCallback(() => {
    const layout = TILINGS[visible.length - 1];
    if (!layout) return;
    const rects = new Map(visible.map((win, index) => [win.id, layout[index]]));
    void mutate((current) => (current ?? []).map((r) => ({ ...r, ...rects.get(r.id) })), {
      revalidate: false,
    });
    for (const [id, rect] of rects) {
      void windowApi.patch(id, rect).catch(() => void mutate());
    }
  }, [visible, mutate]);

  /**
   * Opens a profile — raising the window already running it rather than
   * starting a second one.
   *
   * A profile is a role, and a workspace normally wants one of each: two
   * "Backend Manager" sessions on the same worktree is usually a mistake, not
   * an intention. `forceNew` is the escape hatch for when it is an intention.
   */
  const openProfile = useCallback(
    async (profileId: string, opts: { forceNew?: boolean } = {}) => {
      if (!opts.forceNew) {
        const existing = windows.find((w) => w.profileId === profileId);
        if (existing) {
          raise(existing.id);
          return;
        }
      }
      await spawn(profileId);
    },
    [windows, raise, spawn],
  );

  const markPromptDone = useCallback(
    (id: string) => applyRow(id, { promptDone: true }, () => windowApi.patch(id, { promptDone: true })),
    [applyRow],
  );

  /**
   * Hands this window's terminal to a real terminal, or takes it back.
   *
   * The two directions are deliberately not symmetric. Handing off is
   * optimistic: unmounting our terminal early is harmless, and it is what makes
   * the ssh command appear the instant you ask for it. Taking it back waits for
   * the server, because the server is what detaches the ssh client — remounting
   * first would put two clients on the session for as long as the round trip
   * takes, which is precisely the state this whole dance exists to prevent.
   */
  const handoff = useCallback(
    async (id: string, mode: 'ssh' | null) => {
      // Other tabs are showing this same window and have to let go of it too,
      // or they stay attached and the terminal ends up sharing the session.
      const tell = () => workspaceId && nudgeWindows(workspaceId);

      if (mode === 'ssh') {
        applyRow(id, { handoff: 'ssh' }, () => windowApi.handoff(id, 'ssh').then((row) => (tell(), row)));
        return;
      }
      try {
        const row = await windowApi.handoff(id, null);
        await mutate((current) => (current ?? []).map((r) => (r.id === id ? { ...r, ...row } : r)), {
          revalidate: false,
        });
        tell();
      } catch {
        void mutate();
      }
    },
    [applyRow, mutate, workspaceId],
  );

  const setStatus = useCallback(
    (id: string, status: SshStatus, detail?: string) => {
      patchRuntime(id, { status, detail, ...(status === 'ready' ? { readyAt: Date.now() } : {}) });
    },
    [patchRuntime],
  );

  // One Go runtime serves every window, so when it dies they all die together.
  // Rebuilding each session automatically beats leaving the user with windows
  // that look fine but accept no input.
  useEffect(
    () =>
      onRuntimeDead(() => {
        setRuntime((current) => {
          const next: Record<string, Partial<WindowState>> = {};
          for (const [id, state] of Object.entries(current)) {
            next[id] = {
              ...state,
              generation: (state.generation ?? 0) + 1,
              status: 'loading',
              detail: 'runtime restarted',
              readyAt: undefined,
            };
          }
          return next;
        });
      }),
    [],
  );

  return {
    windows,
    ordered,
    focused,
    isLoading,
    spawn,
    openProfile,
    markPromptDone,
    handoff,
    close,
    restart,
    move,
    raise,
    minimize,
    maximize,
    tile,
    tileable: visible.length > 0 && visible.length <= MAX_TILED,
    setStatus,
    setTitle: useCallback((id: string, title: string) => patchRuntime(id, { title }), [patchRuntime]),
  };
}
