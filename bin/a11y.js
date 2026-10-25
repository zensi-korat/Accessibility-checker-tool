#!/usr/bin/env node
/**
 * accessibility-check (also installed as `a11y`) — one entry point for any project.
 * With npx:  npx accessibility-check <command>
 *
 *   a11y init [dir] [--url <BASE_URL>] [--force]   detect the stack, write a11y.config.js, discover routes
 *             [--ci github|azure|gitlab]           … and add a CI pipeline that scans on every PR
 *   a11y discover [dir] [--live] [--max-pages N]   (re)build a11y.routes.json from the source code;
 *                                                  --live also reads sitemap.xml and crawls the running
 *                                                  app (read-only) for sample ids and routes source can't show
 *   a11y scan [--config <file>] [--public-only]    scan the running app; asks for a login if one is needed
 *   a11y scan <url> [--max-pages N]                quick scan of any URL, no config needed
 *   a11y lint [dir] [--strict] [--json]            accessibility lint of the source (no browser)
 *   a11y verify [--all]                            re-check the issues from the last scan after you fixed them
 *   a11y login                                     log in once and save the session (for CI secrets)
 *   a11y render                                    rebuild reports from the last scan, no browser
 *   a11y combine                                   merge every archived run into one report + gate
 *   a11y e2e-report                                build the report from pooled Playwright-fixture results
 *                                                  (sharded CI; unsharded runs use the reporter instead)
 *
 * Run it from the project's root (where a11y.config.js lives), or pass
 * --config. Reports land in OUTPUT_DIR (a11y-report/ for `init` configs).
 */
if (parseInt(process.versions.node, 10) < 20) {
  console.error(`accessibility-check needs Node.js 20 or newer (you have ${process.version}).`);
  process.exit(1);
}
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const TOOL_DIR = path.resolve(__dirname, '..');
const CLI = require('../lib/cliName')();
const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (name) => argv.includes(name);
const opt = (name) => { const i = argv.indexOf(name); return i > -1 ? argv[i + 1] : undefined; };
const VALUE_FLAGS = ['--url', '--config', '--max-pages', '--ci'];
const positional = () => argv.slice(1).find((a, i, all) => !a.startsWith('--') && !VALUE_FLAGS.includes(all[i - 1]));
const log = (m = '') => process.stdout.write(m + '\n');

function usage() {
  log(fs.readFileSync(__filename, 'utf8').match(/\/\*\*([\s\S]*?)\*\//)[1].replace(/^ \* ?/gm, '').trim());
}

// ── init ─────────────────────────────────────────────────────────────────────
function readText(f) { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } }

/** Best guess at the dev-server URL, from the stack's conventions and the project's own scripts. */
function guessBaseUrl(stacks) {
  for (const s of stacks) {
    const pkg = readText(path.join(s.root, 'package.json'));
    const port = (pkg.match(/(?:--port[ =]|-p\s+)(\d{2,5})/) || [])[1];
    if (port) return `http://localhost:${port}`;
    if (s.id === 'next') return 'http://localhost:3000';
    if (s.id === 'angular') return 'http://localhost:4200';
    if (s.id === 'react') return /"vite"/.test(pkg) ? 'http://localhost:5173' : 'http://localhost:3000';
    if (s.id === 'aspnet-webforms') {
      for (const f of fs.readdirSync(s.root)) {
        const iis = (readText(path.join(s.root, f)).match(/<IISUrl>([^<]+)<\/IISUrl>/) || [])[1];
        if (/\.(cs|vb)proj$/.test(f) && iis) return iis.replace(/\/$/, '');
      }
      const launch = readText(path.join(s.root, 'Properties', 'launchSettings.json'));
      const url = (launch.match(/"applicationUrl"\s*:\s*"([^";]+)/) || [])[1];
      if (url) return url;
    }
  }
  return 'http://localhost:3000';
}

