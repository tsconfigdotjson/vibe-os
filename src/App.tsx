import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { fetchServerConfig, type ServerConfig } from './api';
import { usePanes, type LayoutMode } from './panes/usePanes';
import { PaneView } from './panes/PaneView';
import { Splitter } from './panes/Splitter';
import { TopBar } from './chrome/TopBar';
import { StatusLine } from './chrome/StatusLine';

/**
 * Pane identity colours, drawn from the ANSI palette the terminals themselves
 * use. Assignment is by position so a pane keeps its colour for as long as it
 * exists, and the same colour marks it in the header, the border, and the
 * status line — which is what makes two panes distinguishable at a glance
 * without reading anything.
 */
const HUES = ['#56cfe1', '#a78bfa', '#7ee081', '#f2c14e', '#ef6b73', '#63d4c0'];

export default function App() {
  const [server, setServer] = useState<ServerConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  const {
    panes,
    layout,
    ratio,
    focused,
    setLayout,
    setRatio,
    setFocused,
    setStatus,
    setTitle,
    restart,
    addPane,
    closePane,
  } = usePanes();

  useEffect(() => {
    let cancelled = false;
    fetchServerConfig().then(
      (config) => {
        if (!cancelled) setServer(config);
      },
      (err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const hues = useMemo(() => {
    const map: Record<string, string> = {};
    panes.forEach((pane, index) => {
      map[pane.id] = HUES[index % HUES.length];
    });
    return map;
  }, [panes]);

  const visible = layout === 'focus' ? panes.filter((pane) => pane.id === focused) : panes.slice(0, 2);
  const overflow = layout === 'focus' ? 0 : Math.max(0, panes.length - 2);

  // Alt-based chords rather than tmux's ctrl-b: the terminal has focus almost
  // all the time and ctrl-b belongs to the tmux session running inside it.
  // Capture phase, because xterm claims keys on its own textarea first.
  const onKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (!event.altKey || event.ctrlKey || event.metaKey) return;

      const digit = Number(event.key);
      if (Number.isInteger(digit) && digit >= 1 && digit <= 9) {
        const pane = panes[digit - 1];
        if (pane) {
          setFocused(pane.id);
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      }

      const bindings: Record<string, () => void> = {
        '\\': () => setLayout('columns'),
        '-': () => setLayout('rows'),
        z: () => setLayout(layout === 'focus' ? 'columns' : 'focus'),
        t: () => addPane(),
      };
      const action = bindings[event.key.toLowerCase()];
      if (action) {
        action();
        event.preventDefault();
        event.stopPropagation();
      }
    },
    [panes, layout, setFocused, setLayout, addPane],
  );

  useEffect(() => {
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [onKeyDown]);

  if (error) {
    return (
      <div className="boot boot-error">
        <p className="boot-line">could not reach the vibe-os server</p>
        <p className="boot-detail">{error}</p>
        <button type="button" className="action" onClick={() => window.location.reload()}>
          retry
        </button>
      </div>
    );
  }

  if (!server) {
    return (
      <div className="boot">
        <p className="boot-line">
          vibe-os<span className="caret" aria-hidden="true" />
        </p>
        <p className="boot-detail">reading host configuration…</p>
      </div>
    );
  }

  const splitStyle =
    layout === 'columns'
      ? { gridTemplateColumns: `${ratio}fr 6px ${1 - ratio}fr` }
      : { gridTemplateRows: `${ratio}fr 6px ${1 - ratio}fr` };

  return (
    <div className="app">
      <TopBar
        server={server}
        layout={layout}
        paneCount={panes.length}
        onLayout={setLayout as (mode: LayoutMode) => void}
        onAddPane={addPane}
      />

      <main
        className="grid"
        data-layout={layout}
        data-panes={visible.length}
        style={visible.length > 1 ? splitStyle : undefined}
      >
        {visible.map((pane, index) => (
          <Fragment key={pane.id}>
            {index > 0 ? (
              <Splitter layout={layout === 'rows' ? 'rows' : 'columns'} ratio={ratio} onRatio={setRatio} />
            ) : null}
            <PaneView
              pane={pane}
              server={server}
              hue={hues[pane.id]}
              focused={pane.id === focused}
              closable={panes.length > 1}
              onFocus={setFocused}
              onStatus={setStatus}
              onTitle={setTitle}
              onRestart={restart}
              onClose={closePane}
            />
          </Fragment>
        ))}
      </main>

      {overflow > 0 ? (
        <p className="overflow-note">
          {overflow} more pane{overflow > 1 ? 's' : ''} open — still running, not shown in this layout
        </p>
      ) : null}

      <StatusLine panes={panes} hues={hues} focused={focused} server={server} onFocus={setFocused} />
    </div>
  );
}
