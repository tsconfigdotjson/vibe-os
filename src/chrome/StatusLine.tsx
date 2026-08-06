import { useEffect, useState } from 'react';
import type { ServerConfig } from '../api';
import type { Pane } from '../panes/usePanes';

const SPINNER = ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷'];

function useTick(ms: number): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), ms);
    return () => window.clearInterval(id);
  }, [ms]);
  return tick;
}

function uptime(since: number | undefined, now: number): string {
  if (!since) return '—';
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, '0')}m`;
}

export interface StatusLineProps {
  panes: Pane[];
  hues: Record<string, string>;
  focused: string;
  server: ServerConfig;
  onFocus: (id: string) => void;
}

/**
 * The status line, modelled on tmux's.
 *
 * Everything on it is real state read from the running system rather than
 * decoration: which panes exist and which one has focus, how long the focused
 * pane's session has been up, the host key actually being trusted, and whether
 * the front door is locked.
 */
export function StatusLine({ panes, hues, focused, server, onFocus }: StatusLineProps) {
  const tick = useTick(1000);
  const now = Date.now();
  const active = panes.find((pane) => pane.id === focused);
  const connecting = panes.some((pane) => pane.status === 'loading');

  return (
    <footer className="statusline">
      <div className="sl-panes">
        {panes.map((pane) => (
          <button
            key={pane.id}
            type="button"
            className="sl-pane"
            data-active={pane.id === focused || undefined}
            data-status={pane.status}
            style={{ ['--pane-color' as string]: hues[pane.id] }}
            onClick={() => onFocus(pane.id)}
          >
            {pane.id}:{server.tmux ? `vibe-${pane.id}` : 'shell'}
            {pane.id === focused ? '*' : ''}
          </button>
        ))}
        {connecting ? <span className="sl-spinner">{SPINNER[tick % SPINNER.length]}</span> : null}
      </div>

      <div className="sl-facts">
        <span className="sl-fact">
          {server.user}@{server.hostname}
        </span>
        <span className="sl-sep" aria-hidden="true">
          ·
        </span>
        <span className="sl-fact" title={server.hostKey ?? 'host key not pinned'}>
          {server.hostKeyFingerprint ?? 'host key: prompt'}
        </span>
        <span className="sl-sep" aria-hidden="true">
          ·
        </span>
        <span className="sl-fact">up {uptime(active?.readyAt, now)}</span>
        <span className="sl-sep" aria-hidden="true">
          ·
        </span>
        <span className="sl-fact" data-warn={!server.authRequired || undefined}>
          {server.authRequired ? 'token' : 'open'}
        </span>
      </div>
    </footer>
  );
}