/** How this project starts its app, from its own scripts. → {command, cwd} | null */
function guessWebServer(stacks, dir) {
  for (const s of stacks) {
    const cwd = path.relative(dir, s.root) || '.';
    if (s.id === 'aspnet-core') return { command: 'dotnet run', cwd };
    if (s.id === 'aspnet-webforms') return null; // IIS / IIS Express — started outside the tool
    let pkg = {};
    try { pkg = JSON.parse(readText(path.join(s.root, 'package.json'))); } catch { /* none */ }
    const scripts = pkg.scripts || {};
    const pm = fs.existsSync(path.join(s.root, 'pnpm-lock.yaml')) ? 'pnpm' : fs.existsSync(path.join(s.root, 'yarn.lock')) ? 'yarn' : 'npm';
    const run = (name) => (pm === 'npm' ? (name === 'start' ? 'npm start' : `npm run ${name}`) : `${pm} ${name}`);
    if (scripts.dev) return { command: run('dev'), cwd };
    if (scripts.start) return { command: run('start'), cwd };
    if (scripts.serve) return { command: run('serve'), cwd };
  }
  return null;
}

function configTemplate({ baseUrl, stacks, webServer }) {
  const names = stacks.map((s) => `${s.name} (${path.relative(process.cwd(), s.root) || '.'})`).join(', ') || 'none detected';
  return `/**
 * Accessibility scan config — generated by \`accessibility-check init\`.
 * Detected: ${names}
 *
 *   a11y discover   re-read routes from the source into a11y.routes.json
 *   a11y scan       scan the running app (start it first)
 *
 * Only BASE_URL is required. Every other setting and its default is listed in
 * lib/config/defaults.js of the accessibility tool.
 */
module.exports = {
  // Where the app is running. Override per environment with A11Y_BASE_URL.
  BASE_URL: process.env.A11Y_BASE_URL || '${baseUrl}',

  // Source for file:line hints in the report (relative to this file).
  REPO_PATH: '.',

  // Reports, screenshots and scan history. Add it to .gitignore.
  OUTPUT_DIR: 'a11y-report',
  REPORT_NAME: '${path.basename(process.cwd()).replace(/'/g, "\\'")}',

  // Pages come from a11y.routes.json (review it — see "include" and "params").
  // Add anything discovery cannot see here; entries can carry reveal actions
  // for modals/tabs, e.g.
  //   { name: 'Users · Add dialog', path: '/users', actions: [
  //       { type: 'click', selector: 'button:has-text("Add user")' },
  //       { type: 'snapshot', label: 'Add user dialog' } ] },
  PAGES: [],

  // Started before a scan / live discovery and stopped after; reused if it is
  // already running. Remove it to manage the app yourself.
  ${webServer ? `WEB_SERVER: { command: '${webServer.command}', cwd: '${webServer.cwd}', reuseExisting: true, timeout: 180000 },` : "// WEB_SERVER: { command: 'npm start', reuseExisting: true },"}

  // Login. 'auto' finds out by itself: no login screen → just scans; login
  // screen → asks you to log in (browser window / username+password / skip
  // protected pages) and saves the session in .a11y-auth.json for next time.
  // After a successful login it offers to write the working settings here.
  // Other modes, if you want to pin one:
  //   { mode: 'manual', startPath: '/login' }   always log in by hand in a browser window
  //   { mode: 'form', startPath: '/login', steps: [
  //       { type: 'fill',  selector: '#email',    value: '{{A11Y_USER}}' },
  //       { type: 'fill',  selector: '#password', value: '{{A11Y_PASS}}' },
  //       { type: 'click', selector: 'button[type=submit]' } ],
  //     loginPageSelector: '#password' }        scripted; credentials from env vars
  //   { mode: 'none' }                          never log in
  // CI: A11Y_USER / A11Y_PASS, or a saved session via A11Y_STORAGE_STATE(_B64)
  // (create one with \`npx accessibility-check login\`), or \`scan --public-only\`.
  LOGIN: { mode: 'auto', stateFile: '.a11y-auth.json' },
};
`;
}

const GITIGNORE_LINES = ['a11y-report/', '.a11y-auth.json', '.ci-auth-state.json'];

function ensureGitignore(dir) {
  const file = path.join(dir, '.gitignore');
  if (!fs.existsSync(file)) return false;
  const cur = readText(file);
  const missing = GITIGNORE_LINES.filter((l) => !cur.split(/\r?\n/).includes(l));
  if (!missing.length) return false;
  fs.appendFileSync(file, `${cur.endsWith('\n') ? '' : '\n'}\n# accessibility scan output + saved login session (contains live cookies)\n${missing.join('\n')}\n`);
  return true;
}

