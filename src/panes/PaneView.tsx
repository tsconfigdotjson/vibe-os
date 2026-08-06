import { memo, useMemo } from 'react';
import { SshTerminal } from '../sshterm';
import type { ServerConfig } from '../api';
import { paneSshConfig } from '../api';
import type { Pane } from './usePanes';

const STATUS_LABEL: Record<Pane['status'], string> = {
  loading: 'connecting',
  ready: 'live',
  ended: 'closed',
  error: 'error',
};

export interface PaneViewProps {
  pane: Pane;
  server: ServerConfig;
  hue: string;
  focused: boolean;
  closable: boolean;
  onFocus: (id: string) => void;
  onStatus: (id: string, status: Pane['status'], detail?: string) => void;
  onTitle: (id: string, title: string) => void;
  onRestart: (id: string) => void;
  onClose: (id: string) => void;
}

export const PaneView = memo(function PaneView({
  pane,
  server,
  hue,
  focused,
  closable,
  onFocus,
  onStatus,
  onTitle,
  onRestart,
  onClose,
}: PaneViewProps) {
  // Rebuilt only when the pane identity changes; SshTerminal reads it once.
  const config = useMemo(() => paneSshConfig(server, pane.id, server.tmux ? 'tmux' : 'shell'), [server, pane.id]);

  const sessionName = server.tmux ? `vibe-${pane.id}` : 'login shell';

  return (
    <section
      className="pane"
      data-focused={focused || undefined}
      data-status={pane.status}
      style={{ ['--pane-color' as string]: hue }}
      onPointerDown={() => onFocus(pane.id)}
    >
      <header className="pane-head">
        <span className="pane-index">{pane.id}</span>
        <span className="pane-session">{sessionName}</span>
        <span className="pane-title" title={pane.title}>
          {pane.title ?? ''}
        </span>
        <span className="pane-status">
          <i className="dot" aria-hidden="true" />
          {STATUS_LABEL[pane.status]}
          {pane.detail ? <em className="pane-detail"> {pane.detail}</em> : null}
        </span>
        <span className="pane-actions">
          <button type="button" onClick={() => onRestart(pane.id)} title="Restart this pane's connection">
            restart
          </button>
          {closable ? (
            <button type="button" onClick={() => onClose(pane.id)} title="Close pane (the tmux session keeps running)">
              close
            </button>
          ) : null}
        </span>
      </header>

      <div className="pane-body">
        <SshTerminal
          key={`${pane.id}:${pane.generation}`}
          config={config}
          className="pane-term"
          onFocus={() => onFocus(pane.id)}
          onStatusChange={(status, detail) => onStatus(pane.id, status, detail)}
          onTitleChange={(title) => onTitle(pane.id, title)}
        />
      </div>
    </section>
  );
});
