import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Which windows are currently open in a pop-out browser window.
 *
 * The two documents are separate JavaScript contexts that share nothing but an
 * origin, so they gossip over a BroadcastChannel rather than through any shared
 * object. The desktop cannot simply remember what it opened, either: reload it
 * while a pop-out is live and it would forget, remount the terminal, and end up
 * with two clients fighting over one session. So the desktop asks, and every
 * live pop-out answers.
 */
const CHANNEL = 'vibe-os:popouts:v1';

type Message =
  | { type: 'open'; id: string }
  | { type: 'close'; id: string }
  | { type: 'who' }
  | { type: 'claim'; id: string }
  | { type: 'reclaim'; id: string };

/**
 * Sends one message on a channel of its own.
 *
 * Deliberately not the listening channel held in a ref: that ref is null
 * between an effect's cleanup and its next run, and React runs exactly that
 * sequence on every StrictMode mount — so a click landing in the gap posted
 * nothing at all, silently. A BroadcastChannel is cheap enough that owning one
 * per message is a fair price for the send never depending on lifecycle timing.
 */
function announce(message: Message): void {
  if (typeof BroadcastChannel === 'undefined') return;
  const bc = new BroadcastChannel(CHANNEL);
  bc.postMessage(message);
  bc.close();
}

/** Opened by the desktop: tracks pop-outs and can ask them to close. */
export function usePopoutHost() {
  const [popped, setPopped] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const bc = new BroadcastChannel(CHANNEL);

    bc.onmessage = (event: MessageEvent<Message>) => {
      const msg = event.data;
      if (msg.type === 'open' || msg.type === 'claim') {
        setPopped((current) => (current.has(msg.id) ? current : new Set(current).add(msg.id)));
      } else if (msg.type === 'close') {
        setPopped((current) => {
          if (!current.has(msg.id)) return current;
          const next = new Set(current);
          next.delete(msg.id);
          return next;
        });
      }
    };

    // Re-discover after a desktop reload; live pop-outs answer with `claim`.
    bc.postMessage({ type: 'who' } satisfies Message);

    return () => bc.close();
  }, []);

  const open = useCallback((id: string, label: string, color: string) => {
    const url = new URL(window.location.href);
    url.hash = '';
    url.search = `?popout=${encodeURIComponent(id)}&name=${encodeURIComponent(label)}&color=${encodeURIComponent(color)}`;
    const child = window.open(url.toString(), `vibe-os-${id}`, 'width=900,height=600,menubar=no,toolbar=no');
    if (!child) return false;
    // Marked here as well as on the pop-out's own announcement: a blocked or
    // slow child would otherwise leave the desktop rendering a terminal that is
    // about to have a second client attached to its session.
    setPopped((current) => new Set(current).add(id));
    child.focus();
    return true;
  }, []);

  /**
   * Asks a pop-out to close, and takes the terminal back regardless.
   *
   * Sent over the channel rather than held as a window reference, because a
   * desktop reload loses every reference but not the pop-outs themselves. The
   * local state is cleared either way, so a pop-out that has already been
   * closed by hand — and can no longer answer — still frees its window here.
   */
  const reclaim = useCallback((id: string) => {
    announce({ type: 'reclaim', id });
    setPopped((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  }, []);

  return { popped, open, reclaim };
}

/**
 * Opened in the pop-out itself: announces its existence for as long as it lives.
 *
 * `onReclaimed` runs when the desktop asks for the terminal back. Closing the
 * window is the intended outcome, but `window.close()` is not guaranteed — a
 * page the browser did not open by script refuses to close itself, which is
 * what happens if someone opens the pop-out URL by hand. The callback is how
 * this page then lets go of its SSH connection anyway, because a pop-out that
 * silently stayed attached would leave two clients on the session and
 * shrink it to whichever window is smaller.
 */
export function usePopoutGuest(id: string, onReclaimed: () => void) {
  const reclaimed = useRef(onReclaimed);
  reclaimed.current = onReclaimed;

  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const bc = new BroadcastChannel(CHANNEL);

    announce({ type: 'open', id });
    bc.onmessage = (event: MessageEvent<Message>) => {
      const msg = event.data;
      if (msg.type === 'who') announce({ type: 'claim', id });
      // The desktop wants this terminal back. The session outlives the
      // connection either way, so the desktop reattaches to exactly this state.
      if (msg.type === 'reclaim' && msg.id === id) {
        reclaimed.current();
        window.close();
      }
    };

    // `pagehide` rather than `unload`: it is the one that still fires when the
    // page goes into the back/forward cache, and the one browsers have not been
    // steadily deprecating. It also fires after this channel may already be
    // closed, which is the other reason to send on a fresh one.
    const leave = () => announce({ type: 'close', id });
    window.addEventListener('pagehide', leave);

    return () => {
      leave();
      window.removeEventListener('pagehide', leave);
      bc.close();
    };
  }, [id]);
}

export interface PopoutTarget {
  id: string;
  name: string;
  color: string;
}

/** Reads the pop-out request out of the URL, or null for the normal desktop. */
export function readPopoutTarget(): PopoutTarget | null {
  const params = new URLSearchParams(window.location.search);
  const id = params.get('popout');
  if (!id) return null;
  return {
    id,
    name: params.get('name') ?? 'terminal',
    // Display only — the server resolves everything that matters from the
    // window id, so a doctored URL changes nothing but this page's colour.
    color: params.get('color') ?? 'cyan',
  };
}
