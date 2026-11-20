/**
 * lib/analyze.js — check order.
 *
 * The opt-in interaction checks (LIVE_REGION_CHECKS) submit forms, change
 * selects and press controls. On a real site that leaves the page in a
 * different state: here, changing the sort select fades the list to 50%
 * opacity while it "reloads", as a product grid does. Checks that measure the
 * rendered page (pixel contrast sampling) must therefore run BEFORE the
 * interaction checks, or they measure the half-transparent loading state and
 * report contrast failures that do not exist at rest.
 *
 *   node test/analyzeOrder.test.js
 */
const { chromium } = require('playwright');
const { createAnalyzer } = require('../lib/analyze');

let failures = 0;
const check = (ok, msg) => { console.log((ok ? '  ok   ' : '  FAIL ') + msg); if (!ok) failures++; };

// Black text on a gradient: axe cannot resolve the background, so the pixel
// sampler decides it (21:1 at rest, ~4:1 once faded to 50%).
const html = `<!doctype html><html lang="en"><head><title>Order</title></head><body>
<main>
  <h1>Products</h1>
  <label for="sort">Sort</label>
  <select id="sort"><option>Default</option><option>Newest</option></select>
  <div id="list">
    <p id="txt" style="background:linear-gradient(90deg,#f2f2f2,#ffffff);color:#111111;font-size:16px;padding:8px">Show 12 16 24 products per page</p>
  </div>
</main>
<script>
  document.getElementById('sort').addEventListener('change', function () {
    var l = document.getElementById('list'); l.style.opacity = '.5';
    setTimeout(function () { l.style.opacity = '1'; }, 8000);
  });
</script></body></html>`;

(async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 900, height: 700 } })).newPage(); // axe needs a context page
  await page.setContent(html);
  const analyze = createAnalyzer({
    AXE_TAGS: ['wcag2a', 'wcag2aa'], SCREENSHOTS: { enabled: false }, DYNAMIC_CHECKS: false, VIEWPORT_CHECKS: false,
    LIVE_REGION_CHECKS: true, SECOND_ENGINE: false, RUNTIME_SOURCE: false, OUTPUT_DIR: require('os').tmpdir(),
  });
  const out = await analyze(page, 'initial', false, 'Products', true);

  const ran = out.checksRun;
  check(ran.includes('axe') && ran.includes('contrastPixel') && ran.includes('liveRegion'), `axe, sampling and interaction checks ran (${ran.join(', ')})`);
  check(ran.indexOf('contrastPixel') < ran.indexOf('liveRegion'), 'pixel contrast sampling runs before the interaction checks');
  const sampled = out.violations.filter((v) => v.id === 'contrast-sampled').flatMap((v) => v.nodes || []);
  check(!sampled.length, `black text is not reported as low contrast${sampled.length ? `: ${sampled.map((n) => n.failureSummary).join(' | ')}` : ''}`);

  await browser.close();
  console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
