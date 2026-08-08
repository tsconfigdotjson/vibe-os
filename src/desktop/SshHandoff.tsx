import { useEffect, useRef, useState } from "react";
import { writeClipboard } from "../clipboard";

/** How long the copy button stays in its "done" state. */
const COPY_FEEDBACK_MS = 1_600;

import { type AttachInfo, describeError, windowApi } from "../data";

/**
 * What a window shows while its terminal belongs to a real terminal.
 *
 * The desktop is not mirroring the session here — it has let go of it entirely,
 * the same way it does for a browser pop-out, because dtach sizes the pty to
 * whichever client arrived last and a desktop tile would drag a full-screen
 * terminal down to its own width. So this is a placeholder with the one thing
 * you need next: the command that gets you there.
 *
 * One command, not a choice of two. The other spelling was a URL that fetched a
 * script over curl, which had to carry the server's token in the query string
 * to get past the gate — putting it in shell history and on screen — and the
 * whole appeal of a short URL went with it. An ssh line names the window,
 * carries nothing secret, and is the thing you would have typed anyway.
 */
export function SshHandoff({
  windowId,
  onReclaim,
}: {
  windowId: string;
  onReclaim: () => void;
}) {
  const [info, setInfo] = useState<AttachInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<"ok" | "failed" | null>(null);

  // Cleared on unmount: clicking copy and then "Bring it back" inside the
  // window used to set state on a component that was already gone.
  const copyTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(copyTimer.current), []);

  useEffect(() => {
    let cancelled = false;
    windowApi.attachInfo(windowId).then(
      (next) => !cancelled && setInfo(next),
      (err: unknown) => !cancelled && setError(describeError(err)),
    );
    return () => {
      cancelled = true;
    };
  }, [windowId]);

  const copy = async (text: string) => {
    const ok = await writeClipboard(text);
    // The panel's own comment anticipates plain-HTTP-to-an-IP, which is where
    // this fails — and the button used to just do nothing there, silently.
    setCopied(ok ? "ok" : "failed");
    window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(
      () => setCopied(null),
      COPY_FEEDBACK_MS,
    );
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
          {/* Nothing introduces this. The heading above already says where the
              window went, and a line telling you to type a command into a
              terminal, directly under a line saying it went to a terminal, was
              the same sentence twice.

              Selectable text with a button beside it, never a button alone: on
              plain HTTP the clipboard API does not exist and the fallback in
              clipboard.ts can still be refused, and a command you cannot copy
              is one you should at least be able to read. */}
          <div className="handoff-row">
            <code className="handoff-code">{info.command}</code>
            <button
              type="button"
              className="ghost handoff-copy"
              data-copied={copied ?? undefined}
              onClick={() => void copy(info.command)}
            >
              {copied === "ok"
                ? "copied"
                : copied === "failed"
                  ? "copy failed"
                  : "copy"}
            </button>
          </div>
          {copied === "failed" ? (
            <p className="popped-hint">
              The browser refused the clipboard — this page is not a secure
              origin. Select the command above and copy it by hand.
            </p>
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
