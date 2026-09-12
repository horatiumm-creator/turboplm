/**
 * Records a product walkthrough of TurboPLM against a live instance.
 * Runs in the Playwright container; video is written to /out.
 *
 * The script only ever reads: it navigates, opens tabs and scrolls, and never submits a
 * form. That is a property of the script, not of the account — no read-only account is
 * assumed, required, or claimed on screen.
 *
 * Nothing here is addressed by a hardcoded entity id. Ids differ between instances, and a
 * tour that opens /parts/85 on a database that has 38 parts records a confident narration
 * over "Could not load part". Every subject is discovered at runtime from the list page
 * that leads to it, exactly the way a viewer would reach it. Four optional environment
 * variables pin a specific fixture when you have one; each falls back to list discovery
 * when it is unset or does not resolve:
 *
 *   TOUR_TOP_PART    part id whose eBOM has a level below its own children
 *   TOUR_CAD_DOC     document id whose latest version is a STEP / IGES / BREP file
 *   TOUR_SIGNED_ECN  ECN id carrying at least one executed signature
 *   TOUR_TRACE_UNIT  build unit id — a lot — that ended up inside shipped units
 *
 * Every caption goes through beat(), which evaluates a check against the frame that is
 * already on screen and drops the caption when the frame cannot show what the words
 * claim. A skipped beat makes a shorter tour; a false beat makes a worse one.
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
async function caption(page, title, sub = '', hold = 2800) {
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
  await sleep(380);
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
  await sleep(2400);
  await page.evaluate(() => {
    const el = document.getElementById('__card');
    if (!el) return;
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 700);
  });
  await sleep(600);
}

/** Smooth scroll so panning reads well on video. Only for "pan across a page" beats. */
async function glide(page, px, steps = 18) {
  // The wheel is dispatched at the CURRENT pointer position. Left alone that is (0,0) — the
  // nav rail — or, after orbit(), inside the CAD canvas, whose OrbitControls swallow the
  // event and zoom the model instead of scrolling the page. Park it over the content first.
  await page.mouse.move(660, 420).catch(() => {});
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, px / steps);
    await sleep(38);
  }
}

// ---------------------------------------------------------------------------
// The guard
// ---------------------------------------------------------------------------

const skipped = [];

/** Resolves a check to a boolean. A check that throws is a frame we cannot vouch for. */
async function ok(check) {
  try {
    return Boolean(typeof check === 'function' ? await check() : await check);
  } catch {
    return false;
  }
}

/**
 * The only way a caption reaches the recording.
 *
 * `check` is evaluated against the frame that is already on screen — after the tab click,
 * after the scroll, after the element is in view — and the caption is dropped when it
 * fails. One mechanism for every scene, so no beat can quietly grow its own exception.
 */
async function beat(page, check, title, sub = '', hold = 2600) {
  if (!(await ok(check))) {
    skipped.push(title);
    console.log(`skip: ${title}`);
    return false;
  }
  await caption(page, title, sub, hold);
  await clearCaption(page);
  return true;
}

