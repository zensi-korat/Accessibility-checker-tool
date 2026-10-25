/**
 * Runtime source mapping: reading where an element came from out of a dev
 * build, then pinning it to a repo file:line. Real frameworks are not
 * installed here — the page carries the same properties their dev builds
 * leave on DOM nodes, so every branch runs in a real browser:
 *
 *   Angular   window.ng.getOwningComponent → class → templateUrl → line in the template
 *   Svelte 4  __svelte_meta.loc with a 0-based line
 *   React     fiber._debugSource with an absolute path from ANOTHER machine (CI)
 *   attrs     data-inspector-relative-path + data-inspector-line
 *   none      production build: nothing attached, report falls back to text search
 *
 * (Real React 18/19 + Vite and Vue 3 + Vite dev servers were also checked by
 * hand when this was written; they need network installs, so they are not
 * part of this suite. That check is why lib/codeMap.js re-anchors lines:
 * Vite's React plugin reports JSX lines shifted by its hot-reload preamble.)
 *
 *   node test/runtimeSource.test.js
 */
const path = require('path');
const { chromium } = require('playwright');
const { attachRuntimeSources } = require('../lib/runtimeSource');
const { createMapper, locateNode, resolveRuntimeFile } = require('../lib/codeMap');

let failures = 0;
const check = (ok, msg) => { console.log((ok ? '  ok   ' : '  FAIL ') + msg); if (!ok) failures++; };
const REPO = path.join(__dirname, 'fixtures', 'runtime-repo');

const HTML = `<!doctype html><html lang="en"><head><title>t</title></head><body>
<app-users><h2>Users</h2><div class="toolbar"><button class="add-user" id="ng-btn"><svg></svg></button></div></app-users>
<img id="sv-img" class="card-img" src="/a.png">
<nav><a id="react-link" class="home-link" href="/"><svg></svg></a></nav>
<button id="attr-btn" data-inspector-relative-path="src/Toolbar.tsx" data-inspector-line="4"></button>
<button id="prod-btn"></button>
<script>
  // Angular dev mode
  class _UsersComponent {}
  const host = document.querySelector('app-users');
  window.ng = { getComponent: (el) => el === host ? new _UsersComponent() : null,
                getOwningComponent: (el) => host.contains(el) ? new _UsersComponent() : null };
  // Svelte 4 (0-based line 3 → source line 4)
  document.getElementById('sv-img').__svelte_meta = { loc: { file: 'src/lib/Card.svelte', line: 3, column: 0, char: 40 } };
  // React 18 dev, built on a CI agent with a different checkout path
  const hostFiber = { type: 'a', _debugSource: { fileName: '/home/runner/work/app/app/src/Toolbar.tsx', lineNumber: 4 }, return: { type: function Toolbar() {} } };
  document.getElementById('react-link')['__reactFiber$abc123'] = hostFiber;
</script></body></html>`;

(async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext()).newPage();
  await page.setContent(HTML);
  const node = (id, html) => ({ target: ['#' + id], html });
  const results = { violations: [{ id: 'x', nodes: [
    node('ng-btn', '<button class="add-user" id="ng-btn">'),
    node('sv-img', '<img id="sv-img" class="card-img" src="/a.png">'),
    node('react-link', '<a id="react-link" class="home-link" href="/">'),
    node('attr-btn', '<button id="attr-btn">'),
    node('prod-btn', '<button id="prod-btn">'),
  ] }], incomplete: [] };
  await attachRuntimeSources(page, results);
  await browser.close();

  const mapper = createMapper(REPO, ['.ts', '.tsx', '.html', '.svelte'], { stripServerIds: false });
  const [ng, sv, react, attr, prod] = results.violations[0].nodes.map((n) => ({ n, loc: locateNode(n, mapper)[0] }));

  check(ng.n.runtimeSource && ng.n.runtimeSource.component === 'UsersComponent', 'Angular: owning component read from window.ng (leading _ stripped)');
  check(ng.loc && ng.loc.file === 'src/app/users/users.component.html' && ng.loc.line === 3, `Angular: class → templateUrl → template line (${ng.loc && ng.loc.file}:${ng.loc && ng.loc.line})`);
  check(sv.loc && sv.loc.file === 'src/lib/Card.svelte' && sv.loc.line === 4 && sv.loc.confidence === 'exact', `Svelte 4: 0-based line corrected (${sv.loc && sv.loc.line})`);
  check(react.loc && react.loc.file === 'src/Toolbar.tsx' && react.loc.line === 4 && react.loc.confidence === 'exact', 'React: CI-machine absolute path re-rooted into this checkout, exact line');
  check(react.n.runtimeSource.component === 'Toolbar', 'React: nearest component name captured');
  check(attr.loc && attr.loc.file === 'src/Toolbar.tsx' && attr.loc.line === 4, 'data-inspector-* attributes');
  check(!prod.n.runtimeSource, 'production build (no metadata): nothing attached, text search takes over');

  console.log('\npath resolution');
  check(resolveRuntimeFile('http://localhost:5173/src/Toolbar.tsx?t=1712', REPO) === path.join(REPO, 'src/Toolbar.tsx'), 'Vite dev-server URL with cache-buster');
  check(resolveRuntimeFile('webpack://_N_E/./src/Toolbar.tsx', REPO) === path.join(REPO, 'src/Toolbar.tsx'), 'webpack:// URL (Next.js)');
  check(resolveRuntimeFile('/@fs' + path.join(REPO, 'src/Toolbar.tsx'), REPO) === path.join(REPO, 'src/Toolbar.tsx'), "Vite /@fs/ absolute path");
  check(resolveRuntimeFile('/elsewhere/not-here.tsx', REPO) === null, 'a file that is not in the repo resolves to null, not a guess');

  console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
  process.exitCode = failures ? 1 : 0;
})();
