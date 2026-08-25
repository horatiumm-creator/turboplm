import { useCallback, useMemo, useState } from 'react';

/**
 * Column widths the user has dragged, remembered across reloads.
 *
 * Persisted deliberately. A column width is a statement about which fields matter to the
 * person reading the table — someone who widens Notes and shrinks Effectivity has told you
 * how they work — and making them re-state it on every page load turns a preference into a
 * chore. It is stored per-table so widening the BOM does not disturb any other grid.
 *
 * localStorage rather than the server: this is a per-device display preference, not org
 * data, and it would be odd for a narrow laptop screen to impose its widths on the same
 * user's desktop.
 *
 * Every read is defensive. localStorage survives deploys, so a value written by an older
 * build outlives the code that wrote it — and a shape change would otherwise crash the
 * table for exactly the users who have used it most. Anything unparseable, wrongly shaped
 * or non-finite is dropped and the defaults stand.
 */
export interface ColumnWidths {
  /** Current width per column key — defaults merged with anything the user has dragged. */
  widths: Record<string, number>;
  /** Record a drag. Pass a key not in the defaults and it is simply kept. */
  setWidth: (key: string, width: number) => void;
  /** Forget every customisation for this table and fall back to the defaults. */
  reset: () => void;
  /** True when at least one column differs from its default — gates the reset control. */
  customised: boolean;
}

function read(storageKey: string): Record<string, number> {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      // NaN and Infinity both round-trip through JSON as null, but a hand-edited or
      // half-written value can still arrive as a string. A bad width does not throw — it
      // collapses the column to nothing, which reads as data loss.
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) out[key] = value;
    }
    return out;
  } catch {
    // Private browsing modes and storage-blocking extensions throw on access rather than
    // returning null. The table must still render.
    return {};
  }
}

export function useColumnWidths(
  storageKey: string,
  defaults: Record<string, number>
): ColumnWidths {
  const [stored, setStored] = useState<Record<string, number>>(() => read(storageKey));

  const persist = useCallback(
    (next: Record<string, number>) => {
      setStored(next);
      try {
        if (Object.keys(next).length === 0) localStorage.removeItem(storageKey);
        else localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        // Quota exceeded or storage denied. The widths still apply for this session; the
        // only thing lost is that they will not survive a reload, which is not worth an
        // error message over.
      }
    },
    [storageKey]
  );

  const setWidth = useCallback(
    (key: string, width: number) => {
      // Functional update: a drag fires on every mouse move, and reading `stored` from the
      // closure would work from a snapshot that is already several frames stale.
      setStored((prev) => {
        const next = { ...prev, [key]: width };
        try {
          localStorage.setItem(storageKey, JSON.stringify(next));
        } catch {
          /* see persist */
        }
        return next;
      });
    },
    [storageKey]
  );

  const reset = useCallback(() => persist({}), [persist]);

  const widths = useMemo(() => ({ ...defaults, ...stored }), [defaults, stored]);
  const customised = Object.keys(stored).length > 0;

  return { widths, setWidth, reset, customised };
}
