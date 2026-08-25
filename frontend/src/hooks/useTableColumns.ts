import { useCallback, useMemo, useState } from 'react';

/**
 * Per-table column preferences — widths the user has dragged, and columns they have hidden —
 * remembered across reloads.
 *
 * Persisted deliberately. Both settings are statements about how someone works: a buyer who
 * widens Notes and hides Effectivity has told you what they read a BOM for, and making them
 * re-state it on every page load turns a preference into a chore.
 *
 * Widths and visibility share one record, and one reset. They are the same decision viewed
 * two ways — "this column matters to me" — and splitting them would give the user two
 * controls to hunt down when a table ends up in a state they want out of.
 *
 * localStorage rather than the server: these are per-device display preferences, not org
 * data, and it would be odd for a narrow laptop to impose its layout on the same user's
 * desktop.
 *
 * Every read is defensive. localStorage survives deploys, so a value written by an older
 * build outlives the code that wrote it — and a shape change would otherwise break the table
 * for exactly the users who have used it most. Anything unparseable, wrongly shaped or
 * non-finite is dropped and the defaults stand.
 */
interface StoredPrefs {
  widths: Record<string, number>;
  hidden: string[];
}

export interface TableColumnPrefs {
  /** Current width per column key: the defaults, overlaid with anything the user dragged. */
  widths: Record<string, number>;
  /** Column keys the user has switched off. */
  hidden: ReadonlySet<string>;
  /** Record a drag. */
  setWidth: (key: string, width: number) => void;
  /** Switch one column on or off. */
  setVisible: (key: string, visible: boolean) => void;
  /** Forget every customisation for this table. */
  reset: () => void;
  /** True when anything differs from the defaults — gates the reset control. */
  customised: boolean;
}

const EMPTY: StoredPrefs = { widths: {}, hidden: [] };

function read(storageKey: string): StoredPrefs {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return EMPTY;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return EMPTY;
    const record = parsed as Record<string, unknown>;

    // An earlier build stored a bare {key: width} map under this same key. Read it as widths
    // rather than versioning the key and stranding it — a user who had already sized their
    // columns should not silently lose that to an upgrade.
    const widthSource =
      'widths' in record || 'hidden' in record ? record.widths : (record as unknown);

    const widths: Record<string, number> = {};
    if (typeof widthSource === 'object' && widthSource !== null && !Array.isArray(widthSource)) {
      for (const [key, value] of Object.entries(widthSource as Record<string, unknown>)) {
        // A bad width does not throw — it collapses the column to nothing, which reads to the
        // user as data loss rather than as a corrupt preference.
        if (typeof value === 'number' && Number.isFinite(value) && value > 0) widths[key] = value;
      }
    }

    const hidden = Array.isArray(record.hidden)
      ? record.hidden.filter((k): k is string => typeof k === 'string')
      : [];

    return { widths, hidden };
  } catch {
    // Private browsing and storage-blocking extensions throw on access rather than returning
    // null. The table must still render.
    return EMPTY;
  }
}

function write(storageKey: string, prefs: StoredPrefs): void {
  try {
    if (Object.keys(prefs.widths).length === 0 && prefs.hidden.length === 0) {
      localStorage.removeItem(storageKey);
    } else {
      localStorage.setItem(storageKey, JSON.stringify(prefs));
    }
  } catch {
    // Quota exceeded or storage denied. The preference still applies for this session; all
    // that is lost is surviving a reload, which is not worth interrupting anyone over.
  }
}

export function useTableColumns(
  storageKey: string,
  defaultWidths: Record<string, number>
): TableColumnPrefs {
  const [prefs, setPrefs] = useState<StoredPrefs>(() => read(storageKey));

  // Functional updates throughout: a resize drag fires on every mouse move, and reading
  // `prefs` from the closure would work from a snapshot several frames stale.
  const update = useCallback(
    (fn: (prev: StoredPrefs) => StoredPrefs) => {
      setPrefs((prev) => {
        const next = fn(prev);
        write(storageKey, next);
        return next;
      });
    },
    [storageKey]
  );

  const setWidth = useCallback(
    (key: string, width: number) =>
      update((prev) => ({ ...prev, widths: { ...prev.widths, [key]: width } })),
    [update]
  );

  const setVisible = useCallback(
    (key: string, visible: boolean) =>
      update((prev) => ({
        ...prev,
        hidden: visible ? prev.hidden.filter((k) => k !== key) : [...new Set([...prev.hidden, key])],
      })),
    [update]
  );

  const reset = useCallback(() => update(() => ({ widths: {}, hidden: [] })), [update]);

  const widths = useMemo(
    () => ({ ...defaultWidths, ...prefs.widths }),
    [defaultWidths, prefs.widths]
  );
  const hidden = useMemo(() => new Set(prefs.hidden), [prefs.hidden]);
  const customised = Object.keys(prefs.widths).length > 0 || prefs.hidden.length > 0;

  return { widths, hidden, setWidth, setVisible, reset, customised };
}