/** A scene may degrade; it may never take the recording down with it. */
async function safely(label, fn) {
  try {
    await fn();
  } catch (err) {
    console.error(`scene "${label}" degraded: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Locator plumbing — every one of these swallows its own failure
// ---------------------------------------------------------------------------

/** Every read of the page is short-fused: discovery must not be able to stall a recording. */
const READ = { timeout: 3000 };

async function count(locator) {
  try {
    return await locator.count();
  } catch {
    return 0;
  }
}

async function has(locator) {
  return (await count(locator)) > 0;
}

/** Data rows only — antd renders its empty state as .ant-table-placeholder, not a row. */
const rows = (page) => page.locator('.ant-table-row');

/** Rows carrying a tag with exactly this label (category, kind, status …). */
function rowsTagged(page, label) {
  return rows(page).filter({ has: page.getByText(label, { exact: true }) });
}

/** A card located by its own head title, so an enclosing card cannot be mistaken for it. */
function cardTitled(page, title, scope = page) {
  return scope
    .locator('.ant-card')
    .filter({ has: page.locator('.ant-card-head-title', { hasText: title }) });
}

async function go(page, path) {
  const url = path.startsWith('http') ? path : `${BASE}${path}`;
  try {
    // domcontentloaded, not networkidle: with 24 navigations, a page that polls would
    // otherwise burn 20 s of recorded dead air each time. The settle sleep below covers
    // the paint, and networkidle is then a best-effort nicety.
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForLoadState('networkidle', { timeout: 2500 }).catch(() => {});
  } catch (err) {
    // A page that keeps polling — a document with a conversion still running, say — never
    // reaches networkidle, and its DOM is perfectly fine. Only a page that did not arrive
    // at all is a failure, and that is a question about the path, not about the timeout.
    let arrived = false;
    try {
      arrived = new URL(page.url()).pathname === new URL(url).pathname;
    } catch {
      arrived = false;
    }
    if (!arrived) {
      console.error(`navigation to ${path} failed: ${err.message}`);
      return false;
    }
  }
  await sleep(650);
  return true;
}

/** Brings the element the caption is about into frame, and centres it for the camera. */
async function reveal(locator) {
  try {
    const el = locator.first();
    await el.scrollIntoViewIfNeeded({ timeout: 4000 });
    await el.evaluate(
      (node) => node.scrollIntoView({ behavior: 'smooth', block: 'center' }),
      undefined,
      READ
    );
    await sleep(700);
    return true;
  } catch {
    return false;
  }
}

/**
 * Opens a tab by label. Tabs that do not fit the strip live behind the overflow button,
 * where a plain click would time out.
 */
async function openTab(page, name) {
  try {
    const tab = page.getByRole('tab', { name });
    if ((await count(tab)) > 0 && (await tab.first().isVisible())) {
      await tab.first().click({ timeout: 5000 });
      await sleep(1200);
      return true;
    }
    const more = page.locator('.ant-tabs-nav-more');
    if ((await count(more)) === 0 || !(await more.first().isVisible())) return false;
    await more.first().click({ timeout: 5000 });
    await sleep(400);
    const item = page.locator('.ant-tabs-dropdown-menu-item').filter({ hasText: name });
    if ((await count(item)) === 0) {
      await page.keyboard.press('Escape');
      return false;
    }
    await item.first().click({ timeout: 5000 });
    await sleep(1200);
    return true;
  } catch {
    return false;
  }
}

/** The hrefs of the first `limit` matching rows — ids are read off the UI, never guessed. */
async function rowHrefs(page, locator, limit = 3) {
  const out = [];
  let n = 0;
  try {
    n = Math.min(await locator.count(), limit);
  } catch {
    return out;
  }
  for (let i = 0; i < n; i++) {
    // Per row, NOT around the loop: a single row without a link used to cost its auto-wait
    // and then abandon every row after it, silently emptying the candidate list and
    // deleting whole scenes downstream.
    try {
      const link = locator.nth(i).getByRole('link').first();
      const href = await link.getAttribute('href', READ);
      if (href && !out.includes(href)) out.push(href);
    } catch {
      /* this row has no link; the next one might */
    }
  }
  return out;
}

/** Column index of a header, so a row can be read by what the column means. */
async function headerIndex(page, label) {
  try {
    const ths = page.locator('.ant-table-thead').first().locator('th');
    const n = await ths.count();
    for (let i = 0; i < n; i++) {
      if ((await ths.nth(i).innerText(READ)).trim() === label) return i;
    }
  } catch {
    /* fall through */
  }
  return -1;
}

/** First row whose numeric cell under `header` satisfies `pred`, as an href. */
async function rowHrefWhere(page, header, pred, limit = 20) {
  try {
    const index = await headerIndex(page, header);
    if (index < 0) return null;
    const all = rows(page);
    const n = Math.min(await all.count(), limit);
    for (let i = 0; i < n; i++) {
      const row = all.nth(i);
      const cells = row.locator('td');
      if ((await cells.count()) <= index) continue;
      const value = Number.parseFloat((await cells.nth(index).innerText(READ)).trim());
      if (Number.isFinite(value) && pred(value)) {
        return await row.getByRole('link').first().getAttribute('href', READ);
      }
    }
  } catch {
    /* fall through */
  }
  return null;
}

const idOf = (href) => {
  const match = /\/(\d+)(?:[?#].*)?$/.exec(href ?? '');
  return match ? match[1] : null;
};

/** Orbits whatever is under the pointer, and always releases the button. */
async function orbit(page, target) {
  let box = null;
  try {
    box = await target.boundingBox(READ);
  } catch {
    return;
  }
  if (!box) return;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  try {
    await page.mouse.move(x, y);
    await page.mouse.down();
    for (let i = 0; i < 26; i++) {
      await page.mouse.move(x + i * 9, y - i * 3);
      await sleep(30);
    }
  } catch {
    /* the model simply does not orbit */
  } finally {
    try {
      await page.mouse.up();
    } catch {
      /* nothing left to release */
    }
  }
  await sleep(600);
}

const EBOM_TAB = /^(eBOM|Bill of Materials)$/i;
/** Extensions the CAD service can actually read a structure or geometry out of. */
const CAD_FILE = /\.(step|stp|iges|igs|brep|brp)\b/i;

// ---------------------------------------------------------------------------
// Scenes
// ---------------------------------------------------------------------------

async function signIn(page) {
  try {
    await page.fill('input[type="text"], input[placeholder*="company"]', EMAIL);
    await sleep(400);
    await page.fill('input[type="password"]', PASSWORD);
    await sleep(450);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => !u.pathname.includes('login'), { timeout: 20000 });
    // Reaching a non-login URL IS the success condition. The app polls notifications
    // every 30 s, so networkidle may never arrive — waiting on it unqualified would
    // throw after 30 s and abandon the entire tour on a session that is perfectly live.
    await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});
    await sleep(900);
    return true;
  } catch (err) {
    console.error(`sign-in failed: ${err.message}`);
    return false;
  }
}

/**
 * The product structure. The part is resolved by walking the part master for an assembly
 * whose eBOM actually has a level below its own children — "multi-level" is a claim about
 * the table, so the table is what decides whether it is made.
 *
 * Returns the path of the part it settled on, so later scenes can reuse it.
 */
async function partScene(page) {
  const candidates = [];
  if (process.env.TOUR_TOP_PART) candidates.push(`/parts/${process.env.TOUR_TOP_PART}`);
  candidates.push(...(await rowHrefs(page, rowsTagged(page, 'Assembly'), 3)));
  if (candidates.length === 0) candidates.push(...(await rowHrefs(page, rows(page), 1)));

  const pane = page.locator('.ant-tabs-tabpane-active');
  let deep = null; // has grandchildren — the caption's claim
  let flat = null; // has a BOM at all — good enough for the rest of the scene
  let current = null;

  for (const href of candidates) {
    if (!(await go(page, href))) continue;
    current = href;
    if (!(await openTab(page, EBOM_TAB))) continue;
    if (await has(pane.locator('.ant-table-row-level-1'))) {
      deep = href;
      break;
    }
    if (!flat && (await has(pane.locator('.ant-table-row')))) flat = href;
  }

  const partPath = deep ?? flat;
  if (!partPath) return null;
  if (partPath !== current) {
    if (!(await go(page, partPath))) return null;
    await openTab(page, EBOM_TAB);
  }

  // PartDetail opens on Overview with destroyInactiveTabPane, so the BOM table is not even
  // in the DOM until the tab above has been clicked. The caption follows the table, never
  // the other way round.
  await reveal(pane.locator('.ant-table').first());
  await beat(
    page,
    () => has(pane.locator('.ant-table-row-level-1')),
    'Multi-level bill of materials',
    'The full product structure — find numbers, quantities, resolved revisions',
    2600
  );
  await glide(page, 380);
  await sleep(400);

  // The Access card sits above the tabs. An "Open" card must not be narrated as a locked
  // one, so the headline follows what the card actually says.
  const accessHead = page.locator('.ant-card-head-title').filter({ hasText: 'Access' });
  await reveal(accessHead);
  const restricted = await count(accessHead.getByText('Restricted'));
  // antd paints a Card's head while its body is still a skeleton, so head-presence alone
  // would let this narrate a loading spinner — and worse, read as "Open" before the ACL
  // fetch resolves. Require the card to have settled.
  const accessCard = accessHead.locator('xpath=ancestor::div[contains(@class,"ant-card")][1]');
  await beat(
    page,
    async () => (await has(accessHead)) && !(await has(accessCard.locator('.ant-skeleton'))),
    restricted ? 'Restricted to a named list' : 'Who is allowed to see this',
    'Grant an item to people or groups — everyone else gets a 404, and a restricted child in a BOM is redacted, never quietly dropped',
    2700
  );

  // Nothing to narrate if this part declares no stock material.
  if (await openTab(page, /^Materials$/i)) {
    await reveal(pane.locator('.ant-table').first());
    await beat(
      page,
      () => has(pane.locator('.ant-table-row')),
      'What it is actually made of',
      'Stock material, net quantity and a scrap factor, declared on the part itself',
      2400
    );
  }

  // The roll-up card sits under the routing table on the manufacturing tab.
  if (await openTab(page, /mBOM/i)) {
    const requirements = page
      .locator('.ant-card-head-title')
      .filter({ hasText: 'Material requirements' });
    await reveal(requirements);
    await beat(
      page,
      // Rows, not chrome. The card has three ways to show nothing — a loading skeleton, an
      // error Alert, and the empty state — and only the third carries that empty text, so
      // checking for its absence would still narrate a spinner or a failed fetch.
      () =>
        has(
          requirements
            .locator('xpath=ancestor::div[contains(@class,"ant-card")][1]')
            .locator('.ant-table-row')
        ),
      'Gross demand for a build quantity',
      'Net times scrap, summed over the whole structure — parts with no material declared are listed as gaps, not silently zeroed',
      2700
    );
  }

  return partPath;
}

/** Change control, the diff it links to, and the signatures on it. */
async function changeScene(page) {
  if (!(await go(page, '/ecns'))) return;
  await beat(
    page,
    () => has(rows(page)),
    'Engineering change control',
    'Every change is a governed object with its own lifecycle',
    2400
  );

  const ecnHrefs = await rowHrefs(page, rows(page), 4);
  if (ecnHrefs.length === 0) return;
  if (!(await go(page, ecnHrefs[0]))) return;

  // Affected parts is the fourth card down, well below the fold on arrival. Scroll first,
  // caption second — the reverse narrates the header block.
  const affected = cardTitled(page, 'Affected parts');
  await reveal(affected);
  await beat(
    page,
    () => has(affected.locator('.ant-table-row')),
    'Affected items and dispositions',
    'From → to revisions, and what happens to stock already built',
    2600
  );

  // The compare link is built by the ECN item out of its own from/to revisions, so both
  // ids come from the row rather than from a guess about what the database holds.
  const compareLink = page.locator('a[href*="/compare?left="]');
  if (await has(compareLink)) {
    await reveal(compareLink);
    try {
      await compareLink.first().click({ timeout: 5000 });
      await page.waitForLoadState('networkidle', { timeout: 20000 });
      await sleep(1100);
    } catch (err) {
      console.error(`compare link did not open: ${err.message}`);
    }
    const summary = page.locator('.ant-statistic-title').filter({ hasText: 'Added' });
    await beat(
      page,
      async () => (await has(summary)) && (await has(rows(page))),
      'Compare any two structures',
      'Two revisions, or two different products — added, removed and changed',
      2600
    );
    await glide(page, 420);
    await sleep(400);
  }

  // SignaturePanel renders nothing at all on an empty manifest, and an unsigned row shows
  // "not signed" — so the beat needs an executed signature, not merely the panel.
  const signatureCandidates = [];
  if (process.env.TOUR_SIGNED_ECN) {
    signatureCandidates.push(`/ecns/${process.env.TOUR_SIGNED_ECN}`);
  }
  signatureCandidates.push(...ecnHrefs.slice(0, 3));

  for (const href of signatureCandidates) {
    if (!(await go(page, href))) continue;
    const signatures = cardTitled(page, 'Signatures');
    if (!(await has(signatures))) continue;
    const executed = signatures.locator('.ant-tag', { hasText: /^Signed$/ });
    if (!(await has(executed))) continue;
    await reveal(signatures);
    await beat(
      page,
      () => has(executed),
      'Signatures that mean something',
      'Password re-entry at signing, and the signature voids itself if the signed content changes',
      3000
    );
    break;
  }
}

/** The vault, the viewer, the redline thread, and the cBOM of whatever the viewer showed. */
async function vaultScene(page) {
  if (!(await go(page, '/documents'))) return null;
  await beat(
    page,
    () => has(rows(page)),
    'Documents and CAD',
    'Versioned files linked to parts, revisions and changes',
    2400
  );

  // Everything this scene opens is discovered here, before the first navigation takes us
  // off the list.
  const heldHrefs = await rowHrefs(page, rows(page).filter({ hasText: /Checked out/i }), 1);
  const cadHrefs = await rowHrefs(page, rows(page).filter({ hasText: CAD_FILE }), 2);
  const anyHrefs = await rowHrefs(page, rows(page), 4);

  // Prefer a document somebody is genuinely holding — the lock bar is the frame that makes
  // the point. Otherwise the vault column on the list is what is actually on screen, and
  // the caption says only that.
  const onHeldDoc = heldHrefs.length > 0 && (await go(page, heldHrefs[0]));
  if (onHeldDoc) {
    await beat(
      page,
      () => has(page.getByText(/Checked out by|You checked it out/i)),
      'Check it out before you change it',
      'Two engineers can never both hold the lock, and breaking one takes an admin and a written reason',
      2600
    );
  } else {
    await beat(
      page,
      async () =>
        (await has(rows(page))) &&
        (await has(page.locator('.ant-table-thead th', { hasText: 'Vault' }))),
      'Every document is a vault item',
      'A vault column on every row: available, or checked out and by whom',
      2400
    );
  }

  // --- the viewer ----------------------------------------------------------
  const cadCandidates = [];
  if (process.env.TOUR_CAD_DOC) cadCandidates.push(`/documents/${process.env.TOUR_CAD_DOC}`);
  cadCandidates.push(...cadHrefs);

  let cadDoc = null;
  for (const href of cadCandidates) {
    if (!(await go(page, href))) continue;
    await sleep(2200); // the 3D viewer is lazy-loaded and fetches its geometry
    const canvas = page.locator('canvas');
    if (!(await has(canvas))) continue;
    // Fit is disabled while the geometry is still loading and while an error is showing,
    // so an enabled Fit is the page's own statement that a model is on screen.
    const fit = page.getByRole('button', { name: 'Fit' });
    if ((await count(fit)) === 0) continue;
    if (!(await ok(() => fit.first().isEnabled(READ)))) continue;
    cadDoc = href;
    break;
  }

  if (cadDoc) {
    const canvas = page.locator('canvas').first();
    await reveal(canvas);
    await beat(
      page,
      () => has(page.locator('canvas')),
      '3D CAD in the browser',
      'STEP, IGES and BREP converted server-side — no plugin, no desktop tool',
      2600
    );
    await orbit(page, canvas);
  }

  // --- the redline thread --------------------------------------------------
  // The thread sits beside the viewer it annotates, so the beat is a nudge into frame
  // rather than a navigation — but only onto a version that actually carries markups.
  const reviewCandidates = [...new Set([cadDoc, ...heldHrefs, ...anyHrefs].filter(Boolean))];
  const emptyThread = page.getByText('No markups on this version yet');
  for (const href of reviewCandidates.slice(0, 4)) {
    if (!(await go(page, href))) continue;
    const review = cardTitled(page, 'Preview & design review');
    if (!(await has(review))) continue;
    if (await has(emptyThread)) continue;
    await reveal(review);
    await glide(page, 300);
    await sleep(300);
    await beat(
      page,
      async () => (await has(review)) && !(await has(emptyThread)),
      'Redlines that go somewhere',
      'Pin a comment to the geometry, thread it, resolve it — or escalate it straight into a change request',
      2700
    );
    break;
  }

  return cadDoc;
}

/**
 * The cBOM, reached the way a user reaches it: from the CAD document, through the part it
 * is linked to. That link is also the guarantee the part has a readable model at all. The
 * part from the structure scene is the fallback, where the tab's own empty state ("No
 * readable CAD model is linked to this part") is what stops the caption.
 */
async function cbomScene(page, cadDoc, fallbackPart) {
  let partPath = null;
  if (cadDoc && (await go(page, cadDoc))) {
    const linked = cardTitled(page, 'Linked to').locator('a[href^="/parts/"]');
    if (await has(linked)) partPath = await linked.first().getAttribute('href', READ);
  }
  if (!partPath) partPath = fallbackPart;
  if (!partPath) return;

  if (!(await go(page, partPath))) return;
  if (!(await openTab(page, /^cBOM$/i))) return;
  await sleep(1400);

  const pane = page.locator('.ant-tabs-tabpane-active');
  const structure = cardTitled(page, 'CAD structure', pane);
  await reveal(structure);
  await beat(
    page,
    () => has(structure.locator('.ant-table-row')),
    'The CAD BOM, as its own structure',
    'Read out of the STEP file and versioned with it — products matched to parts automatically',
    2600
  );

  // Two views, and the caption says two: this card reconciles the model against the
  // released eBOM. The manufacturing side is BomReconciliationCard, on the mBOM tab.
  const recon = cardTitled(page, 'cBOM ↔ eBOM', pane);
  await reveal(recon);
  await beat(
    page,
    () => has(recon.locator('.ant-table-row')),
    'Design and engineering, reconciled',
    'What was modelled against what was released — every difference called out line by line',
    2800
  );
}

/** As-built, the recall query, and the field. */
async function buildScene(page) {
  if (!(await go(page, '/build-units'))) return;
  const unitHrefs = await rowHrefs(page, rows(page), 3);
  const lotHrefs = await rowHrefs(page, rowsTagged(page, 'Lot'), 3);

  // The as-built consumption record is not a column on the list — it is a card on the
  // unit — so the caption follows us onto the unit that has one.
  for (const href of unitHrefs) {
    if (!(await go(page, href))) continue;
    const asBuilt = cardTitled(page, 'As-built record');
    if (!(await has(asBuilt.locator('.ant-table-row')))) continue;
    await reveal(asBuilt);
    await beat(
      page,
      () => has(asBuilt.locator('.ant-table-row')),
      'What was actually built',
      'Serialised units and lots, with the as-built record of everything consumed into them',
      2400
    );
    break;
  }

  // The recall query is the point of the module, so it gets the longest beat — and the
  // strictest guard: the caption asserts a LOT, and that shipped serials came back.
  const traceCandidates = [];
  if (process.env.TOUR_TRACE_UNIT) traceCandidates.push(process.env.TOUR_TRACE_UNIT);
  traceCandidates.push(...lotHrefs.map(idOf).filter(Boolean));

  for (const unit of traceCandidates) {
    if (!(await go(page, `/traceability?unit=${unit}`))) continue;
    await sleep(900);
    const kindIsLot = page
      .locator('.ant-descriptions-item')
      .filter({ hasText: 'Kind' })
      .getByText('Lot', { exact: true });
    if (!(await has(kindIsLot))) continue;
    const shipped = cardTitled(page, 'Shipped units to act on');
    if (!(await has(shipped.locator('.ant-table-row')))) continue;
    await reveal(shipped);
    await beat(
      page,
      async () => (await has(kindIsLot)) && (await has(shipped.locator('.ant-table-row'))),
      'A lot is suspect. What shipped with it?',
      'Trace forward through every unit it ended up in — the shipped serials are the recall list',
      3200
    );
    break;
  }

  if (!(await go(page, '/service'))) return;
  await beat(
    page,
    () => has(rows(page)),
    'And then the field happened',
    'Repairs, upgrades and inspections logged against the serial that actually shipped',
    2400
  );

  // A record with swapCount 0 renders an empty swaps section, and the list already exposes
  // the count — so the row is chosen by the column instead of by position.
  const swapHref = await rowHrefWhere(page, 'Swaps', (n) => n > 0);
  if (swapHref && (await go(page, swapHref))) {
    const swaps = cardTitled(page, 'Part swaps');
    await reveal(swaps);
    await beat(
      page,
      () => has(swaps.locator('.ant-table-row')),
      'A swap rewrites the as-built record',
      'So a unit&rsquo;s genealogy and its service history can never drift apart',
      2600
    );
  }
}

/** Supplier portal, catalog import, requirements, analytics. */
async function businessScene(page) {
  // The invite control and the portal state live on the RFQ, never on the list.
  if (await go(page, '/rfqs')) {
    const rfqHrefs = await rowHrefs(page, rows(page), 1);
    if (rfqHrefs.length > 0 && (await go(page, rfqHrefs[0]))) {
      const invited = cardTitled(page, 'Suppliers invited');
      await reveal(invited);
      await beat(
        page,
        () => has(invited),
        'Quotes without email ping-pong',
        'Invite a supplier and they get their own scoped login — their prices, never a competitor&rsquo;s',
        2600
      );
    }
  }

  // A COMMITTED import shows the opposite of "nothing is written until you commit", and a
  // DRAFT one has no validated rows at all — so the row is picked by its status tag.
  if (await go(page, '/catalog-imports')) {
    const validated = await rowHrefs(page, rowsTagged(page, 'Validated'), 1);
    const onImport = validated.length > 0 && (await go(page, validated[0]));
    if (onImport) {
      const staged = page.getByText('Nothing has been written yet');
      await reveal(staged);
      await beat(
        page,
        async () => (await has(staged)) && (await has(rows(page))),
        'Vendor catalogs, without the retyping',
        'CSV, TSV or BMEcat mapped to part fields, validated row by row — and nothing is written until you commit',
        2700
      );
    } else {
      await beat(
        page,
        () => has(page.getByText('Uploading only stages the file')),
        'Vendor catalogs, without the retyping',
        'CSV, TSV or BMEcat mapped to part fields and validated row by row before anything is written',
        2400
      );
    }
  }

  // Coverage is on the matrix tab, not the list, so the tab click comes first.
  if (await go(page, '/requirements')) {
    const opened = await openTab(page, /Traceability matrix/i);
    const pane = page.locator('.ant-tabs-tabpane-active');
    await beat(
      page,
      async () => opened && (await has(pane.locator('.ant-table-row'))),
      'Requirements traceability',
      'Linked to the parts that satisfy them and documents that verify them',
      2400
    );
  }

  if (await go(page, '/analytics')) {
    await sleep(400);
    await beat(
      page,
      async () =>
        (await has(page.locator('.ant-statistic'))) &&
        !(await has(page.getByText('No analytics available'))),
      'Insight across the programme',
      'Change cycle time, BOM health, requirement coverage, cost drivers',
      2600
    );
    await glide(page, 400);
    await sleep(500);
  }
}

async function tour(page) {
  if (!(await go(page, '/login'))) return;
  await sleep(300);
  await card(page, 'TurboPLM', 'Self-hosted product lifecycle management');

  await beat(
    page,
    () => has(page.locator('input[type="password"]')),
    'Sign in',
    'Your own instance, your own accounts — this tour only ever reads',
    1800
  );
  if (!(await signIn(page))) {
    console.error('signed out — nothing further can be shown honestly');
    return;
  }

  await beat(
    page,
    () => has(page.locator('.ant-statistic')),
    'Your product data at a glance',
    'Parts, revisions in flight, open changes and process plans',
    2600
  );
  await glide(page, 380);
  await sleep(400);

  await go(page, '/parts');
  await beat(
    page,
    () => has(rows(page)),
    'The part master',
    'Every part, its category, current revision and lifecycle state',
    2400
  );

  let partPath = null;
  await safely('product structure', async () => {
    partPath = await partScene(page);
  });
  await safely('change control', () => changeScene(page));

  let cadDoc = null;
  await safely('vault', async () => {
    cadDoc = await vaultScene(page);
  });
  await safely('cBOM', () => cbomScene(page, cadDoc, partPath));
  await safely('build and service', () => buildScene(page));
  await safely('supplier, catalog, requirements, analytics', () => businessScene(page));
}

const browser = await chromium.launch({ args: ['--force-color-profile=srgb'] });
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  recordVideo: { dir: '/out', size: { width: 1280, height: 800 } },
  colorScheme: 'light',
  ignoreHTTPSErrors: true,
});
const page = await ctx.newPage();
// Nothing in a recording may wait 30 s. Every implicit auto-wait — fills, clicks,
// attribute reads — is capped so a missing element costs a beat, never the video.
page.setDefaultTimeout(8000);

try {
  try {
    await tour(page);
  } catch (err) {
    console.error('TOUR ERROR:', err.message);
  }
  // Its own try, deliberately: the end card is the last thing a viewer sees, and a tour that
  // threw halfway is exactly when a clean ending matters most. Sharing a try with tour()
  // meant any escape above silently cost the closing frame.
  await card(page, 'Run it yourself', 'Open source · Docker · turboplm.com');
} catch (err) {
  console.error('END CARD ERROR:', err.message);
} finally {
  await ctx.close(); // flushes the video file
  await browser.close();
}

if (skipped.length > 0) {
  console.log(`skipped ${skipped.length} caption(s) the frame could not back:`);
  for (const title of skipped) console.log(`  - ${title}`);
}
console.log('recording complete');