async function init() {
  const dir = path.resolve(positional() || '.');
  const file = path.join(dir, 'a11y.config.js');
  const { detectStacks } = require('../lib/adapters');
  const stacks = detectStacks(dir);

  log(`Project: ${dir}`);
  if (stacks.length) stacks.forEach((s) => log(`  ✔ ${s.name}  — ${path.relative(dir, s.root) || '.'}  (${s.evidence.join(', ')})`));
  else log('  ⚠ No supported stack detected (React, Next.js, Angular, Vue/Nuxt, ASP.NET Core, ASP.NET Web Forms). Use `' + CLI + ' discover --live` to crawl the running app, or list PAGES by hand.');

  if (fs.existsSync(file) && !flag('--force')) {
    log(`\n• ${path.basename(file)} already exists — leaving it alone (--force to overwrite).`);
  } else {
    const baseUrl = opt('--url') || guessBaseUrl(stacks);
    process.chdir(dir);
    fs.writeFileSync(file, configTemplate({ baseUrl, stacks, webServer: guessWebServer(stacks, dir) }));
    log(`\n✔ Wrote ${path.relative(process.cwd(), file)}  (BASE_URL ${baseUrl}${opt('--url') ? '' : ' — guessed, check it'})`);
  }
  if (ensureGitignore(dir)) log(`✔ Added ${GITIGNORE_LINES.join(', ')} to .gitignore`);
  if (opt('--ci')) writeCi(dir, opt('--ci'));

  process.chdir(dir);
  return discover({ quietHeader: true });
}

// ── CI templates ─────────────────────────────────────────────────────────────
const CI_TARGETS = {
  github: { template: 'github-actions.yml', dest: '.github/workflows/accessibility.yml' },
  azure: { template: 'azure-pipelines.yml', dest: 'azure-pipelines.accessibility.yml' },
  gitlab: { template: 'gitlab-ci.yml', dest: '.gitlab/accessibility.gitlab-ci.yml' },
};

function writeCi(dir, provider) {
  const t = CI_TARGETS[provider];
  if (!t) { log(`\n⚠ Unknown --ci "${provider}". Use one of: ${Object.keys(CI_TARGETS).join(', ')}`); return; }
  const dest = path.join(dir, t.dest);
  if (fs.existsSync(dest) && !flag('--force')) { log(`• ${t.dest} already exists — leaving it alone (--force to overwrite).`); return; }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(TOOL_DIR, 'templates', 'ci', t.template), dest);
  log(`✔ Wrote ${t.dest} — if pages need a login, add the A11Y_USER / A11Y_PASS secrets it mentions.`);
  if (provider === 'gitlab') log('  Add `include: .gitlab/accessibility.gitlab-ci.yml` to your .gitlab-ci.yml.');
}

