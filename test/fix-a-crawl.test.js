/**
 * Quick scan of a static site started from a file URL:
 *
 *   a11y scan http://host/index.html
 *
 * must scan /contact.html — never http://host/index.html/contact.html — must
 * treat / and /index.html as one page, must not scan links that answer 404,
 * and must not report an error page as a scanned page.
 *
 *   node test/fix-a-crawl.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { routeOf, splitStartUrl, discoverLive } = require('../lib/routes/live');
const { mergeDefaults } = require('../lib/config/load');

let failures = 0;
const check = (ok, msg) => { console.log((ok ? '  ok   ' : '  FAIL ') + msg); if (!ok) failures++; };

const page = (title, body) => `<!doctype html><html lang="en"><head><title>${title}</title></head><body><main><h1>${title}</h1>${body}</main></body></html>`;
const NAV = '<nav><a href="index.html">Home</a> <a href="contact.html">Contact</a> <a href="missing.html">Gone</a> <a href="secret.html">Secret</a></nav>';
const requested = [];
const server = http.createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  requested.push(p);
  if (p === '/' || p === '/index.html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(page('Home', NAV)); }
  if (p === '/contact.html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(page('Contact', NAV + '<img src="x.png">')); }
  if (p === '/secret.html') { res.writeHead(403, { 'content-type': 'text/html' }); return res.end(page('Forbidden', '<img src="y.png">')); }
  // Error page with a title that does NOT say 404 (like Python's http.server).
  res.writeHead(404, { 'content-type': 'text/html' });
  res.end(page('Error response', '<img src="z.png">'));
});

(async () => {
  console.log('\nURL handling');
  check(splitStartUrl('http://h/index.html').base === 'http://h' && splitStartUrl('http://h/index.html').startPath === '/', 'start file index.html → origin is the base');
  check(splitStartUrl('http://h/site/about.html').base === 'http://h/site' && splitStartUrl('http://h/site/about.html').startPath === '/about.html', 'start file in a folder → folder is the base');
  check(splitStartUrl('http://h/app').startPath === null, 'a base without a file is left alone');
  const base = new URL('http://h');
  check(routeOf('http://h/index.html', base).path === '/' && routeOf('http://h/docs/index.htm', base).path === '/docs', '/index.html is the same route as /');

  await new Promise((r) => server.listen(0, r));
  const url = `http://localhost:${server.address().port}`;

  console.log('\ncrawl');
  const live = await discoverLive({ ...mergeDefaults({}), BASE_URL: url, SETTLE_MS: 50 }, { maxPages: 10, sitemap: false });
  const paths = live.found.map((f) => f.path).sort();
  check(paths.includes('/contact.html'), `contact page found (${paths.join(' ')})`);
  check(!paths.includes('/index.html'), '/index.html folded into /');
  check(!paths.includes('/missing.html') && !paths.includes('/secret.html'), 'links answering 404 / 403 are left out');

  console.log('\nquick scan from a file URL');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a11y-fixa-'));
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('A11Y_')) delete env[k];
  requested.length = 0;
  const out = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'scan.js'), `${url}/index.html`, '--max-pages', '6'],
      { cwd: dir, env: { ...env, A11Y_CI: '1', A11Y_TIMING: '0', A11Y_OPEN_REPORT: '0' } });
    let s = '';
    child.stdout.on('data', (d) => { s += d; });
    child.stderr.on('data', (d) => { s += d; });
    child.on('close', () => resolve(s));
  });
  check(!requested.some((p) => p.startsWith('/index.html/')), 'never requests /index.html/<page>');
  const reportFile = path.join(dir, 'a11y-report', 'report.json');
  if (!fs.existsSync(reportFile)) {
    check(false, 'report written');
    console.log(out.split('\n').slice(-30).join('\n'));
  } else {
    const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
    const urls = [...new Set(report.issues.map((i) => i.url).filter(Boolean))];
    check(urls.some((u) => u.endsWith('/contact.html')), 'contact page scanned');
    check(!urls.some((u) => /missing|secret/.test(u)), 'error pages are not reported as scanned pages');
    const imgs = report.issues.filter((i) => i.rule === 'image-alt').map((i) => i.page);
    check(imgs.length === 1, `one missing-alt issue, not duplicated or taken from an error page (${imgs.join(', ')})`);
    const pages = report.matrix.pages.filter((p) => !/lint/i.test(p));
    check(pages.length === 2, `exactly 2 pages scanned: / and /contact.html (${pages.join(', ')})`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  server.close();
  console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
  process.exitCode = failures ? 1 : 0;
})().catch((e) => { console.error(e); server.close(); process.exitCode = 1; });
