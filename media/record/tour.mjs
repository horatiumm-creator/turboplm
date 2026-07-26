/**
 * Records a product walkthrough of TurboPLM against the live demo instance.
 * Runs in the Playwright container; video is written to /out.
 *
 *   Read-only demo account, so the tour never mutates demo data.
 */
import { chromium } from 'playwright';

const BASE = process.env.TOUR_BASE || 'https://demo.turboplm.com';
// Credentials come from the environment — never commit them:
//   TOUR_EMAIL=you@example.com TOUR_PASSWORD='…' node tour.mjs
const EMAIL = process.env.TOUR_EMAIL;
const PASSWORD = process.env.TOUR_PASSWORD;

if (!EMAIL || !PASSWORD) {
  console.error(
    'Set TOUR_EMAIL and TOUR_PASSWORD to an account on the target instance before recording.'
  );
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Lower-third caption, injected into the page so it appears in the recording. */
async function caption(page, title, sub = '', hold = 3200) {
  await page.evaluate(
    ([t, s]) => {
      document.getElementById('__cap')?.remove();
      const el = document.createElement('div');
      el.id = '__cap';
      el.innerHTML =
        `<div style="font:600 25px/1.3 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#fff">${t}</div>` +
        (s ? `<div style="font:400 16px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#cfe0f5;margin-top:7px">${s}</div>` : '');
      el.style.cssText =
        'position:fixed;left:40px;bottom:40px;z-index:2147483647;max-width:620px;' +
        'background:linear-gradient(135deg,rgba(11,21,36,.96),rgba(22,44,80,.96));' +
        'padding:18px 24px;border-radius:12px;border-left:4px solid #4d94f0;' +
        'box-shadow:0 14px 40px rgba(0,0,0,.42);opacity:0;transform:translateY(12px);' +
        'transition:opacity .45s ease,transform .45s ease';
      document.body.appendChild(el);
      requestAnimationFrame(() => {
        el.style.opacity = '1';
        el.style.transform = 'translateY(0)';
      });
    },
    [title, sub]
  );
  await sleep(hold);
}

async function clearCaption(page) {
  await page.evaluate(() => {
    const el = document.getElementById('__cap');
    if (!el) return;
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 450);
  });
  await sleep(500);
}

/** Full-bleed title/end card. */
async function card(page, title, sub) {
  await page.evaluate(
    ([t, s]) => {
      const el = document.createElement('div');
      el.id = '__card';
      el.innerHTML =
        `<div style="text-align:center;max-width:760px;padding:0 40px">
           <div style="width:74px;height:74px;border-radius:19px;background:#1e6fd9;color:#fff;
                       display:grid;place-items:center;font:800 40px system-ui;margin:0 auto 26px">T</div>
           <div style="font:800 46px/1.15 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
                       color:#fff;letter-spacing:-.02em">${t}</div>
           <div style="font:400 20px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
                       color:#9fb3cd;margin-top:16px">${s}</div>
         </div>`;
      el.style.cssText =
        'position:fixed;inset:0;z-index:2147483647;background:#0b1524;display:grid;place-items:center;' +
        'opacity:0;transition:opacity .6s ease';
      document.body.appendChild(el);
      requestAnimationFrame(() => (el.style.opacity = '1'));
    },
    [title, sub]
  );
  await sleep(3600);
  await page.evaluate(() => {
    const el = document.getElementById('__card');
    if (!el) return;
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 700);
  });
  await sleep(750);
}

/** Smooth scroll so panning reads well on video. */
async function glide(page, px, steps = 26) {
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, px / steps);
    await sleep(38);
  }
}

const browser = await chromium.launch({ args: ['--force-color-profile=srgb'] });
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  recordVideo: { dir: '/out', size: { width: 1280, height: 800 } },
  colorScheme: 'light',
  ignoreHTTPSErrors: true,
});
const page = await ctx.newPage();