// ── discover ─────────────────────────────────────────────────────────────────
async function discover({ quietHeader } = {}) {
  const { discover: run, detectStacks } = require('../lib/adapters');
  const { readManifest, writeManifest, mergeManifest, paramNames } = require('../lib/routes/manifest');

  let root, manifestFile, config = null;
  const dirArg = cmd === 'discover' ? positional() : null;
  if (!dirArg) {
    try { config = require('../lib/config/load').loadConfig({ cwd: process.cwd() }); } catch { /* no config yet */ }
  }
  if (config) {
    root = config.REPO_PATH || config._meta.configDir;
    manifestFile = config.ROUTES_FILE || path.join(config._meta.configDir, 'a11y.routes.json');
  } else {
    root = path.resolve(dirArg || '.');
    manifestFile = path.join(root, 'a11y.routes.json');
  }

  const stacks = detectStacks(root);
  if (!quietHeader) {
    log(`Project: ${root}`);
    stacks.forEach((s) => log(`  ✔ ${s.name}  — ${path.relative(root, s.root) || '.'}`));
  }
  const liveMode = flag('--live');
  if (!stacks.length && !liveMode) {
    log('\n⚠ No supported stack found, so no routes could be read from source.');
    log(`  Start the app and run \`${CLI} discover --live\` to find pages from the running site, or add PAGES by hand.`);
    return;
  }

  const result = run(root, stacks);
  if (liveMode) {
    const baseUrl = opt('--url') || (config && config.BASE_URL);
    if (!baseUrl) { log('\n✗ --live needs BASE_URL (in a11y.config.js, or --url).'); process.exitCode = 2; return; }
    const { discoverLive, applyLive } = require('../lib/routes/live');
    const { mergeDefaults } = require('../lib/config/load');
    const liveConfig = config || { ...mergeDefaults({}), BASE_URL: baseUrl };
    liveConfig.BASE_URL = baseUrl;
    if (!(await ensureBrowser())) { process.exitCode = 2; return; }
    log(`\nReading the live site at ${baseUrl} (read-only: links are followed, nothing is clicked or submitted)…`);
    let liveRes, server;
    try {
      server = await require('../lib/webServer').startWebServer(liveConfig, { log });
      liveRes = await discoverLive(liveConfig, { maxPages: Number(opt('--max-pages')) || 60, sitemap: !flag('--no-sitemap'), log });
    } catch (e) {
      log(`\n✗ Could not read the live site: ${e.message.split('\n')[0]}`);
      log('  Is the app running at BASE_URL? (or set WEB_SERVER in the config to have it started)');
      process.exitCode = 1;
      return;
    } finally {
      if (server) await server.stop();
    }
    const applied = applyLive(result.routes, liveRes.found);
    result.routes = applied.routes;
    log(`  ${applied.matched} URL(s) matched source routes · ${applied.sampled} dynamic route(s) got a sample id · ${applied.added} route(s) found only on the live site`);
  }
  const previous = fs.existsSync(manifestFile) ? readManifest(manifestFile) : null;
  const manifest = mergeManifest(previous, result.routes, { project: path.basename(root), stacks: stacks.map((s) => s.name) });
  writeManifest(manifestFile, manifest);

  const live = manifest.routes.filter((r) => r.status !== 'gone');
  const included = live.filter((r) => r.include);
  const needParams = live.filter((r) => r.params && paramNames(r.pattern).some((p) => !p.optional && !r.params[p.name]));
  const guarded = live.filter((r) => r.guarded);
  const fresh = live.filter((r) => r.status === 'new');
  const gone = manifest.routes.filter((r) => r.status === 'gone');

  log(`\n✔ ${live.length} route(s) → ${path.relative(process.cwd(), manifestFile) || manifestFile}`);
  log(`    ${included.length} included in scans`);
  if (needParams.length) log(`    ${needParams.length} dynamic — need sample "params" before they can be scanned (e.g. ${needParams[0].pattern})`);
  if (guarded.length) log(`    ${guarded.length} behind an auth guard — configure LOGIN in the config`);
  if (previous) log(`    ${fresh.length} new since last discovery${gone.length ? `, ${gone.length} no longer found (marked "gone", not scanned)` : ''}`);
  if (result.skipped.length) {
    log(`    ${result.skipped.length} definition(s) skipped:`);
    const byReason = {};
    for (const s of result.skipped) (byReason[s.reason] = byReason[s.reason] || []).push(s.source);
    for (const [reason, srcs] of Object.entries(byReason)) log(`      · ${reason}: ${srcs.slice(0, 3).join(', ')}${srcs.length > 3 ? ` (+${srcs.length - 3})` : ''}`);
  }
  log(`\nNext: review the routes file, then run \`${CLI} scan\` (it starts the app if WEB_SERVER is set).`);
}

