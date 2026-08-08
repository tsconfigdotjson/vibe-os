import { GRID_COLS, GRID_ROWS } from "../../shared/grid";
import { GUTTER, rectToPixels, type Viewport } from "./geometry";
import type { Rect } from "./useWindows";

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
  const pitchX = (view.width - GUTTER) / GRID_COLS;
  const pitchY = (view.height - GUTTER) / GRID_ROWS;

  return (
    <div className="grid-overlay" aria-hidden="true">
      <svg width="100%" height="100%" role="presentation">
        <defs>
          <pattern
            id="vibe-grid"
            // The pitch is cell + gutter, and the first cell starts one gutter
            // in — see rectToPixels. Without x/y the lines sat a gutter to the
            // left of and above the boundaries they were drawn to show, which
            // is the one thing this overlay exists to communicate.
            x={GUTTER}
            y={GUTTER}
            width={pitchX}
            height={pitchY}
            patternUnits="userSpaceOnUse"
          >
            <path
              d={`M ${pitchX} 0 L 0 0 0 ${pitchY}`}
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
        style={{
          transform: `translate(${box.left}px, ${box.top}px)`,
          width: box.width,
          height: box.height,
        }}
      />
    </div>
  );
}
