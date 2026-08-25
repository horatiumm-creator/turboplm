import { useCallback, useRef } from 'react';
import type { HTMLAttributes } from 'react';

/**
 * A table header cell you can drag to resize.
 *
 * Hand-rolled rather than pulling in react-resizable. That package is the documented
 * route, but it arrives with its own stylesheet and a peer-dependency chain for behaviour
 * this needs about fifty lines to express — and a BOM table is the only place in the app
 * that wants it.
 *
 * The drag is tracked on `document`, not on the handle. A pointer moving faster than React
 * re-renders will leave the 8px handle behind, and a handler bound to the element simply
 * stops receiving events mid-drag — the column sticks and the user is left holding a mouse
 * button that does nothing. Document-level listeners follow the pointer wherever it goes,
 * including outside the window.
 *
 * Width is reported on every move rather than on release. Resizing a column is a visual
 * judgement — you drag until it looks right — and that is impossible if the column only
 * moves once you let go.
 */
export interface ResizableTitleProps extends HTMLAttributes<HTMLTableCellElement> {
  width?: number;
  onResize?: (width: number) => void;
  /** Below this the header label is unreadable and the handle becomes hard to grab. */
  minWidth?: number;
}

export function ResizableTitle({
  width,
  onResize,
  minWidth = 60,
  children,
  ...rest
}: ResizableTitleProps) {
  const start = useRef<{ x: number; width: number } | null>(null);

  const onMouseDown = useCallback(
    (event: React.MouseEvent<HTMLSpanElement>) => {
      if (width === undefined || !onResize) return;
      // Without this the browser begins a text selection across the header, which paints
      // half the table blue while you drag.
      event.preventDefault();
      event.stopPropagation();
      start.current = { x: event.clientX, width };

      const move = (e: MouseEvent): void => {
        if (!start.current) return;
        const next = Math.max(minWidth, start.current.width + (e.clientX - start.current.x));
        onResize(next);
      };
      const up = (): void => {
        start.current = null;
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };

      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
      // Held for the whole drag: the pointer routinely leaves the 8px handle, and without
      // this the cursor flickers back to default the moment it does.
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    },
    [width, onResize, minWidth]
  );

  // A column with no width (a flexible one) gets no handle: there is nothing meaningful to
  // drag it from, and offering a handle that does nothing is worse than offering none.
  if (width === undefined || !onResize) return <th {...rest}>{children}</th>;

  return (
    <th {...rest} style={{ ...rest.style, position: 'relative' }}>
      {children}
      <span
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize column"
        className="col-resize-handle"
        onMouseDown={onMouseDown}
        onClick={(e) => e.stopPropagation()}
      />
    </th>
  );
}
