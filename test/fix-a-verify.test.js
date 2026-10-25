/**
 * Fix verification must not claim "fixed" without evidence, and must not split
 * one defect into "fixed" + "new" just because its selector moved.
 *
 *   axe crashed in the state        → couldn't verify (not fixed)
 *   a custom check threw            → couldn't verify (not fixed)
 *   custom check ran, issue gone    → fixed
 *   nth-child selector shifted      → still failing, and not reported as new
 *   two identical elements          → never matched to each other by markup
 *
 *   node test/fix-a-verify.test.js
 */
const { buildVerification } = require('../lib/verify');

let failures = 0;
const check = (ok, msg) => { console.log((ok ? '  ok   ' : '  FAIL ') + msg); if (!ok) failures++; };

const issue = (rule, target, html, extra = {}) => ({ rule, page: 'Home', target, html, states: ['initial'], kind: 'violation', impact: 'serious', ...extra });
const baselineOf = (issues) => ({ pages: new Map([['Home', { at: new Date('2026-01-01'), label: 'x', issues }]]) });
const scan = (extra = {}) => ({ page: 'Home', state: 'initial', violations: [], incomplete: [], passes: [], inapplicable: [], ...extra });
const visible = (target) => new Map([[`Home::initial::${target}`, 'visible']]);
const has = (v, list, rule) => v[list].some((i) => i.rule === rule);

console.log('\nevidence that the rule ran');
{
  // axe failed: empty results, element still visible.
  const v = buildVerification(baselineOf([issue('image-alt', 'img', '<img src="a.png">')]), [scan()], [], visible('img'));
  check(!has(v, 'fixed', 'image-alt') && has(v, 'unverified', 'image-alt'), 'axe crashed → couldn\'t verify, not fixed');
}
{
  const v = buildVerification(baselineOf([issue('image-alt', 'img', '<img src="a.png">')]),
    [scan({ passes: [{ id: 'image-alt', nodes: [] }] })], [], visible('img'));
  check(has(v, 'fixed', 'image-alt'), 'axe ran and the rule passes → fixed');
}
{
  const v = buildVerification(baselineOf([issue('sr-unnamed-control', 'button.x', '<button class="x"></button>')]),
    [scan({ passes: [{ id: 'image-alt', nodes: [] }], checkErrors: ['screenReader'] })], [], visible('button.x'));
  check(has(v, 'unverified', 'sr-unnamed-control'), 'custom check reported an error → couldn\'t verify');
}
{
  // Dynamic checks off this time: no kbd-/sr- results at all.
  const v = buildVerification(baselineOf([issue('sr-unnamed-control', 'button.x', '<button class="x"></button>')]),
    [scan({ passes: [{ id: 'image-alt', nodes: [] }] })], [], visible('button.x'));
  check(has(v, 'unverified', 'sr-unnamed-control'), 'custom check did not run → couldn\'t verify');
}
{
  // Keyboard ran (same switch as screenReader) and nothing failed.
  const v = buildVerification(baselineOf([issue('sr-unnamed-control', 'button.x', '<button class="x"></button>')]),
    [scan({ passes: [{ id: 'kbd-focus-visible', nodes: [] }] })], [], visible('button.x'));
  check(has(v, 'fixed', 'sr-unnamed-control'), 'sibling dynamic check ran, issue gone → fixed');
}

console.log('\nselector moved');
{
  const before = issue('image-alt', 'li:nth-child(3) > img', '<img src="logo.png">');
  const now = issue('image-alt', 'li:nth-child(4) > img', '<img src="logo.png">');
  const v = buildVerification(baselineOf([before]), [scan({ violations: [{ id: 'image-alt', nodes: [] }] })], [now], visible(before.target));
  check(has(v, 'still', 'image-alt') && !has(v, 'fixed', 'image-alt'), 'nth-child shift → still failing, not fixed');
  check(!has(v, 'new', 'image-alt'), 'nth-child shift → not reported as new');
  check(v.counts.stillConfirmed === 1 && v.counts.newConfirmed === 0, 'confirmed counts follow');
}
{
  // Two identical icon buttons; one fixed. Markup is not unique → no markup match.
  const a = issue('button-name', 'li:nth-child(1) > button', '<button class="i"></button>');
  const b = issue('button-name', 'li:nth-child(2) > button', '<button class="i"></button>');
  const now = issue('button-name', 'li:nth-child(3) > button', '<button class="i"></button>');
  const pres = new Map([[`Home::initial::${a.target}`, 'visible'], [`Home::initial::${b.target}`, 'visible']]);
  const v = buildVerification(baselineOf([a, b]), [scan({ violations: [{ id: 'button-name', nodes: [] }] })], [now], pres);
  check(v.counts.still === 0, 'identical markup on several elements is never used to match');
}
{
  // style="" injected by the scan's highlighter must not break the markup match.
  const before = issue('sr-unnamed-control', 'button:nth-of-type(2)', '<button class="cart" style=""></button>');
  const now = issue('sr-unnamed-control', 'button:nth-of-type(3)', '<button class="cart"></button>');
  const v = buildVerification(baselineOf([before]), [scan({ violations: [{ id: 'sr-unnamed-control', nodes: [] }] })], [now], visible(before.target));
  check(has(v, 'still', 'sr-unnamed-control') && !v.new.length, 'injected style="" ignored when matching markup');
}

console.log('\nlint finding on an edited line');
{
  const lint = (key, line, rule = 'jsx-a11y/alt-text') => ({ rule, page: 'Source code (lint)', target: `src/App.jsx:${line}:5`, html: '<img>', states: ['lint'], kind: 'violation', impact: 'critical', lintKey: key, source: 'lint' });
  const base = { pages: new Map([['Source code (lint)', { at: new Date('2026-01-01'), label: 'x', issues: [lint('alt|src/App.jsx|aaa', 12)] }]]) };
  const lintScan = { page: 'Source code (lint)', state: 'lint', violations: [], incomplete: [], passes: [], inapplicable: [] };
  let v = buildVerification(base, [lintScan], [lint('alt|src/App.jsx|bbb', 12)]);
  check(v.still.length === 1 && v.fixed.length === 0 && v.new.length === 0, 'same rule, same line, line text edited → still failing (not fixed + new)');
  v = buildVerification(base, [lintScan], [lint('alt|src/App.jsx|ccc', 40)]);
  check(v.fixed.length === 1 && v.new.length === 1, 'same rule far away in the file → the old one fixed, a different one new');
  v = buildVerification(base, [lintScan], []);
  check(v.fixed.length === 1, 'gone from the file → fixed');
}

console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
process.exitCode = failures ? 1 : 0;
