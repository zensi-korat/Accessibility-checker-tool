/**
 * `a11y verify` — after a fix, does the re-scan say exactly what got fixed?
 *
 * Run 1 scans a deliberately broken app. Then the "developer" fixes some
 * things, leaves one, introduces one, and deletes the button that opened a
 * dialog. Run 2 (`--verify`) must report:
 *   fixed        — the image that now has alt text (element still there, rule passes)
 *                — the lint finding whose line was fixed
 *   still        — the unnamed button; the lint finding that only MOVED down the file
 *   new          — the unlabelled input added since
 *   unverified   — the dialog image: its dialog never opened, so "gone" is not "fixed"
 * and it must not re-scan the page that was clean, and must exit non-zero.
 *
 *   node test/verify.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

let failures = 0;
const check = (ok, msg) => { console.log((ok ? '  ok   ' : '  FAIL ') + msg); if (!ok) failures++; };

let fixed = false;
const page = (title, body) => `<!doctype html><html lang="en"><head><title>${title}</title></head><body><main><h1>${title}</h1>${body}</main></body></html>`;
const server = http.createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  res.writeHead(200, { 'content-type': 'text/html' });
  if (p === '/') {
    return res.end(page('Home', fixed
      ? '<img src="/logo.png" alt="Acme"><button class="go"></button><input id="email" type="text">'
      : '<img src="/logo.png"><button class="go"></button>'));
  }
  if (p === '/clean') return res.end(page('Clean', '<p>Nothing wrong here.</p>'));
  if (p === '/dialog') {
    return res.end(page('Dialog', (fixed ? '' : '<button id="open" onclick="document.getElementById(\'dlg\').hidden=false">Open</button>')
      + '<div id="dlg" hidden><img id="dimg" src="/d.png"></div>'));
  }
  res.end(page('x', ''));
});

const BAD_JSX = `export default function App() {
  return (
    <main>
      <img src="/a.png" />
      <input tabIndex={2} />
    </main>
  );
}
`;
const FIXED_JSX = `// a comment pushes everything down a line
export default function App() {
  return (
    <main>
      <img src="/a.png" alt="A" />
      <input tabIndex={2} />
    </main>
  );
}
`;

(async () => {
  await new Promise((r) => server.listen(0, r));
  const url = `http://localhost:${server.address().port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a11y-verify-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"dependencies":{"react":"18.0.0"}}');
  fs.writeFileSync(path.join(dir, 'src', 'App.jsx'), BAD_JSX);
  fs.writeFileSync(path.join(dir, 'a11y.config.js'), `module.exports = {
    BASE_URL: '${url}', REPO_PATH: '.', OUTPUT_DIR: 'out', ROUTES_FILE: '', REPORT_NAME: 'verify-test',
    SETTLE_MS: 50, DYNAMIC_CHECKS: false, SCREENSHOTS: { enabled: false }, OPEN_REPORT: false, CUMULATIVE_REPORT: false,
    PAGES: [
      { name: 'Home', path: '/' },
      { name: 'Clean', path: '/clean' },
      { name: 'Dialog', path: '/dialog', actions: [{ type: 'click', selector: '#open', timeout: 1500 }, { type: 'snapshot', label: 'Dialog open' }] },
    ],
  };`);
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('A11Y_')) delete env[k];
  const run = (args) => new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'scan.js'), ...args], { cwd: dir, env: { ...env, A11Y_CI: '1', A11Y_TIMING: '0' } });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (status) => resolve({ status, out }));
  });

  const first = await run([]);
  check(!/Fix verification/.test(first.out), 'first scan: nothing to verify against yet');

  fixed = true;
  fs.writeFileSync(path.join(dir, 'src', 'App.jsx'), FIXED_JSX);
  const second = await run(['--verify']);
  const report = JSON.parse(fs.readFileSync(path.join(dir, 'out', 'report.json'), 'utf8'));
  const v = report.verification;
  check(!!v, 'report.json carries a verification block');
  if (v) {
    const has = (list, page, rule) => v[list].some((i) => i.page === page && i.rule === rule);
    check(has('fixed', 'Home', 'image-alt'), 'fixed: image now has alt text (element re-found, rule passes)');
    check(has('fixed', 'Source code (lint)', 'lint:jsx-a11y/alt-text'), 'fixed: lint finding on the corrected line');
    check(has('still', 'Home', 'button-name'), 'still failing: the unnamed button');
    check(has('still', 'Source code (lint)', 'lint:jsx-a11y/tabindex-no-positive'), 'still failing: lint finding that only moved down a line');
    check(v.new.some((i) => i.page === 'Home' && /label/.test(i.rule)), `new: the unlabelled input (${v.new.map((i) => i.rule).join(', ')})`);
    const dlg = v.unverified.find((i) => i.page === 'Dialog' && i.rule === 'image-alt');
    check(dlg && !has('fixed', 'Dialog', 'image-alt'), `dialog image whose dialog never opened → couldn't verify, not fixed (${dlg && dlg.reason})`);
  }
  check(/Verify: re-scanning \d+ of 3 page/.test(second.out), 'verify mode announces which pages it re-scans');
  {
    // Only pages with open issues are re-scanned (unit level: in the e2e app the
    // cross-page consistency check gives every page an issue).
    const { pagesWithIssues } = require('../lib/verify');
    const set = pagesWithIssues({ pages: new Map([['A', { issues: [{}] }], ['B', { issues: [] }]]) });
    check(set.has('A') && !set.has('B'), 'pages without open issues are not re-scanned');
  }
  check(second.status === 1 && /Not done yet/.test(second.out), `exit 1 while something is still failing (exit ${second.status})`);
  check(/✔ \d+ fixed · ✗ \d+ still failing/.test(second.out), 'terminal summary printed');

  fs.rmSync(dir, { recursive: true, force: true });
  server.close();
  console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
  process.exitCode = failures ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; server.close(); });
