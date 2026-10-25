/**
 * Config loading and the routes manifest — the seams that let the tool run
 * against any project instead of only the folder it is installed in.
 *
 *   - a project config resolves its paths against ITS folder, not the tool's
 *     or the shell's, so `a11y scan` works from anywhere;
 *   - without a config the loader says how to get one;
 *   - re-running discovery never overwrites a human's include/params edits;
 *   - a dynamic route is only scanned once it has sample params.
 *
 *   node test/config.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadConfig } = require('../lib/config/load');
const { mergeManifest, pagesFromManifest, fillPattern, writeManifest } = require('../lib/routes/manifest');

let failures = 0;
const check = (ok, msg) => { console.log((ok ? '  ok   ' : '  FAIL ') + msg); if (!ok) failures++; };
const env = { ...process.env };
for (const k of Object.keys(process.env)) if (k.startsWith('A11Y_') || k === 'CI' || k === 'TF_BUILD') delete process.env[k];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'a11y-cfg-'));
const proj = path.join(tmp, 'my-app');
fs.mkdirSync(proj);
fs.writeFileSync(path.join(proj, 'a11y.config.js'), `module.exports = {
  BASE_URL: 'http://localhost:4200', REPO_PATH: '.', OUTPUT_DIR: 'a11y-report',
  LOGIN: { mode: 'manual', stateFile: '.a11y-auth.json' },
  SCREENSHOTS: { maxPerRule: 1 },
  PAGES: [{ name: 'Home (hand-written)', path: '/', actions: [{ type: 'snapshot' }] }],
};`);
fs.writeFileSync(path.join(proj, 'package.json'), '{"dependencies":{"@angular/core":"18"}}');

console.log('\nproject config');
{
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'a11y-cwd-'));
  const c = loadConfig({ argv: ['node', 'scan.js', '--config', path.join(proj, 'a11y.config.js')], cwd: elsewhere });
  check(c.OUTPUT_DIR === path.join(proj, 'a11y-report'), 'OUTPUT_DIR resolves against the config folder, not the cwd');
  check(c.REPO_PATH === proj, 'REPO_PATH "." is the project');
  check(c.LOGIN.stateFile === path.join(proj, '.a11y-auth.json'), 'session file lives with the project');
  check(c.SCREENSHOTS.maxPerRule === 1 && c.SCREENSHOTS.maxPerState === 15, 'partial SCREENSHOTS override keeps the other defaults');
  check(c.AXE_TAGS.includes('wcag22aa') && c.SETTLE_MS === 900, 'unset keys get defaults');
  check(c.CODE_EXTENSIONS.join() === '.html,.ts', 'code extensions come from the detected stack (Angular)');
  check(c.STRIP_SERVER_IDS === false, 'WebForms id-mangling is off for a non-WebForms project');
}
{
  const c = loadConfig({ argv: ['node', 'scan.js'], cwd: proj });
  check(c._meta.configFile === path.join(proj, 'a11y.config.js'), './a11y.config.js is found from the project folder without --config');
}

console.log('\nno config / WebForms');
{
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'a11y-none-'));
  let msg = '';
  try { loadConfig({ argv: ['node', 'scan.js'], cwd: empty }); } catch (e) { msg = e.message; }
  check(/accessibility-check init/.test(msg), 'no config → error says to run `accessibility-check init`');
  const wf = path.join(tmp, 'webforms');
  fs.mkdirSync(wf);
  fs.writeFileSync(path.join(wf, 'a11y.config.js'), "module.exports = { BASE_URL: 'http://x', CODE_EXTENSIONS: ['.aspx', '.ascx'] };");
  const c = loadConfig({ argv: ['node', 'scan.js'], cwd: wf });
  check(c.CODE_EXTENSIONS.includes('.aspx') && c.STRIP_SERVER_IDS === true, 'explicit WebForms extensions keep id-stripping on');
  check(c.LOGIN.stateFile === path.join(wf, '.a11y-auth.json'), 'default session file is .a11y-auth.json beside the config');
}

console.log('\nroutes manifest');
{
  const found = [
    { pattern: '/', sources: ['angular a.ts:1'] },
    { pattern: '/users/:id', guarded: true, sources: ['angular a.ts:2'] },
    { pattern: '/reports', sources: ['angular a.ts:3'] },
    { pattern: '/docs/:slug*?', sources: ['next x'] },
  ];
  const first = mergeManifest(null, found);
  const by = (m, p) => m.routes.find((r) => r.pattern === p);
  check(by(first, '/').include && !by(first, '/users/:id').include, 'static routes included; dynamic ones wait for params');
  check(by(first, '/docs/:slug*?').include, 'a route whose only param is optional is included');
  check(by(first, '/users/:id').guarded === true, 'guard flag carried through');

  // Human review: exclude /reports, give /users/:id a sample, rename it.
  by(first, '/reports').include = false;
  Object.assign(by(first, '/users/:id'), { include: true, params: { id: '42' }, name: 'User 42' });
  const second = mergeManifest(first, [...found.filter((f) => f.pattern !== '/reports'), { pattern: '/settings', sources: ['angular b.ts:1'] }]);
  check(by(second, '/users/:id').params.id === '42' && by(second, '/users/:id').name === 'User 42', 'human params/name survive re-discovery');
  check(by(second, '/reports').status === 'gone' && by(second, '/reports').include === false, 'vanished route kept as "gone", not deleted');
  check(by(second, '/settings').status === 'new' && by(second, '/').status === 'ok', 'new vs. known routes are marked');

  const pages = pagesFromManifest(second, [{ path: '/' }]);
  const paths = pages.map((p) => p.path).sort();
  check(JSON.stringify(paths) === JSON.stringify(['/docs', '/settings', '/users/42']), `pages = ${paths.join(', ')} (hand-written "/" not duplicated, gone route skipped)`);

  check(fillPattern('/files/:rest*', { rest: 'a/b' }) === '/files/a/b' && fillPattern('/files/:rest*', {}) === null, 'catch-all needs a value; multi-segment values allowed');
  check(pagesFromManifest({ routes: [{ pattern: '/', hash: true, include: true }] })[0].path === '/#/', 'hash routes become /#/…');

  // End to end through the loader: manifest pages are appended to PAGES.
  writeManifest(path.join(proj, 'a11y.routes.json'), second);
  const c = loadConfig({ argv: ['node', 'scan.js'], cwd: proj });
  check(c.PAGES.length === 4 && c.PAGES[0].name === 'Home (hand-written)', 'loader appends manifest pages after hand-written PAGES');
}

fs.rmSync(tmp, { recursive: true, force: true });
Object.assign(process.env, env);
console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
process.exitCode = failures ? 1 : 0;
