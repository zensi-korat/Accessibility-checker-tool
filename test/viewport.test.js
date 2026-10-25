/**
 * lib/viewport.js — checked against fixtures with known outcomes.
 *
 * These four criteria are asserted by resizing a real browser, so the risk is
 * not "does the code run" but "does it blame the right element". Each fixture
 * therefore carries deliberate traps: an off-canvas menu and a wide data table
 * that overflow the viewport but are NOT defects, and (in reflow-clipped) a
 * page that hides its own horizontal overflow so no scrollbar appears while
 * content is silently amputated.
 *
 *   node test/viewport.test.js      (needs Node 22 — see README)
 */
const path = require('path');
const { chromium } = require('playwright');
const { viewportChecks } = require('../lib/viewport');

const FIXTURES = path.join(__dirname, 'fixtures');

// ruleId -> expected outcome per fixture.
const EXPECTED = {
  'reflow-fail.html': {
    'vp-reflow': { fail: true, blames: 'div.wide-panel' },
    'vp-resize-text': { fail: true, blames: 'div.zoom-box' },
    'vp-text-spacing': { fail: true, blames: 'div.spacing-box' },
    'vp-orientation': { fail: true, blames: 'div.rotate-nag' },
  },
  'reflow-clipped.html': {
    // Same layout, but body{overflow-x:hidden}: content loss, not scrolling.
    'vp-reflow': { fail: true, blames: 'div.wide-panel', impact: 'critical' },
  },
  'reflow-pass.html': {
    'vp-reflow': { fail: false },
    'vp-resize-text': { fail: false },
    'vp-text-spacing': { fail: false },
    'vp-orientation': { fail: false },
  },
};

// Elements that overflow but must never be reported.
const TRAPS = ['div.offcanvas', 'table'];

let failures = 0;
const check = (ok, msg) => {
  console.log((ok ? '  ok   ' : '  FAIL ') + msg);
  if (!ok) failures++;
};

(async () => {
  const browser = await chromium.launch();
  for (const [fixture, expectations] of Object.entries(EXPECTED)) {
    console.log('\n' + fixture);
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    const page = await ctx.newPage();
    await page.goto('file://' + path.join(FIXTURES, fixture));

    const res = await viewportChecks(page);
    const byId = {};
    for (const v of res.violations) byId[v.id] = v;

    for (const [rule, exp] of Object.entries(expectations)) {
      const v = byId[rule];
      check(!!v === exp.fail, `${rule} ${exp.fail ? 'fails' : 'passes'}`);
      if (exp.fail && v) {
        if (exp.blames) {
          check(v.nodes.some((n) => n.target[0] === exp.blames), `${rule} blames ${exp.blames}`);
        }
        if (exp.impact) check(v.impact === exp.impact, `${rule} impact is ${exp.impact}`);
        for (const trap of TRAPS) {
          check(!v.nodes.some((n) => n.target[0] === trap), `${rule} does not blame ${trap}`);
        }
      }
    }
    // A check that leaves the page resized would corrupt every later check and
    // every screenshot, so this is load-bearing, not hygiene.
    const vp = page.viewportSize();
    check(vp.width === 1366 && vp.height === 900, 'viewport restored to 1366x900');
    await ctx.close();
  }
  await browser.close();
  console.log(failures ? `\n${failures} assertion(s) failed` : '\nAll assertions passed');
  process.exit(failures ? 1 : 0);
})();
