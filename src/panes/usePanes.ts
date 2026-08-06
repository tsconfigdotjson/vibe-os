import { useCallback, useEffect, useRef, useState } from 'react';
import type { SshStatus } from '../sshterm';
import { onRuntimeDead } from '../sshterm';

export type LayoutMode = 'columns' | 'rows' | 'focus';

export interface Pane {
  /**
   * Stable across reloads and used verbatim as the tmux session suffix
   * (`vibe-<id>`), which is what lets a pane reattach to the session it was
   * running before the tab was closed.
   */
  id: string;
  /** Bumped to force a fresh SSH session without changing the tmux session. */
  generation: number;
  status: SshStatus;
  detail?: string;
  title?: string;
  /** Epoch ms when the session last reached `ready`. */
  readyAt?: number;
}

interface PersistedState {
  ids: string[];
  layout: LayoutMode;
  ratio: number;
  focused: string;
}

const STORAGE_KEY = 'vibe-os:panes:v1';
const MIN_RATIO = 0.15;
const MAX_RATIO = 0.85;

function newPane(id: string): Pane {
  return { id, generation: 0, status: 'loading' };
}

function loadPersisted(): PersistedState {
  const fallback: PersistedState = { ids: ['1', '2'], layout: 'columns', ratio: 0.5, focused: '1' };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<PersistedState>;
    const ids = Array.isArray(parsed.ids) && parsed.ids.length > 0 ? parsed.ids.filter((id) => /^[A-Za-z0-9_-]{1,32}$/.test(id)) : fallback.ids;
    if (ids.length === 0) return fallback;
    return {
      ids,
      layout: parsed.layout === 'rows' || parsed.layout === 'focus' ? parsed.layout : 'columns',
      ratio: typeof parsed.ratio === 'number' && parsed.ratio > 0 ? Math.min(MAX_RATIO, Math.max(MIN_RATIO, parsed.ratio)) : 0.5,
      focused: typeof parsed.focused === 'string' && ids.includes(parsed.focused) ? parsed.focused : ids[0],
    };
  } catch {
    return fallback;
  }
}

export function usePanes() {
  const initial = useRef(loadPersisted()).current;

  const [panes, setPanes] = useState<Pane[]>(() => initial.ids.map(newPane));
  const [layout, setLayout] = useState<LayoutMode>(initial.layout);
  const [ratio, setRatio] = useState(initial.ratio);
  const [focused, setFocused] = useState(initial.focused);

  useEffect(() => {
    const state: PersistedState = { ids: panes.map((p) => p.id), layout, ratio, focused };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // private mode, quota — the app still works, it just forgets the layout
    }
  }, [panes, layout, ratio, focused]);

  const patch = useCallback((id: string, next: Partial<Pane>) => {
    setPanes((current) => current.map((pane) => (pane.id === id ? { ...pane, ...next } : pane)));
  }, []);

  const setStatus = useCallback(
    (id: string, status: SshStatus, detail?: string) => {
      patch(id, { status, detail, ...(status === 'ready' ? { readyAt: Date.now() } : {}) });
    },
    [patch],
  );

  const restart = useCallback((id: string) => {
    setPanes((current) =>
      current.map((pane) =>
        pane.id === id
          ? { ...pane, generation: pane.generation + 1, status: 'loading', detail: undefined, readyAt: undefined }
          : pane,
      ),
    );
  }, []);

  const addPane = useCallback(() => {
    setPanes((current) => {
      // Lowest unused positive integer, so ids stay short and reusable — they
      // become tmux session names and are typed by humans in `tmux ls`.
      const used = new Set(current.map((p) => p.id));
      let n = 1;
      while (used.has(String(n))) n += 1;
      const id = String(n);
      setFocused(id);
      return [...current, newPane(id)];
    });
  }, []);

  const closePane = useCallback((id: string) => {
    setPanes((current) => {
      if (current.length <= 1) return current;
      const next = current.filter((pane) => pane.id !== id);
      setFocused((f) => (f === id ? next[0].id : f));
      return next;
    });
  }, []);

  // One Go runtime serves every pane, so when it dies they all die together.
  // Rebuilding each session is the only recovery, and doing it automatically
  // beats leaving the user with panes that look fine but accept no input.
  useEffect(
    () =>
      onRuntimeDead(() => {
        setPanes((current) =>
          current.map((pane) => ({
            ...pane,
            generation: pane.generation + 1,
            status: 'loading',
            detail: 'runtime restarted',
            readyAt: undefined,
          })),
        );
      }),
    [],
  );

  return {
    panes,
    layout,
    ratio,
    focused,
    setLayout,
    setRatio: useCallback((next: number) => setRatio(Math.min(MAX_RATIO, Math.max(MIN_RATIO, next))), []),
    setFocused,
    setStatus,
    setTitle: useCallback((id: string, title: string) => patch(id, { title }), [patch]),
    restart,
    addPane,
    closePane,
  };
}
