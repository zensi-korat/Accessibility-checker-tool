/**
 * lib/consistency.js — 3.2.3, 3.2.4, 3.2.6, 2.4.5.
 *
 * evaluateConsistency is a pure function, so most of this runs with synthetic
 * signatures and no browser — which lets the edge cases (one deviating page
 * among many, too few pages to have a majority) be stated exactly.
 * collectSignature is exercised against a real page at the end.
 *
 *   node test/consistency.test.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { collectSignature, evaluateConsistency } = require('../lib/consistency');

const FIXTURES = path.join(__dirname, 'fixtures');
let failures = 0;
const check = (ok, msg) => { console.log((ok ? '  ok   ' : '  FAIL ') + msg); if (!ok) failures++; };
const ids = (r, kind) => (r && r[kind] ? r[kind].map((x) => x.id) : []);

const sig = (o) => ({
  nav: [], help: [], hasNav: false, hasSearch: false, hasSitemap: false, hasBreadcrumb: false, ...o,
});
const navOf = (...pairs) => pairs.map(([path, name]) => ({ path, name }));

const STD = navOf(['/home', 'Home'], ['/staff', 'Staff'], ['/reports', 'Reports']);

console.log('\n3.2.3 Consistent Navigation');
{
  const out = evaluateConsistency({
    a: sig({ nav: STD, hasNav: true }),
    b: sig({ nav: STD, hasNav: true }),
    c: sig({ nav: STD, hasNav: true }),
    // Same items, different relative order.
    d: sig({ nav: navOf(['/staff', 'Staff'], ['/home', 'Home'], ['/reports', 'Reports']), hasNav: true }),
  });
  check(ids(out.d, 'violations').includes('con-nav-order'), 'the deviating page is flagged');
  check(!ids(out.a, 'violations').includes('con-nav-order'), '  conforming pages are not');
  check(ids(out.a, 'passes').includes('con-nav-order'), '  and are explicitly passed');
}

console.log('\n3.2.3 — a page missing items is not a violation');
{
  // Fewer items (permissions) but the shared ones keep their order.
  const out = evaluateConsistency({
    a: sig({ nav: STD, hasNav: true }),
    b: sig({ nav: STD, hasNav: true }),
    c: sig({ nav: STD, hasNav: true }),
    d: sig({ nav: navOf(['/home', 'Home'], ['/reports', 'Reports']), hasNav: true }),
  });
  check(!ids(out.d, 'violations').includes('con-nav-order'),
    'a page with FEWER nav items in the same order is not flagged');
}

console.log('\n3.2.4 Consistent Identification');
{
  const out = evaluateConsistency({
    a: sig({ nav: STD, hasNav: true }),
    b: sig({ nav: STD, hasNav: true }),
    c: sig({ nav: STD, hasNav: true }),
    d: sig({ nav: navOf(['/home', 'Home'], ['/staff', 'Employees'], ['/reports', 'Reports']), hasNav: true }),
  });
  check(ids(out.d, 'violations').includes('con-identification'),
    'same destination labelled differently is flagged');
  check(!ids(out.a, 'violations').includes('con-identification'), '  majority pages are not');
}

console.log('\n3.2.6 Consistent Help');
{
  const h = [{ name: 'Support', path: '/help' }];
  const out = evaluateConsistency({
    a: sig({ nav: STD, hasNav: true, help: h }),
    b: sig({ nav: STD, hasNav: true, help: h }),
    c: sig({ nav: STD, hasNav: true, help: h }),
    d: sig({ nav: STD, hasNav: true, help: [] }),
  });
  check(!ids(out.d, 'violations').includes('con-help-missing'),
    'a page WITHOUT help is not a failure (3.2.6 only governs the order of help that is present)');
  check(ids(out.a, 'passes').includes('con-help-missing'), '  pages with help pass');
}

console.log('\n3.2.6 — help moved to a different block / order is flagged');
{
  const h = [{ name: 'Help', path: '/help', region: 'header' }, { name: 'Contact', path: '/contact', region: 'header' }];
  const out = evaluateConsistency({
    a: sig({ help: h }), b: sig({ help: h }), c: sig({ help: h }),
    d: sig({ help: [{ name: 'Contact', path: '/contact', region: 'header' }, { name: 'Help', path: '/help', region: 'header' }] }),
    e: sig({ help: [{ name: 'Help', path: '/help', region: 'footer' }, { name: 'Contact', path: '/contact', region: 'header' }] }),
  });
  check(ids(out.d, 'violations').includes('con-help-missing'), 'swapped help order is flagged');
  check(ids(out.e, 'violations').includes('con-help-missing'), 'help moved from header to footer is flagged');
  check(!ids(out.a, 'violations').includes('con-help-missing'), '  majority pages pass');
}

console.log('\n3.2.6 — a site with no help anywhere is not a violation');
{
  const out = evaluateConsistency({
    a: sig({ nav: STD, hasNav: true }), b: sig({ nav: STD, hasNav: true }),
    c: sig({ nav: STD, hasNav: true }), d: sig({ nav: STD, hasNav: true }),
  });
  check(!ids(out.a, 'violations').includes('con-help-missing'),
    '3.2.6 only applies once help exists somewhere');
}

console.log('\n2.4.5 Multiple Ways');
{
  const one = evaluateConsistency({
    a: sig({ nav: STD, hasNav: true }), b: sig({ nav: STD, hasNav: true }), c: sig({ nav: STD, hasNav: true }),
  });
  check(ids(one.a, 'incomplete').includes('con-multiple-ways') && !ids(one.a, 'violations').includes('con-multiple-ways'),
    'nav alone is only one way — review (unscanned pages may offer another), not a failure');
  const two = evaluateConsistency({
    a: sig({ nav: STD, hasNav: true, hasSearch: true }),
    b: sig({ nav: STD, hasNav: true }), c: sig({ nav: STD, hasNav: true }),
  });
  check(ids(two.a, 'passes').includes('con-multiple-ways'), 'nav + search passes, site-wide');
  check(ids(two.c, 'passes').includes('con-multiple-ways'), '  reported on every page, not just the one with search');
}

console.log('\n3.2.4 — patterns that are NOT inconsistent');
{
  const logoHome = navOf(['/', 'Acme'], ['/', 'Home'], ['/staff', 'Staff'], ['/reports', 'Reports']).map((n, i) => ({ ...n, slot: i === 1 ? 2 : 1 }));
  const cur = (name) => logoHome.map((n) => (n.path === '/staff' ? { ...n, name } : n));
  const out = evaluateConsistency({
    a: sig({ nav: logoHome, hasNav: true }),
    b: sig({ nav: cur('Staff (current)'), hasNav: true }),
    c: sig({ nav: cur('Staff 3'), hasNav: true }),
    d: sig({ nav: logoHome, hasNav: true }),
  });
  for (const p of ['a', 'b', 'c', 'd']) {
    check(!ids(out[p], 'violations').includes('con-identification') && !ids(out[p], 'incomplete').includes('con-identification'),
      `page ${p}: logo + "Home" to "/", "(current)" and counts are not inconsistencies`);
  }
  const drift = evaluateConsistency({
    a: sig({ nav: STD, hasNav: true }), b: sig({ nav: STD, hasNav: true }), c: sig({ nav: STD, hasNav: true }),
    d: sig({ nav: navOf(['/home', 'Home'], ['/staff', 'Staff'], ['/reports', 'All reports']), hasNav: true }),
  });
  check(ids(drift.d, 'incomplete').includes('con-identification') && !ids(drift.d, 'violations').includes('con-identification'),
    '"Reports" vs "All reports" is a review item, not a failure');
}

console.log('\ntoo few pages to judge');
{
  const out = evaluateConsistency({ a: sig({ nav: STD, hasNav: true }), b: sig({ nav: STD, hasNav: true }) });
  check(Object.keys(out).length === 0,
    'fewer than 3 pages produces NO result (no majority to compare against)');
}

(async () => {
  console.log('\ncollectSignature against a real page');
  const server = http.createServer((req, res) => {
    const f = path.join(FIXTURES, req.url.replace(/^\//, '').split('?')[0]);
    if (!fs.existsSync(f)) { res.statusCode = 404; res.end('no'); return; }
    res.setHeader('content-type', 'text/html');
    res.end(fs.readFileSync(f, 'utf8'));
  }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`${base}/consistency.html`);
  const s = await collectSignature(page);
  check(!!s, 'signature collected');
  check(s.hasNav && s.nav.length === 3, `nav found with 3 links (got ${s ? s.nav.length : 0})`);
  check(s.nav[0].name === 'Home' && s.nav[0].path === '/home', '  first item is Home -> /home');
  check(s.hasSearch === true, 'search field detected');
  check(s.help.length > 0, 'help mechanism detected');
  await page.setContent(`<header><nav><a href="/a">A</a><a href="/b">B</a><a href="/c">C</a></nav></header>
    <main><input name="searchTable" placeholder="Search rows"><p><a href="/contact">Contact us</a> about this article.</p></main>`);
  const s2 = await collectSignature(page);
  check(s2.hasSearch === false, 'a table filter input in main is not site search');
  check(s2.help.length === 0, 'a "Contact" link inside page content is not a repeated help mechanism');
  await browser.close();
  server.close();

  console.log(failures ? `\n${failures} assertion(s) failed` : '\nAll assertions passed');
  process.exit(failures ? 1 : 0);
})();
