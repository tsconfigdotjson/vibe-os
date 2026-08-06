import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchServerConfig, type ServerConfig } from './api';
import { useWindows, type Rect } from './desktop/useWindows';
import { TermWindow } from './desktop/TermWindow';
import { Dock } from './desktop/Dock';
import { GridOverlay } from './desktop/GridOverlay';
import { WallpaperPanel } from './desktop/WallpaperPanel';
import { useWallpaper } from './desktop/useWallpaper';
import type { Viewport } from './desktop/geometry';

/**
 * Window identity colours, drawn from the ANSI palette the terminals themselves
 * use. Assignment is by position, and the same colour marks a window in its
 * title bar, its focus ring and its dock entry — which is what makes several
 * windows distinguishable at a glance without reading anything.
 */
const HUES = ['#56cfe1', '#a78bfa', '#7ee081', '#f2c14e', '#ef6b73', '#63d4c0'];

/**
 * Measures the window surface.
 *
 * This has to be a callback ref, not an effect over a ref object. The desktop
 * renders a boot screen until the server config arrives, so on mount there is
 * no `.surface` to observe — and an effect keyed on the ref object never runs
 * again when one finally appears, leaving the viewport pinned to whatever the
 * initial value was. Windows would then be clamped into a phantom rectangle the
 * size of that default, which looks like the desktop only occupying a corner of
 * the screen.
 *
 * A callback ref fires exactly when the node attaches and detaches, and taking
 * a synchronous measurement there means the first painted frame already has
 * real numbers.
 */
function useViewport(): [(node: HTMLElement | null) => void, Viewport] {
  const [view, setView] = useState<Viewport>({ width: 0, height: 0 });
  const observer = useRef<ResizeObserver | null>(null);

  const attach = useCallback((node: HTMLElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!node) return;

    const measure = (width: number, height: number) => {
      if (width > 0 && height > 0) {
        setView((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
      }
    };

    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      measure(width, height);
    });
    ro.observe(node);
    observer.current = ro;

    const rect = node.getBoundingClientRect();
    measure(rect.width, rect.height);
  }, []);

  return [attach, view];
}

export default function App() {
  const [server, setServer] = useState<ServerConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Rect | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);

  const [attachSurface, view] = useViewport();

  const {
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
    setTitle,
  } = useWindows();

  const wallpaper = useWallpaper();

  useEffect(() => {
    let cancelled = false;
    fetchServerConfig().then(
      (config) => !cancelled && setServer(config),
      (err: unknown) => !cancelled && setError(err instanceof Error ? err.message : String(err)),
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const hues = useMemo(() => {
    const map: Record<string, string> = {};
    windows.forEach((win, index) => {
      map[win.id] = HUES[index % HUES.length];
    });
    return map;
  }, [windows]);

  // Alt chords rather than tmux's ctrl-b: the terminal has focus almost all the
  // time and ctrl-b belongs to the tmux session running inside it. Capture
  // phase, because xterm claims keys on its own textarea first.
  const onKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (!event.altKey || event.ctrlKey || event.metaKey) return;
      const digit = Number(event.key);
      if (Number.isInteger(digit) && digit >= 1 && digit <= 9) {
        const win = windows[digit - 1];
        if (win) {
          raise(win.id);
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      }
      const actions: Record<string, () => void> = {
        t: spawn,
        w: () => focused && close(focused),
        z: () => focused && maximize(focused),
        m: () => focused && minimize(focused),
      };
      const action = actions[event.key.toLowerCase()];
      if (action) {
        action();
        event.preventDefault();
        event.stopPropagation();
      }
    },
    [windows, focused, spawn, close, maximize, minimize, raise],
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
        <button type="button" className="ghost" onClick={() => window.location.reload()}>
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

  const wallpaperUrl = wallpaper.prefs.wallpaper ? `/api/wallpapers/${wallpaper.prefs.wallpaper}` : null;
  // Cell size divides by this; rendering a window before the first measurement
  // would place it with NaN geometry.
  const measured = view.width > 0 && view.height > 0;

  return (
    <div className="desktop">
      <div
        className="wallpaper"
        style={
          wallpaperUrl
            ? {
                backgroundImage: `url(${wallpaperUrl})`,
                backgroundSize: wallpaper.prefs.fit === 'tile' ? 'auto' : wallpaper.prefs.fit,
                backgroundRepeat: wallpaper.prefs.fit === 'tile' ? 'repeat' : 'no-repeat',
              }
            : undefined
        }
      />
      <div className="wallpaper-dim" style={{ opacity: wallpaperUrl ? wallpaper.prefs.dim : 0 }} />

      <header className="menubar glass">
        <span className="wordmark">
          vibe-os<span className="caret" aria-hidden="true" />
        </span>
        <span className="menu-facts">
          <span>
            {server.user}@{server.hostname}
          </span>
          <span className="sep">·</span>
          <span title={server.hostKey ?? 'host key not pinned'}>
            {server.hostKeyFingerprint ?? 'host key: prompt'}
          </span>
          <span className="sep">·</span>
          <span>{server.tmux ? 'tmux' : 'no tmux'}</span>
          <span className="sep">·</span>
          <span data-warn={!server.authRequired || undefined}>{server.authRequired ? 'token' : 'open'}</span>
        </span>
        <span className="menu-right">v{server.version}</span>
      </header>

      <main className="surface" ref={attachSurface}>
        {measured ? <GridOverlay preview={preview} view={view} /> : null}

        {measured ? ordered.map((win) => (
          <TermWindow
            key={win.id}
            win={win}
            server={server}
            hue={hues[win.id]}
            focused={win.id === focused}
            view={view}
            onRaise={raise}
            onCommit={move}
            onPreview={setPreview}
            onClose={close}
            onRestart={restart}
            onMinimize={minimize}
            onMaximize={maximize}
            onStatus={setStatus}
            onTitle={setTitle}
          />
        )) : null}

        {measured && windows.length === 0 ? (
          <div className="empty">
            <p className="empty-line">No windows open.</p>
            <button type="button" className="ghost" onClick={spawn}>
              Open a terminal
            </button>
            <p className="empty-hint">
              or press <kbd>alt</kbd> <kbd>t</kbd>
            </p>
          </div>
        ) : null}
      </main>

      <Dock
        windows={windows}
        hues={hues}
        focused={focused}
        tmux={server.tmux}
        onSpawn={spawn}
        onSelect={raise}
        onWallpaper={() => setPanelOpen(true)}
      />

      {panelOpen ? (
        <WallpaperPanel
          list={wallpaper.list}
          prefs={wallpaper.prefs}
          busy={wallpaper.busy}
          error={wallpaper.error}
          maxBytes={server.maxWallpaperBytes}
          onSave={wallpaper.save}
          onUpload={wallpaper.upload}
          onRemove={wallpaper.remove}
          onClose={() => setPanelOpen(false)}
        />
      ) : null}
    </div>
  );
}
