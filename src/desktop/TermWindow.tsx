import type { Terminal } from "@xterm/xterm";
import { memo, useCallback, useMemo, useRef, useState } from "react";
import type { ServerConfig } from "../api";
import { windowSshConfig } from "../api";
import type { Profile } from "../data";
import { SshTerminal } from "../sshterm";
import {
  clampBox,
  HANDLES,
  type Handle,
  pixelsToRect,
  rectToPixels,
  type Viewport,
} from "./geometry";
import { PromptBand } from "./PromptBand";
import { SshHandoff } from "./SshHandoff";
import { useDismiss } from "./useDismiss";
import {
  clampRect,
  type DragMode,
  type Rect,
  STATUS_LABEL,
  type WindowState,
} from "./useWindows";

/** Corner and edge grips. Anything not listed is not resizable from that side. */

/**
 * Where a terminal has gone, when it is not in its window.
 *
 * Both destinations mean the same thing to the desktop — let go of the session,
 * show a placeholder — and differ only in who picks it up and how it comes
 * back. A browser pop-out is asked to close over a BroadcastChannel; a terminal
 * is detached by the server, which kills the attached dtach client.
 */
export type PopTarget = "browser" | "ssh";

export interface TermWindowProps {
  win: WindowState;
  /**
   * The positional name of this window. Separate from `win` on purpose: it is
   * derived from the workspace, and folding it in with a spread built a fresh
   * object every render, which defeated the `memo` around this component.
   */
  label: string;
  server: ServerConfig;
  hue: string;
  /** The role this window runs as, when it has one. */
  profile: Profile | null;
  /** Where this window's terminal has gone, or null while it is here. */
  poppedTo: PopTarget | null;
  /** Returns false when the browser refused to open the window. */
  onPopOut: (id: string) => boolean;
  /** Hands the terminal to a real terminal, or takes it back with null. */
  onHandoff: (id: string, mode: "ssh" | null) => void;
  onReclaim: (id: string) => void;
  focused: boolean;
  view: Viewport;
  onRaise: (id: string) => void;
  onCommit: (id: string, rect: Rect, mode: DragMode) => void;
  onPreview: (rect: Rect | null) => void;
  onClose: (id: string) => void;
  onRestart: (id: string) => void;
  onMinimize: (id: string) => void;
  onMaximize: (id: string) => void;
  onStatus: (
    id: string,
    status: WindowState["status"],
    detail?: string,
  ) => void;
  onTitle: (id: string, title: string) => void;
  onPromptDone: (id: string) => void;
}

interface DragState {
  mode: "move" | Handle;
  startX: number;
  startY: number;
  origin: { left: number; top: number; width: number; height: number };
}

