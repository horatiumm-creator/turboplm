import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { ConfigProvider, theme as antdTheme } from 'antd';

export type ThemeMode = 'light' | 'dark' | 'system';

interface ThemeContextValue {
  /** What the user chose. */
  mode: ThemeMode;
  /** What that resolves to right now — `system` follows the OS and can change under you. */
  resolved: 'light' | 'dark';
  setMode: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const STORAGE_KEY = 'turboplm.theme';
const QUERY = '(prefers-color-scheme: dark)';

function readMode(): ThemeMode {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === 'light' || raw === 'dark' || raw === 'system' ? raw : 'system';
  } catch {
    // Storage can throw outright in private browsing rather than returning null.
    return 'system';
  }
}

function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.(QUERY).matches === true;
}

/**
 * Light/dark theming for the whole app.
 *
 * Three modes, not two. A plain toggle forces a choice the user has usually already made at
 * the OS level, and then ignores it — someone whose machine switches to dark at sunset
 * expects an app that follows, and `system` is the only setting that keeps doing the right
 * thing tomorrow. It is the default for that reason.
 *
 * The OS preference is watched, not just read. Under `system` the query can flip while the
 * app is open, and without the listener the UI stays in whichever mode it happened to load
 * in until the next refresh.
 *
 * Two things are published outside React: `data-theme` on <html>, so the plain CSS in
 * styles.css can respond to a mode that otherwise only exists inside antd's token system;
 * and `color-scheme`, which is what makes scrollbars, form controls and the flash of
 * background during a reload follow the theme instead of staying stubbornly white.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(readMode);
  const [systemDark, setSystemDark] = useState(systemPrefersDark);

  useEffect(() => {
    const mq = window.matchMedia?.(QUERY);
    if (!mq) return;
    const onChange = (e: MediaQueryListEvent): void => setSystemDark(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const resolved: 'light' | 'dark' =
    mode === 'system' ? (systemDark ? 'dark' : 'light') : mode;

  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute('data-theme', resolved);
    root.style.colorScheme = resolved;
  }, [resolved]);

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // The choice still applies for this session; only persistence is lost.
    }
  }, []);

  const value = useMemo(() => ({ mode, resolved, setMode }), [mode, resolved, setMode]);

  return (
    <ThemeContext.Provider value={value}>
      <ConfigProvider
        theme={{
          algorithm: resolved === 'dark' ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
          token: {
            // The brand blue, unchanged by mode. It is mostly a *fill* — button backgrounds,
            // selected rows, focus rings — and a fill wants to stay dark, because what sits on
            // it is white text. Lightening it for dark mode measured worse, not better: button
            // label contrast fell to 4.05:1, under AA, to fix a problem that was never really
            // about the primary colour.
            colorPrimary: '#1e6fd9',
            // Links are the part that genuinely needed lifting, and they are a separate seed.
            // colorInfo does NOT follow colorPrimary, and colorLink derives from colorInfo — so
            // left alone, every link in the app stayed antd's stock #1677ff, measuring 3.55:1
            // against the dark table and failing AA on the one token a reader scans a BOM for.
            // Seeded at #6aa9ff it lands at 5.85:1: antd runs the seed through the dark
            // algorithm rather than using it literally, and the result comes out ~15% darker.
            colorInfo: resolved === 'dark' ? '#6aa9ff' : '#1e6fd9',
            colorLink: resolved === 'dark' ? '#6aa9ff' : '#1e6fd9',
            borderRadius: 6,
            fontFamily:
              "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
          },
        }}
      >
        {children}
      </ConfigProvider>
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside a ThemeProvider');
  return ctx;
}
