/**
 * lib/pointerCancel.js — 2.5.2 Pointer Cancellation.
 *
 * The distinction that matters is between a control that merely REGISTERS a
 * down-event listener and one that actually ACTS on it. Most down-handlers are
 * harmless (focus, ripple, hover styling), so a check that flagged all of them
 * would be noise. The fixture contains both, and the harmless one must pass.
 *
 *   node test/pointerCancel.test.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { instrumentListeners } = require('../lib/clickable');
const { installGuard } = require('../lib/interact');
const { pointerCancelChecks } = require('../lib/pointerCancel');

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
  const page = await ctx.newPage();
  // Must be installed BEFORE navigation, or the page's own listeners register
  // before the hook exists and no candidate is ever seen.
  await instrumentListeners(page);
  const guard = await installGuard(page);
  await page.goto(`${base}/pointer.html`);

  const res = await pointerCancelChecks(page, { guard });
  const v = res.violations[0];
  const blamed = v ? v.nodes.map((n) => n.target[0]) : [];

  console.log('\n2.5.2 — pointer.html');
  check(blamed.includes('button#ondown'),
    'acts on mousedown → flagged (press-and-drag-away still fired it)');
  check(!blamed.includes('button#onclick'),
    'acts on click → not flagged (dragging away aborts it)');
  check(!blamed.includes('button#harmless'),
    'harmless mousedown listener → not flagged (registers, but does not act)');
  check(!blamed.some((b) => /slider/.test(b)),
    'slider exempt — acting on down is essential');
  check(!blamed.some((b) => /drag/.test(b)),
    'drag source exempt — the press IS the interaction');

  // The proof stage must have actually run, or the passes above are vacuous.
  check(res.violations.length + res.passes.length > 0, 'the check produced a verdict');

  console.log('\nno down-event controls at all');
  {
    const p2 = await ctx.newPage();
    await instrumentListeners(p2);
    await p2.goto(`${base}/nostructure.html`);
    const r2 = await pointerCancelChecks(p2, {});
    check(r2.violations.length + r2.passes.length === 0,
      'emits NO verdict when nothing listens for a down-event');
    await p2.close();
  }

  await guard.uninstall();
  await browser.close();
  server.close();
  console.log(failures ? `\n${failures} assertion(s) failed` : '\nAll assertions passed');
  process.exit(failures ? 1 : 0);
})();
