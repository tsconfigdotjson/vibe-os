import { GRID_COLS, GRID_ROWS, rectToPixels, type Viewport } from './geometry';
import type { Rect } from './useWindows';

export interface GridOverlayProps {
  /** The cell a dragged window would land in, or null when nothing is moving. */
  preview: Rect | null;
  view: Viewport;
}

/**
 * The grid only exists while you are moving something.
 *
 * Showing it permanently would make the desktop look like a wireframe; showing
 * it never would leave snapping feeling arbitrary. Fading it in during a drag,
 * with the destination lit up, makes the rule visible exactly when it applies.
 */
export function GridOverlay({ preview, view }: GridOverlayProps) {
  if (!preview) return null;
  const box = rectToPixels(preview, view);

  return (
    <div className="grid-overlay" aria-hidden="true">
      <svg width="100%" height="100%">
        <defs>
          <pattern
            id="vibe-grid"
            width={(view.width - 10) / GRID_COLS}
            height={(view.height - 10) / GRID_ROWS}
            patternUnits="userSpaceOnUse"
          >
            <path
              d={`M ${(view.width - 10) / GRID_COLS} 0 L 0 0 0 ${(view.height - 10) / GRID_ROWS}`}
              fill="none"
              stroke="currentColor"
              strokeWidth="1"
            />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#vibe-grid)" />
      </svg>
      <div
        className="grid-target"
        style={{ transform: `translate(${box.left}px, ${box.top}px)`, width: box.width, height: box.height }}
      />
    </div>
  );
}
