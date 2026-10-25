#!/usr/bin/env node
/**
 * Main runner.
 *   1. Launches Chromium (Playwright).
 *   2. Optionally logs in once.
 *   3. For each configured page: navigates, runs axe, then performs any
 *      reveal `actions` (click/hover/fill…) and re-runs axe after each
 *      `snapshot` step — so modals, dropdowns, tabs, accordions and other
 *      conditionally-rendered / deeply-nested components get checked too.
 *   4. Aggregates everything into per-criterion status + a code-mapped
 *      issue list, and writes dashboard.html / report.html / report.json.
 *
 *   npm run scan
 */
const path = require('path');
const fs = require('fs');

// Playwright needs Node 20+. The default `node` on this
// machine may be older — fail loudly with a fix instead of a cryptic crash.
const major = parseInt(process.versions.node.split('.')[0], 10);
if (major < 20) {
  console.error(`\n✗ This tool needs Node.js 20+ (you have ${process.version}).`);
  console.error('  If you use nvm:   nvm use 22   (a .nvmrc is included)');
  console.error('  then re-run:      npm run scan\n');
  process.exit(1);
}

const { chromium } = require('playwright');
const { isCI } = require('./lib/ci');
// Which config: --config <file> / A11Y_CONFIG, else ./a11y.config.js in the
// current directory. Defaults are filled in, paths
// resolved against the config's own folder, A11Y_* env overrides applied, and
// reviewed routes from a11y.routes.json appended to PAGES — see lib/config.
let config;
try {
  const loader = require('./lib/config/load');
  const quickUrl = loader.urlArg();
  const logLine = (m) => process.stdout.write(m + '\n');
  // `a11y scan <url>`: no config needed. With a config present, the URL just
  // replaces its BASE_URL.
  const hasConfig = process.argv.includes('--config') || process.env.A11Y_CONFIG || fs.existsSync(path.join(process.cwd(), 'a11y.config.js'));
  if (quickUrl && !hasConfig) {
    const i = process.argv.indexOf('--max-pages');
    config = loader.quickConfig(quickUrl, { log: logLine, maxPages: (i > -1 && Number(process.argv[i + 1])) || 20 });
  } else {
    if (quickUrl) process.env.A11Y_BASE_URL = quickUrl;
    config = loader.loadConfig({ log: logLine });
  }
} catch (e) {
  console.error(`\n✗ ${e.message}\n`);
  process.exit(2);
}
const { createMapper } = require('./lib/codeMap');
const { autoExplore } = require('./lib/explore');
const { instrumentListeners } = require('./lib/clickable');
const { collectSignature } = require('./lib/consistency');
const { pageInventory } = require('./lib/inventory');
const { createAnalyzer } = require('./lib/analyze');
const { finalizeRun } = require('./lib/finalize');
const auth = require('./lib/auth/detect');
const authPrompt = require('./lib/auth/prompt');
const verify = require('./lib/verify');
const CLI = require('./lib/cliName')();
const { exec } = require('child_process');

// Open a file in the OS default app (browser). No-op if OPEN_REPORT is false.
function openReport(file) {
  if (config.OPEN_REPORT === false) return;
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start ""' : 'xdg-open';
  exec(`${cmd} "${file}"`, () => {});
}


// Per-phase timing. The first full production run showed ~225s per base state
// against a documented ~47s/page, and nothing in local benchmarking reproduced
// it — so the cost is measured here rather than guessed at. Printed per page
// and totalled at the end; set A11Y_TIMING=0 to silence.
const TIMING = process.env.A11Y_TIMING !== '0';
const phaseTotals = {};
async function timed(name, fn) {
  if (!TIMING) return fn();
  const t0 = Date.now();
  try { return await fn(); }
  finally {
    const ms = Date.now() - t0;
    phaseTotals[name] = (phaseTotals[name] || 0) + ms;
  }
}
function formatPhases(totals) {
  const rows = Object.entries(totals).sort((a, b) => b[1] - a[1]);
  const sum = rows.reduce((n, r) => n + r[1], 0) || 1;
  return rows.map(([k, v]) => `      ${k.padEnd(18)} ${String((v / 1000).toFixed(1) + 's').padStart(8)}  ${(v / sum * 100).toFixed(0)}%`).join('\n');
}

// Reports, screenshots and history go here (OUTPUT_DIR, default: beside the config).
const OUT_DIR = config.OUTPUT_DIR;
fs.mkdirSync(OUT_DIR, { recursive: true });

