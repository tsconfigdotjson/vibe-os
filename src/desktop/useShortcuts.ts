import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Keyboard shortcuts, behind one leader chord.
 *
 * The terminal has focus nearly all the time, so a shortcut is a key the
 * session cannot have. A leader keeps that cost to a single chord: press it,
 * then one plain key names the command, the way tmux's prefix works.
 *
 * The leader is Ctrl+`. xterm.js turns Ctrl with a letter, space, 3 to 8, `[`,
 * `\` or `]` into a control byte and sends nothing at all for Ctrl+`, so a
 * program in the terminal never sees that chord whether or not the desktop
 * takes it. It is matched by physical key (`code`), so it sits in the same
 * place on layouts where that key types something other than a backtick.
 *
 * The listener runs in the capture phase on `window`, which is ahead of the
 * textarea xterm listens on. A swallowed key is stopped there, so neither the
 * leader nor the command key after it ever reaches the session.
 */

export type ShortcutMode = "idle" | "armed" | "profile";

export type ShortcutCommand =
  | { kind: "window"; idx: number }
  | { kind: "cycle"; step: 1 | -1 }
  | { kind: "workspace"; step: 1 | -1 }
  | { kind: "profile"; index: number }
  | { kind: "spawn" }
  | { kind: "minimize" }
  | { kind: "maximize" }
  | { kind: "tile" };

export type KeyLike = Pick<
  KeyboardEvent,
  "key" | "code" | "ctrlKey" | "altKey" | "metaKey" | "shiftKey"
>;

export interface Step {
  mode: ShortcutMode;
  command?: ShortcutCommand;
  /** True when the key belongs to the desktop and must not reach the page. */
  swallow: boolean;
}

/** What the hint panel calls the leader on this platform. */
export const LEADER_LABEL =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform)
    ? "⌃`"
    : "Ctrl+`";

const MODIFIERS = new Set(["Control", "Shift", "Alt", "Meta", "AltGraph"]);

export function isLeader(e: KeyLike): boolean {
  return (
    e.code === "Backquote" &&
    e.ctrlKey &&
    !e.altKey &&
    !e.metaKey &&
    !e.shiftKey
  );
}

/** 1 to 9 from the digit row or the keypad, whatever the layout puts on it. */
function digit(e: KeyLike): number | null {
  const match = /^(?:Digit|Numpad)([1-9])$/.exec(e.code);
  if (match) return Number(match[1]);
  return /^[1-9]$/.test(e.key) ? Number(e.key) : null;
}

const LETTERS: Record<string, ShortcutCommand> = {
  t: { kind: "spawn" },
  m: { kind: "minimize" },
  f: { kind: "maximize" },
  g: { kind: "tile" },
};

const ARROWS: Record<string, ShortcutCommand> = {
  ArrowRight: { kind: "cycle", step: 1 },
  ArrowLeft: { kind: "cycle", step: -1 },
  ArrowDown: { kind: "workspace", step: 1 },
  ArrowUp: { kind: "workspace", step: -1 },
};

/**
 * One key in, the next mode and possibly a command out.
 *
 * Idle passes everything through except the leader. Once armed, every key is
 * swallowed, including ones that mean nothing: a mistyped command is a stray
 * key, and a stray key typed into a shell is worse than one dropped. Holding a
 * modifier on its own changes nothing, so Shift can be reached for on the way
 * to a key without disarming.
 */
export function step(mode: ShortcutMode, e: KeyLike): Step {
  if (mode === "idle") {
    return isLeader(e)
      ? { mode: "armed", swallow: true }
      : { mode, swallow: false };
  }
  if (MODIFIERS.has(e.key)) return { mode, swallow: true };
  // The leader again, or Escape, backs out without doing anything.
  if (isLeader(e) || e.key === "Escape") return { mode: "idle", swallow: true };

  const n = digit(e);
  if (mode === "profile") {
    return n === null
      ? { mode: "idle", swallow: true }
      : {
          mode: "idle",
          command: { kind: "profile", index: n - 1 },
          swallow: true,
        };
  }

  if (n !== null)
    return { mode: "idle", command: { kind: "window", idx: n }, swallow: true };
  if (e.ctrlKey || e.altKey || e.metaKey)
    return { mode: "idle", swallow: true };
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (key === "p") return { mode: "profile", swallow: true };
  const command = ARROWS[key] ?? LETTERS[key];
  return { mode: "idle", command, swallow: true };
}

/**
 * Wires `step` to the page.
 *
 * Disabled while a panel is open over the desktop: a command acting on the
 * windows behind a form would move focus out of the form you are filling in.
 */
export function useShortcuts(
  enabled: boolean,
  run: (command: ShortcutCommand) => void,
) {
  const [mode, setMode] = useState<ShortcutMode>("idle");
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const runRef = useRef(run);
  runRef.current = run;

  const set = useCallback((next: ShortcutMode) => {
    modeRef.current = next;
    setMode(next);
  }, []);

  useEffect(() => {
    if (!enabled) {
      set("idle");
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing || event.repeat) {
        // A held leader repeats; swallow the repeats so they do not toggle.
        if (event.repeat && modeRef.current !== "idle") {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
        return;
      }
      const next = step(modeRef.current, event);
      if (!next.swallow) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      set(next.mode);
      if (next.command) runRef.current(next.command);
    };
    // Clicking anywhere is a change of mind.
    const onPointer = () => {
      if (modeRef.current !== "idle") set("idle");
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("blur", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("blur", onPointer);
    };
  }, [enabled, set]);

  return { mode, arm: useCallback(() => set("armed"), [set]) };
}
