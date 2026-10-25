/**
 * lib/contrastPixel.js — resolving axe's "incomplete" colour-contrast results
 * by sampling the rendered page.
 *
 * The fixture uses CSS gradients precisely because axe cannot resolve them:
 * every element here is one axe would report as incomplete rather than
 * pass/fail. The critical assertion is #busy — a visually noisy background
 * must stay unresolved rather than be guessed at, because a fabricated pass
 * is worse than an honest "needs a human".
 *
 *   node test/contrastPixel.test.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { contrastPixelChecks, ratio } = require('../lib/contrastPixel');

const FIXTURES = path.join(__dirname, 'fixtures');
let failures = 0;
const check = (ok, msg) => { console.log((ok ? '  ok   ' : '  FAIL ') + msg); if (!ok) failures++; };

console.log('\ncontrast maths (known WCAG values)');
check(Math.abs(ratio([0, 0, 0], [255, 255, 255]) - 21) < 0.01, 'black on white is 21:1');
check(Math.abs(ratio([255, 255, 255], [255, 255, 255]) - 1) < 0.01, 'white on white is 1:1');
check(Math.abs(ratio([117, 117, 117], [255, 255, 255]) - 4.6075) < 0.001, '#757575 on white is 4.6075:1');
check(Math.abs(ratio([255, 255, 255], [0, 0, 255]) - 8.5925) < 0.001, 'white on blue is 8.5925:1 (symmetric)');

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
  await page.goto(`${base}/contrast.html`);

  console.log('\nsampling a real render');
  const res = await contrastPixelChecks(page, ['#bad', '#good', '#large', '#busy']);
  const v = res.violations[0];
  const blamed = v ? v.nodes.map((n) => n.target[0]) : [];

  check(blamed.includes('#bad'), '#bad fails — grey on grey gradient');
  check(!blamed.includes('#good'), '#good passes — dark on light gradient');
  check(!blamed.includes('#large'), '#large passes — large text only needs 3:1');
  check(!blamed.includes('#busy'), '#busy is not blamed');
  check(res.unresolved >= 1, '  #busy stayed UNRESOLVED rather than being guessed');
  check(res.resolved === 3, `3 of 4 resolved (got ${res.resolved})`);

  // The measured ratio must be real, not a placeholder.
  const badNode = v && v.nodes.find((n) => n.target[0] === '#bad');
  const m = badNode && badNode.failureSummary.match(/Measured ([\d.]+):1/);
  check(!!m && parseFloat(m[1]) > 1 && parseFloat(m[1]) < 4.5,
    `  the reported ratio is a real measurement (${m ? m[1] : 'none'}:1)`);

  console.log('\nno targets');
  const empty = await contrastPixelChecks(page, []);
  check(empty.violations.length === 0 && empty.passes.length === 0,
    'no targets produces no result at all');

  await browser.close();
  server.close();
  console.log(failures ? `\n${failures} assertion(s) failed` : '\nAll assertions passed');
  process.exit(failures ? 1 : 0);
})();
