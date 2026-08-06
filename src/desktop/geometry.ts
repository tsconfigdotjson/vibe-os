import { GRID_COLS, GRID_ROWS, type Rect } from './useWindows';

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
