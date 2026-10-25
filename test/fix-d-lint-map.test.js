/**
 * Accuracy pins for the source lint, code mapping and route discovery —
 * each one a false positive / false location / missed guard found in an audit.
 *
 *   lint      tests, stories, cypress, generated docs, .eslintignore and the
 *             project's ignorePatterns / flat-config ignores are not linted;
 *             rules the project turned off stay off, its options (Next.js Link)
 *             and jsx-a11y component settings are used; aria-role ignores
 *             components; spread props / fragments / href="#" are not failures;
 *             best-practice rules carry no WCAG criterion; Vue labels by
 *             nesting OR for/id both pass; Angular 20 inline templates in
 *             files without the .component suffix are linted.
 *   codeMap   word-bounded, attribute-first id search; clues found in several
 *             files are downgraded and say so; minified / name-only React
 *             components never pick a file; basename-only matches are not "exact".
 *   routes    Next proxy.ts and layout-level redirect() guards, Nuxt global middleware.
 *
 *   node test/fix-d-lint-map.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { lintProject, toScan } = require('../lib/static/eslint');
const { detectStacks } = require('../lib/adapters');
const { createMapper, locateNode } = require('../lib/codeMap');

let failures = 0;
const check = (ok, msg) => { console.log((ok ? '  ok   ' : '  FAIL ') + msg); if (!ok) failures++; };
const FIX = path.join(__dirname, 'fixtures', 'lint');
const run = async (name, opts) => {
  const root = path.join(FIX, name);
  return lintProject(root, detectStacks(root).map((s) => s.id), opts);
};
const find = (res, rule, loc) => res.findings.find((f) => f.ruleId === rule && (!loc || `${f.file}:${f.line}` === loc));

function tmpProject(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a11y-fixd-'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

(async () => {
  console.log('\nlint: what is not the product is not linted');
  const r = await run('fp-react');
  const files = new Set(r.findings.map((f) => f.file));
  for (const f of ['src/__tests__/Form.test.tsx', 'stories/Btn.stories.tsx', 'cypress/e2e/a.cy.jsx', 'docs/api/index.html']) {
    check(!files.has(f), `${f} skipped`);
  }
  check(!files.has('generated/Gen.jsx'), '.eslintignore honoured');
  check(!files.has('legacy-ignored/L.jsx'), '.eslintrc ignorePatterns honoured');
  check(r.projectConfig === '.eslintrc.json', `project config reported (${r.projectConfig})`);
  const withTests = await run('fp-react', { includeTests: true });
  check(withTests.findings.some((f) => f.file === 'src/__tests__/Form.test.tsx'), 'STATIC_LINT.includeTests lints test files again');

  console.log('\nlint: the project\'s own decisions');
  check(!find(r, 'jsx-a11y/no-autofocus'), 'rule the project turned off stays off');
  check(!find(r, 'jsx-a11y/anchor-is-valid', 'src/components/Form.tsx:11'), 'project options for anchor-is-valid (Next.js Link) are used');
  const noProject = await run('fp-react', { useProjectConfig: false });
  check(find(noProject, 'jsx-a11y/no-autofocus'), 'useProjectConfig: false ignores the project config');

  console.log('\nlint: rule options');
  check(!find(r, 'jsx-a11y/aria-role', 'src/components/Form.tsx:5'), '<UserCard role="admin"> is a prop, not an ARIA role');
  check(!find(r, 'jsx-a11y/control-has-associated-label', 'src/components/Form.tsx:6'), 'input with <label htmlFor> is not "unlabelled"');
  check(!find(r, 'jsx-a11y/no-noninteractive-element-to-interactive-role', 'src/components/Form.tsx:8'), 'ul role=menu / li role=menuitem allowed');
  const spread = find(r, 'jsx-a11y/alt-text', 'src/components/Form.tsx:9');
  check(!spread || spread.mapping.conf === 'review', '<img {...props}> is a review item, not a violation');
  const real = find(r, 'jsx-a11y/alt-text', 'src/components/Form.tsx:10');
  check(real && real.mapping.conf === 'high', 'a plain <img> without alt is still a violation');
  const noHref = find(noProject, 'jsx-a11y/anchor-is-valid', 'src/components/Anchors.jsx:3');
  check(noHref && noHref.mapping.sc.includes('2.1.1') && !noHref.mapping.bp, '<a onClick> without href is still a 2.1.1 review item');
  const hash = find(noProject, 'jsx-a11y/anchor-is-valid', 'src/components/Anchors.jsx:4');
  check(hash && hash.mapping.bp && hash.mapping.sc.length === 0, '<a href="#" onClick> is best practice (still keyboard-operable), not 2.1.1');

  console.log('\nlint: best practice carries no criterion');
  {
    const bp = find(noProject, 'jsx-a11y/no-autofocus');
    check(bp && bp.mapping.bp && bp.mapping.sc.length === 0, 'no-autofocus is best practice, no WCAG criterion');
    const scan = toScan(noProject);
    const rule = scan.incomplete.find((x) => x.id === 'lint:jsx-a11y/no-autofocus');
    check(rule && rule.tags.includes('best-practice') && !rule.tags.some((t) => /^wcag\d/.test(t)), 'scan entry tagged best-practice, no wcag tag');
    check(!scan.violations.some((x) => x.id === 'lint:jsx-a11y/no-autofocus'), 'never a violation');
  }

  console.log('\nlint: flat config');
  const flat = await run('fp-flat');
  check(flat.projectConfig === 'eslint.config.cjs', `flat config read (${flat.projectConfig})`);
  check(!find(flat, 'jsx-a11y/iframe-has-title'), 'rule turned off in eslint.config is off');
  check(!flat.findings.some((f) => f.file.startsWith('ignored/')), 'flat-config ignores honoured');
  check(find(flat, 'jsx-a11y/alt-text', 'src/App.jsx:4'), 'jsx-a11y components setting (Image → img) applied');

  console.log('\nlint: Vue');
  const vue = await run('fp-vue');
  check(!find(vue, 'vuejs-accessibility/label-has-for'), 'label by for/id and label by nesting are both fine');
  const vspread = find(vue, 'vuejs-accessibility/alt-text', 'src/A.vue:5');
  check(!vspread || vspread.mapping.conf === 'review', '<img v-bind="$attrs"> is a review item');
  check(find(vue, 'vuejs-accessibility/alt-text', 'src/A.vue:6'), 'real missing alt still found');

  console.log('\nlint: Angular 20 (no .component suffix)');
  const ng = await run('fp-ng');
  check(find(ng, '@angular-eslint/template/alt-text', 'src/app/user-card.ts:7'), 'inline template in user-card.ts linted');

  console.log('\nlint: HTML fragments');
  const html = await run('fp-html');
  const page = find(html, '@html-eslint/require-img-alt', 'public/index.html:4');
  check(page && page.mapping.conf === 'high', 'full document: missing alt is a violation');
  const part = find(html, '@html-eslint/require-img-alt', 'templates/partial.html:1');
  check(part && part.mapping.conf === 'review', 'fragment: missing alt is a review item');

  console.log('\ncodeMap');
  {
    const repo = tmpProject({
      'src/z/Header.tsx': 'export function Header() { return <form><input id="search" /><img src="/logo.png" /></form>; }\n',
      'src/a/Aa.tsx': 'export const Button = styled.button``; const t = 1;\n',
      'src/a/Analytics.tsx': "export function Analytics() { const search = 1; const researchers = 2; return <img src=\"/logo.png\" alt=\"\" />; }\n",
      'src/b/Card.tsx': 'export function Card() { return <div id="nav" className="card-x" />; }\n',
      'src/c/Navigation.tsx': 'export const navigation = 1;\n',
      'index.tsx': 'export {};\n',
      'src/pages/index.tsx': 'export default function P() { return <button />; }\n',
    });
    const m = createMapper(repo, ['.tsx']);
    const id = locateNode({ html: '<input id="search">', target: ['#search'] }, m);
    check(id[0] && id[0].file === 'src/z/Header.tsx' && id[0].confidence === 'high', `id found in attribute position, not "const search" (${id[0] && id[0].file})`);
    const img = locateNode({ html: '<img src="/logo.png">', target: ['img'] }, m);
    check(img.length && img.every((x) => x.confidence !== 'high') && /matches 2 files/.test(img[0].clue), `image in 2 files is not "high" and says so (${img[0] && img[0].clue} · ${img[0] && img[0].confidence})`);
    const shortId = locateNode({ html: '<div id="nav">', target: ['#nav'] }, m);
    check(shortId[0] && shortId[0].file === 'src/b/Card.tsx' && shortId[0].confidence === 'low', `3-char id → low confidence, no substring hit in "navigation" (${shortId.map((x) => x.file).join(',')})`);
    const minified = locateNode({ html: '<button class="sc-a">', target: ['button'], runtimeSource: { framework: 'react', file: null, line: null, component: 't' } }, m);
    check(!minified.some((x) => /dev build/.test(x.clue)), 'minified component name "t" never picks a file');
    const nameOnly = locateNode({ html: '<button class="sc-a">', target: ['button'], runtimeSource: { framework: 'react', file: null, line: null, component: 'Button', nameOnly: true } }, m);
    check(!nameOnly.some((x) => /dev build/.test(x.clue)), 'production React name (no _debugSource) is not used as a location');
    const base = locateNode({ html: '<button>', target: ['button'], runtimeSource: { framework: 'react', file: '/elsewhere/app/index.tsx', line: 1, exact: true } }, m);
    check(base[0] && base[0].confidence === 'low', `basename-only match shared by 2 files → low, not exact (${base[0] && base[0].confidence})`);
    const gone = locateNode({ html: '<button>', target: ['button'], runtimeSource: { framework: 'react', file: '/elsewhere/Missing.tsx', line: 3, exact: true } }, m);
    check(gone[0] && gone[0].confidence === 'low', 'a build path this checkout does not have is shown as low confidence');
  }

  console.log('\nroutes');
  {
    const next = tmpProject({
      'package.json': '{"dependencies":{"next":"16"}}',
      'proxy.ts': "import { auth } from './auth';\nexport default auth;\nexport const config = { matcher: ['/account/:path*'] };\n",
      'app/page.tsx': 'export default function H() { return null; }\n',
      'app/account/page.tsx': 'export default function A() { return null; }\n',
      'app/(admin)/layout.tsx': "import { redirect } from 'next/navigation';\nimport { auth } from '@/auth';\nexport default async function L({ children }) { const s = await auth(); if (!s) redirect('/login'); return children; }\n",
      'app/(admin)/admin/page.tsx': 'export default function Ad() { return null; }\n',
      'app/about/page.tsx': 'export default function Ab() { return null; }\n',
    });
    const nextAdapter = require('../lib/adapters/next');
    const { routes } = nextAdapter.discoverRoutes({ id: 'next', root: next });
    const g = (p) => (routes.find((x) => x.pattern === p) || {}).guarded;
    check(g('/account') === true, 'Next 16 proxy.ts matcher marks /account guarded');
    check(g('/admin') === true, 'layout with auth() + redirect() marks /admin guarded');
    check(g('/about') === false && g('/') === false, 'public pages stay public');

    const nuxt = tmpProject({
      'package.json': '{"dependencies":{"nuxt":"3"}}',
      'middleware/auth.global.ts': "export default defineNuxtRouteMiddleware((to) => {\n  const { loggedIn } = useUserSession();\n  if (to.path === '/login') return;\n  if (!loggedIn.value) return navigateTo('/login');\n});\n",
      'pages/index.vue': '<template><p>home</p></template>\n',
      'pages/login.vue': '<template><p>login</p></template>\n',
      'pages/pricing.vue': "<script setup>definePageMeta({ auth: false })</script><template><p>p</p></template>\n",
    });
    const vueAdapter = require('../lib/adapters/vue');
    const nr = vueAdapter.discoverRoutes({ id: 'nuxt', root: nuxt }).routes;
    const ng2 = (p) => (nr.find((x) => x.pattern === p) || {}).guarded;
    check(ng2('/') === true, 'Nuxt global auth middleware guards /');
    check(ng2('/login') === false, '… except the path it lets through');
    check(ng2('/pricing') === false, '… and pages that opt out with auth: false');
  }

  console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
  process.exitCode = failures ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
