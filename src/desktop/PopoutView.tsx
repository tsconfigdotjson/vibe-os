import { useEffect, useMemo, useState } from "react";
import { windowSshConfig } from "../api";
import { useServerConfig } from "../data";
import type { SshStatus } from "../sshterm";
import { SshTerminal } from "../sshterm";
import { Boot, BootError } from "./Boot";
import { type PopoutTarget, usePopoutGuest } from "./usePopouts";
import { STATUS_LABEL } from "./useWindows";

/**
 * One terminal, filling its own browser window.
 *
 * This is the same session as the desktop window it came from, not a copy of
 * it. Both address the same window id, which the server turns into the same
 * session — so popping out is really just detaching one client and
 * attaching another, and everything that was running carries on.
 *
 * The desktop hides its own terminal while this is open. Two clients on one
 * session do mirror each other, but dtach sizes the pty to whichever client
 * most recently arrived, so the pair would drag each other between sizes.
 * One client at a time means this window gets the size it actually has.
 */
export function PopoutView({ target }: { target: PopoutTarget }) {
  const { server, error } = useServerConfig();
  const [status, setStatus] = useState<SshStatus>("loading");
  const [reclaimed, setReclaimed] = useState(false);

  usePopoutGuest(target.id, () => setReclaimed(true));

  useEffect(() => {
    document.title = `${target.name} — vibe-os`;
  }, [target.name]);

  const config = useMemo(
    () => (server ? windowSshConfig(server, target.id) : null),
    [server, target.id],
  );

  if (error) {
    return <BootError message={error} />;
  }

  if (!config) {
    return <Boot title={target.name} detail="attaching…" />;
  }

  return (
    <div
      className="popout"
      style={{ ["--win-color" as string]: `var(--profile-${target.color})` }}
    >
      <header className="popout-bar">
        <span className="win-dot" aria-hidden="true" />
        <span className="popout-name">{target.name}</span>
        {/* Once reclaimed the terminal is unmounted, so `status` freezes at
            whatever it last was — which read as "live" above a panel saying the
            desktop had taken the terminal back. */}
        <span className="win-state">
          {reclaimed ? "reclaimed" : STATUS_LABEL[status]}
        </span>
      </header>
      <div className="popout-body">
        {/* Unmounted the moment the desktop reclaims, so this page stops being
            a second client even when the browser will not close it. */}
        {reclaimed ? (
          // No "reattach" button here on purpose: the desktop is showing this
          // terminal again, and a second client would only shrink the session
          // to fit both. Popping out again is a decision the desktop makes.
          <div className="popped">
            <p className="popped-line">The desktop took this terminal back.</p>
            <p className="popped-hint">
              You can close this window. Nothing was lost.
            </p>
          </div>
        ) : (
          <SshTerminal
            config={config}
            className="win-term"
            onStatusChange={(next) => setStatus(next)}
          />
        )}
      </div>
    </div>
  );
}
