import { useCallback, useState } from 'react';
import { writeClipboard } from '../clipboard';

export interface PromptBandProps {
  profileName: string;
  prompt: string;
  /** Writes the text into the live SSH session. Absent until the term is up. */
  onSend: ((text: string) => void) | null;
  onDismiss: () => void;
}

/**
 * The standing prompt for a profile, offered above its terminal.
 *
 * Send is the path that always works: it writes into the SSH channel directly,
 * so it needs no clipboard and no secure context. xterm wraps it in bracketed
 * paste markers, which is what keeps a multi-line prompt from submitting itself
 * on the first newline — it lands in the composer as one block, unsent, for you
 * to read before you commit to it.
 */
export function PromptBand({ profileName, prompt, onSend, onDismiss }: PromptBandProps) {
  const [copied, setCopied] = useState<'ok' | 'failed' | null>(null);
  const [overflowing, setOverflowing] = useState(false);

  // Measured rather than assumed: the fade marking "there is more below" has to
  // be absent when the whole prompt fits, or every short prompt looks truncated.
  const measure = useCallback((node: HTMLDivElement | null) => {
    if (node) setOverflowing(node.scrollHeight > node.clientHeight + 1);
  }, []);

  const copy = async () => {
    const ok = await writeClipboard(prompt);
    setCopied(ok ? 'ok' : 'failed');
    // A failed copy leaves the band open — dismissing it would throw away the
    // only copy of the text on the strength of a button that did nothing.
    if (ok) window.setTimeout(onDismiss, 450);
  };

  return (
    <div className="band">
      <div className="band-head">
        <span className="band-label">{profileName} prompt</span>
        <button type="button" className="band-x" onClick={onDismiss} title="Dismiss — you can reopen it from the rail">
          ✕
        </button>
      </div>

      <div className="band-text" ref={measure} data-more={overflowing || undefined}>
        {prompt}
      </div>

      <div className="band-actions">
        {copied === 'failed' ? (
          <span className="band-note">
            The browser blocked the clipboard — this page is not a secure origin. Send still works.
          </span>
        ) : copied === 'ok' ? (
          <span className="band-note band-ok">Copied</span>
        ) : null}

        <button type="button" className="btn btn-quiet" onClick={() => void copy()}>
          Copy
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!onSend}
          title={onSend ? 'Type it into the terminal, unsent' : 'Waiting for the session'}
          onClick={() => {
            onSend?.(prompt);
            onDismiss();
          }}
        >
          Send ▸
        </button>
      </div>
    </div>
  );
}
