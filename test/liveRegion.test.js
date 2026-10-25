/**
 * lib/liveRegion.js — 4.1.3 Status Messages and 3.3.1 Error Identification.
 *
 * The most important assertion in this file is the one about livereg-none:
 * a page with nothing to trigger must produce NO results at all. Emitting a
 * pass there is precisely the false-assurance bug that had 4.1.3 reporting
 * green while the VPAT called it Partially Supports, so it is guarded
 * explicitly rather than left to reviewer discipline.
 *
 *   node test/liveRegion.test.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { installGuard } = require('../lib/interact');
const { liveRegionChecks } = require('../lib/liveRegion');

const FIXTURES = path.join(__dirname, 'fixtures');

let failures = 0;
const check = (ok, msg) => {
  console.log((ok ? '  ok   ' : '  FAIL ') + msg);
  if (!ok) failures++;
};

(async () => {
  const received = [];
  const server = http.createServer((req, res) => {
    received.push(`${req.method} ${req.url}`);
    const name = req.url.replace(/^\//, '').split('?')[0] || 'livereg-bad.html';
    const file = path.join(FIXTURES, name);
    if (!fs.existsSync(file)) { res.statusCode = 404; res.end('nope'); return; }
    res.setHeader('content-type', 'text/html');
    res.end(fs.readFileSync(file, 'utf8'));
  }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;

  const browser = await chromium.launch();
  const ctx = await browser.newContext();

  const run = async (fixture) => {
    const page = await ctx.newPage();
    const guard = await installGuard(page);
    await page.goto(`${base}/${fixture}`);
    const res = await liveRegionChecks(page, { guard });
    const ids = {
      v: res.violations.map((r) => r.id),
      p: res.passes.map((r) => r.id),
    };
    const emailValue = await page.locator('#email').inputValue().catch(() => null);
    await guard.uninstall();
    await page.close();
    return { res, ids, emailValue };
  };

  console.log('\nlivereg-bad.html — message shown, but silent and unlinked');
  {
    const { ids } = await run('livereg-bad.html');
    check(ids.v.includes('lr-status-not-announced'), '4.1.3 fails — not in a live region');
    check(ids.v.includes('lr-error-not-associated'), '3.3.1 fails — not linked to the field');
    check(ids.p.length === 0, '  no passes emitted');
  }

  console.log('\nlivereg-good.html — role="alert" + aria-describedby');
  {
    const { ids } = await run('livereg-good.html');
    check(ids.p.includes('lr-status-not-announced'), '4.1.3 passes — announced via role="alert"');
    check(ids.p.includes('lr-error-not-associated'), '3.3.1 passes — linked via aria-describedby');
    check(ids.v.length === 0, '  no violations emitted');
  }

  console.log('\nlivereg-none.html — nothing to trigger');
  {
    const { res } = await run('livereg-none.html');
    const total = res.violations.length + res.passes.length + res.incomplete.length;
    check(total === 0, 'emits NO result at all (absence of evidence is not a pass)');
  }

  console.log('\nside effects');
  {
    const page = await ctx.newPage();
    const guard = await installGuard(page);
    await page.goto(`${base}/livereg-bad.html`);
    await page.fill('#email', 'original@example.com');
    await liveRegionChecks(page, { guard });
    check(await page.locator('#email').inputValue() === 'original@example.com',
      'field values are restored after the check');
    check(!received.some((r) => r.startsWith('POST')),
      'no write ever reached the server');
    check(!guard.isLocked(), 'the guard is left unlocked for later checks');
    await guard.uninstall();
    await page.close();
  }

  await browser.close();
  server.close();
  console.log(failures ? `\n${failures} assertion(s) failed` : '\nAll assertions passed');
  process.exit(failures ? 1 : 0);
})();
