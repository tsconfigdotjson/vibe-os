import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";
import { describeError } from "../data";
import "@xterm/xterm/css/xterm.css";
import { writeClipboard } from "../clipboard";
import { startSshSession } from "./runtime";
import type { SshStatus, SshTermConfig } from "./types";

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
  background: "rgba(0, 0, 0, 0)",
  foreground: "#c8cedb",
  cursor: "#56cfe1",
  cursorAccent: "#090c12",
  selectionBackground: "rgba(86, 207, 225, 0.26)",
  black: "#161b25",
  red: "#ef6b73",
  green: "#7ee081",
  yellow: "#f2c14e",
  blue: "#56cfe1",
  magenta: "#a78bfa",
  cyan: "#63d4c0",
  white: "#c8cedb",
  brightBlack: "#5c6678",
  brightRed: "#ff8288",
  brightGreen: "#95e998",
  brightYellow: "#ffd166",
  brightBlue: "#7bdcea",
  brightMagenta: "#c0a8ff",
  brightCyan: "#83e3d3",
  brightWhite: "#e7ecf3",
};

/** The escape byte that opens every CSI sequence. */
/** How long the selection must hold still before it is worth copying. */
const SELECTION_SETTLE_MS = 120;
/** How long to wait for a closing session before disposing the terminal anyway. */
const CLOSE_GRACE_MS = 2_000;

const ESC = "\u001b";

/**
 * Colour codes, stripped before the banner match so styling cannot hide it.
 * Built from a constant because the escape byte cannot sit in a regex literal.
 */
const SGR_CODES = new RegExp(`${ESC}\\[[0-9;]*m`, "g");

