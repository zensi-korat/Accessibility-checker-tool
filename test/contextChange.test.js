/**
 * lib/contextChange.js — 3.2.1 On Focus, 3.2.2 On Input, 1.4.13 Hover/Focus.
 *
 *   node test/contextChange.test.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { installGuard } = require('../lib/interact');
const { contextChangeChecks } = require('../lib/contextChange');

const FIXTURES = path.join(__dirname, 'fixtures');
let failures = 0;
const check = (ok, msg) => { console.log((ok ? '  ok   ' : '  FAIL ') + msg); if (!ok) failures++; };

(async () => {
  const server = http.createServer((req, res) => {
    const name = req.url.replace(/^\//, '').split('?')[0];
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
    const res = await contextChangeChecks(page, { guard });
    const selectValue = await page.locator('#dept').inputValue().catch(() => null);
    await guard.uninstall();
    await page.close();
    return {
      v: res.violations.map((r) => r.id),
      p: res.passes.map((r) => r.id),
      res, selectValue,
    };
  };

  console.log('\nctx-bad.html');
  {
    const r = await run('ctx-bad.html');
    check(r.v.includes('cc-focus-context-change'), '3.2.1 fails — focus changed the page title');
    check(r.v.includes('cc-input-context-change'), '3.2.2 fails — changing the select opened a dialog');
    check(r.v.includes('cc-hover-not-dismissable'), '1.4.13 fails — native title tooltip');
    check(r.selectValue === 'a', '  the select was restored to its original value');
  }

  console.log('\nctx-good.html');
  {
    const r = await run('ctx-good.html');
    check(!r.v.includes('cc-focus-context-change'), '3.2.1 passes');
    check(!r.v.includes('cc-input-context-change'), '3.2.2 passes');
    check(!r.v.includes('cc-hover-not-dismissable'), '1.4.13 dismissable — no violation');
    check(!r.v.includes('cc-hover-not-persistent'), '1.4.13 persistent — no violation');
    check(r.p.includes('cc-focus-context-change') && r.p.includes('cc-input-context-change'),
      '  passes are actually emitted (not just silence)');
  }

  await browser.close();
  server.close();
  console.log(failures ? `\n${failures} assertion(s) failed` : '\nAll assertions passed');
  process.exit(failures ? 1 : 0);
})();