function log(msg) { process.stdout.write(msg + '\n'); }

async function runAction(page, action) {
  const t = action.timeout || 8000;
  switch (action.type) {
    case 'click':      return page.click(action.selector, { timeout: t }).catch((e) => warn('click', action.selector, e));
    case 'hover':      return page.hover(action.selector, { timeout: t }).catch((e) => warn('hover', action.selector, e));
    case 'fill':       return page.fill(action.selector, action.value ?? '', { timeout: t }).catch((e) => warn('fill', action.selector, e));
    case 'select':     return page.selectOption(action.selector, action.value, { timeout: t }).catch((e) => warn('select', action.selector, e));
    case 'press':      return page.press(action.selector || 'body', action.value || 'Enter', { timeout: t }).catch((e) => warn('press', action.selector, e));
    case 'waitFor':    return page.waitForSelector(action.selector, { timeout: t }).catch((e) => warn('waitFor', action.selector, e));
    case 'waitForUrl': return page.waitForURL(action.value, { timeout: t }).catch((e) => warn('waitForUrl', action.value, e));
    case 'wait':       return page.waitForTimeout(action.value || 500);
    case 'show':       return forceShow(page, action.selector);   // reveal a hidden modal via CSS (no click)
    case 'hide':       return forceHide(page, action.selector);   // re-hide it after scanning
    case 'css':        return applyCss(page, action.selector, action.styles); // arbitrary style overrides (e.g. off-screen drawers hidden via transform/position, not display)
    case 'snapshot':   return null; // handled by caller
    default:           warn('unknown-action', action.type, {}); return null;
  }
}

// Force a hidden element (e.g. a pre-rendered modal) visible WITHOUT clicking
// anything — so axe can analyze it. Also un-hides display:none ancestors.
// This never triggers app JS / server calls, so it's safe on live data.
function forceShow(page, selector) {
  return page.evaluate((sel) => {
    const show = (el) => {
      el.style.setProperty('display', 'block', 'important');
      el.style.setProperty('visibility', 'visible', 'important');
      el.style.setProperty('opacity', '1', 'important');
      ['none', 'hide', 'hidden', 'd-none', 'collapse'].forEach((c) => el.classList && el.classList.remove(c));
      el.removeAttribute && el.removeAttribute('hidden');
      if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') el.setAttribute('aria-hidden', 'false');
    };
    document.querySelectorAll(sel).forEach((el) => {
      show(el);
      let a = el.parentElement;
      while (a) { if (getComputedStyle(a).display === 'none') show(a); a = a.parentElement; }
    });
  }, selector).catch((e) => warn('show', selector, e));
}
// Apply arbitrary inline style overrides (!important) to every element
// matching selector. For drawers/slide-ups/offcanvas hidden by being pushed
// off-screen (transform/position/right) rather than display:none — `show`
// alone won't reveal these. Selectors match ALL matching elements, which
// also fixes pages with duplicate ids (invalid but common in legacy markup):
// `[id="foo"]` reveals every element with that id, not just the first.
function applyCss(page, selector, styles) {
  return page.evaluate(({ sel, styles }) => {
    document.querySelectorAll(sel).forEach((el) => {
      Object.entries(styles).forEach(([prop, val]) => el.style.setProperty(prop, String(val), 'important'));
    });
  }, { sel: selector, styles: styles || {} }).catch((e) => warn('css', selector, e));
}
function forceHide(page, selector) {
  return page.evaluate((sel) => {
    document.querySelectorAll(sel).forEach((el) => el.style.setProperty('display', 'none', 'important'));
  }, selector).catch((e) => warn('hide', selector, e));
}

function warn(kind, sel, e) {
  log(`      ⚠ ${kind} "${sel}" skipped (${(e && e.message ? e.message.split('\n')[0] : 'not found')})`);
}

