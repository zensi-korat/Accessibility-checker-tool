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
    const rev = r.incomplete.map((x) => x.id);
    check(rev.includes('hl-heading-duplicate') && !ids.includes('hl-heading-duplicate'), 'duplicate sibling h3s go to review');
    check(rev.includes('hl-h1-count') && !ids.includes('hl-h1-count'), 'two <h1> go to review, not a 2.4.6 failure');
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

  console.log('\n2.4.6 — patterns that must not fail');
  {
    const p = await ctx.newPage();
    await p.setContent(`<h1><a href="/"><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="Acme"></a></h1>
      <div class="modal" style="display:none"><h1>Confirm</h1></div>
      <h2>A</h2><p>Aardvark</p><h3>42</h3><p>Open tickets</p>
      <div class="card"><h3>Details</h3></div><div class="card"><h3>Details</h3></div>`);
    const r = await headingChecks(p);
    const ids = r.violations.map((x) => x.id);
    const rev = r.incomplete.map((x) => x.id);
    check(!ids.includes('hl-heading-empty'), 'linked logo <h1><a><img alt></a></h1> is not empty');
    check(!rev.includes('hl-h1-count'), 'hidden modal <h1> is not counted');
    check(!ids.includes('hl-heading-placeholder') && rev.includes('hl-heading-placeholder'), '"A" / "42" headings are review, not failures');
    check(!rev.includes('hl-heading-duplicate'), 'repeated card headings in different cards are not duplicates');
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
    check(blamed.includes('input#faint'), '#faint fails — 1.6:1 border on white');
    check(!blamed.includes('input#strong'), '#strong passes — 5.7:1 border');
    check(blamed.includes('input#ghost'), '#ghost fails — fill almost identical to page');
    check(!blamed.includes('input#filled'), '#filled passes — dark fill');
    check(!blamed.includes('input#off'), '#off exempt — disabled controls are out of scope');
    check(reviewed.includes('input#onimg'), '#onimg goes to review, not guessed, on a gradient');
    check(!blamed.includes('input#under'), '#under passes — dark bottom-only border is measured');
    check(blamed.includes('input#underfaint'), '#underfaint fails — faint bottom-only border');
    check(!blamed.includes('button#btnlight'), 'text button with faint fill is not a 1.4.11 failure');
    check(!blamed.includes('input#onhero') && reviewed.includes('input#onhero'),
      'control over a positioned dark backdrop goes to review instead of a false 1.00:1');
    await p.close();
  }

  await browser.close();
  server.close();
  console.log(failures ? `\n${failures} assertion(s) failed` : '\nAll assertions passed');
  process.exit(failures ? 1 : 0);
})();
