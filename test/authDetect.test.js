/**
 * LOGIN.mode 'auto' — does the scanner notice a login wall by itself, log in
 * through whatever form it finds, and leave public sites alone?
 *
 * One server, several "apps" by port-less path prefix is not realistic enough
 * (login redirects are per-origin), so each app gets its own tiny server:
 *   public   — no login anywhere; a change-password page has a password field
 *   form     — /app/* redirects to /login; one-page form, cookie session
 *   twostep  — identifier-first: username → Next → password
 *   basic    — HTTP Basic auth on everything
 *   sso      — redirects to another origin whose path looks like an IdP
 * Then scan.js itself is run against `form` in CI mode: with credentials it
 * logs in and scans the protected page; without them it exits 2; with
 * --public-only it skips the protected page and still scans the public one.
 *
 *   node test/authDetect.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { chromium } = require('playwright');
const auth = require('../lib/auth/detect');
const { mergeDefaults } = require('../lib/config/load');
const { decideNonInteractive } = require('../lib/auth/prompt');

let failures = 0;
const check = (ok, msg) => { console.log((ok ? '  ok   ' : '  FAIL ') + msg); if (!ok) failures++; };
const html = (title, body) => `<!doctype html><html lang="en"><head><title>${title}</title></head><body><main><h1>${title}</h1>${body}</main></body></html>`;

function serve(handler) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => handler(req, res, new URLSearchParams(body)));
  });
  return new Promise((r) => server.listen(0, () => r({ server, url: `http://localhost:${server.address().port}` })));
}
const send = (res, code, body, headers = {}) => { res.writeHead(code, { 'content-type': 'text/html', ...headers }); res.end(body); };
const loggedIn = (req) => /session=ok/.test(req.headers.cookie || '');

const apps = {
  public: (req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    if (p === '/settings/password') return send(res, 200, html('Change password', '<label>New password <input type="password"></label>'));
    return send(res, 200, html('Home', '<a href="/settings/password">Settings</a>'));
  },
  form: (req, res, body) => {
    const p = new URL(req.url, 'http://x').pathname;
    if (p === '/login' && req.method === 'POST') {
      if (body.get('email') === 'qa@example.com' && body.get('pwd') === 's3cret') return send(res, 302, '', { location: '/app', 'set-cookie': 'session=ok; Path=/' });
      return send(res, 200, html('Sign in', '<div role="alert">Invalid email or password</div>' + loginForm()));
    }
    if (p === '/login') return send(res, 200, html('Sign in', loginForm()));
    if (p === '/') return send(res, 200, html('Welcome', '<a href="/app">Open the app</a>'));
    if (p.startsWith('/app') && !loggedIn(req)) return send(res, 302, '', { location: '/login' });
    return send(res, 200, html('Dashboard', '<button>Do it</button>'));
  },
  twostep: (req, res, body) => {
    const p = new URL(req.url, 'http://x').pathname;
    if (p === '/signin' && req.method === 'POST' && body.get('username') && !body.get('password')) {
      return send(res, 200, html('Sign in', `<form method="post" action="/signin"><input type="hidden" name="username" value="${body.get('username')}"><label>Password <input type="password" name="password"></label><button type="submit">Sign in</button></form>`));
    }
    if (p === '/signin' && req.method === 'POST') {
      if (body.get('username') === 'qa' && body.get('password') === 'pw') return send(res, 302, '', { location: '/', 'set-cookie': 'session=ok; Path=/' });
      return send(res, 200, html('Sign in', 'nope'));
    }
    if (p === '/signin') return send(res, 200, html('Sign in', '<form method="post" action="/signin"><label>Username <input type="text" name="username" autocomplete="username"></label><button type="submit">Next</button></form>'));
    if (!loggedIn(req)) return send(res, 302, '', { location: '/signin' });
    return send(res, 200, html('Home', '<p>in</p>'));
  },
  basic: (req, res) => {
    const ok = req.headers.authorization === 'Basic ' + Buffer.from('qa:pw').toString('base64');
    if (!ok) return send(res, 401, 'auth', { 'www-authenticate': 'Basic realm="x"' });
    return send(res, 200, html('Home', '<p>in</p>'));
  },
};
function loginForm() {
  return '<form method="post" action="/login"><label>Email <input type="email" name="email" id="email"></label><label>Password <input type="password" name="pwd" id="pwd"></label><button type="submit">Log in</button></form>';
}

(async () => {
  const s = {};
  for (const [k, h] of Object.entries(apps)) s[k] = await serve(h);
  // A fake IdP on another origin; the app sends everyone there.
  const idp = await serve((req, res) => send(res, 200, html('Sign in', '<input type="email" name="loginfmt"><button>Next</button>')));
  s.sso = await serve((req, res) => send(res, 302, '', { location: `${idp.url}/realms/acme/protocol/openid-connect/auth?client_id=x` }));

  const browser = await chromium.launch();
  const fresh = async () => (await browser.newContext()).newPage();
  const cfg = (url, pages = []) => ({ ...mergeDefaults({}), BASE_URL: url, SETTLE_MS: 50, PAGES: pages });

  console.log('\ndetection');
  {
    const d = await auth.detectLogin(await fresh(), cfg(s.public.url, [{ name: 'Password', path: '/settings/password' }]));
    check(!d.required, 'public site (with a change-password page) → no login');
  }
  {
    const page = await fresh();
    const d = await auth.detectLogin(page, cfg(s.form.url, [{ name: 'Dashboard', path: '/app', guarded: true }]));
    check(d.required && d.kind === 'form', `form app → login required (${d.kind})`);
    check(d.loginUrl.endsWith('/login') && d.sameOrigin, 'login URL is the app\'s own /login');
    check(d.fields && d.fields.user === '#email' && d.fields.pass === '#pwd', `fields inferred (${JSON.stringify(d.fields)})`);
    check(/submit|button/.test(d.fields.submit || ''), `submit button found (${d.fields.submit})`);

    const bad = await auth.credentialLogin(page, d, { username: 'qa@example.com', password: 'wrong', baseUrl: s.form.url, timeoutMs: 4000 });
    check(!bad.ok && /Invalid email or password/.test(bad.reason), `wrong password reported with the page's message (${bad.reason})`);
    const good = await auth.credentialLogin(page, d, { username: 'qa@example.com', password: 's3cret', baseUrl: s.form.url });
    check(good.ok, 'right credentials → logged in');
    await page.goto(s.form.url + '/app');
    check(!(await auth.isLoginRedirect(page, s.form.url + '/app')), 'after login /app is no longer a login redirect');

    const block = auth.loginConfigFor(d, 'credentials', '/x/.a11y-auth.json');
    check(block.mode === 'form' && block.steps.some((st) => st.value === '{{A11Y_PASS}}') && !JSON.stringify(block).includes('s3cret'), 'saved LOGIN block uses env placeholders, never the password');
  }
  {
    const page = await fresh();
    const d = await auth.detectLogin(page, cfg(s.twostep.url));
    check(d.required && d.kind === 'form', 'identifier-first login detected without a password field on screen');
    const r = await auth.credentialLogin(page, d, { username: 'qa', password: 'pw', baseUrl: s.twostep.url });
    check(r.ok, `two-step login completes${r.ok ? '' : ` (${r.reason})`}`);
  }
  {
    const d = await auth.detectLogin(await fresh(), cfg(s.basic.url));
    check(d.required && d.kind === 'http' && d.authScheme === 'Basic', 'HTTP Basic → kind http');
  }
  {
    const d = await auth.detectLogin(await fresh(), cfg(s.sso.url));
    check(d.required && d.kind === 'sso' && !d.sameOrigin, 'redirect to an OpenID provider → kind sso');
  }
  {
    const page = await fresh();
    await page.goto(s.public.url + '/settings/password');
    check(!(await auth.isLoginRedirect(page, s.public.url + '/settings/password')), 'a password field on the requested page is not a login redirect');
  }

  console.log('\nnon-interactive decisions');
  {
    const keep = { u: process.env.A11Y_USER, p: process.env.A11Y_PASS };
    delete process.env.A11Y_USER; delete process.env.A11Y_PASS;
    check(decideNonInteractive({ kind: 'form', loginUrl: 'http://x/login' }).method === 'fail', 'CI without credentials → fail with instructions');
    check(decideNonInteractive({ kind: 'form', loginUrl: 'http://x/login' }, { publicOnly: true }).method === 'skip', '--public-only → skip');
    process.env.A11Y_USER = 'u'; process.env.A11Y_PASS = 'p';
    check(decideNonInteractive({ kind: 'form', loginUrl: 'http://x/login' }).method === 'credentials', 'A11Y_USER/PASS → credentials');
    if (keep.u === undefined) delete process.env.A11Y_USER; else process.env.A11Y_USER = keep.u;
    if (keep.p === undefined) delete process.env.A11Y_PASS; else process.env.A11Y_PASS = keep.p;
  }
  await browser.close();

  console.log('\nscan.js end to end (CI mode)');
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a11y-auth-'));
    fs.writeFileSync(path.join(dir, 'a11y.config.js'), `module.exports = {
      BASE_URL: '${s.form.url}', OUTPUT_DIR: 'out', ROUTES_FILE: '', SETTLE_MS: 50, DYNAMIC_CHECKS: false,
      SCREENSHOTS: { enabled: false }, OPEN_REPORT: false,
      PAGES: [{ name: 'Welcome', path: '/' }, { name: 'Dashboard', path: '/app', guarded: true }],
    };`);
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (k.startsWith('A11Y_')) delete env[k];
    // Async: the fixture servers live in this process, so a blocking spawn would starve them.
    const run = (extraEnv, args = []) => new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(__dirname, '..', 'scan.js'), ...args], { cwd: dir, env: { ...env, A11Y_CI: '1', A11Y_TIMING: '0', ...extraEnv } });
      let stdout = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stdout += d; });
      const t = setTimeout(() => child.kill(), 240000);
      child.on('close', (status) => { clearTimeout(t); resolve({ status, stdout }); });
    });
    const pagesIn = () => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'out', 'report.json'), 'utf8')).matrix.pages; } catch { return []; } };

    const none = await run({});
    check(none.status === 2 && /A11Y_USER/.test(none.stdout), `no credentials → exit 2 with instructions (exit ${none.status})`);

    const ok = await run({ A11Y_USER: 'qa@example.com', A11Y_PASS: 's3cret' });
    const pages = pagesIn();
    check(/Logged in/.test(ok.stdout) && !/s3cret/.test(ok.stdout), 'logged in from env; password never printed');
    check(pages.includes('Dashboard') && pages.includes('Login'), `protected page and the login page were scanned (${pages.join(', ')})`);
    check(fs.existsSync(path.join(dir, '.a11y-auth.json')), 'session saved beside the config');

    fs.rmSync(path.join(dir, '.a11y-auth.json'));
    fs.rmSync(path.join(dir, 'out'), { recursive: true, force: true });
    const pub = await run({}, ['--public-only']);
    const pubPages = pagesIn();
    check(/need a login and were skipped/.test(pub.stdout) && pubPages.includes('Welcome') && !pubPages.includes('Dashboard'), `--public-only skips the protected page, scans the public one (${pubPages.join(', ')})`);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  for (const v of [...Object.values(s), idp]) v.server.close();
  console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
  process.exitCode = failures ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
