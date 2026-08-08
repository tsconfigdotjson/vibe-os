import { describe, expect, test } from "bun:test";
import {
  GRID_COLS,
  GRID_ROWS,
  MIN_WINDOW_COLS,
  MIN_WINDOW_ROWS,
} from "../../shared/grid";
import {
  cellSize,
  clampBox,
  GUTTER,
  pixelsToRect,
  rectToPixels,
} from "./geometry";
import { clampRect } from "./useWindows";

const view = { width: 1920, height: 1080 };

describe("grid geometry", () => {
  test("a full-width row of cells plus gutters fills the viewport", () => {
    const { cellW } = cellSize(view);
    const used = GRID_COLS * cellW + (GRID_COLS + 1) * GUTTER;
    expect(used).toBeCloseTo(view.width, 6);
  });

  test("a full-height column does the same", () => {
    const { cellH } = cellSize(view);
    const used = GRID_ROWS * cellH + (GRID_ROWS + 1) * GUTTER;
    expect(used).toBeCloseTo(view.height, 6);
  });

  test("the first cell starts one gutter in", () => {
    const box = rectToPixels({ col: 0, row: 0, colSpan: 1, rowSpan: 1 }, view);
    expect(box.left).toBe(GUTTER);
    expect(box.top).toBe(GUTTER);
  });

  test("the last cell ends one gutter from the far edge", () => {
    const box = rectToPixels(
      { col: GRID_COLS - 1, row: GRID_ROWS - 1, colSpan: 1, rowSpan: 1 },
      view,
    );
    expect(box.left + box.width).toBeCloseTo(view.width - GUTTER, 6);
    expect(box.top + box.height).toBeCloseTo(view.height - GUTTER, 6);
  });

  /**
   * GridOverlay draws its lines with an SVG pattern, which repeats from an
   * origin at a fixed pitch. Both have to match what rectToPixels actually does
   * or the guides sit beside the cells they claim to mark — the overlay drew a
   * correct pitch from the wrong origin, so every line was a gutter out.
   */
  describe("overlay pattern matches real cell edges", () => {
    const pitchX = (view.width - GUTTER) / GRID_COLS;
    const pitchY = (view.height - GUTTER) / GRID_ROWS;

    test("pitch equals cell plus gutter", () => {
      const { cellW, cellH } = cellSize(view);
      expect(pitchX).toBeCloseTo(cellW + GUTTER, 6);
      expect(pitchY).toBeCloseTo(cellH + GUTTER, 6);
    });

    test("every column line lands on a cell's left edge", () => {
      for (let col = 0; col < GRID_COLS; col += 1) {
        const drawn = GUTTER + col * pitchX; // pattern origin + n * pitch
        const actual = rectToPixels(
          { col, row: 0, colSpan: 1, rowSpan: 1 },
          view,
        ).left;
        expect(drawn).toBeCloseTo(actual, 6);
      }
    });

    test("every row line lands on a cell's top edge", () => {
      for (let row = 0; row < GRID_ROWS; row += 1) {
        const drawn = GUTTER + row * pitchY;
        const actual = rectToPixels(
          { col: 0, row, colSpan: 1, rowSpan: 1 },
          view,
        ).top;
        expect(drawn).toBeCloseTo(actual, 6);
      }
    });
  });
});

/**
 * Every rectangle the drag preview shows must be a real cell.
 *
 * The highlight has no transition, so whatever comes out of here is drawn
 * exactly where it lands — an off-grid or out-of-bounds rect would be visible
 * as a box sitting between the lines rather than on them.
 */
describe("resize previews stay on the grid", () => {
  const HANDLES = ["n", "s", "e", "w", "ne", "nw", "se", "sw"] as const;
  const start = { col: 6, row: 4, colSpan: 9, rowSpan: 6 };
  const origin = rectToPixels(start, view);

  for (const handle of HANDLES) {
    test(`handle ${handle}`, () => {
      for (let dx = -600; dx <= 600; dx += 23) {
        for (let dy = -400; dy <= 400; dy += 29) {
          const next = { ...origin };
          if (handle.includes("w")) {
            next.left = origin.left + dx;
            next.width = origin.width - dx;
          }
          if (handle.includes("e")) next.width = origin.width + dx;
          if (handle.includes("n")) {
            next.top = origin.top + dy;
            next.height = origin.height - dy;
          }
          if (handle.includes("s")) next.height = origin.height + dy;

          const r = clampRect(
            pixelsToRect(clampBox(next, handle, view), view),
            "resize",
          );
          const where = `${handle} ${dx},${dy} -> ${JSON.stringify(r)}`;
          expect(
            Number.isInteger(r.col) && Number.isInteger(r.row),
            where,
          ).toBe(true);
          expect(r.colSpan >= MIN_WINDOW_COLS, where).toBe(true);
          expect(r.rowSpan >= MIN_WINDOW_ROWS, where).toBe(true);
          expect(r.col >= 0 && r.row >= 0, where).toBe(true);
          expect(r.col + r.colSpan <= GRID_COLS, where).toBe(true);
          expect(r.row + r.rowSpan <= GRID_ROWS, where).toBe(true);
        }
      }
    });
  }

  test("dragging one edge leaves the opposite edge alone", () => {
    // The two roundings (origin and size) are independent, so this is only
    // true because the edge that is not moving stays on a cell boundary.
    for (let dx = 0; dx <= 200; dx += 1) {
      const dragged = {
        ...origin,
        left: origin.left + dx,
        width: origin.width - dx,
      };
      const r = clampRect(
        pixelsToRect(clampBox(dragged, "w", view), view),
        "resize",
      );
      expect(r.col + r.colSpan).toBe(start.col + start.colSpan);
    }
  });
});
