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

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../screenshots');
mkdirSync(OUT, { recursive: true });

/** Wide enough that the grouped sidebar and a full BOM table both fit without scrolling. */
const VIEWPORT = { width: 1440, height: 900 };

const SHOTS = [
  { file: 'part-overview.png', path: '/parts/1', wait: null, tab: null },
  // eBOM, not "Bill of Materials" — the tabs are cBOM / eBOM / mBOM, and a name that does
  // not match silently captures whatever tab was already open.
  // Taller viewport: the part header, signature gate and access panel sit above the tab
  // strip, so at 900px the BOM tree is off-screen no matter how it is scrolled — the app
  // scrolls an inner container, not the window.
  { file: 'part-bom.png', path: '/parts/1', wait: null, tab: 'eBOM', height: 1700 },
  { file: 'dashboard.png', path: '/', wait: null, tab: null },
  { file: 'changes.png', path: '/ecns', wait: null, tab: null },
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 2 });
page.setDefaultTimeout(20000);

try {
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.getByPlaceholder('you@company.com').fill(EMAIL);
  await page.getByPlaceholder('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 });
  console.log('signed in as', EMAIL);

  for (const shot of SHOTS) {
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
    await page.waitForTimeout(600);
    const out = `${OUT}/${shot.file}`;
    await page.screenshot({ path: out });
    console.log('captured', shot.file);
  }
} finally {
  await browser.close();
}
