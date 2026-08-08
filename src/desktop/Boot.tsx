export interface BootProps {
  /** The name to show while waiting — the product, or the window being attached. */
  title: string;
  /** What is happening, in lower case. */
  detail: string;
}

/**
 * The screen shown before there is anything to draw.
 *
 * Both page roots — the desktop and a pop-out — render this same markup with
 * the same class names, differing only in the two strings.
 */
export function Boot({ title, detail }: BootProps) {
  return (
    <div className="boot">
      <p className="boot-line">
        {title}
        <span className="caret" aria-hidden="true" />
      </p>
      <p className="boot-detail">{detail}</p>
    </div>
  );
}

export interface BootErrorProps {
  message: string;
  /** Offered where reloading can actually help — the desktop, not a pop-out. */
  onRetry?: () => void;
}

/** The same screen when the server could not be reached at all. */
export function BootError({ message, onRetry }: BootErrorProps) {
  return (
    <div className="boot boot-error">
      <p className="boot-line">could not reach the vibe-os server</p>
      <p className="boot-detail">{message}</p>
      {onRetry ? (
        <button type="button" className="ghost" onClick={onRetry}>
          retry
        </button>
      ) : null}
    </div>
  );
}
