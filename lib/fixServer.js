/**
 * `a11y fix` — the fix plan, live.
 *
 * Serves fix-plan.html on 127.0.0.1 and keeps it current while you work:
 *
 *   Re-check    a card's button (or "Re-check all open") re-scans just the
 *               pages involved, as `a11y verify` would, and the plan updates
 *               in place: proven fixes move to Done, new issues are flagged.
 *   --watch     (default when REPO_PATH is set) saving a source file re-checks
 *               the pages whose issues point at that file, or every open page
 *               when nothing maps to it (a stylesheet, say).
 *   Decisions   in progress / snoozed / won't fix are written to
 *               a11y.triage.json next to the config, for the team to share.
 *
 * Re-checks run scan.js in a child process with --verify, so "fixed" means
 * exactly what it means for `a11y verify` — never a guess.
 *
 * Safety: binds to 127.0.0.1 only; rejects any Host header other than
 * localhost/127.0.0.1 (blocks DNS rebinding); every request that changes
 * anything needs the per-session token embedded in the served page.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, exec } = require('child_process');
const { renderFixPlan, readTriage, writeTriage, triageFile } = require('./fixPlan');
const { LINT_PAGE } = require('./verify');

const TOOL_DIR = path.resolve(__dirname, '..');
const SCAN_JS = path.join(TOOL_DIR, 'scan.js');
const IMG = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const WATCH_EXT = /\.(jsx?|tsx?|mjs|cjs|vue|svelte|html?|css|scss|sass|less|cshtml|razor|aspx|ascx|master|php|erb|hbs|njk|liquid)$/i;
const WATCH_IGNORE = /(^|[\\/])(node_modules|\.git|dist|build|out|coverage|\.next|\.nuxt|\.svelte-kit|\.angular|\.cache|\.turbo|bin|obj|test-results|playwright-report|a11y-report)([\\/]|$)/;
const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');

function parseArgs(args) {
  const opt = (name) => { const i = args.indexOf(name); return i > -1 ? args[i + 1] : undefined; };
  const VALUE = ['--port', '--config', '--max-pages', '--only'];
  return {
    port: parseInt(opt('--port'), 10) || 4777,
    portExplicit: args.includes('--port'),
    config: opt('--config'),
    open: !args.includes('--no-open'),
    watch: args.includes('--no-watch') ? false : args.includes('--watch') ? true : null,
    url: args.find((a, i) => !a.startsWith('--') && !VALUE.includes(args[i - 1])),
  };
}

function loadConfig(o) {
  const loader = require('./config/load');
  const hasConfig = o.config || process.env.A11Y_CONFIG || fs.existsSync(path.join(process.cwd(), 'a11y.config.js'));
  if (o.url && !hasConfig) return loader.quickConfig(o.url, { log: () => {} });
  if (o.url) process.env.A11Y_BASE_URL = o.url;
  if (o.config) process.env.A11Y_CONFIG = path.resolve(o.config);
  return loader.loadConfig({ log: () => {} });
}

function openInBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start ""' : 'xdg-open';
  exec(`${cmd} "${url}"`, () => {});
}

async function main(args, { log = (m) => process.stdout.write(m + '\n') } = {}) {
  const o = parseArgs(args);
  let config;
  try { config = loadConfig(o); } catch (e) { log(`\n✗ ${e.message}\n`); process.exitCode = 2; return; }
  const OUT = path.resolve(config.OUTPUT_DIR);
  const planFile = path.join(OUT, 'fix-plan.json');
  const tFile = triageFile(config);
  const quick = !!config._meta.quick;
  const scanArgs = [SCAN_JS, ...(quick ? [o.url] : []), ...(config._meta.configFile ? ['--config', config._meta.configFile] : [])];
  const childEnv = (extra) => ({ ...process.env, A11Y_OPEN_REPORT: '0', FORCE_COLOR: '0', ...extra });

  // Keep the app up for the whole session (re-checks reuse it) when the
  // config knows how to start it.
  let server = { stop: async () => {} };
  try { server = await require('./webServer').startWebServer(config, { log }); } catch (e) { log(`✗ Could not start the app: ${e.message}`); process.exitCode = 2; return; }

  // First run: no plan yet → a full scan, in the foreground (it may need a login).
  if (!fs.existsSync(planFile)) {
    log('No scan results yet — running a full scan first (this one may ask you to log in)…\n');
    const code = await new Promise((resolve) => {
      spawn(process.execPath, scanArgs, { stdio: 'inherit', env: childEnv({}) }).on('close', resolve);
    });
    if (!fs.existsSync(planFile)) {
      log(`\n✗ The scan did not produce a fix plan (exit ${code}). Fix the problem above and run this again.`);
      await server.stop();
      process.exitCode = 2;
      return;
    }
  }

  const readPlan = () => {
    const data = JSON.parse(fs.readFileSync(planFile, 'utf8'));
    const decisions = readTriage(tFile);
    for (const g of data.groups) g.triage = decisions[g.key] || null;
    return data;
  };

  // ── Server-sent events ────────────────────────────────────────────────────
  const clients = new Set();
  const send = (res, event, data) => res.write(`event: ${event}\ndata: ${typeof data === 'string' ? data.replace(/\n/g, ' ') : JSON.stringify(data)}\n\n`);
  const broadcast = (event, data) => { for (const res of clients) send(res, event, data); };
  setInterval(() => { for (const res of clients) res.write(': keep-alive\n\n'); }, 25000).unref();

  // ── Re-check runner (one at a time; requests during a run are merged) ─────
  let running = null;
  let queued = null;
  let lastStart = null;
  const { splitStartUrl } = require('./routes/live');
  const basePath = (() => { try { return new URL(splitStartUrl(config.BASE_URL).base).pathname.replace(/\/+$/, ''); } catch { return ''; } })();
  const pathFor = (plan, name) => {
    for (const g of plan.groups) for (const e of g.elements) {
      if (e.page !== name || !e.url) continue;
      try {
        const u = new URL(e.url);
        let p = u.pathname;
        if (basePath && p.startsWith(basePath)) p = p.slice(basePath.length) || '/';
        return p + u.search;
      } catch { /* next */ }
    }
    return null;
  };

  function start(req) {
    const plan = readPlan();
    const known = new Set(plan.pages);
    // The lint pseudo-page isn't a URL; the source lint re-runs on every check anyway.
    const pages = [...req.pages].filter((p) => known.has(p) && p !== LINT_PAGE);
    if (!pages.length && [...req.pages].includes(LINT_PAGE)) pages.push(...plan.pages.filter((p) => p !== LINT_PAGE).slice(0, 1));
    if (!pages.length) return;
    const only = quick
      ? pages.map((name) => ({ name, path: pathFor(plan, name) })).filter((p) => p.path)
      : pages;
    const startedAt = Date.now();
    running = { pages, startedAt };
    lastStart = { phase: 'start', pages, all: !!req.all };
    broadcast('run', lastStart);
    log(`\n↻ Re-checking ${pages.length} page(s): ${pages.slice(0, 5).join(', ')}${pages.length > 5 ? ', …' : ''}`);
    const child = spawn(process.execPath, [...scanArgs, '--verify', '--all'], {
      env: childEnv({ A11Y_ONLY_PAGES: JSON.stringify(only) }), stdio: ['ignore', 'pipe', 'pipe'],
    });
    running.child = child;
    let index = 0;
    const tail = [];
    const onLine = (raw) => {
      const line = stripAnsi(raw);
      if (!line.trim()) return;
      tail.push(line); if (tail.length > 40) tail.shift();
      broadcast('log', line);
      const m = line.match(/^▶ (.+?)\s{2}\(/);
      if (m) { index += 1; broadcast('run', { phase: 'page', name: m[1], index, total: pages.length }); }
      else if (/^Aggregating results/.test(line)) broadcast('run', { phase: 'finishing' });
    };
    const pipe = (stream) => {
      let buf = '';
      stream.on('data', (d) => { buf += d; const lines = buf.split(/\r?\n/); buf = lines.pop(); lines.forEach(onLine); });
      stream.on('end', () => { if (buf) onLine(buf); });
    };
    pipe(child.stdout); pipe(child.stderr);
    child.on('close', (code) => {
      running = null;
      lastStart = null;
      let fresh = false;
      try { fresh = fs.statSync(planFile).mtimeMs >= startedAt; } catch { /* missing */ }
      if (fresh) {
        const plan2 = readPlan();
        broadcast('state', plan2);
        broadcast('run', { phase: 'done', ok: true });
        const c = plan2.counts;
        log(`  ✓ done — ${c.now} fix first · ${c.next} fix next · ${c.plan} schedule · ${plan2.done.length} done`);
      } else {
        const why = [...tail].reverse().find((l) => /✗|error|Error/.test(l)) || `the scan exited with code ${code}`;
        broadcast('run', { phase: 'done', ok: false, message: why.trim().slice(0, 300) });
        log(`  ✗ re-check failed: ${why.trim()}`);
      }
      if (queued) { const q = queued; queued = null; start(q); }
    });
  }

  function enqueue(pages, all) {
    if (running) {
      queued = queued || { pages: new Set(), all: false };
      pages.forEach((p) => queued.pages.add(p));
      queued.all = queued.all || all;
      broadcast('run', { phase: 'queued', pages: [...queued.pages] });
      return { queued: true };
    }
    start({ pages: new Set(pages), all });
    return { queued: false };
  }

  // ── File watcher ──────────────────────────────────────────────────────────
  const repo = config.REPO_PATH ? path.resolve(config._meta.configDir || process.cwd(), config.REPO_PATH) : null;
  let watching = false;
  if (o.watch !== false && repo && fs.existsSync(repo)) {
    const outRel = path.relative(repo, OUT);
    const changed = new Set();
    let timer = null;
    const delay = config.FIX_WATCH_DELAY_MS || 1800; // debounce + time for the dev server to hot-reload
    try {
      fs.watch(repo, { recursive: true }, (evt, file) => {
        if (!file) return;
        const rel = String(file);
        if (!WATCH_EXT.test(rel) || WATCH_IGNORE.test(rel)) return;
        if (/^\.|~$|\.(swp|swx|tmp|bak)$/i.test(path.basename(rel))) return; // editor temp / backup files
        if (outRel && !outRel.startsWith('..') && rel.startsWith(outRel)) return;
        changed.add(rel.split(path.sep).join('/'));
        clearTimeout(timer);
        timer = setTimeout(() => {
          const files = [...changed];
          changed.clear();
          let plan;
          try { plan = readPlan(); } catch { return; }
          const open = plan.groups.filter((g) => !(g.triage && (g.triage.state === 'wontfix' || g.triage.state === 'snoozed')));
          const hits = open.filter((g) => g.locations.some((l) => files.some((f) => {
            const lf = String(l.file || '').split(path.sep).join('/');
            return lf && (lf === f || lf.endsWith('/' + f) || f.endsWith('/' + lf));
          })));
          const pages = [...new Set((hits.length ? hits : open).flatMap((g) => g.pages.map((p) => p.name)))];
          if (!pages.length) return;
          broadcast('watch', { files, pages: hits.length ? pages : [] });
          log(`\n✎ ${files.slice(0, 3).join(', ')}${files.length > 3 ? ', …' : ''} changed`);
          enqueue(pages, false);
        }, delay);
      });
      watching = true;
    } catch (e) {
      log(`⚠ Could not watch ${repo} for changes (${e.message}). Use the Re-check buttons instead.`);
    }
  }

  // ── HTTP ──────────────────────────────────────────────────────────────────
  const token = crypto.randomBytes(18).toString('base64url');
  let port = o.port;
  const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
  const readBody = (req) => new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (d) => { b += d; if (b.length > 64 * 1024) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(new Error('bad JSON')); } });
  });

  const srv = http.createServer(async (req, res) => {
    const host = String(req.headers.host || '');
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) { res.writeHead(403); res.end('Forbidden'); return; }
    const u = new URL(req.url, `http://${host}`);
    const authed = req.headers['x-a11y-token'] === token || u.searchParams.get('t') === token;
    try {
      if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/fix-plan.html')) {
        const html = renderFixPlan(readPlan(), { mode: 'live', live: { token, watch: watching } });
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY' });
        res.end(html);
        return;
      }
      if (req.method === 'GET' && u.pathname === '/api/events') {
        if (!authed) { res.writeHead(401); res.end(); return; }
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write('retry: 2000\n\n');
        clients.add(res);
        if (lastStart) send(res, 'run', lastStart);
        req.on('close', () => clients.delete(res));
        return;
      }
      if (req.method === 'GET' && u.pathname === '/api/state') {
        if (!authed) { json(res, 401, { error: 'unauthorized' }); return; }
        json(res, 200, readPlan());
        return;
      }
      if (req.method === 'POST' && (u.pathname === '/api/recheck' || u.pathname === '/api/triage')) {
        if (req.headers['x-a11y-token'] !== token) { json(res, 401, { error: 'unauthorized' }); return; }
        const body = await readBody(req);
        if (u.pathname === '/api/recheck') {
          const pages = Array.isArray(body.pages) ? body.pages.filter((p) => typeof p === 'string').slice(0, 500) : [];
          if (!pages.length) { json(res, 400, { error: 'no pages' }); return; }
          json(res, 202, enqueue(pages, !!body.all));
        } else {
          const decisions = writeTriage(tFile, body.key, body.decision);
          const decision = decisions[body.key] || null;
          broadcast('triage', { key: body.key, decision });
          json(res, 200, { decision });
        }
        return;
      }
      if (req.method === 'GET' && IMG[path.extname(u.pathname).toLowerCase()]) {
        const file = path.resolve(OUT, '.' + decodeURIComponent(u.pathname));
        if (!file.startsWith(OUT + path.sep) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'Content-Type': IMG[path.extname(file).toLowerCase()], 'Cache-Control': 'no-cache' });
        fs.createReadStream(file).pipe(res);
        return;
      }
      res.writeHead(404); res.end('Not found');
    } catch (e) {
      json(res, 400, { error: e.message });
    }
  });

  await new Promise((resolve, reject) => {
    let tries = 0;
    srv.on('error', (e) => {
      if (e.code === 'EADDRINUSE' && tries < 10 && !o.portExplicit) { tries += 1; port += 1; srv.listen(port, '127.0.0.1'); }
      else reject(e);
    });
    srv.listen(port, '127.0.0.1', resolve);
    srv.once('listening', resolve);
  }).catch((e) => { log(`✗ Could not start the fix-plan server: ${e.message}`); process.exitCode = 2; });
  if (process.exitCode === 2) { await server.stop(); return; }

  const url = `http://127.0.0.1:${port}/`;
  const plan = readPlan();
  log('\n─────────────────────────────────────────────');
  log(`  Fix plan (live): ${url}`);
  log(`  ${plan.counts.now} fix first · ${plan.counts.next} fix next · ${plan.counts.plan} schedule · ${plan.done.length} done`);
  log(watching
    ? `  Watching ${path.relative(process.cwd(), repo) || '.'} — saving a file re-checks the pages it affects.`
    : (repo ? '  File watching is off — use the Re-check buttons.' : '  Set REPO_PATH in the config to re-check automatically when you save a file.'));
  log(`  Decisions are saved to ${path.relative(process.cwd(), tFile) || tFile}`);
  log('  Press Ctrl+C to stop.');
  log('─────────────────────────────────────────────');
  if (o.open && !require('./ci').isCI()) openInBrowser(url);

  const stop = async () => {
    if (running && running.child) running.child.kill();
    for (const res of clients) res.end();
    srv.close();
    await server.stop();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

module.exports = { main, parseArgs };