// Poll until the user has finished logging in. Login often bounces through an
// external identity provider (Auth0/SSO), so success = back on the APP's own
// host AND no longer on the login path (and optionally a logged-in-only
// selector is present). Returns false on timeout.
async function waitForLogin(page, login, appHost) {
  const deadline = Date.now() + (login.timeoutMs || 300000);
  const loginRe = new RegExp(login.loginPathPattern || '/login', 'i');
  const sameHost = (u) => { try { return new URL(u).host === appHost; } catch { return false; } };
  // "Logged in" is decided by, in priority order:
  //  loggedOutSelector — a login-only element (e.g. the password field) is GONE
  //  successSelector   — a logged-in-only element is PRESENT
  //  else              — URL is on the app host and no longer matches the login path
  const loggedIn = async () => {
    if (!sameHost(page.url())) return false; // still on an external IdP
    if (login.loggedOutSelector) {
      const stillOut = await page.$(login.loggedOutSelector).catch(() => null);
      return !stillOut;
    }
    if (login.successSelector) {
      const found = await page.$(login.successSelector).catch(() => null);
      return !!found;
    }
    return !loginRe.test(page.url());
  };
  while (Date.now() < deadline) {
    if (await loggedIn()) {
      await page.waitForTimeout(1500); // settle, then re-confirm
      if (await loggedIn()) return true;
    }
    await page.waitForTimeout(1500);
  }
  return false;
}

// --public-only: never log in; pages behind a login are skipped and listed.
// --login-only:  log in, save the session, stop (`a11y login`).
const PUBLIC_ONLY = process.argv.includes('--public-only') || process.env.A11Y_PUBLIC_ONLY === '1';
const LOGIN_ONLY = process.argv.includes('--login-only');
// Scans taken before the page loop (the login page itself).
const preScans = [];
// --verify (`a11y verify`): re-scan only pages that had issues last time and
// report fixed / still failing / new. --all re-scans everything.
const VERIFY = process.argv.includes('--verify');
// Last run's issues per page, and whether each one's element is still in the
// DOM after this run's scan of the same state (lib/verify.js).
let baseline = null;
const presence = new Map();
async function recordPresence(page, pageName, state) {
  const targets = verify.targetsFor(baseline, pageName, state);
  if (!targets.length) return;
  // 'visible' | 'hidden' | 'absent' | null (selector unusable). Hidden counts
  // separately: axe skips hidden elements, so "no finding" proves nothing there.
  const found = await page.evaluate((sels) => sels.map((s) => {
    let els;
    try { els = [...document.querySelectorAll(s)]; } catch (e) { return null; }
    if (!els.length) return 'absent';
    const shown = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
    return els.some(shown) ? 'visible' : 'hidden';
  }), targets).catch(() => targets.map(() => null));
  targets.forEach((t, i) => presence.set(`${pageName}::${state}::${t}`, found[i]));
}

// Per-state analysis lives in lib/analyze.js (shared with the Playwright fixture).
const analyze = createAnalyzer(config, { log, timed, outDir: OUT_DIR });

// A reused storageState proves only that a FILE exists — not that its cookies
// are still valid. Apps with MFA often expire sessions within hours,
// so probe once up front rather than discovering it N pages into the run.
async function sessionAlive(page, login) {
  const url = config.BASE_URL.replace(/\/$/, '') + (login.startPath || '/');
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40000 });
  } catch {
    return true; // network/DNS trouble — let the per-page guard report it properly
  }
  await page.waitForTimeout(config.SETTLE_MS);
  const sel = login.loginPageSelector || login.loggedOutSelector;
  // No selector configured: ask the detector whether we bounced to a login screen.
  if (!sel) return !(await auth.isLoginRedirect(page, url));
  const onLogin = await page.$(sel).catch(() => null);
  return !onLogin;
}

// Pages that bounced to the login screen mid-run. They were NOT scanned, and a
// report that quietly omits them understates the true defect count — so the run
// has to end non-zero even if the pages that DID load were clean.
let loginRedirects = 0;
// "Skip protected pages" (LOGIN.mode 'auto', option 3 / --public-only): pages
// behind the login are listed here instead of failing the run.
let skipProtected = false;
const skippedPages = [];

