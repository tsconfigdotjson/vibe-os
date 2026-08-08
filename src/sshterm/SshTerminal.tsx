import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import '@xterm/xterm/css/xterm.css';
import { startSshSession } from './runtime';
import { writeClipboard } from '../clipboard';
import type { SshStatus, SshTermConfig } from './types';

export interface SshTerminalProps {
  config: SshTermConfig;
  onStatusChange?: (status: SshStatus, detail?: string) => void;
  onTitleChange?: (title: string) => void;
  onBell?: () => void;
  onFocus?: () => void;
  /**
   * Hands out the Terminal once it exists, and null on teardown.
   *
   * The one thing outside this component can usefully do with it is
   * `term.paste(text)`, which writes into the session without touching the
   * clipboard — the only way to put text in front of a program on a page that
   * is not a secure origin.
   */
  onTerminal?: (term: Terminal | null) => void;
  className?: string;
}

/**
 * Transparent background so the window's frosted plate shows through: xterm
 * paints its own background otherwise and would punch an opaque rectangle
 * through the glass. Needs allowTransparency below to take effect.
 */
const THEME = {
  background: 'rgba(0, 0, 0, 0)',
  foreground: '#c8cedb',
  cursor: '#56cfe1',
  cursorAccent: '#090c12',
  selectionBackground: 'rgba(86, 207, 225, 0.26)',
  black: '#161b25',
  red: '#ef6b73',
  green: '#7ee081',
  yellow: '#f2c14e',
  blue: '#56cfe1',
  magenta: '#a78bfa',
  cyan: '#63d4c0',
  white: '#c8cedb',
  brightBlack: '#5c6678',
  brightRed: '#ff8288',
  brightGreen: '#95e998',
  brightYellow: '#ffd166',
  brightBlue: '#7bdcea',
  brightMagenta: '#c0a8ff',
  brightCyan: '#83e3d3',
  brightWhite: '#e7ecf3',
};

/**
 * Records every byte the session hands the terminal, and ships it to the server
 * so it can be replayed offline.
 *
 * This is the only place the stream can be seen. SSH decrypts inside the page,
 * so there is nothing to tap on the wire, and by the time anything is visible
 * on screen xterm has already interpreted it — which is precisely the step
 * under suspicion when a pane is garbled. Wrapping `write` catches the bytes in
 * between, exactly as they arrive and before anything has read them.
 *
 * Recording from the first byte matters more than it sounds. A full-screen
 * program paints incrementally, so a capture that starts late is missing the
 * frame every later update is written against, and replaying it will diverge
 * for reasons that are an artefact of the capture rather than a bug. This
 * installs before the session is started, so the stream is self-contained.
 *
 * Uploads on a timer rather than on demand so that reproducing a fault needs no
 * console work — open the window with `?debugterm`, make it misbehave, and the
 * bytes are already on the server. Capped, because a busy pane can produce
 * megabytes and the point is to catch a fault, not to keep a session log.
 */
function captureBytes(term: Terminal): () => void {
  const CAP = 6 * 1024 * 1024;
  const original = term.write.bind(term);
  let chunks: Uint8Array[] = [];
  let held = 0;
  let seq = 0;
  // Every terminal on the page records separately, and replaying two streams as
  // one would invent corruption that never happened. The id keeps them apart.
  const id = Math.random().toString(36).slice(2, 8);

  (term as unknown as { write: Terminal['write'] }).write = ((
    data: string | Uint8Array,
    callback?: () => void,
  ) => {
    if (typeof data !== 'string' && held < CAP) {
      chunks.push(new Uint8Array(data));
      held += data.length;
    }
    return original(data as string, callback);
  }) as Terminal['write'];

  const flush = (): void => {
    if (chunks.length === 0) return;
    const blob = new Blob(chunks as BlobPart[]);
    chunks = [];
    held = 0;
    const label = `${id}-t${String(seq++).padStart(3, "0")}`;
    void fetch(`/api/debug/capture?label=${label}`, { method: 'POST', body: blob }).catch(() => {
      // Best effort: a failed upload must never disturb the session it watches.
    });
  };

  // Short interval while debugging: each upload is paired with a grid snapshot,
  // so more uploads means finer resolution when bisecting.
  const timer = setInterval(flush, 15_000);
  return () => {
    clearInterval(timer);
    flush();
  };
}

