/**
 * Posts one message on a channel opened just for it.
 *
 * A throwaway channel rather than a long-lived one, because a ref to a
 * listening channel is null between an effect's cleanup and its next run — so
 * a message sent in that gap is silently dropped, and the gap is exactly when
 * React StrictMode and every re-render put you. Opening one, posting, and
 * closing it costs nothing and cannot miss.
 *
 * Two modules had this same function with the same paragraph of justification
 * on each, one of them citing the other.
 */
export function postOnce(channel: string, message: unknown): void {
  if (typeof BroadcastChannel === "undefined") return;
  const bc = new BroadcastChannel(channel);
  bc.postMessage(message);
  bc.close();
}