async function scanPage(page, pageDef, scans) {
  const url = config.BASE_URL.replace(/\/$/, '') + pageDef.path;
  log(`\n▶ ${pageDef.name}  (${url})`);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40000 });
    await page.waitForLoadState('load').catch(() => {});
  } catch (e) {
    log(`   ✗ could not load: ${e.message.split('\n')[0]}`);
    return;
  }
  await page.waitForTimeout(config.SETTLE_MS);

  // Guard: don't scan a login or 404 page (e.g. an expired session that
  // silently redirected). Report it clearly instead of analyzing garbage.
  const loginSel = (config.LOGIN && (config.LOGIN.loginPageSelector || config.LOGIN.loggedOutSelector)) || null;
  const guard = await page.evaluate((sel) => ({
    loginish: sel ? !!document.querySelector(sel) : false,
    notfound: /not found|404/i.test(document.title || ''),
  }), loginSel);
  // Without a configured selector, recognise a redirect onto a login screen.
  if (!loginSel && config.LOGIN.mode !== 'none') guard.loginish = await auth.isLoginRedirect(page, url);
  if (guard.loginish && skipProtected) {
    skippedPages.push({ name: pageDef.name, path: pageDef.path });
    log('   – Needs login — skipped (public-only scan).');
    return;
  }
  if (guard.loginish) {
    loginRedirects += 1;
    log('   ✗ Redirected to login — the session expired mid-run. Not scanned.');
    return;
  }
  if (guard.notfound) {
    log('   ✗ Page returned "Not Found" (404). Check the path and that this account can access it.');
    return;
  }

  // Base state — run the dynamic keyboard/SR checks + the DOM inventory here.
  const pageStartedAt = Date.now();
  const base = await analyze(page, 'initial', true, pageDef.name, true);
  await recordPresence(page, pageDef.name, 'initial');
  const inventory = await pageInventory(page);
  // 3.2.3/3.2.4/3.2.6/2.4.5 are cross-page, so only a fingerprint is taken
  // here; the comparison happens once every page has been visited.
  const consistency = await collectSignature(page);
  scans.push({ page: pageDef.name, url, ...base, inventory, consistency });
  log(`   • initial: ${base.violations.length} violations, ${base.incomplete.length} to review`
    + (TIMING ? `  [${((Date.now() - pageStartedAt) / 1000).toFixed(0)}s]` : ''));

  // Reveal actions; re-scan on each `snapshot`.
  let stateIdx = 0;
  const pending = [];
  for (const action of pageDef.actions || []) {
    if (action.type === 'snapshot') {
      stateIdx += 1;
      await page.waitForTimeout(config.SETTLE_MS);
      const label = action.label || `after ${pending.join(' → ') || 'actions'} (state ${stateIdx})`;
      const snap = await analyze(page, label, config.DYNAMIC_ON_ALL_STATES === true, pageDef.name);
      await recordPresence(page, pageDef.name, label);
      scans.push({ page: pageDef.name, url, ...snap });
      log(`   • ${label}: ${snap.violations.length} violations, ${snap.incomplete.length} to review`);
      pending.length = 0;
    } else {
      pending.push(`${action.type}(${action.selector || action.value || ''})`);
      await runAction(page, action);
    }
  }
}

async function main() {
  // Start the app first when WEB_SERVER is configured; always stop it again,
  // whichever way the scan ends.
  let server;
  try {
    server = await require('./lib/webServer').startWebServer(config, { log });
  } catch (e) {
    log(`\n✗ Could not start the app: ${e.message}`);
    process.exitCode = 2;
    return;
  }
  try { await scanAll(); }
  finally { await server.stop(); }
}

// Lint, aggregate, write reports, apply the gate and — for `a11y verify` —
// the fixed / still failing verdict. Shared by the browser and lint-only paths.
async function finish(scans, mapper) {
  // Static half: accessibility lint of the source (exact file:line).
  const linted = await require('./lib/static/eslint').lintForConfig(config, log);
  if (linted) scans.push(linted.scan);
  if (!scans.length) {
    log('\n✗ Nothing was scanned or linted.');
    process.exitCode = 1;
    return {};
  }

  // Aggregation, reports, archive, JUnit and the gate: lib/finalize.js.
  const res = finalizeRun({ scans, config, mapper, log, skippedPages, verifyWith: { baseline, presence } });
  if (VERIFY && res.data.verification) {
    const c = res.data.verification.counts;
    if (c.still || c.new) process.exitCode = 1;
    log(c.still || c.new
      ? `\n✗ Not done yet: ${c.still} still failing, ${c.new} new. Fix those and run \`${CLI} verify\` again.`
      : `\n✔ All re-checked issues are fixed${c.unverified ? ` (${c.unverified} could not be verified — see the dashboard)` : ''}.`);
  }
  return res;
}

