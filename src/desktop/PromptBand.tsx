import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { writeClipboard } from "../clipboard";

/** Long enough to see the button confirm before the band folds away. */
const DISMISS_DELAY_MS = 450;

import { fillPrompt, parsePrompt } from "../../shared/blanks";

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
export function PromptBand({
  profileName,
  prompt,
  onSend,
  onDismiss,
}: PromptBandProps) {
  const [copied, setCopied] = useState<"ok" | "failed" | null>(null);
  const [overflowing, setOverflowing] = useState(false);

  // Blanks are keyed by position, not label: two `{{file}}` in one prompt are
  // almost always two different files, and one field driving both would be a
  // worse surprise than typing it twice.
  const [values, setValues] = useState<Record<number, string>>({});
  const [nagging, setNagging] = useState(false);
  const firstEmpty = useRef<HTMLInputElement | null>(null);

  const segments = useMemo(() => parsePrompt(prompt), [prompt]);
  // From the segments already parsed, rather than a second pass of the same
  // regex over the same string.
  const total = useMemo(
    () => segments.filter((s) => s.type === "blank").length,
    [segments],
  );
  const resolved = useMemo(() => fillPrompt(prompt, values), [prompt, values]);
  /**
   * How many blanks are still empty, and which one comes first — one walk
   * rather than two identical `Array.from(...)` constructions with the same
   * predicate and the same dependencies.
   */
  const { unfilled, unfilledFirst } = useMemo(() => {
    let count = 0;
    let first: number | undefined;
    for (let i = 0; i < total; i += 1) {
      if (values[i]?.trim()) continue;
      count += 1;
      first ??= i;
    }
    return { unfilled: count, unfilledFirst: first };
  }, [total, values]);

  /**
   * Refuses once, then obeys.
   *
   * Handing over a prompt with holes in it wastes a turn, so the first press
   * points at the empty field instead. Pressing again goes anyway — the blanks
   * fall back to their own labels, and someone who insists probably has a
   * reason the editor does not know about.
   */
  const guard = (): boolean => {
    if (unfilled === 0 || nagging) return true;
    setNagging(true);
    firstEmpty.current?.focus();
    return false;
  };

  // Measured rather than assumed: the fade marking "there is more below" has to
  // be absent when the whole prompt fits, or every short prompt looks truncated.
  const measure = useCallback((node: HTMLDivElement | null) => {
    if (node) setOverflowing(node.scrollHeight > node.clientHeight + 1);
  }, []);

  // onDismiss reaches the server (applyRow -> PATCH), so firing it after the
  // window has closed patches a row that is gone and forces a revalidation.
  const dismissTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(dismissTimer.current), []);

  const copy = async () => {
    if (!guard()) return;
    const ok = await writeClipboard(resolved);
    setCopied(ok ? "ok" : "failed");
    // A failed copy leaves the band open — dismissing it would throw away the
    // only copy of the text on the strength of a button that did nothing.
    if (ok) {
      window.clearTimeout(dismissTimer.current);
      dismissTimer.current = window.setTimeout(onDismiss, DISMISS_DELAY_MS);
    }
  };

  return (
    <div className="band">
      <div className="band-head">
        <span className="band-label">{profileName} prompt</span>
        <button
          type="button"
          className="band-x"
          onClick={onDismiss}
          title="Dismiss — you can reopen it from the rail"
        >
          ✕
        </button>
      </div>

      <div
        className="band-text"
        ref={measure}
        data-more={overflowing || undefined}
      >
        {segments.map((segment) =>
          segment.type === "text" ? (
            <span key={segment.key}>{segment.value}</span>
          ) : (
            <input
              key={segment.key}
              className="blank"
              // Sized to its own content so the sentence closes up around a
              // short answer instead of leaving a gap the width of the label.
              size={
                Math.max(
                  segment.value.length,
                  (values[segment.index] ?? "").length,
                  4,
                ) + 1
              }
              value={values[segment.index] ?? ""}
              placeholder={segment.value}
              aria-label={segment.value}
              data-empty={!values[segment.index]?.trim() || undefined}
              ref={(node) => {
                if (
                  node &&
                  !values[segment.index]?.trim() &&
                  unfilledFirst === segment.index
                ) {
                  firstEmpty.current = node;
                }
              }}
              onChange={(event) =>
                setValues((v) => ({
                  ...v,
                  [segment.index]: event.target.value,
                }))
              }
            />
          ),
        )}
      </div>

      <div className="band-actions">
        {nagging && unfilled > 0 ? (
          <span className="band-note">
            {unfilled} blank{unfilled === 1 ? "" : "s"} still empty. Fill{" "}
            {unfilled === 1 ? "it" : "them"} in, or press again to go anyway.
          </span>
        ) : copied === "failed" ? (
          <span className="band-note">
            The browser blocked the clipboard — this page is not a secure
            origin. Send still works.
          </span>
        ) : copied === "ok" ? (
          <span className="band-note band-ok">Copied</span>
        ) : null}

        <button
          type="button"
          className="btn btn-quiet"
          onClick={() => void copy()}
        >
          Copy
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!onSend}
          title={
            onSend
              ? "Type it into the terminal, unsent"
              : "Waiting for the session"
          }
          onClick={() => {
            if (!guard()) return;
            onSend?.(resolved);
            onDismiss();
          }}
        >
          Send ▸
        </button>
      </div>
    </div>
  );
}
