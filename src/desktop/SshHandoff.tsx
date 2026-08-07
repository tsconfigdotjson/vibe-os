import { useEffect, useState } from 'react';
import { windowApi, type AttachInfo } from '../data';
import { writeClipboard } from '../clipboard';

/**
 * What a window shows while its terminal belongs to a real terminal.
 *
 * The desktop is not mirroring the session here — it has let go of it entirely,
 * the same way it does for a browser pop-out, because tmux sizes a session to
 * its smallest client and a desktop tile would drag a full-screen terminal down
 * to its own width. So this is a placeholder with the one thing you need next:
 * the command that gets you there.
 *
 * Two spellings of the same thing, whichever suits this server first — the
 * order comes from `attachForms` on the far side, because which one is nicer
 * depends on whether the token gate is on, and that is not the browser's
 * business to know.
 */
export function SshHandoff({ windowId, onReclaim }: { windowId: string; onReclaim: () => void }) {
  const [info, setInfo] = useState<AttachInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

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

  const copy = async (label: string, text: string) => {
    if (await writeClipboard(text)) {
      setCopied(label);
      window.setTimeout(() => setCopied((c) => (c === label ? null : c)), 1600);
    }
  };

  return (
    <div className="popped handoff">
      <p className="popped-line">Handed to a terminal.</p>

      {error ? (
        <p className="handoff-error">{error}</p>
      ) : !info ? (
        <p className="popped-hint">resolving…</p>
      ) : (
        <>
          <p className="handoff-lead">Type either of these into a terminal:</p>
          {/* Selectable text with a button beside it, never a button alone: on
              plain HTTP the clipboard API does not exist and the fallback in
              clipboard.ts can still be refused, and a command you cannot copy
              is one you should at least be able to read. */}
          {info.forms.map((form) => (
            <div className="handoff-cmd" key={form.key}>
              <div className="handoff-hint">{form.hint}</div>
              <div className="handoff-row">
                <code className="handoff-code">{form.command}</code>
                <button
                  type="button"
                  className="ghost handoff-copy"
                  onClick={() => void copy(form.key, form.command)}
                >
                  {copied === form.key ? 'copied' : 'copy'}
                </button>
              </div>
            </div>
          ))}
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
