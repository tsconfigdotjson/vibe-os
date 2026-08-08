/**
 * The window grid, agreed on by both halves of the desktop.
 *
 * Geometry is stored in grid units rather than pixels, and both sides clamp
 * against these bounds: the browser so a drag cannot leave the screen, the
 * server so a row arriving over HTTP cannot claim a window is 900 cells wide.
 * They were declared separately in `server/windows.ts` and
 * `src/desktop/useWindows.ts` with the server's copy imported by nobody — so
 * changing the grid on one side silently clamped every stored window to a
 * rectangle the other side was not drawing.
 *
 * Runtime values, so `shared/` ships with the package. See `shared/wire.ts` for
 * the type-only half.
 */

/** Columns across the desktop. */
export const GRID_COLS = 24;
/** Rows down the desktop. */
export const GRID_ROWS = 14;

/**
 * The smallest a window may be, in cells.
 *
 * Below this a terminal has too few columns to be worth having — an 80-column
 * program in four cells is unreadable rather than merely small.
 */
export const MIN_WINDOW_COLS = 5;
export const MIN_WINDOW_ROWS = 4;

/** The default size a new window opens at. */
export const DEFAULT_WINDOW_COLS = 11;
export const DEFAULT_WINDOW_ROWS = 8;
