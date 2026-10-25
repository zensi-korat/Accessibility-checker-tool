/**
 * Route discovery from the RUNNING app — the stack-neutral source that works
 * for anything served over HTTP (Laravel, Django, Rails, PHP, Vue, Svelte, …),
 * and the complement to the source adapters:
 *
 *   1. sitemap.xml (+ any Sitemap: listed in robots.txt, + sitemap indexes)
 *   2. a read-only crawl: follows same-origin <a href>, routerLink attributes
 *      and SPA navigations (history.pushState/replaceState), never clicks
 *      anything, blocks every non-GET request (lib/interact.js guard), and
 *      skips links whose URL reads like an action (/delete, /logout, …).
 *      Uses the saved login session when there is one, so guarded areas are
 *      reached too.
 *
 * The concrete URLs it finds are then
 *   - matched against routes from the source adapters, giving dynamic routes
 *     (/users/:id) a real sample value so they can be scanned, and
 *   - for URLs no adapter knows, collapsed into patterns (/orders/1042 →
 *     /orders/:id) and added as routes of their own.
 */
const fs = require('fs');
const { matchPattern } = require('./manifest');

const SKIP_EXT = /\.(pdf|zip|gz|tgz|rar|7z|png|jpe?g|gif|svg|webp|ico|mp4|mp3|wav|avi|mov|docx?|xlsx?|pptx?|csv|xml|json|txt|css|js|map|woff2?|ttf|eot)$/i;
const ACTION_URL = /\b(delete|remove|destroy|drop|purge|deactivate|disable|archive|void|cancel|approve|reject|publish|send|pay|checkout|logout|log-out|signout|sign-out|unsubscribe|download|export)\b/i;

/** Normalise a link to a route key: path (+ hash route), no query. null = skip. */
function routeOf(href, base) {
  let u;
  try { u = new URL(href, base); } catch { return null; }
  if (u.origin !== base.origin || !/^https?:$/.test(u.protocol)) return null;
  if (SKIP_EXT.test(u.pathname) || ACTION_URL.test(u.pathname + u.search)) return null;
  // Page paths are appended to BASE_URL by the scanner, so make them relative
  // to its path (BASE_URL is normally just the origin).
  let p = decodeURI(u.pathname).replace(/\/{2,}/g, '/');
  const prefix = base.pathname.replace(/\/+$/, '');
  if (prefix && (p === prefix || p.startsWith(prefix + '/'))) p = p.slice(prefix.length) || '/';
  // /index.html is the same document as / (and /docs/index.htm as /docs):
  // keeping both would scan one page twice and report every issue twice.
  p = p.replace(/\/index\.html?$/i, '/');
  if (p.length > 1) p = p.replace(/\/+$/, '');
  const hash = u.hash.startsWith('#/') || u.hash.startsWith('#!/') ? u.hash.replace(/^#!?/, '').replace(/[?].*$/, '') : null;
  return { path: p || '/', hash: hash ? (hash.length > 1 ? hash.replace(/\/+$/, '') : '/') : null };
}

/**
 * A start URL that names a file (http://host/site/index.html) is a page, not
 * the base routes get appended to — otherwise /contact.html would become
 * http://host/site/index.html/contact.html. → { base, startPath }; startPath
 * is null when the URL is already a base.
 */
function splitStartUrl(url) {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/^(.*\/)([^/]+\.(?:html?|php|aspx?|jsp))$/i);
    if (!m) return { base: url, startPath: null };
    const startPath = /^index\.html?$/i.test(m[2]) ? '/' : '/' + m[2];
    u.pathname = m[1]; u.search = ''; u.hash = '';
    return { base: u.href.replace(/\/$/, ''), startPath };
  } catch { return { base: url, startPath: null }; }
}

async function fetchSitemaps(request, base, log, max = 5000) {
  const urls = new Set();
  const queue = [new URL('/sitemap.xml', base).href];
  try {
    const robots = await request.get(new URL('/robots.txt', base).href, { timeout: 10000 });
    if (robots.ok()) {
      for (const m of (await robots.text()).matchAll(/^\s*sitemap:\s*(\S+)/gim)) queue.push(m[1]);
    }
  } catch { /* no robots.txt */ }
  const seen = new Set();
  while (queue.length && seen.size < 25 && urls.size < max) {
    const sm = queue.shift();
    if (seen.has(sm)) continue;
    seen.add(sm);
    let body = '';
    try {
      const res = await request.get(sm, { timeout: 15000 });
      if (!res.ok()) continue;
      body = await res.text();
    } catch { continue; }
    const locs = [...body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1].replace(/&amp;/g, '&'));
    if (/<sitemapindex/i.test(body)) queue.push(...locs);
    else for (const l of locs) if (urls.size < max) urls.add(l);
  }
  if (urls.size) log(`  sitemap: ${urls.size} URL(s) from ${seen.size} sitemap file(s)`);
  return [...urls];
}

