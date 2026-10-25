/**
 * Auto-explore mode. Instead of you enumerating every page and every modal,
 * this:
 *   1. starts at BASE_URL (plus any PAGES you listed as seeds),
 *   2. optionally crawls same-origin links to discover more pages,
 *   3. on each page, clicks clickable elements one at a time and re-scans the
 *      revealed state — so modals / dropdowns / tabs / accordions get checked
 *      without you naming them.
 *
 * SAFE_MODE (a11y.config.js):
 *   true  → skip anything that looks destructive or navigational
 *           (delete / remove / logout / submit / save / pay / confirm …) and
 *           never click links that leave the page. Safe against a live app.
 *   false → aggressive: click everything, including submits and destructive
 *           buttons. Only run this against a throwaway / test database.
 *
 * To keep state deterministic, the page is reloaded before each click, then
 * the Nth clickable is clicked. Slower, but no state bleed between clicks.
 */

// In-page routine, serialized and run IN THE BROWSER by page.evaluate — so it
// must be fully self-contained (no references to anything outside this fn).
// Takes one arg object { i, safe, doClick }; finds clickable candidates in a
// stable DOM order and optionally clicks the i-th one.
function browserClickables(arg) {
  const i = arg.i, safe = arg.safe, doClick = arg.doClick;
  const SKIP = /delete|remove|destroy|discard|drop|log\s?out|sign\s?out|logout|submit|\bsave\b|\bpay\b|purchase|checkout|\border\b|confirm|cancel|reset|deactivate|disable|archive|\bsend\b|unsubscribe|revoke|approve|reject/i;
  const SAFE_SEL = 'button:not([type="submit"]):not([type="reset"]),[role="button"],[data-toggle],[data-bs-toggle],summary,.accordion-button,[aria-haspopup],[aria-expanded],a[href="#"],a[href^="javascript"]';
  const AGGRO_SEL = 'button,[role="button"],.btn,[data-toggle],[data-bs-toggle],summary,.accordion-button,[aria-haspopup],[aria-expanded],[onclick],input[type="submit"],input[type="button"],a[href]';
  let els = Array.prototype.slice.call(document.querySelectorAll(safe ? SAFE_SEL : AGGRO_SEL));
  els = els.filter((el) => el.getClientRects().length > 0); // visible-ish only
  if (safe) {
    els = els.filter((el) => {
      // never leave the page in safe mode
      if (el.tagName === 'A') {
        const href = el.getAttribute('href') || '';
        if (href && href !== '#' && href.indexOf('javascript') !== 0 && href.indexOf('#') !== 0) return false;
      }
      const hay = [el.innerText, el.getAttribute('aria-label'), el.id, el.className,
        el.getAttribute('name'), el.value, el.getAttribute('title')].join(' ');
      return !SKIP.test(hay);
    });
  }
  if (!doClick) return { count: els.length };
  const el = els[i];
  if (!el) return null;
  const label = String(el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || el.id || el.className || el.tagName).trim().replace(/\s+/g, ' ').slice(0, 40);
  try { el.scrollIntoView({ block: 'center' }); el.click(); } catch (e) { /* ignore */ }
  return { label };
}

function normalizePath(p) {
  try {
    const u = new URL(p, 'http://x');
    let path = u.pathname.replace(/\/+$/, '') || '/';
    return path.toLowerCase();
  } catch { return p; }
}

