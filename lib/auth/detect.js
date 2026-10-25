/**
 * Login-screen detection for LOGIN.mode 'auto' — so a project with no LOGIN
 * config still notices when its pages are behind a login, instead of quietly
 * scanning the login screen N times and reporting it as the app.
 *
 * A page "needs login" when, after asking for an app URL, the browser ends up
 * on one of:
 *   http  — a 401 with WWW-Authenticate (Basic / NTLM / Negotiate)
 *   sso   — an external identity provider (Entra ID, Auth0, Okta, Google, …)
 *   form  — a visible password field, or a username field on a login-looking
 *           URL (identifier-first logins show the password on step two)
 *
 * A password field on the page that was ASKED for (e.g. /settings/password)
 * is not a login wall — only a redirect onto a login screen is.
 */

const IDP_HOSTS = [
  /(^|\.)login\.microsoftonline\.com$/i, /(^|\.)login\.live\.com$/i, /\.b2clogin\.com$/i,
  /\.auth0\.com$/i, /\.okta(preview|-emea)?\.com$/i, /(^|\.)accounts\.google\.com$/i,
  /\.amazoncognito\.com$/i, /\.onelogin\.com$/i, /\.pingone\.(com|eu|asia)$/i,
  /\.duosecurity\.com$/i, /(^|\.)github\.com$/i, /\.clerk\.accounts\.dev$/i,
];
const IDP_PATHS = /\/realms\/[^/]+\/protocol\/openid-connect\/|\/oauth2?\/(authorize|auth)\b|\/adfs\/ls\b|\/saml2?\//i;
const LOGIN_PATH = /(^|\/)(log-?in|log-?on|sign-?in|sign-?on|auth|authenticate|sso|session\/new|users\/sign_in|account\/log-?in)(\.aspx|\.php|\.html?)?(\/|$)/i;
const PASSWORD = 'input[type="password"]';

const sameHost = (a, b) => { try { return new URL(a).host === new URL(b).host; } catch { return false; } };
const isIdp = (u) => { try { const x = new URL(u); return IDP_HOSTS.some((re) => re.test(x.hostname)) || IDP_PATHS.test(x.pathname); } catch { return false; } };
const loginPath = (u) => { try { return LOGIN_PATH.test(new URL(u).pathname); } catch { return false; } };
const pathOf = (u) => { try { const x = new URL(u); return (x.pathname.replace(/\/+$/, '') || '/') + (x.hash.startsWith('#/') ? x.hash : ''); } catch { return u; } };

/**
 * In-page: the login form's fields as selectors the scanner can act on.
 * Prefers stable selectors (id, name, autocomplete) and checks each one is
 * unique; otherwise falls back to a Playwright `:visible >> nth=0` selector.
 */