/** Runs in the page before any app script: record SPA navigations. */
function navRecorder() {
  window.__a11yNav = [];
  for (const k of ['pushState', 'replaceState']) {
    const orig = history[k];
    history[k] = function (state, title, url) {
      try { if (url) window.__a11yNav.push(String(new URL(url, location.href))); } catch (e) { /* ignore */ }
      return orig.apply(this, arguments);
    };
  }
}

function collectLinks() {
  const out = [];
  document.querySelectorAll('a[href], area[href], [routerlink], [ng-reflect-router-link], [data-href]').forEach((el) => {
    const v = el.getAttribute('href') || el.getAttribute('routerlink') || el.getAttribute('ng-reflect-router-link') || el.getAttribute('data-href');
    if (v && !/^(mailto|tel|javascript):/i.test(v)) { try { out.push(String(new URL(v, location.href))); } catch (e) { /* ignore */ } }
  });
  return { links: out, nav: window.__a11yNav || [], href: location.href };
}

/**
 * @param {object} config  loaded a11y config (BASE_URL, LOGIN, IGNORE_HTTPS_ERRORS, …)
 * @param {{maxPages?:number, seeds?:string[], sitemap?:boolean, crawl?:boolean, log?:Function}} opts
 * @returns {Promise<{found:{path:string,hash:string|null,via:string}[], visited:number, loginRedirects:number}>}
 */
async function discoverLive(config, opts = {}) {
  const log = opts.log || (() => {});
  const { chromium, request: pwRequest } = require('playwright');
  const base = new URL(config.BASE_URL);
  const stateFile = config.LOGIN && config.LOGIN.stateFile && fs.existsSync(config.LOGIN.stateFile) ? config.LOGIN.stateFile : undefined;
  const found = new Map();
  const keyOf = (r) => (r.hash ? '#' + r.hash : r.path);
  const add = (r, via) => { if (r) { const k = keyOf(r); if (!found.has(k)) found.set(k, { ...r, via }); } };
  // Routes the crawl itself saw answer with an HTTP error (404, 403, 500…).
  // Scanning those would report the error page's markup as the app's.
  const broken = new Set();

  if (opts.sitemap !== false) {
    const request = await pwRequest.newContext({ ignoreHTTPSErrors: config.IGNORE_HTTPS_ERRORS !== false, storageState: stateFile });
    for (const u of await fetchSitemaps(request, base, log)) add(routeOf(u, base), 'sitemap');
    await request.dispose();
  }

  let visited = 0, loginRedirects = 0;
  if (opts.crawl !== false) {
    const maxPages = opts.maxPages || 60;
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ ignoreHTTPSErrors: config.IGNORE_HTTPS_ERRORS !== false, storageState: stateFile, viewport: config.VIEWPORT });
    await context.addInitScript(navRecorder);
    const page = await context.newPage();
    page.on('dialog', (d) => d.dismiss().catch(() => {}));
    const { installGuard } = require('../interact');
    const guard = await installGuard(page, { log: () => {} });
    const loginSel = config.LOGIN && (config.LOGIN.loginPageSelector || config.LOGIN.loggedOutSelector);

    const queue = [base.href, ...(opts.seeds || [])];
    const queued = new Set(queue);
    while (queue.length && visited < maxPages) {
      const url = queue.shift();
      let status = 0;
      try {
        const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        status = res ? res.status() : 0;
        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(Math.min(config.SETTLE_MS || 500, 1500));
      } catch { continue; }
      visited++;
      if (status >= 400) {
        const r = routeOf(url, base);
        if (r) broken.add(keyOf(r));
        continue;
      }
      const onLogin = loginSel
        ? await page.$(loginSel).catch(() => null)
        : await require('../auth/detect').isLoginRedirect(page, url).catch(() => false);
      if (onLogin) { loginRedirects++; continue; }
      const { links, nav, href } = await page.evaluate(collectLinks).catch(() => ({ links: [], nav: [], href: url }));
      add(routeOf(href, base), 'crawl');
      for (const n of nav) add(routeOf(n, base), 'crawl');
      for (const l of links) {
        const r = routeOf(l, base);
        if (!r) continue;
        add(r, 'crawl');
        // r.path is relative to BASE_URL's own path (see routeOf), so join it
        // back onto that prefix rather than resolving it against the origin.
        const prefix = base.pathname.replace(/\/+$/, '');
        const target = base.origin + prefix + (r.hash ? '/#' + r.hash : r.path);
        if (!queued.has(target)) { queued.add(target); queue.push(target); }
      }
    }
    await guard.uninstall();
    await browser.close();
    for (const k of broken) found.delete(k);
    if (broken.size) log(`  crawl: left out ${broken.size} link(s) that answered with an HTTP error (${[...broken].slice(0, 3).join(', ')}${broken.size > 3 ? ', …' : ''})`);
    log(`  crawl: visited ${visited} page(s)${queue.length ? ` (stopped at the ${maxPages}-page limit; --max-pages to raise)` : ''}, ${found.size} distinct route(s) seen`);
    if (loginRedirects) log(`  ⚠ ${loginRedirects} page(s) showed the login screen — run \`${require('../cliName')()} login\` once so the crawl can reuse the session, then discover again`);
  }
  return { found: [...found.values()], visited, loginRedirects };
}