/**
 * Swallows the banner upstream prints into every session.
 *
 * `internal/start.go` writes a three-line box and a blank line straight to the
 * terminal object before the app boots, with no config option to turn it off.
 * Patching that would mean forking the Go source and building ssh.wasm
 * ourselves, which costs the "prebuilt from upstream releases, no Go toolchain
 * on the VPS" property — a bad trade for four lines of output.
 *
 * We own the object Go writes to, so the banner is filtered at the boundary
 * instead. The filter disables itself the moment it sees a line that is not
 * part of the banner, so it can never eat real output; if upstream changes the
 * art, the banner simply comes back rather than anything breaking.
 */
function suppressBanner(term: Terminal): void {
  const original = term.writeln.bind(term);
  const BANNER = /[╔╚╗╝║═]|SSH TERM|^Welcome!/;
  let filtering = true;
  let sawBox = false;

  (term as unknown as { writeln: Terminal['writeln'] }).writeln = ((
    data: string | Uint8Array,
    callback?: () => void,
  ) => {
    if (filtering && typeof data === 'string') {
      const plain = data.replace(/\x1b\[[0-9;]*m/g, '');
      if (BANNER.test(plain)) {
        sawBox = true;
        callback?.();
        return;
      }
      // The banner ends with one blank line; anything else means real output
      // has started and the filter has done its job.
      if (sawBox && plain.trim() === '') {
        filtering = false;
        callback?.();
        return;
      }
      filtering = false;
    }
    return original(data as string, callback);
  }) as Terminal['writeln'];
}

/**
 * Renders one SSH session: owns an xterm.js Terminal and hands it to the
 * sshterm WASM runtime.
 *
 * Remount the component (e.g. via a changing `key`) to start a fresh session.
 */
export function SshTerminal({
  config,
  onStatusChange,
  onTitleChange,
  onBell,
  onFocus,
  onTerminal,
  className,
}: SshTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Held in a ref so changing callback identity never restarts the session.
  const handlers = useRef({ onStatusChange, onTitleChange, onBell, onFocus, onTerminal });
  handlers.current = { onStatusChange, onTitleChange, onBell, onFocus, onTerminal };

  const configRef = useRef(config);
  configRef.current = config;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
    const nudges: number[] = [];
    let stopCapture: (() => void) | undefined;

    // Own child element per session, so a StrictMode double-mount never has
    // two terminals fighting over the same node.
    const host = document.createElement('div');
    host.style.cssText = 'width: 100%; height: 100%;';
    container.appendChild(host);

    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: 'block',
      cursorInactiveStyle: 'outline',
      fontFamily:
        'ui-monospace, SFMono-Regular, "SF Mono", "JetBrains Mono", "Cascadia Mono", Menlo, Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.25,
      letterSpacing: 0,
      scrollback: 10_000,
      allowProposedApi: true,
      allowTransparency: true,
      theme: THEME,
    });
    suppressBanner(term);

    /*
     * The terminal and whatever draws into it have to agree on how many cells a
     * character takes, or every line after the first disagreement is wrong for
     * good.
     *
     * xterm ships a Unicode 6 width table, which is older than the ones the
     * programs drawing into it use. Measured against tmux 3.6 as a reference
     * implementation: `🔥` and `⌛` are two cells there and one here. A program
     * that lays out a line assuming two will have every column after that glyph
     * land one place to the left, and nothing corrects it — the program has no
     * reason to think anything went wrong.
     *
     * Loaded before `open` so no output is ever measured with the old table.
     *
     * One case survives: a symbol followed by U+FE0F — `⚠️`, `ℹ️` — is two cells
     * to tmux and one to every width table xterm has, because the width belongs
     * to the pair rather than to either codepoint.
     */
    const unicode11 = new Unicode11Addon();
    term.loadAddon(unicode11);
    term.unicode.activeVersion = '11';

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());
    term.open(host);

    const fit = () => {
      if (disposed) return;
      if (host.clientWidth === 0 || host.clientHeight === 0) return;
      try {
        fitAddon.fit();
      } catch {
        // xterm throws if the element is detached mid-layout; harmless.
      }
    };
    fit();

    /*
     * Coalesced, never per-notification.
     *
     * A drag of a window's edge crosses a column boundary every few pixels and
     * the observer fires on each one. Unthrottled that is a `term.resize()` per
     * crossing, and a resize is cheap nowhere along the chain: xterm re-wraps
     * its whole buffer, the WASM sends an SSH window-change, sshd resizes the
     * pty, and the program repaints everything. One gesture was paying that
     * forty times over.
     *
     * Waiting for the size to settle makes a gesture cost one, and reflowing on
     * release rather than during the drag is what every native terminal does.
     */
    let settle: ReturnType<typeof setTimeout> | undefined;
    const resizeObserver = new ResizeObserver(() => {
      clearTimeout(settle);
      settle = setTimeout(fit, 120);
    });
    resizeObserver.observe(host);

    // Match upstream sshterm ergonomics: copy on select, paste on
    // right-click / middle-click. Paste needs a secure context, which plain
    // HTTP on an IP address is not, so it silently no-ops there; copy has a
    // fallback that works anywhere.
    const copySelection = () => {
      const selection = term.getSelection();
      if (selection !== '') void writeClipboard(selection);
    };

    /**
     * OSC 52 — how a program running in the terminal asks to set the clipboard.
     *
     * This is the sequence Claude Code and vim emit when they copy something,
     * and it is the only way a copy that happens *inside* the session can reach
     * the browser. It arrives here untouched now that nothing sits between the
     * program and this terminal, but xterm.js ships handlers for OSC 0, 1, 2, 4,
     * 8, 10-12 and 104-112 — not 52 — so without this it is dropped on arrival
     * and copying in Claude appears to do nothing.
     *
     * The payload is `<targets>;<base64>`. A payload of `?` is a *read*: the
     * program is asking what is on the clipboard. That is deliberately refused.
     * Anything running in a pane could otherwise exfiltrate whatever the person
     * at the keyboard last copied — a password, a token — and no terminal
     * should hand that over for free.
     */
    const onOsc52 = (data: string): boolean => {
      const semi = data.indexOf(';');
      if (semi === -1) return false;
      const payload = data.slice(semi + 1);
      if (payload === '?' || payload === '') return false;
      try {
        const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
        void writeClipboard(new TextDecoder().decode(bytes));
        return true;
      } catch {
        // Not valid base64 — let the sequence fall through untouched.
        return false;
      }
    };
    const paste = () => {
      if (!navigator.clipboard?.readText) return;
      navigator.clipboard
        .readText()
        .then((text) => term.paste(text))
        .catch(() => {});
    };
    const onContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      paste();
    };
    const onMouseDown = (event: MouseEvent) => {
      if (event.button === 1) paste();
    };

    /*
     * Diagnostic handle, opt-in.
     *
     * Reaching a Terminal from a devtools console is otherwise impossible — it
     * lives in a closure inside this effect, and only the desktop happens to
     * park a copy in React state. Chasing a corruption that only appears in the
     * browser means being able to read the buffer, so `?debugterm` hands one
     * out. Off unless asked for, and it exposes nothing a page on this origin
     * could not already reach.
     */
    if (new URLSearchParams(window.location.search).has('debugterm')) {
      ((window as unknown as { __vibeTerms?: Set<Terminal> }).__vibeTerms ??= new Set()).add(term);
      stopCapture = captureBytes(term);
    }

    const disposables = [
      term.parser.registerOscHandler(52, onOsc52),
      term.onSelectionChange(copySelection),
      term.onTitleChange((title) => handlers.current.onTitleChange?.(title)),
      term.onBell(() => handlers.current.onBell?.()),
    ];
    term.element?.addEventListener('contextmenu', onContextMenu);
    term.element?.addEventListener('mousedown', onMouseDown);
    term.textarea?.addEventListener('focus', () => handlers.current.onFocus?.());

    handlers.current.onTerminal?.(term);
    handlers.current.onStatusChange?.('loading');

    // Started synchronously so teardown can always await the same promise,
    // even when the component unmounts before the runtime finishes booting.
    const sessionPromise = startSshSession(configRef.current, term);

    sessionPromise.then(
      (session) => {
        if (disposed) return; // cleanup owns shutdown from here
        handlers.current.onStatusChange?.('ready');
        fit();

        /*
         * Ask whatever is running to paint itself, if it has not already.
         *
         * Reattaching to a session means arriving at a blank terminal: dtach
         * holds the pty and nothing else, so unlike tmux there is no stored
         * screen to replay — the program has to redraw, and until it does the
         * window is empty even though the session is perfectly alive.
         *
         * dtach offers `-r winch` for exactly this and it is set, but it signals
         * the size the terminal already has. A full-screen program that tracks
         * its own dimensions sees nothing new and does not repaint; measured
         * against Claude, the screen stayed blank until the size actually
         * changed. So change it: one column narrower and back, which is a real
         * resize to the program and invisible here because the second one
         * restores the fitted size before anything is drawn at the odd width.
         *
         * Conditioned on the screen actually being empty, and retried, because
         * the useful moment cannot be timed from here. `ready` means the WASM
         * has a session, not that dtach has attached and the program has its
         * SIGWINCH handler back — nudge before that and the resize lands on
         * nobody, which is exactly what a first attempt at a fixed 120ms did.
         * A delay long enough to be safe is also long enough to be seen.
         *
         * Emptiness rather than "has anything been written", because plenty is
         * written that is not a repaint — connection notices, a stray newline —
         * and any of it would call the problem solved while the window is still
         * blank. Asking what is on screen tests the symptom itself, so a session
         * that paints on its own is never nudged and one that stays dark is
         * asked again.
         */
        const blank = (): boolean => {
          const buf = term.buffer.active;
          for (let y = 0; y < term.rows; y++) {
            if ((buf.getLine(buf.viewportY + y)?.translateToString(true) ?? '').trim() !== '') return false;
          }
          return true;
        };
        const repaint = (): void => {
          if (disposed || term.cols < 2 || !blank()) return;
          term.resize(term.cols - 1, term.rows);
          nudges.push(window.setTimeout(() => !disposed && fit(), 60));
        };
        for (const delay of [350, 1200, 2600]) {
          nudges.push(window.setTimeout(repaint, delay));
        }

        session.done
          .then((result) => {
            if (!disposed) handlers.current.onStatusChange?.('ended', result);
          })
          .catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            if (!disposed) {
              term.writeln(`\r\n\x1b[31m${message}\x1b[0m`);
              handlers.current.onStatusChange?.('error', message);
            }
          });
      },
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        if (!disposed) {
          term.writeln(`\x1b[31mFailed to start SSH runtime: ${message}\x1b[0m`);
          handlers.current.onStatusChange?.('error', message);
        }
      },
    );

    return () => {
      disposed = true;
      resizeObserver.disconnect();
      clearTimeout(settle);
      for (const n of nudges) window.clearTimeout(n);
      stopCapture?.();
      // Retracted before disposal, so nothing outside can write to a dead term.
      handlers.current.onTerminal?.(null);
      term.element?.removeEventListener('contextmenu', onContextMenu);
      term.element?.removeEventListener('mousedown', onMouseDown);
      for (const d of disposables) d.dispose();

      // Teardown must be ordered: ssh.wasm is one shared Go runtime for the
      // whole page, and it reads term.element while starting up. Disposing the
      // Terminal out from under it panics Go, which kills every other session
      // on the page. So: let the session finish, then dispose the Terminal.
      void sessionPromise
        .then(async (session) => {
          session.close();
          await session.done.catch(() => {});
        })
        .catch(() => {
          // start() failed; nothing to close.
        })
        .finally(() => {
          term.dispose();
          host.remove();
        });
    };
  }, []);

  return <div ref={containerRef} className={className} />;
}