function inferFields() {
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const unique = (sel) => { try { return document.querySelectorAll(sel).length === 1; } catch { return false; } };
  const selectorFor = (el, fallback) => {
    if (!el) return null;
    const tag = el.tagName.toLowerCase();
    if (el.id && unique('#' + CSS.escape(el.id))) return '#' + CSS.escape(el.id);
    const name = el.getAttribute('name');
    if (name && unique(`${tag}[name="${name}"]`)) return `${tag}[name="${name}"]`;
    const ac = el.getAttribute('autocomplete');
    if (ac && unique(`${tag}[autocomplete="${ac}"]`)) return `${tag}[autocomplete="${ac}"]`;
    return fallback;
  };
  const pass = [...document.querySelectorAll('input[type="password"]')].find(visible) || null;
  const scope = (pass && (pass.closest('form') || pass.parentElement.closest('div,section,main'))) || document;
  const candidates = [...scope.querySelectorAll('input:not([type]), input[type="text"], input[type="email"], input[type="tel"]')].filter(visible);
  const score = (el) => {
    const hay = [el.name, el.id, el.getAttribute('autocomplete'), el.getAttribute('placeholder'), el.getAttribute('aria-label'), el.type].join(' ').toLowerCase();
    let s = 0;
    if (/username|email/.test(el.getAttribute('autocomplete') || '')) s += 4;
    if (el.type === 'email') s += 3;
    if (/user|email|login|account|mail|phone/.test(hay)) s += 2;
    // The username normally comes before the password.
    if (pass && (el.compareDocumentPosition(pass) & Node.DOCUMENT_POSITION_FOLLOWING)) s += 1;
    return s;
  };
  const user = candidates.sort((a, b) => score(b) - score(a))[0] || null;
  const form = (pass || user) && (pass || user).closest('form');
  const buttons = [...(form || document).querySelectorAll('button, input[type="submit"], input[type="button"], [role="button"]')].filter(visible);
  const label = (b) => (b.innerText || b.value || b.getAttribute('aria-label') || '').trim();
  const submit = buttons.find((b) => b.type === 'submit' && b.tagName !== 'A')
    || buttons.find((b) => /^(log ?in|sign ?in|log ?on|continue|next|submit)\b/i.test(label(b)))
    || null;
  return {
    pass: selectorFor(pass, pass ? 'input[type="password"]:visible >> nth=0' : null),
    user: selectorFor(user, user ? `input[type="${user.type || 'text'}"]:visible >> nth=0` : null),
    submit: submit && (() => {
      const tag = submit.tagName.toLowerCase();
      if (submit.type === 'submit' && unique(`${tag}[type="submit"]`)) return `${tag}[type="submit"]`;
      const text = label(submit).replace(/"/g, '\\"');
      return selectorFor(submit, text ? `${tag}:has-text("${text}"):visible >> nth=0` : null);
    })(),
    title: document.title || '',
  };
}

/** Does the page currently in the tab look like a login screen? */
async function looksLikeLogin(page) {
  const url = page.url();
  if (isIdp(url)) return true;
  const hasPassword = await page.locator(PASSWORD).first().isVisible().catch(() => false);
  if (hasPassword) return true;
  if (!loginPath(url)) return false;
  // Identifier-first logins: no password yet, but a username box on /login.
  return page.locator('input[type="email"], input[autocomplete="username"], input[name*="user" i], input[name*="email" i]').first().isVisible().catch(() => false);
}

/**
 * True when navigating to `requestedUrl` landed on a login screen instead —
 * the per-page guard. A password field on the requested page itself does not
 * count (change-password pages are real pages).
 */
async function isLoginRedirect(page, requestedUrl) {
  const now = page.url();
  if (!sameHost(now, requestedUrl)) return isIdp(now) || await looksLikeLogin(page);
  if (pathOf(now) === pathOf(requestedUrl) && !loginPath(now)) return false;
  return looksLikeLogin(page);
}

/**
 * Visit the app's entry points and decide whether it is behind a login.
 *
 * @param {import('playwright').Page} page   a page in a context WITHOUT a saved session
 * @param {object} config                     loaded config (BASE_URL, LOGIN, PAGES, SETTLE_MS)
 * @returns {Promise<{required:boolean, kind?:'http'|'sso'|'form', loginUrl?:string,
 *   probedUrl?:string, sameOrigin?:boolean, fields?:{user:string|null, pass:string|null, submit:string|null}, authScheme?:string}>}
 */
async function detectLogin(page, config) {
  const base = config.BASE_URL.replace(/\/$/, '');
  const login = config.LOGIN || {};
  const pages = config.PAGES || [];
  const probes = [...new Set([
    login.startPath || '/',
    ...(pages.find((p) => p.guarded) ? [pages.find((p) => p.guarded).path] : []),
    ...pages.filter((p) => !loginPath(base + p.path)).slice(0, 1).map((p) => p.path),
  ])];

  for (const p of probes) {
    const url = base + (p.startsWith('/') ? p : '/' + p);
    let res;
    try {
      res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(Math.min(config.SETTLE_MS || 900, 2000));
    } catch { continue; }

    const status = res ? res.status() : 0;
    const challenge = res ? (res.headers()['www-authenticate'] || '') : '';
    if (status === 401 && challenge) {
      return { required: true, kind: 'http', authScheme: challenge.split(/\s/)[0], loginUrl: url, probedUrl: url, sameOrigin: true, fields: null };
    }
    const landed = page.url();
    const offsite = !sameHost(landed, base);
    // A site's own home page may be a public page with a login box in the
    // header; that is not a wall unless the URL also moved or says "login".
    const walled = offsite
      ? (isIdp(landed) || await looksLikeLogin(page))
      : (pathOf(landed) !== pathOf(url) || loginPath(landed) || p === (login.startPath || '/')) && await looksLikeLogin(page);
    if (!walled) continue;
    if (p === '/' && pathOf(landed) === '/' && !loginPath(landed) && probes.length > 1) {
      // Root shows a login box without redirecting. Only a wall if a deeper
      // page also bounces; keep probing.
      continue;
    }
    const fields = await page.evaluate(inferFields).catch(() => null);
    return {
      required: true,
      kind: offsite && isIdp(landed) ? 'sso' : 'form',
      loginUrl: landed,
      probedUrl: url,
      sameOrigin: !offsite,
      fields: fields ? { user: fields.user, pass: fields.pass, submit: fields.submit } : null,
    };
  }
  return { required: false };
}

/**
 * Wait until the tab is back on the app and no longer shows a login screen —
 * used while a person logs in by hand (SSO, MFA, captchas).
 */
async function waitUntilLoggedIn(page, baseUrl, timeoutMs = 300000) {
  const deadline = Date.now() + timeoutMs;
  const ok = async () => sameHost(page.url(), baseUrl) && !(await looksLikeLogin(page));
  while (Date.now() < deadline) {
    if (await ok().catch(() => false)) {
      await page.waitForTimeout(1500);
      if (await ok().catch(() => false)) return true;
    }
    await page.waitForTimeout(1000).catch(() => {});
    if (page.isClosed()) return false;
  }
  return false;
}

/**
 * Fill a detected login form. Handles one-page forms and identifier-first
 * (username → Next → password) flows. Never logs the password.
 * @returns {Promise<{ok:boolean, reason?:string}>}
 */
async function credentialLogin(page, detected, { username, password, baseUrl, timeoutMs = 30000 }) {
  const f = detected.fields || {};
  const userSel = f.user || 'input[type="email"]:visible >> nth=0';
  const passSel = f.pass || 'input[type="password"]:visible >> nth=0';
  const submit = async (fallbackSel) => {
    const sel = (await page.evaluate(inferFields).catch(() => ({}))).submit || f.submit;
    if (sel && await page.locator(sel).first().isVisible().catch(() => false)) await page.locator(sel).first().click({ timeout: 8000 });
    else await page.press(fallbackSel, 'Enter', { timeout: 8000 });
  };

  if (detected.loginUrl && page.url() !== detected.loginUrl) {
    await page.goto(detected.loginUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  }
  try {
    const passVisible = await page.locator(PASSWORD).first().isVisible().catch(() => false);
    if (await page.locator(userSel).first().isVisible().catch(() => false)) await page.fill(userSel, username, { timeout: 8000 });
    if (!passVisible) {
      // Identifier-first: submit the username, wait for the password step.
      await submit(userSel);
      await page.locator(PASSWORD).first().waitFor({ state: 'visible', timeout: 15000 });
    }
    const passNow = (await page.evaluate(inferFields).catch(() => ({}))).pass || passSel;
    await page.fill(passNow, password, { timeout: 8000 });
    await submit(passNow);
  } catch (e) {
    return { ok: false, reason: `could not fill the login form (${String(e.message).split('\n')[0]})` };
  }
  const loggedIn = await waitUntilLoggedIn(page, baseUrl, timeoutMs);
  if (loggedIn) return { ok: true };
  const err = await page.evaluate(() => {
    const el = document.querySelector('[role="alert"], .alert-danger, .error, .invalid-feedback, [aria-live="assertive"]');
    return el ? el.innerText.trim().slice(0, 160) : '';
  }).catch(() => '');
  return { ok: false, reason: err ? `still on the login screen: "${err}"` : 'still on the login screen after submitting (wrong credentials, MFA or a captcha?)' };
}

/** LOGIN block for a11y.config.js reproducing a successful credential login (no secrets). */
function loginConfigFor(detected, method, stateFile) {
  const start = (() => { try { const u = new URL(detected.probedUrl); return u.pathname + u.search; } catch { return '/'; } })();
  if (method === 'browser') return { mode: 'manual', startPath: start, stateFile };
  const f = detected.fields || {};
  const steps = [];
  if (f.user) steps.push({ type: 'fill', selector: f.user, value: '{{A11Y_USER}}' });
  if (f.pass) steps.push({ type: 'fill', selector: f.pass, value: '{{A11Y_PASS}}' });
  steps.push(f.submit ? { type: 'click', selector: f.submit } : { type: 'press', selector: f.pass || f.user, value: 'Enter' });
  // No loginPageSelector: without one, scan.js uses the redirect-aware
  // detector, so a change-password page is not mistaken for the login screen.
  return { mode: 'form', startPath: start, steps, stateFile };
}

module.exports = {
  detectLogin, looksLikeLogin, isLoginRedirect, waitUntilLoggedIn, credentialLogin, loginConfigFor,
  inferFields, isIdp, loginPath, PASSWORD,
};