try {
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await sleep(900);
  await card(page, 'TurboPLM', 'Self-hosted product lifecycle management');

  // --- sign in -------------------------------------------------------------
  await caption(page, 'Sign in', 'A read-only guest account is open to everyone', 2600);
  await page.fill('input[type="text"], input[placeholder*="company"]', EMAIL);
  await sleep(500);
  await page.fill('input[type="password"]', PASSWORD);
  await sleep(600);
  await clearCaption(page);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.includes('login'), { timeout: 20000 });
  await page.waitForLoadState('networkidle');
  await sleep(1400);

  // --- dashboard -----------------------------------------------------------
  await caption(page, 'Your product data at a glance', 'Parts, revisions in flight, open changes and process plans', 4000);
  await clearCaption(page);
  await glide(page, 380);
  await sleep(900);

  // --- parts ---------------------------------------------------------------
  await page.goto(`${BASE}/parts`, { waitUntil: 'networkidle' });
  await sleep(1200);
  await caption(page, 'The part master', 'Every part, its category, current revision and lifecycle state', 4200);
  await clearCaption(page);

  // --- BOM tree ------------------------------------------------------------
  await page.goto(`${BASE}/parts/1`, { waitUntil: 'networkidle' });
  await sleep(1500);
  await caption(page, 'Multi-level bill of materials', 'The full product structure — find numbers, quantities, resolved revisions', 4400);
  await clearCaption(page);
  const bom = page.getByRole('tab', { name: /Bill of Materials/i });
  if (await bom.count()) {
    await bom.first().click();
    await sleep(2400);
    await glide(page, 460);
    await sleep(1200);
  }

  // --- BOM compare ---------------------------------------------------------
  await page.goto(`${BASE}/compare?left=1&right=41`, { waitUntil: 'networkidle' });
  await sleep(2600);
  await caption(page, 'Compare any two structures', 'Two revisions, or two different products — added, removed and changed', 4600);
  await clearCaption(page);
  await glide(page, 420);
  await sleep(1000);

  // --- change control ------------------------------------------------------
  await page.goto(`${BASE}/ecns`, { waitUntil: 'networkidle' });
  await sleep(1400);
  await caption(page, 'Engineering change control', 'Every change is a governed object with its own lifecycle', 4000);
  await clearCaption(page);
  await page.goto(`${BASE}/ecns/1`, { waitUntil: 'networkidle' });
  await sleep(1800);
  await caption(page, 'Affected items and dispositions', 'From → to revisions, and what happens to stock already built', 4400);
  await clearCaption(page);
  await glide(page, 620);
  await sleep(1200);

  // --- CAD viewer ----------------------------------------------------------
  await page.goto(`${BASE}/documents`, { waitUntil: 'networkidle' });
  await sleep(1300);
  await caption(page, 'Documents and CAD', 'Versioned files linked to parts, revisions and changes', 3800);
  await clearCaption(page);
  await page.goto(`${BASE}/documents/4`, { waitUntil: 'networkidle' });
  await sleep(4200); // let the 3D viewer initialise
  await caption(page, '3D CAD in the browser', 'STEP, IGES and BREP converted server-side — no plugin, no desktop tool', 4600);
  await clearCaption(page);
  // orbit the model a little
  await page.mouse.move(640, 520);
  await page.mouse.down();
  for (let i = 0; i < 34; i++) {
    await page.mouse.move(640 + i * 7, 520 - i * 2);
    await sleep(34);
  }
  await page.mouse.up();
  await sleep(1500);

  // --- requirements + analytics -------------------------------------------
  await page.goto(`${BASE}/requirements`, { waitUntil: 'networkidle' });
  await sleep(1500);
  await caption(page, 'Requirements traceability', 'Linked to the parts that satisfy them and documents that verify them', 4000);
  await clearCaption(page);

  await page.goto(`${BASE}/analytics`, { waitUntil: 'networkidle' });
  await sleep(1800);
  await caption(page, 'Insight across the programme', 'Change cycle time, BOM health, requirement coverage, cost drivers', 4200);
  await clearCaption(page);
  await glide(page, 400);
  await sleep(1000);

  await card(page, 'Run it yourself', 'Open source · Docker · turboplm.com');
} catch (err) {
  console.error('TOUR ERROR:', err.message);
} finally {
  await ctx.close(); // flushes the video file
  await browser.close();
}
console.log('recording complete');
