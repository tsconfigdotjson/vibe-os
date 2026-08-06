import { useCallback, useRef } from 'react';
import type { LayoutMode } from './usePanes';

export interface SplitterProps {
  layout: Exclude<LayoutMode, 'focus'>;
  ratio: number;
  onRatio: (next: number) => void;
}

const STEP = 0.02;

/**
 * The divider between two panes.
 *
 * Pointer capture rather than window listeners: it keeps the drag alive when
 * the cursor crosses an xterm canvas, which would otherwise swallow the events.
 */
export function Splitter({ layout, ratio, onRatio }: SplitterProps) {
  const ref = useRef<HTMLDivElement>(null);

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    ref.current?.setPointerCapture(event.pointerId);
  }, []);

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const node = ref.current;
      if (!node?.hasPointerCapture(event.pointerId)) return;
      const parent = node.parentElement;
      if (!parent) return;
      const box = parent.getBoundingClientRect();
      const next = layout === 'columns' ? (event.clientX - box.left) / box.width : (event.clientY - box.top) / box.height;
      onRatio(next);
    },
    [layout, onRatio],
  );

  const onPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    ref.current?.releasePointerCapture(event.pointerId);
  }, []);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const back = layout === 'columns' ? 'ArrowLeft' : 'ArrowUp';
      const forward = layout === 'columns' ? 'ArrowRight' : 'ArrowDown';
      if (event.key === back) onRatio(ratio - STEP);
      else if (event.key === forward) onRatio(ratio + STEP);
      else if (event.key === 'Enter') onRatio(0.5);
      else return;
      event.preventDefault();
    },
    [layout, ratio, onRatio],
  );

  return (
    <div
      ref={ref}
      className="splitter"
      data-layout={layout}
      role="separator"
      tabIndex={0}
      aria-orientation={layout === 'columns' ? 'vertical' : 'horizontal'}
      aria-valuenow={Math.round(ratio * 100)}
      aria-valuemin={15}
      aria-valuemax={85}
      aria-label="Resize panes"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={() => onRatio(0.5)}
      onKeyDown={onKeyDown}
    >
      <span className="splitter-grip" aria-hidden="true" />
    </div>
  );
}