/** Muted and reset, for the terminal's own asides. */
const DIM = `${ESC}[2m`;
const RED = `${ESC}[31m`;
const RESET = `${ESC}[0m`;

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

  (term as unknown as { writeln: Terminal["writeln"] }).writeln = ((
    data: string | Uint8Array,
    callback?: () => void,
  ) => {
    if (filtering && typeof data === "string") {
      const plain = data.replace(SGR_CODES, "");
      if (BANNER.test(plain)) {
        sawBox = true;
        callback?.();
        return;
      }
      // The banner ends with one blank line; anything else means real output
      // has started and the filter has done its job.
      if (sawBox && plain.trim() === "") {
        filtering = false;
        callback?.();
        return;
      }
      filtering = false;
    }
    return original(data as string, callback);
  }) as Terminal["writeln"];
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
  const handlers = useRef({
    onStatusChange,
    onTitleChange,
    onBell,
    onFocus,
    onTerminal,
  });
  handlers.current = {
    onStatusChange,
    onTitleChange,
    onBell,
    onFocus,
    onTerminal,
  };

  const configRef = useRef(config);
  configRef.current = config;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
    const nudges: number[] = [];

    // Own child element per session, so a StrictMode double-mount never has
    // two terminals fighting over the same node.
    const host = document.createElement("div");
    host.style.cssText = "width: 100%; height: 100%;";
    container.appendChild(host);

    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: "block",
      cursorInactiveStyle: "outline",
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
    term.unicode.activeVersion = "11";

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
    /*
     * Copy once the selection settles, not on every change.
     *
     * xterm fires onSelectionChange whenever the endpoints move, which during a
     * drag is once per animation frame. On plain HTTP — the deployment this is
     * built for — `navigator.clipboard` is undefined, so each of those ran the
     * textarea-and-execCommand fallback: append an element, select it, copy,
     * remove it, and hand focus back. Dozens of times, mid-gesture.
     */
    let copyTimer: number | undefined;
    const copySelection = () => {
      window.clearTimeout(copyTimer);
      copyTimer = window.setTimeout(() => {
        if (disposed) return;
        const selection = term.getSelection();
        if (selection !== "") void writeClipboard(selection);
      }, SELECTION_SETTLE_MS);
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
      const semi = data.indexOf(";");
      if (semi === -1) return false;
      const payload = data.slice(semi + 1);
      if (payload === "?" || payload === "") return false;
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
      // Reads have no fallback the way writes do: execCommand('paste') is not
      // permitted from script. On an insecure origin there is nothing to try,
      // so say so in the terminal rather than having the click do nothing.
      if (!navigator.clipboard?.readText) {
        term.writeln(
          `\r\n${DIM}paste needs a secure origin (https or localhost)${RESET}`,
        );
        return;
      }
      navigator.clipboard
        .readText()
        .then((text) => {
          if (!disposed) term.paste(text);
        })
        .catch(() => {
          if (!disposed)
            term.writeln(`\r\n${DIM}clipboard read was blocked${RESET}`);
        });
    };
    const onContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      paste();
    };
    const onMouseDown = (event: MouseEvent) => {
      if (event.button === 1) paste();
    };

    const disposables = [
      term.parser.registerOscHandler(52, onOsc52),
      term.onSelectionChange(copySelection),
      term.onTitleChange((title) => handlers.current.onTitleChange?.(title)),
      term.onBell(() => handlers.current.onBell?.()),
    ];
    const onFocus = () => {
      if (!disposed) handlers.current.onFocus?.();
    };
    term.element?.addEventListener("contextmenu", onContextMenu);
    term.element?.addEventListener("mousedown", onMouseDown);
    term.textarea?.addEventListener("focus", onFocus);

    handlers.current.onTerminal?.(term);
    handlers.current.onStatusChange?.("loading");

    // Started synchronously so teardown can always await the same promise,
    // even when the component unmounts before the runtime finishes booting.
    const sessionPromise = startSshSession(configRef.current, term);

    sessionPromise.then(
      (session) => {
        if (disposed) return; // cleanup owns shutdown from here
        handlers.current.onStatusChange?.("ready");
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
            if (
              (
                buf.getLine(buf.viewportY + y)?.translateToString(true) ?? ""
              ).trim() !== ""
            )
              return false;
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
            if (!disposed) handlers.current.onStatusChange?.("ended", result);
          })
          .catch((err: unknown) => {
            const message = describeError(err);
            if (!disposed) {
              term.writeln(`\r\n${RED}${message}${RESET}`);
              handlers.current.onStatusChange?.("error", message);
            }
          });
      },
      (err: unknown) => {
        const message = describeError(err);
        if (!disposed) {
          term.writeln(`${RED}Failed to start SSH runtime: ${message}${RESET}`);
          handlers.current.onStatusChange?.("error", message);
        }
      },
    );

    return () => {
      disposed = true;
      resizeObserver.disconnect();
      clearTimeout(settle);
      for (const n of nudges) window.clearTimeout(n);
      // Retracted before disposal, so nothing outside can write to a dead term.
      handlers.current.onTerminal?.(null);
      window.clearTimeout(copyTimer);
      term.element?.removeEventListener("contextmenu", onContextMenu);
      term.element?.removeEventListener("mousedown", onMouseDown);
      // The one listener that used to outlive the terminal. The host div stays
      // in the document until the async teardown below runs, which can be a
      // whole session close later, so a focus landing on the retired textarea
      // would raise a window on behalf of a terminal being torn down.
      term.textarea?.removeEventListener("focus", onFocus);
      for (const d of disposables) d.dispose();

      // Teardown must be ordered: ssh.wasm is one shared Go runtime for the
      // whole page, and it reads term.element while starting up. Disposing the
      // Terminal out from under it panics Go, which kills every other session
      // on the page. So: let the session finish, then dispose the Terminal.
      void sessionPromise
        .then(async (session) => {
          session.close();
          // Raced against a timeout: `done` is a promise handed over from Go,
          // and a panicked runtime settles nothing. That is exactly when every
          // terminal on the page unmounts at once, so waiting forever would
          // leave every dead host div stacked inside its container.
          await Promise.race([
            session.done.catch(() => {}),
            new Promise((r) => setTimeout(r, CLOSE_GRACE_MS)),
          ]);
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