const ID_SEG = /^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{24}|[0-9a-f]{32})$/i;

/**
 * Fold live URLs into the route list.
 * @param {object[]} routes  routes from the source adapters
 * @param {object[]} found   discoverLive().found
 * @returns {{routes:object[], matched:number, sampled:number, added:number}}
 */
function applyLive(routes, found) {
  const out = routes.map((r) => ({ ...r, sources: [...r.sources] }));
  // Most specific first, so /users/new is not taken as /users/:id.
  const order = [...out].sort((a, b) => (a.pattern.match(/:/g) || []).length - (b.pattern.match(/:/g) || []).length);
  let matched = 0, sampled = 0;
  const unmatched = [];
  for (const f of found) {
    const target = f.hash || f.path;
    const r = order.find((x) => !!x.hash === !!f.hash && matchPattern(x.pattern, target));
    if (!r) { unmatched.push(f); continue; }
    matched++;
    const tag = `${f.via} (live site)`;
    if (!r.sources.includes(tag)) r.sources.push(tag);
    const params = matchPattern(r.pattern, target);
    if (Object.keys(params).length && !r.sample) { r.sample = params; sampled++; }
  }

  // URLs no source route explains: /orders/1042 + /orders/1043 → /orders/:id.
  const byShape = new Map();
  for (const f of unmatched) {
    const segs = (f.hash || f.path).split('/').filter(Boolean);
    const sample = {};
    const shape = segs.map((s, i) => {
      if (!ID_SEG.test(s)) return s;
      const name = i > 0 ? `${segs[i - 1].replace(/s$/, '').replace(/[^A-Za-z0-9]/g, '') || 'item'}Id` : 'id';
      sample[name] = s;
      return ':' + name;
    });
    const pattern = '/' + shape.join('/');
    const key = (f.hash ? '#' : '') + pattern;
    if (!byShape.has(key)) byShape.set(key, { pattern, hash: !!f.hash, via: f.via, sample: Object.keys(sample).length ? sample : null, count: 0 });
    byShape.get(key).count++;
  }
  // Many siblings that differ only in the last segment (/blog/<slug> ×40) are one template.
  const byParent = new Map();
  for (const v of byShape.values()) {
    const parent = (v.hash ? '#' : '') + v.pattern.replace(/\/[^/]+$/, '');
    if (/\/:[^/]+$/.test(v.pattern) || v.pattern === '/') continue; // already a template / the root
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent).push(v);
  }
  for (const [parent, kids] of byParent) {
    if (kids.length <= 10) continue;
    const first = kids[0];
    for (const k of kids) byShape.delete((k.hash ? '#' : '') + k.pattern);
    const p = parent.replace(/^#/, '') + '/:slug';
    byShape.set((first.hash ? '#' : '') + p, { pattern: p, hash: first.hash, via: first.via, sample: { slug: first.pattern.split('/').pop() }, count: kids.length, collapsed: true });
  }
  let added = 0;
  for (const v of byShape.values()) {
    added++;
    out.push({
      pattern: v.pattern, hash: v.hash, guarded: false, sources: [`${v.via} (live site)`], sample: v.sample || undefined,
      notes: [
        'found on the live site only — no route definition in source explains it',
        ...(v.collapsed ? [`${v.count} similar URLs collapsed into one template; check they really share a layout`] : []),
      ],
    });
  }
  return { routes: out, matched, sampled, added };
}

module.exports = { discoverLive, applyLive, routeOf, fetchSitemaps, splitStartUrl };
