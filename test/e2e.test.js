/**
 * Playwright fixture + reporter, through the real test runner: a small project
 * (test/fixtures/e2e-project) whose tests call a11y.check() at points a
 * route scan cannot reach — e.g. after opening a dialog.
 *
 * Pins: states are attributed to the right route (most specific pattern wins),
 * findings that only exist after an interaction are caught, auto mode scans
 * the final page, tests that don't use the fixture are not scanned, retries/
 * workers don't duplicate data, and the run lands in the normal reports as a
 * "(E2E)" run.
 *
 *   node test/e2e.test.js
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

let failures = 0;
const check = (ok, msg) => { console.log((ok ? '  ok   ' : '  FAIL ') + msg); if (!ok) failures++; };
const DIR = path.join(__dirname, 'fixtures', 'e2e-project');
const OUT = path.join(DIR, 'a11y-report');
fs.rmSync(OUT, { recursive: true, force: true });

const cli = require.resolve('@playwright/test/cli');
const env = { ...process.env };
for (const k of Object.keys(env)) if (k.startsWith('A11Y_')) delete env[k];
const run = spawnSync(process.execPath, [cli, 'test'], { cwd: DIR, encoding: 'utf8', env: { ...env, CI: '1' }, timeout: 300000 });
const out = run.stdout + run.stderr;
check(run.status === 0, `playwright test exits 0${run.status ? `\n${out.slice(-2000)}` : ''}`);

let report = null;
try { report = JSON.parse(fs.readFileSync(path.join(OUT, 'report.json'), 'utf8')); } catch { /* checked below */ }
check(!!report, 'report.json written to the project\'s a11y-report/');
if (report) {
  const issues = report.issues || [];
  const pages = new Set(issues.map((i) => i.page).concat((report.matrix && report.matrix.pages) || []));
  check(pages.has('User detail') && pages.has('New user'), `results named after routes from a11y.routes.json (${[...pages].join(', ')})`);
  check(pages.has('/app/settings'), 'auto mode scanned the final page of a test that made no check() call');
  check(!pages.has('/app/about'), 'a test that does not use the fixture is not scanned');
  const btn = issues.find((i) => i.rule === 'button-name' && i.page === 'New user');
  check(!!btn && btn.states.some((s) => /dialog open/.test(s)), 'violation that only exists after a click is reported, under the test step that found it');
  check(report.meta && /\(E2E\)$/.test(report.meta.reportName), `run is labelled as E2E (${report.meta && report.meta.reportName})`);
}
check(!fs.existsSync(path.join(OUT, '.e2e-scans')) || !fs.readdirSync(path.join(OUT, '.e2e-scans')).length, 'raw per-test files cleaned up after the report is built');
check(/a11y: \d+ state\(s\) on \d+ page\(s\) from 3 test\(s\)/.test(out), 'reporter summary printed');

fs.rmSync(OUT, { recursive: true, force: true });
console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
process.exitCode = failures ? 1 : 0;
