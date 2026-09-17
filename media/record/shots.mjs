/**
 * Capture README screenshots from the live public demo.
 *
 * Deliberately driven against demo.turboplm.com rather than a local instance: the README
 * points people at that URL, so a screenshot taken anywhere else is a promise the demo may
 * not keep. If the shot looks right, the thing the reader clicks through to looks the same.
 *
 * Signs in through the shared read-only account, which is the same door the "Explore the
 * demo" button uses — so this also fails loudly if that path ever breaks.
 *
 *   node media/record/shots.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.DEMO_URL || 'https://demo.turboplm.com';
const EMAIL = process.env.DEMO_EMAIL || 'demo@turboplm.com';
const PASSWORD = process.env.DEMO_PASSWORD || 'explore-turboplm';

// 'dark' or 'light'. Written to localStorage before the app boots, which is where
// ThemeContext reads it from; otherwise the app would follow the runner's system setting.
const THEME = process.env.THEME || 'dark';
// The part the two part shots use. Not every instance numbers its parts the same way.
const PART_PATH = process.env.PART_PATH || '/parts/1';

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../screenshots');
mkdirSync(OUT, { recursive: true });

/** Wide enough that the grouped sidebar and a full BOM table both fit without scrolling. */
const VIEWPORT = { width: 1440, height: 900 };

const SHOTS = [
  { file: 'part-overview.png', path: PART_PATH, wait: null, tab: 'eBOM' },
  // eBOM, not "Bill of Materials" — the tabs are cBOM / eBOM / mBOM, and a name that does
  // not match silently captures whatever tab was already open.
  // Taller viewport: the part header, signature gate and access panel sit above the tab
  // strip, so at 900px the BOM tree is off-screen no matter how it is scrolled — the app
  // scrolls an inner container, not the window.
  { file: 'part-bom.png', path: PART_PATH, wait: '.bom-tree tr.ant-table-row', tab: 'eBOM', height: 2600, element: '.ant-tabs-tabpane-active' },
  { file: 'dashboard.png', path: '/', wait: null, tab: null },
  { file: 'changes.png', path: '/ecns', wait: null, tab: null },
];

// SHOTS=part-bom.png,dashboard.png captures only those files.
const ONLY = process.env.SHOTS ? process.env.SHOTS.split(',') : null;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 2, colorScheme: THEME });
await page.addInitScript((theme) => {
  try { localStorage.setItem('turboplm.theme', theme); } catch { /* private mode */ }
}, THEME);
page.setDefaultTimeout(20000);

try {
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.getByPlaceholder('you@company.com').fill(EMAIL);
  await page.getByPlaceholder('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 });
  console.log('signed in as', EMAIL);

  for (const shot of SHOTS.filter((s) => !ONLY || ONLY.includes(s.file))) {
    if (shot.height) await page.setViewportSize({ ...VIEWPORT, height: shot.height });
    else await page.setViewportSize(VIEWPORT);
    await page.goto(`${BASE}${shot.path}`, { waitUntil: 'networkidle' });
    if (shot.tab) {
      const tab = page.getByRole('tab', { name: shot.tab });
      await tab.click().catch(() => {});
      // Scroll the tab STRIP to the top of the viewport. The part header, signatures and
      // access panels sit above it, so without this the selected tab is visible but its
      // content — the actual bill of materials — is entirely below the fold.
      await tab.scrollIntoViewIfNeeded().catch(() => {});
      await page.mouse.wheel(0, 120);
      // The tree renders after the tab's fetch resolves; without this the shot catches a
      // spinner, which is a worse advertisement than no screenshot at all.
      await page.waitForTimeout(1200);
    }
    if (shot.wait) await page.locator(shot.wait).first().waitFor();
    await page.waitForTimeout(600);
    const out = `${OUT}/${shot.file}`;
    // The eBOM is framed on its own tab so the tree fills the image instead of the part header.
    if (shot.element) await page.locator(shot.element).screenshot({ path: out });
    else await page.screenshot({ path: out });
    console.log('captured', shot.file);
  }
} finally {
  await browser.close();
}
