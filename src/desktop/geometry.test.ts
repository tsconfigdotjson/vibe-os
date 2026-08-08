import { describe, expect, test } from "bun:test";
import { GRID_COLS, GRID_ROWS } from "../../shared/grid";
import { cellSize, GUTTER, rectToPixels } from "./geometry";

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
