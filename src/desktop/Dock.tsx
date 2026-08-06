import type { WindowState } from './useWindows';

export interface DockProps {
  windows: WindowState[];
  hues: Record<string, string>;
  focused: string | null;
  tmux: boolean;
  onSpawn: () => void;
  onSelect: (id: string) => void;
  onWallpaper: () => void;
}

/**
 * The dock is the only way to open a window, and the only place every running
 * session is listed — including minimised ones, which have no other
 * representation on screen.
 */
export function Dock({ windows, hues, focused, tmux, onSpawn, onSelect, onWallpaper }: DockProps) {
  return (
    <div className="dock-wrap">
      <nav className="dock glass" aria-label="Windows">
        <button type="button" className="dock-spawn" onClick={onSpawn} title="Open a terminal  (alt t)">
          <span className="dock-plus" aria-hidden="true">
            +
          </span>
          terminal
        </button>

        {windows.length > 0 ? <span className="dock-rule" aria-hidden="true" /> : null}

        <ul className="dock-list">
          {windows.map((win) => (
            <li key={win.id}>
              <button
                type="button"
                className="dock-item"
                data-active={win.id === focused && !win.minimized ? '' : undefined}
                data-minimized={win.minimized || undefined}
                data-status={win.status}
                style={{ ['--win-color' as string]: hues[win.id] }}
                onClick={() => onSelect(win.id)}
                title={win.minimized ? 'Restore this window' : 'Bring this window to the front'}
              >
                <span className="dock-chip" aria-hidden="true">
                  {win.id}
                </span>
                <span className="dock-label">{tmux ? `vibe-${win.id}` : `shell ${win.id}`}</span>
              </button>
            </li>
          ))}
        </ul>

        <span className="dock-rule" aria-hidden="true" />

        <button type="button" className="dock-icon" onClick={onWallpaper} title="Change the wallpaper">
          ◑
        </button>
      </nav>
    </div>
  );
}