function sameOriginPath(href, origin) {
  if (!href) return null;
  if (/^(mailto:|tel:|javascript:|#)/i.test(href)) return null;
  // Never crawl to logout/sign-out endpoints — that would end the session.
  if (/log\s*out|logout|logoff|sign\s*out|signout|\/auth\/logout/i.test(href)) return null;
  try {
    const u = new URL(href, origin.href);
    if (u.host !== origin.host) return null;
    return u.pathname + u.search;
  } catch { return null; }
}

/**
 * @param {import('playwright').Page} page
 * @param {object} config
 * @param {{ analyze: Function, log: Function }} deps
 * @returns {Promise<Array>} scans
 */
function attachDialogHandler(page, log) {
  page.on('dialog', (dialog) => {
    log(`      ⚠ native ${dialog.type()} dialog appeared ("${dialog.message().slice(0, 80)}") — dismissing`);
    dialog.dismiss().catch(() => {});
  });
  return page;
}

async function autoExplore(page, config, deps) {
  const { analyze, log } = deps;
  const scans = [];
  const origin = new URL(config.BASE_URL);
  const maxPages = config.MAX_PAGES || 20;
  const maxClicks = config.MAX_CLICKS_PER_PAGE || 25;
  const settle = config.SETTLE_MS || 500;

  const seen = new Set();
  const queue = [];
  const seeds = (config.PAGES && config.PAGES.length) ? config.PAGES.map((p) => p.path) : ['/'];
  for (const s of seeds) queue.push(s);

  log(`\nAuto-explore ON · mode: ${config.SAFE_MODE ? 'SAFE' : 'AGGRESSIVE'} · crawl links: ${config.CRAWL_LINKS ? 'yes' : 'no'} · max ${maxPages} pages`);

  while (queue.length && seen.size < maxPages) {
    const rawPath = queue.shift();
    const norm = normalizePath(rawPath);
    if (seen.has(norm)) continue;
    seen.add(norm);

    const url = config.BASE_URL.replace(/\/$/, '') + rawPath;
    log(`\n▶ ${norm}  (${url})`);
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    } catch (e) {
      log(`   ✗ load failed: ${e.message.split('\n')[0]}`);
      continue;
    }
    await page.waitForTimeout(settle);

    // Initial state — run dynamic keyboard/SR checks + the DOM inventory here.
    const base = await analyze(page, 'initial', true, norm);
    const inventory = deps.pageInventory ? await deps.pageInventory(page) : null;
    scans.push({ page: norm, url, ...base, inventory });
    log(`   • initial: ${base.violations.length} violations, ${base.incomplete.length} to review`);

    // Discover links to crawl.
    if (config.CRAWL_LINKS) {
      const hrefs = await page.$$eval('a[href]', (as) => as.map((a) => a.getAttribute('href'))).catch(() => []);
      let added = 0;
      for (const href of hrefs) {
        const p = sameOriginPath(href, origin);
        if (p && !seen.has(normalizePath(p)) && !queue.some((q) => normalizePath(q) === normalizePath(p))) {
          queue.push(p); added += 1;
        }
      }
      if (added) log(`   • discovered ${added} new link(s) to scan`);
    }

    // Count clickables, then click each (reloading between clicks for a clean state).
    let count = 0;
    try { count = (await page.evaluate(browserClickables, { i: -1, safe: config.SAFE_MODE, doClick: false })).count; } catch { count = 0; }
    const toClick = Math.min(count, maxClicks);
    if (toClick > 0) log(`   • ${count} clickable element(s); revealing up to ${toClick}…`);

    // Watchdog: a click can open a native dialog, an infinite spinner, or a
    // navigation that never settles. try/catch alone doesn't help if a
    // promise never resolves — race it against a timeout so ONE bad click
    // can't stall the rest of the scan (and every future page after it).
    const withTimeout = (promise, ms, label) => Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms: ${label}`)), ms)),
    ]);
    const perClickBudget = config.CLICK_TIMEOUT_MS || 45000;

    for (let i = 0; i < toClick; i++) {
      try {
        await withTimeout((async () => {
          await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
          await page.waitForTimeout(settle);
          const res = await page.evaluate(browserClickables, { i, safe: config.SAFE_MODE, doClick: true });
          if (!res || !res.label) return;
          await page.waitForTimeout(settle);
          const snap = await analyze(page, `after click: "${res.label}"`, config.DYNAMIC_ON_ALL_STATES === true, norm);
          scans.push({ page: norm, url, ...snap });
        })(), perClickBudget, `click #${i + 1}/${toClick}`);
      } catch (e) {
        log(`      ⚠ click #${i + 1}/${toClick} skipped (${e.message.split('\n')[0]})`);
        // The underlying hung operation is still running against the OLD page
        // and could wedge every remaining click too. Recreate the page (same
        // browser context → session/cookies survive) so the scan can recover
        // instead of timing out 45s at a time for everything left.
        if (/timed out after/.test(e.message)) {
          try {
            const ctx = page.context();
            await page.close({ runBeforeUnload: false }).catch(() => {});
            page = attachDialogHandler(await ctx.newPage(), log);
            log('      ↻ page recovered after hang — continuing');
          } catch (e2) { /* if this fails too, subsequent iterations will keep erroring visibly */ }
        }
      }
    }
  }

  return scans;
}

module.exports = { autoExplore };
