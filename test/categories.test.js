/**
 * Issue types (lib/categories.js): every rule the tool can report has a type,
 * `--only` parsing, and a scoped run keeps only what was asked for.
 *
 *   node test/categories.test.js
 */
const axe = require('axe-core');
const { BY_RULE } = require('../lib/static/wcagMap');
const c = require('../lib/categories');

let failures = 0;
const check = (ok, msg) => { console.log((ok ? '  ok   ' : '  FAIL ') + msg); if (!ok) failures++; };

const CUSTOM = ['cc-focus-context-change', 'con-nav-order', 'contrast-sampled', 'ff-redundant-entry', 'hl-heading-empty',
  'hl-label-duplicate', 'kbd-click-not-focusable', 'kbd-focus-visible', 'lr-error-not-associated', 'lr-status-not-announced',
  'pc-down-event-action', 'sr-broken-aria-ref', 'sr-duplicate-name', 'sr-unnamed-control', 'uic-component-boundary', 'vp-reflow'];
const untyped = [...axe.getRules().map((r) => r.ruleId), ...CUSTOM, ...Object.keys(BY_RULE).map((id) => `lint:${id}`)]
  .filter((id) => c.categoryOf(id) === 'other');
check(!untyped.length, `every axe, custom and lint rule has a type${untyped.length ? ` (missing: ${untyped.join(', ')})` : ''}`);

check(c.categoryOf('color-contrast') === 'contrast' && c.categoryOf('uic-component-boundary') === 'contrast', 'contrast: axe + non-text contrast');
check(c.categoryOf('aria-roles') === 'aria' && c.categoryOf('lint:jsx-a11y/aria-role') === 'aria', 'aria: axe + lint');
check(c.categoryOf('link-name') === 'links' && c.categoryOf('lint:jsx-a11y/anchor-has-content') === 'links', 'links: axe + lint');
check(c.categoryOf('sr-unnamed-control', '<input type="text">') === 'forms', 'an unnamed text field is a forms issue');
check(c.categoryOf('sr-unnamed-control', '<button class="x"></button>') === 'links', 'an unnamed button is a links & buttons issue');

check(JSON.stringify(c.parseOnly('color, roles,links,links')) === '["contrast","aria","links"]', '--only accepts aliases, commas and spaces, de-duplicates');
let threw = false;
try { c.parseOnly('contrast,bogus'); } catch (e) { threw = /bogus/.test(e.message); }
check(threw, '--only rejects an unknown type by name');

const cfg = c.scopeConfig({ OUTPUT_DIR: '/x/a11y-report', ONLY: [] }, { A11Y_ONLY: 'contrast,aria' });
check(cfg.OUTPUT_DIR === require('path').join('/x/a11y-report', 'only-contrast-aria'), 'a scoped run writes to its own folder');
check(c.scopeConfig({ OUTPUT_DIR: '/x', ONLY: [] }, {}).OUTPUT_DIR === '/x', 'no scope: output folder unchanged');

const rules = c.axeRulesFor(['contrast'], ['wcag2aa']);
check(rules.includes('color-contrast') && !rules.includes('image-alt'), 'axe runs only the rules in scope');

const scan = {
  violations: [
    { id: 'color-contrast', nodes: [{ html: '<p>' }] },
    { id: 'image-alt', nodes: [{ html: '<img>' }] },
    { id: 'sr-unnamed-control', nodes: [{ html: '<button></button>' }, { html: '<input>' }] },
  ],
  passes: [{ id: 'label', nodes: [] }],
};
c.scopeScan(scan, ['contrast', 'links']);
check(scan.violations.map((r) => r.id).join() === 'color-contrast,sr-unnamed-control', 'scopeScan drops out-of-scope rules');
check(scan.violations[1].nodes.length === 1 && scan.violations[1].nodes[0].html === '<button></button>', '…and the unnamed text field (forms) from the mixed rule');
check(!scan.passes.length, '…and their passes, so no criterion looks tested');
check(c.moduleInScope('uiContrast', ['contrast']) && !c.moduleInScope('keyboard', ['contrast']), 'checks that cannot report a type in scope are skipped');

console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
process.exitCode = failures ? 1 : 0;