// ── lint ─────────────────────────────────────────────────────────────────────
// Static accessibility lint only: no browser, no running app — seconds, so it
// fits a pre-commit hook. Exit 1 when there are violations (--strict: also
// when there are findings to review).
async function lint() {
  const { lintProject } = require('../lib/static/eslint');
  const { detectStacks } = require('../lib/adapters');
  let root = positional() ? path.resolve(positional()) : null;
  let opts = {}, stacks;
  if (!root) {
    try {
      const config = require('../lib/config/load').loadConfig({ cwd: process.cwd() });
      root = config.REPO_PATH || config._meta.configDir;
      opts = config.STATIC_LINT || {};
      stacks = config.STACKS;
    } catch { root = process.cwd(); }
  }
  stacks = stacks && stacks.length ? stacks : detectStacks(root).map((s) => s.id);
  const res = await lintProject(root, stacks, opts);
  if (flag('--json')) { log(JSON.stringify(res.findings.map(({ abs, mapping, ...f }) => ({ ...f, wcag: mapping.sc, confidence: mapping.conf, impact: mapping.impact })), null, 2)); }
  else {
    log(`Accessibility lint — ${root}${stacks.length ? `  (${stacks.join(', ')})` : ''}`);
    const byFile = new Map();
    for (const f of res.findings) byFile.set(f.file, [...(byFile.get(f.file) || []), f]);
    for (const [file, list] of byFile) {
      log(`\n${file}`);
      for (const f of list.sort((a, b) => a.line - b.line)) {
        log(`  ${String(f.line).padStart(4)}:${String(f.column).padEnd(3)} ${f.mapping.conf === 'high' ? '✗' : '?'} ${f.mapping.sc.join(',').padEnd(13)} ${f.message}  (${f.ruleId})`);
      }
    }
    for (const u of res.unparsed) log(`\n⚠ ${u.file}: could not parse (${u.message.split('\n')[0]})`);
  }
  const high = res.findings.filter((f) => f.mapping.conf === 'high').length;
  const review = res.findings.length - high;
  if (!flag('--json')) {
    log(`\n${res.files} file(s) checked in ${(res.durationMs / 1000).toFixed(1)}s — ✗ ${high} violation(s), ? ${review} to review (heuristics; check the rendered component).`);
    if (!res.files) log('No lintable files found (JSX/TSX, Vue, Angular templates, HTML). Razor / Web Forms markup is covered by `' + CLI + ' scan` instead.');
  }
  process.exitCode = high || (flag('--strict') && review) ? 1 : 0;
}

// ── first run: the browser Playwright drives ────────────────────────────────
// Launching is the only reliable test: headless runs use a separate
// "headless shell" binary, and each Playwright version wants its own build.
async function browserMissing() {
  try {
    const b = await require('playwright').chromium.launch({ headless: true });
    await b.close();
    return false;
  } catch (e) {
    return /Executable doesn't exist|playwright install/i.test(String(e.message));
  }
}

async function ensureBrowser() {
  if (!(await browserMissing())) return true;
  const cli = path.join(path.dirname(require.resolve('playwright/package.json')), 'cli.js');
  const install = () => spawnSync(process.execPath, [cli, 'install', 'chromium'], { stdio: 'inherit' }).status === 0;
  log('The Chromium browser used for scanning is not installed yet (one-time download, ~150 MB).');
  const { interactive, ask } = require('../lib/auth/prompt');
  if (!interactive()) {
    if (process.env.CI || process.env.A11Y_CI) { log('Installing it now…'); return install(); }
    log('Install it with:  npx playwright install chromium');
    return false;
  }
  return ask('Install it now? [Y/n]: ').then((a) => (/^n/i.test(a) ? (log('Run `npx playwright install chromium` when ready.'), false) : install()));
}

async function withBrowser(script, extra) {
  if (!(await ensureBrowser())) { process.exitCode = 2; return; }
  passthrough(script, extra);
}

// ── scan / render / combine: thin pass-through to the existing scripts ──────
function passthrough(script, extra = []) {
  const r = spawnSync(process.execPath, [path.join(TOOL_DIR, script), ...argv.slice(1), ...extra], { stdio: 'inherit', cwd: process.cwd() });
  process.exitCode = r.status === null ? 1 : r.status;
}

switch (cmd) {
  case 'init': init().catch((e) => { console.error(e); process.exitCode = 1; }); break;
  case 'discover': discover().catch((e) => { console.error(e); process.exitCode = 1; }); break;
  case 'scan': withBrowser('scan.js'); break;
  case 'login': withBrowser('scan.js', ['--login-only']); break;
  case 'verify': withBrowser('scan.js', ['--verify']); break;
  case 'lint': lint().catch((e) => { console.error(e); process.exitCode = 1; }); break;
  case 'render': passthrough('render.js'); break;
  case 'combine': passthrough('combine-reports.js'); break;
  case 'e2e-report': {
    const { loadE2eConfig } = require('../lib/playwright/shared');
    const { finalizeE2e } = require('../lib/playwright/e2eReport');
    const res = finalizeE2e(loadE2eConfig(opt('--config')));
    process.exitCode = !res ? 1 : res.gate.failed ? 1 : 0;
    break;
  }
  case undefined: case '-h': case '--help': case 'help': usage(); break;
  default: log(`Unknown command: ${cmd}\n`); usage(); process.exitCode = 1;
}
