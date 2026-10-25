/**
 * Counting accuracy — one defect is one issue, and only confirmed WCAG
 * violations count as defects:
 *   - a node seen as "review" in one state and "violation" in another is a violation
 *   - the tool's own unnamed-control check on the same element as axe's
 *     button-name is folded into the axe issue, not reported twice
 *   - the same header defect on several pages is N issues but 1 unique
 *   - best-practice rules (no WCAG tag) are listed but not counted as violations
 *   - a criterion whose rules were only "inapplicable" is not "pass"
 *   - IBM alone never makes a criterion "Failed", and never decides manual-only criteria
 *   - JUnit: tests= equals the real number of cases; lint gets its own suite
 *   - the gate ignores best-practice findings and non-numeric thresholds
 *
 *   node test/fix-b-aggregate.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { aggregate } = require('../lib/aggregate');
const { evaluateGate, writeJUnit } = require('../lib/ci');

let failures = 0;
const check = (ok, msg) => { console.log((ok ? '  ok   ' : '  FAIL ') + msg); if (!ok) failures++; };

const rule = (id, tags, nodes, impact = 'serious') => ({ id, tags, impact, help: id, nodes });
const node = (target, html, impact) => ({ target: [target], html, impact });
const scan = (page, state, parts) => ({
  page, url: `http://x/${page}`, state,
  violations: parts.violations || [], incomplete: parts.incomplete || [],
  passes: parts.passes || [], inapplicable: parts.inapplicable || [],
  ...(parts.ibm ? { ibm: parts.ibm } : {}),
});

const headerBtn = '<button class="cart"><svg aria-hidden="true"></svg></button>';
const scans = [
  // Home: contrast is undecided initially, confirmed inside a dialog.
  scan('Home', 'initial', {
    incomplete: [rule('color-contrast', ['wcag2aa', 'wcag143'], [node('.lowc', '<p class="lowc">x</p>', 'serious')])],
    violations: [
      rule('button-name', ['wcag2a', 'wcag412'], [node('.cart', headerBtn, 'critical')], 'critical'),
      // Same button from the screen-reader check, different selector shape + style="".
      rule('sr-unnamed-control', ['wcag2a', 'wcag412'], [node('button.cart', headerBtn.replace('class="cart"', 'class="cart" style=""'))]),
      rule('region', ['cat.keyboard', 'best-practice'], [node('body > p', '<p>loose</p>', 'moderate')], 'moderate'),
    ],
    // 2.2.1: only an inapplicable rule. 1.3.3 (manual-only) and 1.3.5: IBM only.
    inapplicable: [rule('meta-refresh', ['wcag2a', 'wcag221'], [])],
    ibm: { byCriterion: { '1.3.5': { fail: 2, review: 0, pass: 0 }, '1.3.3': { fail: 0, review: 0, pass: 3 } } },
  }),
  scan('Home', 'dialog: Settings', {
    violations: [rule('color-contrast', ['wcag2aa', 'wcag143'], [node('.lowc', '<p class="lowc">x</p>', 'serious')])],
  }),
  scan('About', 'initial', {
    violations: [rule('button-name', ['wcag2a', 'wcag412'], [node('.cart', headerBtn, 'critical')], 'critical')],
  }),
  scan('Contact', 'initial', {
    violations: [rule('button-name', ['wcag2a', 'wcag412'], [node('.cart', headerBtn, 'critical')], 'critical')],
  }),
  // Source lint pseudo-scan.
  { page: 'Source code (lint)', url: '', state: 'lint',
    violations: [rule('jsx-a11y/alt-text', ['wcag2a', 'wcag111'], [{ target: ['src/App.jsx:3'], html: '<img src="a.png">', lintKey: 'k1', impact: 'critical' }], 'critical')],
    incomplete: [], passes: [], inapplicable: [] },
];

const { criteria, issues, stats, matrix } = aggregate(scans, null);
const byId = Object.fromEntries(criteria.map((c) => [c.id, c]));

console.log('\nmerging');
const contrast = issues.filter((i) => i.rule === 'color-contrast');
check(contrast.length === 1, `contrast on one element is one issue (${contrast.length})`);
check(contrast[0] && contrast[0].kind === 'violation', `review in one state + violation in another = violation (${contrast[0] && contrast[0].kind})`);
check(contrast[0] && contrast[0].states.length === 2, 'both states recorded');
const homeBtn = issues.filter((i) => i.page === 'Home' && /button-name|sr-unnamed-control/.test(i.rule));
check(homeBtn.length === 1 && homeBtn[0].rule === 'button-name', `axe + own check on the same button = one axe issue (${homeBtn.map((i) => i.rule)})`);
check(homeBtn[0] && (homeBtn[0].alsoFlaggedBy || []).includes('sr-unnamed-control'), 'the own check is noted as alsoFlaggedBy');

console.log('\ncounting');
check(stats.confirmed.total === 5, `confirmed = contrast + 3 header buttons + lint (${stats.confirmed.total})`);
check(stats.bestPractice === 1 && issues.some((i) => i.rule === 'region' && i.category === 'best-practice'), 'best-practice rule listed, flagged as best-practice');
check(stats.confirmed.moderate === 0, 'best-practice finding not in confirmed counts');
check(stats.unique.confirmed === 3, `header button on 3 pages counts once in unique (${stats.unique.confirmed})`);
check(issues.filter((i) => i.rule === 'button-name').every((i) => i.groupPages === 3), 'each copy knows it repeats on 3 pages');
check(stats.byPageSeverity.Home.moderate === 0 && stats.byPageSeverity.Home.bestPractice === 1, 'health score ignores best-practice findings');
const c143 = stats.byCriterion.find((c) => c.id === '1.4.3');
check(c143 && c143.confirmed === 1 && c143.review === 0, 'byCriterion splits confirmed / review');

console.log('\ncriterion status');
check(byId['2.2.1'].status === 'manual' && byId['2.2.1'].untested, `inapplicable-only criterion is not "pass" (${byId['2.2.1'].status})`);
check(/not evidence/.test(byId['2.2.1'].untestedWhy || ''), 'and says why');
check(byId['1.3.5'].status === 'review' && byId['1.3.5'].source === 'ibm', `IBM-only fail → review, not fail (${byId['1.3.5'].status})`);
check(byId['1.3.3'].status === 'manual', `IBM cannot pass a manual-only criterion (${byId['1.3.3'].status})`);
check(byId['3.2.6'].level === 'A' && byId['3.3.7'].level === 'A', '3.2.6 and 3.3.7 are Level A');
check(matrix.cells.Home['1.3.5'] !== 'fail', 'matrix: IBM-only fail is not a fail cell');
check(matrix.lintPages.includes('Source code (lint)'), 'matrix exposes the lint pseudo-page');

console.log('\nJUnit');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a11y-junit-'));
const xml = fs.readFileSync(writeJUnit(dir, { criteria, issues, stats, matrix }), 'utf8');
const declared = Number((xml.match(/<testsuites[^>]*tests="(\d+)"/) || [])[1]);
const actual = (xml.match(/<testcase /g) || []).length;
check(declared === actual, `tests= matches the real number of cases (${declared} vs ${actual})`);
check(!/testsuite name="Source code \(lint\)" tests="4\d"/.test(xml) && /classname="lint"/.test(xml), 'lint is its own suite of real findings, not a page of skipped criteria');
check(!/0 issue\(s\) for this criterion/.test(xml), 'no empty failures');
fs.rmSync(dir, { recursive: true, force: true });

console.log('\ngate');
const saved = { ...process.env };
process.env.A11Y_FAIL_ON_SERIOUS = '$(A11Y_FAIL_ON_SERIOUS)'; // unset Azure variable
process.env.A11Y_FAIL_ON_CRITICAL = '3';
let g = evaluateGate(stats, { PAGES: [] }, matrix, null);
check(g.limits.serious === null, 'non-numeric threshold is treated as unset, not NaN');
check(g.failed && /4 critical/.test(g.reasons[0]), `critical gate counts confirmed WCAG violations (${g.reasons[0]})`);
process.env.A11Y_GATE_UNIQUE = '1';
g = evaluateGate(stats, { PAGES: [] }, matrix, null);
check(!g.failed && g.actual.critical === 2, `A11Y_GATE_UNIQUE counts the repeated header button once (${g.actual.critical})`);
delete process.env.A11Y_FAIL_ON_CRITICAL; delete process.env.A11Y_FAIL_ON_SERIOUS; delete process.env.A11Y_GATE_UNIQUE;
process.env.CI = '1';
g = evaluateGate(stats, { PAGES: [] }, matrix, null);
check(!g.enforced && g.warnings.length === 1, 'warns in CI when no threshold is set');
process.env = saved;

console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
process.exitCode = failures ? 1 : 0;
