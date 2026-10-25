/**
 * Source lint (lib/static) — exact file:line findings per stack, mapped to
 * WCAG, and folded into the same aggregation as the browser scan.
 *
 * Pins:
 *   - each stack gets its own rule set (JSX, Vue SFC, Angular template incl.
 *     inline templates, plain HTML) and finds the planted defects on the right line;
 *   - node_modules / dist / eslint-disable comments are respected;
 *   - a heuristic on the same line as a precise rule for the same criterion is dropped;
 *   - high-confidence rules fail a criterion, heuristics only ask for review;
 *   - lint findings get the browser rule's fix advice and an exact location;
 *   - STATIC_LINT.rules can turn a rule off.
 *
 *   node test/lint.test.js
 */
const path = require('path');
const { lintProject, toScan } = require('../lib/static/eslint');
const { detectStacks } = require('../lib/adapters');
const { aggregate } = require('../lib/aggregate');

let failures = 0;
const check = (ok, msg) => { console.log((ok ? '  ok   ' : '  FAIL ') + msg); if (!ok) failures++; };
const FIX = path.join(__dirname, 'fixtures', 'lint');
const run = async (name, opts) => {
  const root = path.join(FIX, name);
  return lintProject(root, detectStacks(root).map((s) => s.id), opts);
};
const at = (res, rule, loc) => res.findings.find((f) => f.ruleId === rule && `${f.file}:${f.line}` === loc);

(async () => {
  console.log('\nReact (JSX + TSX)');
  const react = await run('react');
  check(at(react, 'jsx-a11y/alt-text', 'src/App.jsx:6'), 'img without alt → alt-text at App.jsx:6');
  check(at(react, 'jsx-a11y/tabindex-no-positive', 'src/App.jsx:9'), 'positive tabIndex at App.jsx:9');
  check(at(react, 'jsx-a11y/aria-role', 'src/App.jsx:12'), 'invalid role at App.jsx:12');
  check(at(react, 'jsx-a11y/iframe-has-title', 'src/Card.tsx:3'), 'TSX with generics parses; iframe title at Card.tsx:3');
  check(!react.findings.some((f) => f.file.includes('ignored') || f.line === 11), 'eslint-disable-next-line is honoured');
  check(!react.findings.some((f) => /node_modules|dist\//.test(f.file)), 'node_modules and dist are skipped');
  check(!at(react, 'jsx-a11y/control-has-associated-label', 'src/App.jsx:8') && at(react, 'jsx-a11y/anchor-has-content', 'src/App.jsx:8'), 'heuristic shadowed by a precise rule on the same line is dropped');
  check(at(react, 'jsx-a11y/control-has-associated-label', 'src/App.jsx:9'), '… but kept when the precise rule is about another criterion');
  check(react.unparsed.length === 0, 'no parse failures');

  console.log('\nVue SFC');
  const vue = await run('vue');
  check(at(vue, 'vuejs-accessibility/alt-text', 'src/components/Hello.vue:3'), 'img without alt in <template> at Hello.vue:3');
  check(at(vue, 'vuejs-accessibility/heading-has-content', 'src/components/Hello.vue:4'), 'empty heading at Hello.vue:4');

  console.log('\nAngular');
  const ng = await run('angular');
  check(at(ng, '@angular-eslint/template/alt-text', 'src/app/home.component.html:2'), 'templateUrl file: img without alt at home.component.html:2');
  check(at(ng, '@angular-eslint/template/valid-aria', 'src/app/home.component.html:3'), 'invalid aria-* attribute');
  check(at(ng, '@angular-eslint/template/alt-text', 'src/app/inline.component.ts:7'), 'inline template mapped back to the .ts line');

  console.log('\nPlain HTML');
  const html = await run('html');
  for (const [rule, line] of [['require-lang', 2], ['require-img-alt', 5], ['require-frame-title', 6], ['no-non-scalable-viewport', 3]]) {
    check(at(html, `@html-eslint/${rule}`, `public/index.html:${line}`), `${rule} at index.html:${line}`);
  }

  console.log('\noverrides');
  const off = await run('react', { rules: { 'jsx-a11y/alt-text': 'off' } });
  check(!off.findings.some((f) => f.ruleId === 'jsx-a11y/alt-text') && off.findings.length > 0, 'STATIC_LINT.rules turns one rule off, keeps the rest');

  console.log('\naggregation');
  {
    const scan = toScan(react);
    const { criteria, issues } = aggregate([scan], null, { stacks: ['react'] });
    const c = (id) => criteria.find((x) => x.id === id).status;
    check(c('1.1.1') === 'fail', '1.1.1 fails from a high-confidence lint finding');
    check(c('2.1.1') === 'review', '2.1.1 only "review" from keyboard heuristics');
    const alt = issues.find((i) => i.rule === 'lint:jsx-a11y/alt-text');
    check(alt && alt.source === 'lint' && alt.kind === 'violation', 'lint issue is a violation tagged source=lint');
    check(alt && alt.locations[0] && alt.locations[0].file && alt.locations[0].line === 6, `exact location kept (${alt && JSON.stringify(alt.locations[0])})`);
    check(alt && alt.customFix && /alt/i.test(alt.customFix.fix || ''), 'fix advice borrowed from the browser rule image-alt');
    check(alt && /^jsx-a11y\/alt-text\|src\/App\.jsx\|[0-9a-f]{10}$/.test(alt.lintKey), `lintKey survives line moves (${alt && alt.lintKey})`);
  }

  console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
  process.exitCode = failures ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
