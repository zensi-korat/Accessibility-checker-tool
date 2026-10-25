/**
 * Selector uniqueness — a correctness guard, not a style check.
 *
 * Every probe builds a CSS selector for the elements it reports, and the
 * interactive modules then ACT on those selectors. The original helper emitted
 * `tag.class1.class2`, which on this application is ambiguous for roughly 60%
 * of elements (they carry no id). The consequences were silent and serious:
 *
 *   - lib/liveRegion.js filled and restored only the first matching element,
 *     so a three-field form was tested once and two fields were left untested
 *     while the first was overwritten with another field's value;
 *   - lib/contextChange.js did the same to <select> elements, because
 *     page.selectOption is NOT strict and quietly acts on the first match;
 *   - defect lifecycle signatures (rule|page|target) collapsed distinct
 *     elements into one, under-counting defects and hiding regressions.
 *
 * These tests pin the fix: selectors must resolve to exactly one element, and
 * driving a form must leave every field as it was found.
 *
 *   node test/selector.test.js
 */
const http = require('http');
const { chromium } = require('playwright');
const { installGuard } = require('../lib/interact');
const { liveRegionChecks } = require('../lib/liveRegion');
const { contextChangeChecks } = require('../lib/contextChange');

let failures = 0;
const check = (ok, msg) => { console.log((ok ? '  ok   ' : '  FAIL ') + msg); if (!ok) failures++; };

// Shaped like real WebForms output: repeated controls sharing a class, no ids.
const HTML = `<!doctype html><html lang=en><head><meta charset=utf-8><title>t</title></head><body>
<form id=f method=POST action=/save>
  <label>Email <input class="form-control" name="email" type="email" required></label>
  <label>Phone <input class="form-control" name="phone" type="tel" required></label>
  <label>City  <input class="form-control" name="city" required></label>
  <select class="sel"><option value=a>A</option><option value=b>B</option></select>
  <select class="sel"><option value=x>X</option><option value=y>Y</option></select>
  <div id=err role=alert style="min-height:1.2em"></div>
  <button id=save type=submit>Save</button>
</form>
<p class="readable">Only one of these</p>
<script>document.getElementById('f').addEventListener('submit', function (e) {
  e.preventDefault(); document.getElementById('err').textContent = 'Invalid entry.'; });</script>
</body></html>`;

// The same helper the probes use, kept in sync by these assertions.
const selOfSrc = () => {
  window.__selOf = (el) => {
    const tag = el.tagName.toLowerCase();
    if (el.id && document.getElementById(el.id) === el) return tag + '#' + el.id;
    const classesOf = (n, take) => (typeof n.className === 'string' && n.className.trim())
      ? '.' + n.className.trim().split(/\s+/).slice(0, take).join('.') : '';
    const cls = classesOf(el, 2);
    if (cls) { try { if (document.querySelectorAll(tag + cls).length === 1) return tag + cls; } catch (e) {} }
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentElement) {
      const t = n.tagName.toLowerCase();
      if (n.id && document.getElementById(n.id) === n) { parts.unshift(t + '#' + n.id); break; }
      let p = t + classesOf(n, 1);
      const par = n.parentElement;
      if (par) {
        const sibs = [];
        for (const ch of par.children) if (ch.tagName === n.tagName) sibs.push(ch);
        if (sibs.length > 1) p += ':nth-of-type(' + (sibs.indexOf(n) + 1) + ')';
      }
      parts.unshift(p);
    }
    return parts.join(' > ');
  };
};

(async () => {
  const server = http.createServer((q, r) => { r.setHeader('content-type', 'text/html'); r.end(HTML); }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  const ctx = await browser.newContext();

  console.log('\nselector uniqueness');
  {
    const p = await ctx.newPage();
    await p.goto(base + '/');
    await p.evaluate(selOfSrc);
    const sels = await p.evaluate(() =>
      [...document.querySelectorAll('input, select, p')].map((e) => window.__selOf(e)));
    check(new Set(sels).size === sels.length,
      `every element gets a distinct selector (${new Set(sels).size}/${sels.length})`);
    let allSingle = true;
    for (const s of sels) if (await p.locator(s).count() !== 1) allSingle = false;
    check(allSingle, '  and each selector resolves to exactly one element');
    // Readability must not be sacrificed where the short form is already unique.
    const readable = await p.evaluate(() => window.__selOf(document.querySelector('p.readable')));
    check(readable === 'p.readable', `  a unique class selector stays readable (got "${readable}")`);
    await p.close();
  }

  console.log('\nlib/liveRegion.js leaves the form as it found it');
  {
    const p = await ctx.newPage();
    const g = await installGuard(p);
    await p.goto(base + '/');
    const seed = ['a@b.com', '0123456789', 'Ahmedabad'];
    for (let i = 0; i < seed.length; i++) await p.locator('input').nth(i).fill(seed[i]);
    await liveRegionChecks(p, { guard: g });
    const after = await p.locator('input').evaluateAll((els) => els.map((e) => e.value));
    check(JSON.stringify(after) === JSON.stringify(seed),
      `all three fields restored (${JSON.stringify(after)})`);
    await g.uninstall(); await p.close();
  }

  console.log('\nlib/contextChange.js restores every select, not just the first');
  {
    const p = await ctx.newPage();
    const g = await installGuard(p);
    await p.goto(base + '/');
    await p.locator('select').nth(0).selectOption('a');
    await p.locator('select').nth(1).selectOption('y');
    await contextChangeChecks(p, { guard: g });
    const after = await p.locator('select').evaluateAll((els) => els.map((e) => e.value));
    check(JSON.stringify(after) === JSON.stringify(['a', 'y']),
      `both selects restored (${JSON.stringify(after)})`);
    await g.uninstall(); await p.close();
  }

  await browser.close();
  server.close();
  console.log(failures ? `\n${failures} assertion(s) failed` : '\nAll assertions passed');
  process.exit(failures ? 1 : 0);
})();
