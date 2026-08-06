import { GRID_COLS, GRID_ROWS, MIN_WINDOW_COLS, MIN_WINDOW_ROWS, type Rect } from './useWindows';

export interface Viewport {
  width: number;
  height: number;
}

export const GUTTER = 10;

export interface CellSize {
  cellW: number;
  cellH: number;
}

export function cellSize(view: Viewport): CellSize {
  return {
    cellW: (view.width - GUTTER * (GRID_COLS + 1)) / GRID_COLS,
    cellH: (view.height - GUTTER * (GRID_ROWS + 1)) / GRID_ROWS,
  };
}

/** Grid units -> pixels, including the gutters between cells. */
export function rectToPixels(rect: Rect, view: Viewport) {
  const { cellW, cellH } = cellSize(view);
  return {
    left: GUTTER + rect.col * (cellW + GUTTER),
    top: GUTTER + rect.row * (cellH + GUTTER),
    width: rect.colSpan * cellW + (rect.colSpan - 1) * GUTTER,
    height: rect.rowSpan * cellH + (rect.rowSpan - 1) * GUTTER,
  };
}

/** Pixels -> nearest grid cell. Used when a drag or resize is released. */
export function pixelsToRect(
  box: { left: number; top: number; width: number; height: number },
  view: Viewport,
): Rect {
  const { cellW, cellH } = cellSize(view);
  return {
    col: Math.round((box.left - GUTTER) / (cellW + GUTTER)),
    row: Math.round((box.top - GUTTER) / (cellH + GUTTER)),
    colSpan: Math.max(1, Math.round((box.width + GUTTER) / (cellW + GUTTER))),
    rowSpan: Math.max(1, Math.round((box.height + GUTTER) / (cellH + GUTTER))),
  };
}

export { GRID_COLS, GRID_ROWS };

/** Smallest a window may be, in pixels — mirrors the grid minimum exactly. */
export function minPixels(view: Viewport) {
  const { cellW, cellH } = cellSize(view);
  return {
    width: MIN_WINDOW_COLS * cellW + (MIN_WINDOW_COLS - 1) * GUTTER,
    height: MIN_WINDOW_ROWS * cellH + (MIN_WINDOW_ROWS - 1) * GUTTER,
  };
}

/**
 * Keeps a dragged box inside the desktop, in pixel space.
 *
 * Doing this here rather than only on release is what makes the gesture
 * honest: the window never floats somewhere it cannot land, so the highlighted
 * destination and the final position are always the same rect.
 *
 * For a resize the edge under the pointer is the one that gives way — the
 * opposite edge is anchored. Clamping width alone would let a west-handle drag
 * past the minimum keep moving the window's left edge while its right edge
 * stayed still, which reads as the window sliding away from the pointer.
 */
export function clampBox(
  box: { left: number; top: number; width: number; height: number },
  mode: 'move' | Handle,
  view: Viewport,
) {
  const min = minPixels(view);
  const maxW = Math.max(min.width, view.width - GUTTER * 2);
  const maxH = Math.max(min.height, view.height - GUTTER * 2);
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

  if (mode === 'move') {
    const width = Math.min(box.width, maxW);
    const height = Math.min(box.height, maxH);
    return {
      width,
      height,
      left: clamp(box.left, GUTTER, view.width - width - GUTTER),
      top: clamp(box.top, GUTTER, view.height - height - GUTTER),
    };
  }

  let { left, top, width, height } = box;
  if (mode.includes('w')) {
    const right = box.left + box.width;
    left = clamp(box.left, GUTTER, right - min.width);
    width = right - left;
  }
  if (mode.includes('e')) {
    width = clamp(box.width, min.width, view.width - GUTTER - left);
  }
  if (mode.includes('n')) {
    const bottom = box.top + box.height;
    top = clamp(box.top, GUTTER, bottom - min.height);
    height = bottom - top;
  }
  if (mode.includes('s')) {
    height = clamp(box.height, min.height, view.height - GUTTER - top);
  }
  return { left, top, width, height };
}

export type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