export const TermWindow = memo(function TermWindow({
  win,
  label,
  server,
  hue,
  profile,
  poppedTo,
  onPopOut,
  onHandoff,
  onReclaim,
  focused,
  view,
  onRaise,
  onCommit,
  onPreview,
  onClose,
  onRestart,
  onMinimize,
  onMaximize,
  onStatus,
  onTitle,
  onPromptDone,
}: TermWindowProps) {
  // Rebuilt only when the window identity changes; SshTerminal reads it once.
  const config = useMemo(
    () => windowSshConfig(server, win.id),
    [server, win.id],
  );

  const anchored = rectToPixels(win, view);
  const [live, setLive] = useState<typeof anchored | null>(null);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<DragState | null>(null);
  // State rather than a ref: the Send button has to re-render from disabled to
  // enabled when the terminal appears, which a ref would not trigger.
  const [term, setTerm] = useState<Terminal | null>(null);
  // A blocked pop-up is silent — the browser tells the user in the omnibox, but
  // the click looks like it did nothing at all here. Say so in the window.
  const [popBlocked, setPopBlocked] = useState(false);
  // The ⇗ button offers a choice now, so it opens a menu rather than acting.
  const [menuOpen, setMenuOpen] = useState(false);
  // Covers the toggle and the menu together, so a pointerdown on either is
  // "inside" and the dismiss-on-outside-click handler leaves it alone.
  const menuAnchor = useRef<HTMLSpanElement | null>(null);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  // The exact rect the overlay is promising. Committing this value rather than
  // recomputing one on pointerup is what guarantees the window lands where the
  // highlight said it would — no rounding done twice, no stale state read.
  const snap = useRef<Rect | null>(null);
  const box = live ?? anchored;

  const begin = useCallback(
    (mode: DragState["mode"]) => (event: React.PointerEvent) => {
      if (event.button !== 0) return;
      // The window buttons live inside the drag handle, so their pointerdown
      // bubbles to it. Without this guard the handle preventDefaults the event
      // and captures the pointer, and the button never sees a click at all.
      if ((event.target as HTMLElement).closest("button")) return;
      event.preventDefault();
      event.stopPropagation();
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
      onRaise(win.id);
      drag.current = {
        mode,
        startX: event.clientX,
        startY: event.clientY,
        origin: anchored,
      };
      snap.current = null;
      setLive(anchored);
      setDragging(true);
    },
    [anchored, onRaise, win.id],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent) => {
      const state = drag.current;
      if (!state) return;
      const dx = event.clientX - state.startX;
      const dy = event.clientY - state.startY;
      const o = state.origin;

      const next = { ...o };
      if (state.mode === "move") {
        next.left = o.left + dx;
        next.top = o.top + dy;
      } else {
        // Each letter in the handle name moves one edge. Left/top edges move
        // the origin as well as the size, which is why they adjust both.
        if (state.mode.includes("e")) next.width = o.width + dx;
        if (state.mode.includes("s")) next.height = o.height + dy;
        if (state.mode.includes("w")) {
          next.left = o.left + dx;
          next.width = o.width - dx;
        }
        if (state.mode.includes("n")) {
          next.top = o.top + dy;
          next.height = o.height - dy;
        }
      }

      // Clamp in pixel space so the window can never be dragged somewhere it
      // cannot land; the snapped rect below is then always reachable.
      const bounded = clampBox(next, state.mode, view);
      const snapped = clampRect(
        pixelsToRect(bounded, view),
        state.mode === "move" ? "move" : "resize",
      );

      // Only when the destination cell changes. This pushes state to the whole
      // desktop, so firing it every pointermove re-rendered every sibling
      // window for a preview that was usually identical to the last frame.
      const moved =
        !snap.current ||
        snap.current.col !== snapped.col ||
        snap.current.row !== snapped.row ||
        snap.current.colSpan !== snapped.colSpan ||
        snap.current.rowSpan !== snapped.rowSpan;
      snap.current = snapped;
      setLive(bounded);
      if (moved) onPreview(snapped);
    },
    [onPreview, view],
  );

  const finish = useCallback(
    (event: React.PointerEvent) => {
      const state = drag.current;
      if (!state) return;
      drag.current = null;
      try {
        (event.currentTarget as HTMLElement).releasePointerCapture(
          event.pointerId,
        );
      } catch {
        // pointer already gone
      }
      if (snap.current)
        onCommit(
          win.id,
          snap.current,
          state.mode === "move" ? "move" : "resize",
        );
      snap.current = null;
      setLive(null);
      setDragging(false);
      onPreview(null);
    },
    [onCommit, onPreview, win.id],
  );

  useDismiss(menuOpen, menuAnchor, closeMenu);

  if (win.minimized) return null;

  const showBand = Boolean(
    profile && profile.prompt.trim() !== "" && !win.promptDone,
  );
  const poppedOut = poppedTo !== null;

  /** Takes the terminal back from wherever it went. */
  const reclaim = () =>
    poppedTo === "ssh" ? onHandoff(win.id, null) : onReclaim(win.id);

  return (
    <section
      className="win"
      data-focused={focused || undefined}
      // A popped-out window has no connection of its own, so its last status is
      // meaningless here — reporting it would leave the dot pulsing at
      // "connecting" forever for something that is not connecting.
      data-status={poppedOut ? "popped" : win.status}
      data-dragging={dragging || undefined}
      data-profile={profile ? "" : undefined}
      style={{
        ["--win-color" as string]: hue,
        transform: `translate(${box.left}px, ${box.top}px)`,
        width: box.width,
        height: box.height,
        zIndex: win.z,
      }}
      onPointerDown={() => onRaise(win.id)}
    >
      <header
        className="win-bar"
        role="toolbar"
        aria-label={`${label} window controls`}
        onPointerDown={begin("move")}
        onPointerMove={onPointerMove}
        onPointerUp={finish}
        onPointerCancel={finish}
        onDoubleClick={() => onMaximize(win.id)}
      >
        <span className="win-dot" aria-hidden="true" />
        {profile ? (
          // A role window says whose it is first and where it is second. The
          // workspace-and-index label is still there, just demoted.
          <span className="win-ident">
            <span className="win-role">{profile.name}</span>
            <span className="win-sub">{label}</span>
          </span>
        ) : (
          <span className="win-name">{label}</span>
        )}
        <span className="win-title">{poppedOut ? "" : (win.title ?? "")}</span>
        <span className="win-state">
          {poppedTo === "ssh"
            ? "in a terminal"
            : poppedTo === "browser"
              ? "popped out"
              : STATUS_LABEL[win.status]}
        </span>
        <span className="win-buttons">
          <span className="win-menu-anchor" ref={menuAnchor}>
            <button
              type="button"
              aria-haspopup={poppedOut ? undefined : "menu"}
              aria-expanded={poppedOut ? undefined : menuOpen}
              title={
                poppedOut
                  ? "Bring this terminal back into the desktop"
                  : "Send this terminal somewhere else"
              }
              onClick={() => {
                if (poppedOut) {
                  reclaim();
                  return;
                }
                setMenuOpen((open) => !open);
              }}
            >
              {poppedOut ? "⇱" : "⇗"}
            </button>
            {menuOpen && !poppedOut ? (
              // Both entries do the same thing to this window — let go of the
              // session — and differ only in who picks it up. Keeping them on
              // one menu is what makes that legible.
              <div className="win-menu" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    setPopBlocked(!onPopOut(win.id));
                  }}
                >
                  <span className="win-menu-icon" aria-hidden="true">
                    ⧉
                  </span>
                  <span className="win-menu-text">
                    <span className="win-menu-label">Browser window</span>
                    <span className="win-menu-hint">
                      Its own window on this screen
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  disabled={!server.sessions}
                  title={
                    server.sessions
                      ? undefined
                      : "This server runs plain login shells (--no-sessions)"
                  }
                  onClick={() => {
                    setMenuOpen(false);
                    onHandoff(win.id, "ssh");
                  }}
                >
                  <span className="win-menu-icon" aria-hidden="true">
                    ❯
                  </span>
                  <span className="win-menu-text">
                    <span className="win-menu-label">SSH session</span>
                    <span className="win-menu-hint">
                      Attach from a real terminal
                    </span>
                  </span>
                </button>
              </div>
            ) : null}
          </span>
          <button
            type="button"
            title="Restart this connection"
            onClick={() => onRestart(win.id)}
          >
            ⟳
          </button>
          <button
            type="button"
            title="Minimise to the dock — keeps running"
            onClick={() => onMinimize(win.id)}
          >
            –
          </button>
          <button
            type="button"
            title="Fill the desktop"
            onClick={() => onMaximize(win.id)}
          >
            ▢
          </button>
          <button
            type="button"
            className="win-close"
            title="Close the window and end its session"
            onClick={() => onClose(win.id)}
          >
            ✕
          </button>
        </span>
      </header>

      <div className="win-body">
        {/*
          Unmounted while popped out, not merely hidden. The terminal owns an
          SSH connection, and leaving it mounted would put a second client on
          the session — which dtach would then size to whichever of the two
          windows most recently arrived. The session itself is untouched: it lives on the
          server, and both views only ever attach to it.
        */}
        {poppedTo === "ssh" ? (
          <SshHandoff windowId={win.id} onReclaim={reclaim} />
        ) : poppedTo === "browser" ? (
          <div className="popped">
            <p className="popped-line">Open in its own window.</p>
            <button type="button" className="ghost" onClick={reclaim}>
              Bring it back
            </button>
            <p className="popped-hint">The session keeps running either way.</p>
          </div>
        ) : (
          <>
            {popBlocked ? (
              <div className="band band-warn">
                <div className="band-text">
                  Your browser blocked the pop-up window. Allow pop-ups for this
                  site, then try again.
                </div>
                <div className="band-actions">
                  <button
                    type="button"
                    className="btn btn-quiet"
                    onClick={() => setPopBlocked(false)}
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            ) : null}
            {showBand && profile ? (
              <PromptBand
                profileName={profile.name}
                prompt={profile.prompt}
                // xterm's paste() wraps the text in bracketed-paste markers, so
                // a multi-line prompt reaches the composer as one unsent block.
                onSend={term ? (text) => term.paste(text) : null}
                onDismiss={() => onPromptDone(win.id)}
              />
            ) : null}
            <SshTerminal
              key={`${win.id}:${win.generation}`}
              config={config}
              className="win-term"
              onFocus={() => onRaise(win.id)}
              onStatusChange={(status, detail) =>
                onStatus(win.id, status, detail)
              }
              onTitleChange={(title) => onTitle(win.id, title)}
              onTerminal={setTerm}
            />
          </>
        )}
      </div>

      {HANDLES.map((handle) => (
        <span
          key={handle}
          className={`grip grip-${handle}`}
          data-handle={handle}
          onPointerDown={begin(handle)}
          onPointerMove={onPointerMove}
          onPointerUp={finish}
          onPointerCancel={finish}
        />
      ))}
    </section>
  );
});
