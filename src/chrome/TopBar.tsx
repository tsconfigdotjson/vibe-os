import type { LayoutMode } from '../panes/usePanes';
import type { ServerConfig } from '../api';

const LAYOUTS: { mode: LayoutMode; glyph: string; label: string; hint: string }[] = [
  { mode: 'columns', glyph: '▌▐', label: 'side by side', hint: 'Split side by side  (alt \\)' },
  { mode: 'rows', glyph: '▀▄', label: 'stacked', hint: 'Stack vertically  (alt -)' },
  { mode: 'focus', glyph: '█', label: 'one pane', hint: 'Show only the focused pane  (alt z)' },
];

export interface TopBarProps {
  server: ServerConfig;
  layout: LayoutMode;
  paneCount: number;
  onLayout: (mode: LayoutMode) => void;
  onAddPane: () => void;
}

export function TopBar({ server, layout, paneCount, onLayout, onAddPane }: TopBarProps) {
  return (
    <header className="topbar">
      <div className="wordmark">
        vibe-os<span className="caret" aria-hidden="true" />
      </div>

      <div className="topbar-meta">
        <span className="meta-item">{server.workspace}</span>
        <span className="meta-item meta-dim">{server.tmux ? 'tmux' : 'no tmux'}</span>
        <span className="meta-item meta-dim">v{server.version}</span>
      </div>

      <div className="topbar-actions">
        <div className="segmented" role="group" aria-label="Pane layout">
          {LAYOUTS.map(({ mode, glyph, hint, label }) => (
            <button
              key={mode}
              type="button"
              data-active={layout === mode || undefined}
              onClick={() => onLayout(mode)}
              title={hint}
              aria-label={label}
              aria-pressed={layout === mode}
            >
              <span aria-hidden="true">{glyph}</span>
            </button>
          ))}
        </div>
        <button type="button" className="action" onClick={onAddPane} title="Open another pane  (alt t)">
          + pane
          <span className="action-count">{paneCount}</span>
        </button>
      </div>
    </header>
  );
}