async function scanAll() {
  log('Accessibility Automation Tool — scanning ' + config.BASE_URL);
  log(`Config: ${config._meta.configFile || '(none — quick scan of this URL)'}`);
  if (!config.BASE_URL) {
    log('\n✗ BASE_URL is not set — point it at the running app (or set A11Y_BASE_URL).');
    process.exitCode = 2;
    return;
  }
  baseline = verify.loadBaseline(OUT_DIR, config.REPORT_NAME || '');
  let lintOnly = false;
  if (VERIFY) {
    if (!baseline) {
      log(`\nNo previous scan to verify against — running a full scan; run \`${CLI} verify\` again after fixing.`);
    } else if (!process.argv.includes('--all')) {
      const open = verify.pagesWithIssues(baseline);
      const before = config.PAGES.length;
      config.PAGES = config.PAGES.filter((p) => open.has(p.name));
      log(`\nVerify: re-scanning ${config.PAGES.length} of ${before} page(s) that had issues last time (--all for every page).`);
      config.AUTO_EXPLORE = false;
      lintOnly = !config.PAGES.length;
    }
  }
  if (!config.AUTO_EXPLORE && !config.PAGES.length && !lintOnly && !config._meta.quick) {
    log('\n✗ Nothing to scan: PAGES is empty and no included routes were found in the routes manifest.');
    log(`  Run \`${CLI} discover\` to list your app's routes, or add PAGES to the config.`);
    process.exitCode = 2;
    return;
  }

  const mapper = config.REPO_PATH
    ? createMapper(config.REPO_PATH, config.CODE_EXTENSIONS, { stripServerIds: config.STRIP_SERVER_IDS })
    : { indexedFiles: 0, guessLocations: () => [] };
  if (config.REPO_PATH) log(`Indexed ${mapper.indexedFiles} source files for code mapping (${config.CODE_EXTENSIONS.join(' ')}).`);
  else log('Code mapping OFF (set REPO_PATH in the config to enable).');

  if (lintOnly) {
    log('Only source-lint issues were open last time — re-running the lint, no browser needed.');
    const { singleFile } = await finish([], mapper);
    if (singleFile) openReport(singleFile.file);
    return;
  }

  const login = config.LOGIN || { mode: 'none' };
  // Already absolute: the loader resolves it against the config's folder, and
  // lib/ci.js hands back an absolute path for A11Y_STORAGE_STATE(_B64).
  const stateFile = path.resolve(login.stateFile || '.a11y-auth.json');
  const haveState = fs.existsSync(stateFile);
  const reuse = login.reuse !== false && haveState;

  // We only need a visible (headed) browser when the user must log in by hand.
  const needInteractive = login.mode === 'manual' && !reuse;
  // On a build agent there is nobody to complete an MFA login. Fail fast with
  // an actionable message instead of opening an invisible window and hanging
  // until the job times out.
  if (needInteractive && isCI()) {
    log('\n✗ CI mode: no saved session found and manual login is impossible on a build agent.');
    log('  Provide a Playwright storageState via one of:');
    log('    A11Y_STORAGE_STATE=<path to auth-state.json>        (Azure secure file)');
    log('    A11Y_STORAGE_STATE_B64=<base64 of that file>        (Azure secret variable)');
    log('  Or use a non-MFA test account with LOGIN.mode = "form".\n');
    process.exitCode = 2;
    return;
  }
  // Built by openSession() so that an expired saved session can be thrown away
  // and the whole thing reopened headed for a fresh login (see the probe below).
  let browser, context, page;
  // HTTP (Basic/NTLM) auth can't be stored in a session file, so credentials
  // given for it are kept in memory for this run only.
  let httpCredentials = null;
  const openSession = async ({ headless, withState }) => {
    browser = await chromium.launch({ headless });
    context = await browser.newContext({
      viewport: config.VIEWPORT,
      ignoreHTTPSErrors: config.IGNORE_HTTPS_ERRORS !== false, // self-signed dev certs
      ...(withState ? { storageState: stateFile } : {}),
      ...(httpCredentials ? { httpCredentials } : {}),
    });
    page = await context.newPage();

    // Must be installed BEFORE any page script runs so we can observe native
    // addEventListener('click') registrations (jQuery-delegated handlers are
    // detected separately, at scan time, from jQuery's own event store).
    if (config.DYNAMIC_CHECKS !== false) await instrumentListeners(page);

    // Auto-explore clicks buttons it doesn't fully understand. Some trigger a
    // native alert()/confirm()/prompt(), which BLOCKS Playwright indefinitely
    // if nothing responds to it — the whole scan hangs with no error. Dismiss
    // (never accept) so an unexpected confirm() can't let a destructive action
    // through; this is the "Cancel" outcome, matching SAFE_MODE's intent.
    page.on('dialog', (dialog) => {
      log(`      ⚠ native ${dialog.type()} dialog appeared ("${dialog.message().slice(0, 80)}") — dismissing`);
      dialog.dismiss().catch(() => {});
    });
  };

  // `reuse` was decided from the state file EXISTING. Whether its cookies still
  // work is a separate question, answered by the probe below.
  // HEADLESS: undefined keeps the default (visible only when login is needed);
  // explicit true/false — via config or A11Y_HEADLESS — overrides that for the
  // WHOLE run, e.g. to watch a scan live rather than infer from log lines
  // whether it's progressing or stuck.
  const forceHeaded = config.HEADLESS === false;
  const forceHeadless = config.HEADLESS === true;
  let usingState = reuse && ['manual', 'form', 'auto'].includes(login.mode);
  await openSession({ headless: forceHeadless || (!forceHeaded && !needInteractive), withState: usingState });
  if (usingState) log(`Reusing saved session → ${path.basename(stateFile)} (delete it to log in again).`);

  // ── Is the reused session actually alive? ──────────────────────────────────
  // Without this, a day-old state file launches a HEADLESS browser that quietly
  // redirects every page to the login screen: the run ends having scanned
  // nothing, or — worse — scans the handful of pages that happen to be public
  // and reports a passing gate for a site it never looked at.
  if (usingState && !(await sessionAlive(page, login))) {
    if (isCI()) {
      log('\n✗ The stored session has expired — every page would redirect to the login screen.');
      log('  Refresh the storageState secret (A11Y_STORAGE_STATE / A11Y_STORAGE_STATE_B64) and re-run.');
      await browser.close().catch(() => {});
      process.exitCode = 2;
      return;
    }
    log(login.mode === 'auto'
      ? 'Saved session has expired — checking the login again.'
      : 'Saved session has expired — reopening a window so you can log in again.');
    await browser.close().catch(() => {});
    await openSession({ headless: forceHeadless || (!forceHeaded && login.mode !== 'manual'), withState: false });
    usingState = false;
  }

  // ── Authentication ─────────────────────────────────────────────────────────
  if (login.mode === 'manual' && !usingState) {
    // Auth0 / SSO / magic-link: user logs in once in the opened window; we then
    // save the session and reuse it on later runs.
    const startUrl = config.BASE_URL.replace(/\/$/, '') + (login.startPath || '/');
    log('\n──────────────────────────────────────────────────────────────');
    log('  A browser window is opening. Please LOG IN there normally.');
    log('  The scan starts automatically once you reach the app.');
    log(`  (waiting up to ${Math.round((login.timeoutMs || 300000) / 60000)} min)`);
    log('──────────────────────────────────────────────────────────────');
    await page.goto(startUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
    const appHost = new URL(config.BASE_URL).host;
    const ok = await waitForLogin(page, login, appHost);
    if (!ok) {
      log('\n✗ Login not detected before timeout. Nothing scanned.');
      await browser.close();
      process.exitCode = 1;
      return;
    }
    await context.storageState({ path: stateFile });
    log(`\n✔ Logged in. Session saved → ${path.basename(stateFile)}\n`);
  } else if (login.mode === 'form' && !usingState) {
    log('\nLogging in (form)…');
    await page.goto(config.BASE_URL.replace(/\/$/, '') + (login.startPath || login.path || '/'), { waitUntil: 'networkidle' }).catch(() => {});
    // Credentials come from env in CI so they're never committed. `{{A11Y_USER}}`
    // / `{{A11Y_PASS}}` placeholders in a step's `value` are substituted here.
    // Placeholders with no env value: ask at the terminal (never in CI).
    const usesCreds = JSON.stringify(login.steps || []).match(/\{\{A11Y_(USER|PASS)\}\}/g) || [];
    const creds = { user: process.env.A11Y_USER, pass: process.env.A11Y_PASS };
    if (usesCreds.length && (!creds.user || !creds.pass)) {
      if (!authPrompt.interactive()) {
        log('\n✗ LOGIN.mode "form" needs A11Y_USER and A11Y_PASS (CI secrets / environment variables).');
        await browser.close().catch(() => {});
        process.exitCode = 2;
        return;
      }
      if (!creds.user) creds.user = await authPrompt.ask('  Username / email: ');
      if (!creds.pass) creds.pass = await authPrompt.askHidden('  Password: ');
    }
    const subst = (v) => String(v ?? '')
      .replace(/\{\{A11Y_USER\}\}/g, creds.user || '')
      .replace(/\{\{A11Y_PASS\}\}/g, creds.pass || '');
    for (const step of login.steps || []) {
      await runAction(page, step.value !== undefined ? { ...step, value: subst(step.value) } : step);
    }
    await page.waitForTimeout(config.SETTLE_MS);
    // Verify the form login actually worked before scanning 14 pages of a
    // login screen.
    const stillOut = login.loginPageSelector
      ? await page.$(login.loginPageSelector).catch(() => null)
      : await auth.looksLikeLogin(page).catch(() => false);
    if (stillOut) {
      log('\n✗ Form login failed — still on the login page. Check A11Y_USER / A11Y_PASS and the LOGIN.steps selectors.');
      await browser.close().catch(() => {});
      process.exitCode = 2;
      return;
    }
    await context.storageState({ path: stateFile });
    log(`Session saved → ${path.basename(stateFile)}`);
  } else if (login.mode === 'auto' && !usingState) {
    // ── Auto: find out whether there is a login at all, and ask if so ────────
    const detected = await auth.detectLogin(page, config);
    if (!detected.required) {
      log('No login screen detected — scanning as-is.');
    } else {
      // The login screen is a real page people use; scan it while we're on it
      // (only our own app's, not a third-party sign-in provider's).
      if (detected.sameOrigin && detected.kind === 'form' && login.scanLoginPage !== false) {
        const res = await analyze(page, 'initial', true, 'Login', true);
        await recordPresence(page, 'Login', 'initial');
        preScans.push({ page: 'Login', url: detected.loginUrl, ...res, inventory: await pageInventory(page), consistency: await collectSignature(page) });
        log(`   • login page: ${res.violations.length} violations, ${res.incomplete.length} to review`);
      }
      const choice = PUBLIC_ONLY ? { method: 'skip' }
        : authPrompt.interactive()
        ? await authPrompt.chooseLoginMethod(detected, log)
        : authPrompt.decideNonInteractive(detected, { publicOnly: PUBLIC_ONLY });
      if (choice.note) log(`  ⚠ ${choice.note}`);
      if (choice.method === 'fail') {
        log(`\n✗ ${choice.message}\n`);
        await browser.close().catch(() => {});
        process.exitCode = 2;
        return;
      }
      let loggedIn = false;
      if (choice.method === 'skip') {
        skipProtected = true;
        log('Scanning public pages only — pages that need a login will be listed as skipped.');
      } else if (choice.method === 'browser') {
        await browser.close().catch(() => {});
        await openSession({ headless: false, withState: false });
        log('\n  A browser window is open. Log in there; the scan continues by itself once you reach the app.');
        await page.goto(detected.probedUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
        loggedIn = await auth.waitUntilLoggedIn(page, config.BASE_URL, login.timeoutMs || 300000);
        if (!loggedIn) log('\n✗ Login not detected before the timeout (LOGIN.timeoutMs).');
      } else if (detected.kind === 'http') {
        httpCredentials = { username: choice.username, password: choice.password };
        await browser.close().catch(() => {});
        await openSession({ headless: forceHeadless || !forceHeaded, withState: false });
        const r = await page.goto(detected.probedUrl, { waitUntil: 'domcontentloaded' }).catch(() => null);
        loggedIn = !!r && r.status() !== 401;
        if (!loggedIn) log('\n✗ The server rejected those credentials (still 401).');
      } else {
        log('Logging in…');
        const r = await auth.credentialLogin(page, detected, { username: choice.username, password: choice.password, baseUrl: config.BASE_URL });
        loggedIn = r.ok;
        if (!r.ok) log(`\n✗ Login failed — ${r.reason}`);
      }
      if (choice.method !== 'skip') {
        if (!loggedIn) {
          log('  Nothing scanned. Re-run and pick another option, or set LOGIN in a11y.config.js (see the guide).');
          await browser.close().catch(() => {});
          process.exitCode = 2;
          return;
        }
        if (detected.kind !== 'http') {
          await context.storageState({ path: stateFile });
          log(`\n✔ Logged in. Session saved → ${path.basename(stateFile)} (reused next time; delete it to log in again)`);
          if (authPrompt.interactive() && config._meta.configFile) {
            await authPrompt.offerSaveLogin(config._meta.configFile, auth.loginConfigFor(detected, choice.method, stateFile), log);
          }
          // Login needed a window; the scan itself doesn't.
          if (choice.method === 'browser' && !forceHeaded) {
            await browser.close().catch(() => {});
            await openSession({ headless: true, withState: true });
          }
        } else {
          log('\n✔ Authenticated (HTTP). Set A11Y_USER / A11Y_PASS to skip this question next time.');
        }
      }
    }
  }

  if (LOGIN_ONLY) {
    await browser.close().catch(() => {});
    if (fs.existsSync(stateFile)) {
      log(`\nSession file: ${stateFile}`);
      log('For CI, store its base64 as the secret A11Y_STORAGE_STATE_B64:');
      log(`  ${process.platform === 'win32' ? `certutil -encode "${stateFile}" tmp.b64` : `base64 < "${stateFile}" | tr -d '\\n'`}`);
    } else {
      log('\nNo login needed — nothing to save.');
    }
    return;
  }

  // Quick scan: the pages are whatever a read-only crawl of the site finds.
  if (config._meta.quick && !config.PAGES.length) {
    const { discoverLive, applyLive } = require('./lib/routes/live');
    const { mergeManifest, pagesFromManifest } = require('./lib/routes/manifest');
    const max = config._meta.quick.maxPages;
    log(`\nNo a11y.config.js here — quick scan. Finding pages (read-only crawl, up to ${max})…`);
    try {
      // After login, so the crawl reuses the saved session and sees the app.
      const live = await discoverLive(config, { maxPages: max, log });
      const manifest = mergeManifest(null, applyLive([], live.found).routes);
      config.PAGES = pagesFromManifest(manifest).slice(0, max);
      log(`  ${config.PAGES.length} page(s) to scan. For a repeatable setup run \`${CLI} init\` in your project.`);
    } catch (e) {
      log(`  ⚠ crawl failed (${String(e.message).split('\n')[0]}) — scanning the start page only.`);
    }
    if (!config.PAGES.length) config.PAGES = [{ name: 'Home', path: '/' }];
  }

  let scans = [...preScans];
  if (config.AUTO_EXPLORE) {
    // Auto-discover pages + click clickable elements to reveal hidden UI.
    scans = await autoExplore(page, config, { analyze, log, pageInventory });
  } else {
    // Precise mode: only the pages/actions you listed.
    for (const pageDef of config.PAGES) {
      await scanPage(page, pageDef, scans);
    }
  }

  await browser.close();

  if (!scans.length) {
    if (loginRedirects) {
      log(`\n✗ Nothing scanned — all ${loginRedirects} page(s) redirected to the login screen.`);
      log(`  Delete ${path.basename(stateFile)} and re-run to log in again.`);
    } else {
      log('\n✗ No pages were scanned — check BASE_URL and that the site is running.');
    }
    process.exitCode = 1;
    return;
  }

  // Partial expiry is the dangerous case: some pages loaded, so a report gets
  // written and the gate is applied — to a fraction of the site. Coverage this
  // incomplete is a failed run regardless of what the scanned pages scored.
  if (loginRedirects) {
    log(`\n⚠ ${loginRedirects} page(s) redirected to the login screen and were NOT scanned.`);
    log('  The session expired part-way through. Counts below cover only the pages that loaded.');
    process.exitCode = 1;
  }

  if (skippedPages.length) {
    log(`\nℹ ${skippedPages.length} page(s) need a login and were skipped (public-only scan):`);
    skippedPages.slice(0, 10).forEach((p) => log(`    · ${p.name}  ${p.path}`));
    if (skippedPages.length > 10) log(`    · … +${skippedPages.length - 10} more (listed in the report)`);
  }

  if (TIMING && Object.keys(phaseTotals).length) {
    log('\nWhere the time went (all pages):');
    log(formatPhases(phaseTotals));
  }

  const { singleFile } = await finish(scans, mapper);

  log(config.OPEN_REPORT === false
    ? ''
    : `\n(opening ${singleFile ? 'the single-file report' : 'the dashboard'} in your browser…)\n`);

  openReport(singleFile ? singleFile.file : path.join(OUT_DIR, 'dashboard.html'));
}

main().catch((e) => { console.error('\nFatal:', e); process.exitCode = 1; });
