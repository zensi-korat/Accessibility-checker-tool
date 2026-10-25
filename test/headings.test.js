/**
 * lib/headings.js (2.4.6) and lib/uiContrast.js (1.4.11) — the two criteria
 * the VPAT calls Partially Supports that had no rule in either engine.
 *
 * Neither module claims to settle the criterion outright. They decide the
 * structural half, which is what moves 2.4.6 and 1.4.11 from "not tested" to
 * a real partial verdict.
 *
 *   node test/headings.test.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { headingChecks } = require('../lib/headings');
const { uiContrastChecks } = require('../lib/uiContrast');

const FIXTURES = path.join(__dirname, 'fixtures');
let failures = 0;
const check = (ok, msg) => { console.log((ok ? '  ok   ' : '  FAIL ') + msg); if (!ok) failures++; };

(async () => {
  const server = http.createServer((req, res) => {
    const f = path.join(FIXTURES, req.url.replace(/^\//, '').split('?')[0]);
    if (!fs.existsSync(f)) { res.statusCode = 404; res.end('no'); return; }
    res.setHeader('content-type', 'text/html');
    res.end(fs.readFileSync(f, 'utf8'));
  }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 900, height: 700 } });

  const open = async (f) => { const p = await ctx.newPage(); await p.goto(`${base}/${f}`); return p; };

  console.log('\n2.4.6 — headings-bad.html');
  {
    const p = await open('headings-bad.html');
    const r = await headingChecks(p);
    const ids = r.violations.map((x) => x.id);
    check(ids.includes('hl-heading-empty'), 'empty heading flagged');
    check(ids.includes('hl-heading-placeholder'), '"Untitled" flagged as placeholder');
    check(ids.includes('hl-heading-duplicate'), 'duplicate sibling h3s flagged');
    check(ids.includes('hl-h1-count'), 'two <h1> flagged (the 30809 shape)');
    check(ids.includes('hl-label-duplicate'), 'two fields labelled "Date" flagged');
    check(ids.includes('hl-label-generic'), '"Field 1" flagged as generic');
    check(r.passes.length === 0, '  no pass emitted alongside violations');
    await p.close();
  }

  console.log('\n2.4.6 — headings-good.html');
  {
    const p = await open('headings-good.html');
    const r = await headingChecks(p);
    check(r.violations.length === 0, 'clean page produces no violations');
    check(r.passes.length === 1, '  and does emit a pass');
    await p.close();
  }

  console.log('\n2.4.6 — a page with no headings or controls');
  {
    const p = await open('nostructure.html');
    const r = await headingChecks(p);
    check(r.violations.length + r.passes.length === 0,
      'emits NO verdict when there is nothing to judge');
    await p.close();
  }

  console.log('\n1.4.11 — uicontrast.html');
  {
    const p = await open('uicontrast.html');
    const r = await uiContrastChecks(p);
    const blamed = r.violations.length ? r.violations[0].nodes.map((n) => n.target[0]) : [];
    const reviewed = r.incomplete.length ? r.incomplete[0].nodes.map((n) => n.target[0]) : [];
    check(blamed.includes('button#faint'), '#faint fails — 1.6:1 border on white');
    check(!blamed.includes('button#strong'), '#strong passes — 5.7:1 border');
    check(blamed.includes('button#ghost'), '#ghost fails — fill almost identical to page');
    check(!blamed.includes('button#filled'), '#filled passes — dark fill');
    check(!blamed.includes('button#off'), '#off exempt — disabled controls are out of scope');
    check(reviewed.includes('button#onimg'), '#onimg goes to review, not guessed, on a gradient');
    await p.close();
  }

  await browser.close();
  server.close();
  console.log(failures ? `\n${failures} assertion(s) failed` : '\nAll assertions passed');
  process.exit(failures ? 1 : 0);
})();
