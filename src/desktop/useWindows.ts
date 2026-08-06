import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SshStatus } from '../sshterm';
import { onRuntimeDead } from '../sshterm';

/**
 * Window geometry lives in grid units, not pixels.
 *
 * That is what makes "free drag, snap to grid" cheap: dragging is a transient
 * pixel offset laid over a grid-anchored box, and letting go just rounds to the
 * nearest cell. It also means a window keeps its proportions when the browser
 * is resized or the desktop is opened on a different screen, which pixel
 * coordinates would not.
 */
export const GRID_COLS = 24;
export const GRID_ROWS = 14;

const MIN_COLS = 5;
const MIN_ROWS = 4;
const STORAGE_KEY = 'vibe-os:desktop:v1';

export interface WindowState {
  /**
   * Stable across reloads and used verbatim as the tmux session suffix
   * (`vibe-<id>`), which is what lets a window reattach to whatever it was
   * running before the tab was closed.
   */
  id: string;
  /** Bumped to force a fresh SSH session without changing the tmux session. */
  generation: number;
  col: number;
  row: number;
  colSpan: number;
  rowSpan: number;
  z: number;
  minimized: boolean;
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

function clampRect(r: Rect): Rect {
  const colSpan = Math.max(MIN_COLS, Math.min(GRID_COLS, Math.round(r.colSpan)));
  const rowSpan = Math.max(MIN_ROWS, Math.min(GRID_ROWS, Math.round(r.rowSpan)));
  return {
    colSpan,
    rowSpan,
    col: Math.max(0, Math.min(GRID_COLS - colSpan, Math.round(r.col))),
    row: Math.max(0, Math.min(GRID_ROWS - rowSpan, Math.round(r.row))),
  };
}

interface Persisted {
  windows: Omit<WindowState, 'status' | 'detail' | 'readyAt' | 'generation' | 'title'>[];
  nextZ: number;
}

function load(): Persisted {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { windows: [], nextZ: 1 };
    const parsed = JSON.parse(raw) as Persisted;
    const windows = (parsed.windows ?? []).filter((w) => /^[A-Za-z0-9_-]{1,32}$/.test(w.id));
    return { windows, nextZ: Number(parsed.nextZ) || windows.length + 1 };
  } catch {
    return { windows: [], nextZ: 1 };
  }
}

/**
 * Places a new window without covering an existing one exactly.
 *
 * A plain cascade walks off the bottom-right after a few windows, so this wraps
 * back to the origin and nudges sideways instead.
 */
function placement(index: number): Rect {
  const colSpan = 11;
  const rowSpan = 8;
  const step = 2;
  const slots = Math.max(1, Math.floor((GRID_COLS - colSpan) / step));
  const lane = index % slots;
  const wrap = Math.floor(index / slots);
  return clampRect({
    col: lane * step + wrap,
    row: (lane * step + wrap) % Math.max(1, GRID_ROWS - rowSpan),
    colSpan,
    rowSpan,
  });
}

export function useWindows() {
  const initial = useRef(load()).current;
  const [nextZ, setNextZ] = useState(initial.nextZ);
  const [windows, setWindows] = useState<WindowState[]>(() =>
    initial.windows.map((w) => ({
      ...w,
      generation: 0,
      status: 'loading' as SshStatus,
    })),
  );
  const [focused, setFocused] = useState<string | null>(initial.windows.at(-1)?.id ?? null);

  useEffect(() => {
    try {
      const payload: Persisted = {
        windows: windows.map(({ id, col, row, colSpan, rowSpan, z, minimized }) => ({
          id,
          col,
          row,
          colSpan,
          rowSpan,
          z,
          minimized,
        })),
        nextZ,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // private mode or quota — the desktop still works, it just forgets layout
    }
  }, [windows, nextZ]);

  const patch = useCallback((id: string, next: Partial<WindowState>) => {
    setWindows((current) => current.map((w) => (w.id === id ? { ...w, ...next } : w)));
  }, []);

  const raise = useCallback(
    (id: string) => {
      setFocused(id);
      setNextZ((z) => {
        setWindows((current) => current.map((w) => (w.id === id ? { ...w, z, minimized: false } : w)));
        return z + 1;
      });
    },
    [],
  );

  const spawn = useCallback(() => {
    setWindows((current) => {
      // Lowest unused positive integer: ids become tmux session names and get
      // typed by humans in `tmux ls`, so they should stay short and reusable.
      const used = new Set(current.map((w) => w.id));
      let n = 1;
      while (used.has(String(n))) n += 1;
      const id = String(n);
      const rect = placement(current.length);
      setFocused(id);
      setNextZ((z) => z + 1);
      return [
        ...current,
        { id, generation: 0, ...rect, z: nextZ, minimized: false, status: 'loading' as SshStatus },
      ];
    });
  }, [nextZ]);

  const close = useCallback((id: string) => {
    setWindows((current) => {
      const next = current.filter((w) => w.id !== id);
      setFocused((f) => (f === id ? (next.at(-1)?.id ?? null) : f));
      return next;
    });
  }, []);

  const restart = useCallback((id: string) => {
    setWindows((current) =>
      current.map((w) =>
        w.id === id
          ? { ...w, generation: w.generation + 1, status: 'loading', detail: undefined, readyAt: undefined }
          : w,
      ),
    );
  }, []);

  const move = useCallback((id: string, rect: Rect) => {
    const clamped = clampRect(rect);
    setWindows((current) => current.map((w) => (w.id === id ? { ...w, ...clamped } : w)));
  }, []);

  const setStatus = useCallback(
    (id: string, status: SshStatus, detail?: string) => {
      patch(id, { status, detail, ...(status === 'ready' ? { readyAt: Date.now() } : {}) });
    },
    [patch],
  );

  const minimize = useCallback((id: string) => patch(id, { minimized: true }), [patch]);

  const maximize = useCallback(
    (id: string) => {
      setWindows((current) =>
        current.map((w) => {
          if (w.id !== id) return w;
          const isFull = w.colSpan === GRID_COLS && w.rowSpan === GRID_ROWS;
          return isFull
            ? { ...w, ...placement(0) }
            : { ...w, col: 0, row: 0, colSpan: GRID_COLS, rowSpan: GRID_ROWS };
        }),
      );
      raise(id);
    },
    [raise],
  );

  // One Go runtime serves every window, so when it dies they all die together.
  // Rebuilding each session is the only recovery, and doing it automatically
  // beats leaving the user with windows that look fine but accept no input.
  useEffect(
    () =>
      onRuntimeDead(() => {
        setWindows((current) =>
          current.map((w) => ({
            ...w,
            generation: w.generation + 1,
            status: 'loading',
            detail: 'runtime restarted',
            readyAt: undefined,
          })),
        );
      }),
    [],
  );

  const ordered = useMemo(() => [...windows].sort((a, b) => a.z - b.z), [windows]);

  return {
    windows,
    ordered,
    focused,
    spawn,
    close,
    restart,
    move,
    raise,
    minimize,
    maximize,
    setStatus,
    setTitle: useCallback((id: string, title: string) => patch(id, { title }), [patch]),
  };
}
