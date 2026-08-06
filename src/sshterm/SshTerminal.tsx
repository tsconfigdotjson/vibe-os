import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { startSshSession } from './runtime';
import type { SshStatus, SshTermConfig } from './types';

export interface SshTerminalProps {
  config: SshTermConfig;
  onStatusChange?: (status: SshStatus, detail?: string) => void;
  onTitleChange?: (title: string) => void;
  onBell?: () => void;
  onFocus?: () => void;
  className?: string;
}

/** Matches the app palette in styles.css so panes and chrome read as one surface. */
const THEME = {
  background: '#0d1117',
  foreground: '#c8cedb',
  cursor: '#56cfe1',
  cursorAccent: '#0d1117',
  selectionBackground: '#25324a',
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
  className,
}: SshTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Held in a ref so changing callback identity never restarts the session.
  const handlers = useRef({ onStatusChange, onTitleChange, onBell, onFocus });
  handlers.current = { onStatusChange, onTitleChange, onBell, onFocus };

  const configRef = useRef(config);
  configRef.current = config;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;

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
      theme: THEME,
    });
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

    const resizeObserver = new ResizeObserver(fit);
    resizeObserver.observe(host);

    // Match upstream sshterm ergonomics: copy on select, paste on
    // right-click / middle-click. Both need a secure context, which plain HTTP
    // on an IP address is not, so they silently no-op there.
    const copySelection = () => {
      const selection = term.getSelection();
      if (selection !== '' && navigator.clipboard) {
        void navigator.clipboard.writeText(selection).catch(() => {});
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

    const disposables = [
      term.onSelectionChange(copySelection),
      term.onTitleChange((title) => handlers.current.onTitleChange?.(title)),
      term.onBell(() => handlers.current.onBell?.()),
    ];
    term.element?.addEventListener('contextmenu', onContextMenu);
    term.element?.addEventListener('mousedown', onMouseDown);
    term.textarea?.addEventListener('focus', () => handlers.current.onFocus?.());

    handlers.current.onStatusChange?.('loading');

    // Started synchronously so teardown can always await the same promise,
    // even when the component unmounts before the runtime finishes booting.
    const sessionPromise = startSshSession(configRef.current, term);

    sessionPromise.then(
      (session) => {
        if (disposed) return; // cleanup owns shutdown from here
        handlers.current.onStatusChange?.('ready');
        fit();

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
