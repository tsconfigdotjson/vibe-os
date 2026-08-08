import { useEffect, useState } from 'react';
import { windowApi, type AttachInfo } from '../data';

/**
 * What a window shows while its terminal belongs to a real terminal.
 *
 * The desktop is not mirroring the session here — it has let go of it entirely,
 * the same way it does for a browser pop-out, because dtach sizes the pty to
 * whichever client arrived last and a desktop tile would drag a full-screen
 * terminal down to its own width. So this is a placeholder with the one thing
 * you need next: a way to get there.
 *
 * ── Why a link and then a command ────────────────────────────────────────────
 * `ssh://` opens the terminal your machine already associates with it, which is
 * the whole point — nothing to select, nothing to paste. What it cannot do is
 * say *which* window: the scheme carries a user, a host and a port and nothing
 * else. draft-ietf-secsh-scp-sftp-ssh-uri is explicit that a non-empty path
 * SHOULD be ignored, and handlers ignore it.
 *
 * So the far side has to already know, and it does. Pressing "SSH session"
 * records the handoff before anyone connects, so `vibe-os attach` with no
 * argument lands in this window — no name to remember, no line to copy. Two
 * short steps, neither of them clipboard work.
 *
 * The full command stays underneath as text. A scheme handler is a thing an OS
 * either has or does not: macOS ships one, and elsewhere it is a registration
 * somebody has to have done. When the link does nothing at all — and it fails
 * silently, which is the unhelpful part — the line below is the way through,
 * so it is selectable rather than hidden behind a button that may not work
 * either: on plain HTTP there is no clipboard API to press.
 */
export function SshHandoff({ windowId, onReclaim }: { windowId: string; onReclaim: () => void }) {
  const [info, setInfo] = useState<AttachInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    windowApi.attachInfo(windowId).then(
      (next) => !cancelled && setInfo(next),
      (err: unknown) => !cancelled && setError(err instanceof Error ? err.message : String(err)),
    );
    return () => {
      cancelled = true;
    };
  }, [windowId]);

  const ssh = info?.forms.find((f) => f.key === 'command');

  return (
    <div className="popped handoff">
      <p className="popped-line">Handed to a terminal.</p>

      {error ? (
        <p className="handoff-error">{error}</p>
      ) : !info ? (
        <p className="popped-hint">resolving…</p>
      ) : (
        <>
          <a className="btn handoff-open" href={info.sshUrl}>
            Open a terminal
          </a>
          <p className="handoff-lead">
            then type <code className="handoff-inline">vibe-os attach</code> — it knows which window
          </p>

          {ssh ? (
            <details className="handoff-fallback">
              <summary>Nothing happened?</summary>
              <p className="handoff-hint">
                Your machine has no handler for <code className="handoff-inline">ssh://</code> links. This does the
                whole thing in one:
              </p>
              <code className="handoff-code">{ssh.command}</code>
            </details>
          ) : null}
        </>
      )}

      <button type="button" className="ghost" onClick={onReclaim}>
        Bring it back
      </button>
      <p className="popped-hint">
        {/* The wording matters: people hesitate to press a button that might kill
            what they left running. It detaches the terminal, nothing more. */}
        That detaches the terminal. The session keeps running either way.
      </p>
    </div>
  );
}
