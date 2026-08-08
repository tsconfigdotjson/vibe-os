import { type RefObject, useEffect } from "react";

/**
 * Closes a transient overlay on a click outside it, or on Escape.
 *
 * Written twice by hand — once for the window menu, once for the project
 * picker — with the same reasoning in both and two different sets of local
 * names. The reasoning is worth keeping in one place, because both details
 * below are easy to leave out and each produces a menu that looks fine and
 * cannot be used:
 *
 * - `pointerdown`, not `click`. Pointerdown fires long before click, and
 *   closing on it unmounts the item under the cursor — so React has thrown the
 *   button away by the time a click would have reached it, and every entry does
 *   nothing at all. Events inside `anchor` are ignored so the item's own
 *   onClick can run and close the overlay itself.
 * - Capture phase. The terminal underneath stops plenty of events from
 *   bubbling, and an overlay you cannot dismiss by clicking away is worse than
 *   no overlay.
 */
export function useDismiss(
  open: boolean,
  anchor: RefObject<HTMLElement | null>,
  onDismiss: () => void,
): void {
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (anchor.current?.contains(event.target as Node)) return;
      onDismiss();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onDismiss();
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open, anchor, onDismiss]);
}
