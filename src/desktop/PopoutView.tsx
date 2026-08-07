import { useEffect, useMemo, useState } from 'react';
import { fetchServerConfig, windowSshConfig, type ServerConfig } from '../api';
import { SshTerminal } from '../sshterm';
import type { SshStatus } from '../sshterm';
import { usePopoutGuest, type PopoutTarget } from './usePopouts';

const STATUS_LABEL: Record<SshStatus, string> = {
  loading: 'connecting',
  ready: 'live',
  ended: 'closed',
  error: 'error',
};

/**
 * One terminal, filling its own browser window.
 *
 * This is the same session as the desktop window it came from, not a copy of
 * it. Both address the same window id, which the server turns into the same
 * tmux session — so popping out is really just detaching one client and
 * attaching another, and everything that was running carries on.
 *
 * The desktop hides its own terminal while this is open. Two clients on one
 * tmux session do mirror each other, but tmux sizes a session to its smallest
 * client, so the pair would drag each other into whichever window is narrower.
 * One client at a time means this window gets the size it actually has.
 */
export function PopoutView({ target }: { target: PopoutTarget }) {
  const [server, setServer] = useState<ServerConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<SshStatus>('loading');
  const [reclaimed, setReclaimed] = useState(false);

  usePopoutGuest(target.id, () => setReclaimed(true));

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

  useEffect(() => {
    document.title = `${target.name} — vibe-os`;
  }, [target.name]);

  const config = useMemo(() => (server ? windowSshConfig(server, target.id) : null), [server, target.id]);

  if (error) {
    return (
      <div className="boot boot-error">
        <p className="boot-line">could not reach the vibe-os server</p>
        <p className="boot-detail">{error}</p>
      </div>
    );
  }

  if (!config) {
    return (
      <div className="boot">
        <p className="boot-line">
          {target.name}
          <span className="caret" aria-hidden="true" />
        </p>
        <p className="boot-detail">attaching…</p>
      </div>
    );
  }

  return (
    <div className="popout" style={{ ['--win-color' as string]: `var(--profile-${target.color})` }}>
      <header className="popout-bar">
        <span className="win-dot" aria-hidden="true" />
        <span className="popout-name">{target.name}</span>
        <span className="win-state">{STATUS_LABEL[status]}</span>
      </header>
      <div className="popout-body">
        {/* Unmounted the moment the desktop reclaims, so this page stops being
            a second tmux client even when the browser will not close it. */}
        {reclaimed ? (
          // No "reattach" button here on purpose: the desktop is showing this
          // terminal again, and a second client would only shrink the session
          // to fit both. Popping out again is a decision the desktop makes.
          <div className="popped">
            <p className="popped-line">The desktop took this terminal back.</p>
            <p className="popped-hint">You can close this window. Nothing was lost.</p>
          </div>
        ) : (
          <SshTerminal config={config} className="win-term" onStatusChange={(next) => setStatus(next)} />
        )}
      </div>
    </div>
  );
}
