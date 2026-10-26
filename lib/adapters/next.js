/**
 * Next.js adapter. Next routes are the file system, so this is a walk — no
 * parsing needed — over both routers:
 *
 *   pages/   users/[id].tsx → /users/:id      (skips _app, _document, api/, 404/500)
 *   app/     users/[id]/page.tsx → /users/:id (skips (groups), @slots, _private,
 *            (.)intercepting routes and route.ts API handlers)
 *
 * If a build exists (.next/routes-manifest.json, app-path-routes-manifest.json)
 * its routes are merged in as a second source, which also catches routes added
 * by plugins. basePath and pageExtensions are read from next.config.*, and a
 * middleware.ts (proxy.ts since Next 16) that looks auth-related marks the
 * routes its matcher covers as guarded — so does an app-router layout or page
 * that calls redirect() next to an auth/session lookup.
 */
const fs = require('fs');
const path = require('path');
const { readJson } = require('../routes/jsProject');
const { dedupe } = require('../routes/routeTree');

function deps(pkg) { return { ...(pkg && pkg.dependencies), ...(pkg && pkg.devDependencies) }; }

function detect(dir) {
  const d = deps(readJson(path.join(dir, 'package.json')));
  if (!d.next) return null;
  return { id: 'next', name: 'Next.js', root: dir, evidence: ['package.json: next'] };
}

function readNextConfig(root) {
  for (const f of ['next.config.js', 'next.config.mjs', 'next.config.ts', 'next.config.cjs']) {
    let src;
    try { src = fs.readFileSync(path.join(root, f), 'utf8'); } catch { continue; }
    const basePath = (src.match(/basePath\s*:\s*['"`]([^'"`]*)['"`]/) || [])[1] || '';
    const extMatch = src.match(/pageExtensions\s*:\s*\[([^\]]*)\]/);
    const pageExtensions = extMatch ? [...extMatch[1].matchAll(/['"`]([^'"`]+)['"`]/g)].map((m) => m[1]) : null;
    const i18n = /\bi18n\s*:/.test(src);
    return { basePath, pageExtensions, i18n, file: f };
  }
  return { basePath: '', pageExtensions: null, i18n: false, file: null };
}

/** One file-system segment → canonical segment, or null to drop it from the URL. */
function segment(s) {
  if (/^\(.+\)$/.test(s)) return null;                 // (group)
  let m;
  if ((m = s.match(/^\[\[\.\.\.(.+)\]\]$/))) return `:${m[1]}*?`;
  if ((m = s.match(/^\[\.\.\.(.+)\]$/))) return `:${m[1]}*`;
  if ((m = s.match(/^\[(.+)\]$/))) return `:${m[1]}`;
  return s;
}

function toPattern(segs) {
  const out = segs.map(segment).filter((s) => s !== null && s !== '');
  return '/' + out.join('/');
}

function walkPages(dir, exts, rel = [], out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    if (e.isDirectory()) {
      if (rel.length === 0 && e.name === 'api') continue;
      walkPages(path.join(dir, e.name), exts, [...rel, e.name], out);
      continue;
    }
    const ext = exts.find((x) => e.name.endsWith('.' + x));
    if (!ext) continue;
    const base = e.name.slice(0, -(ext.length + 1));
    if (/\.(test|spec|stories)$/.test(base)) continue;
    if (rel.length === 0 && /^(_app|_document|_error|_middleware|404|500)$/.test(base)) continue;
    const segs = base === 'index' ? rel : [...rel, base];
    out.push({ pattern: toPattern(segs), file: path.join(dir, e.name) });
  }
  return out;
}

// A server component that looks the session up and redirects when it is missing.
const AUTH_CALL = /\b(?:auth|getServerSession|getSession|currentUser|getUser|requireAuth|requireUser|withPageAuthRequired)\s*\(|auth\(\)\.protect|\.auth\.getUser\(/;
function guardsAuth(file) {
  let src;
  try { src = fs.readFileSync(file, 'utf8'); } catch { return false; }
  return AUTH_CALL.test(src) && /\b(?:redirect|notFound|unauthorized|forbidden)\s*\(|\.protect\(/.test(src);
}

function walkApp(dir, exts, rel = [], out = [], guarded = false) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  const layout = entries.find((e) => !e.isDirectory() && exts.some((x) => e.name === `layout.${x}`));
  const here = guarded || (!!layout && guardsAuth(path.join(dir, layout.name)));
  for (const e of entries) {
    if (e.isDirectory()) {
      const n = e.name;
      if (n.startsWith('_') || n.startsWith('.') || n.startsWith('@') || /^\(\.{1,3}\)/.test(n) || /^\(\.\.\)/.test(n)) continue;
      if (n === 'node_modules') continue;
      walkApp(path.join(dir, n), exts, [...rel, n], out, here);
      continue;
    }
    if (exts.some((x) => e.name === `page.${x}`)) {
      const file = path.join(dir, e.name);
      out.push({ pattern: toPattern(rel), file, guarded: here || guardsAuth(file) });
    }
  }
  return out;
}

/** Routes from a previous `next build`, if one is on disk. */
function fromBuild(root) {
  const out = [];
  const dot = path.join(root, '.next');
  const rm = readJson(path.join(dot, 'routes-manifest.json'));
  const pages = [...((rm && rm.staticRoutes) || []), ...((rm && rm.dynamicRoutes) || [])].map((r) => r.page);
  const app = readJson(path.join(dot, 'app-path-routes-manifest.json'));
  if (app) for (const [k, v] of Object.entries(app)) if (/\/page$/.test(k)) pages.push(v);
  for (const p of new Set(pages)) {
    if (/^\/(api|404|500)(\/|$)/.test(p)) continue;
    // Next internals (_not-found, _global-error, _error, _app, …) are not pages.
    if (p.split('/').some((seg) => seg.startsWith('_'))) continue;
    // Metadata routes and static files: /favicon.ico, /icon.png, /sitemap.xml,
    // /robots.txt, /manifest.webmanifest, /opengraph-image, …
    if (/\.[a-z0-9]{2,12}$/i.test(p) || /(^|\/)(icon|apple-icon|opengraph-image|twitter-image|sitemap|robots|manifest)(\d*)$/i.test(p)) continue;
    out.push(toPattern(p.split('/').filter(Boolean)));
  }
  return out;
}

/** middleware.ts / proxy.ts matcher → regexes, only if it looks auth-related. */
function guardMatchers(root) {
  const files = ['proxy', 'middleware'].flatMap((n) => ['ts', 'js', 'mjs'].flatMap((x) => [`${n}.${x}`, `src/${n}.${x}`]));
  for (const f of files) {
    let src;
    try { src = fs.readFileSync(path.join(root, f), 'utf8'); } catch { continue; }
    if (!/auth|session|token|clerk|getServerSession|withAuth|cookies\(\)/i.test(src)) return { file: f, matchers: [] };
    // Paths the guard lets through: `const PUBLIC_PATHS = ['/login', …]`,
    // publicRoutes / PUBLIC_ROUTES / publicPaths / unprotectedRoutes, ….
    const publicPaths = [];
    for (const pm of src.matchAll(/(?:public|unprotected|unauth\w*|open|allow\w*)\w*\s*(?::[^=]*)?=\s*(?:new\s+Set\(\s*)?\[([^\]]*)\]/gi)) {
      for (const sm of pm[1].matchAll(/['"`](\/[^'"`]*)['"`]/g)) publicPaths.push(sm[1].replace(/\/$/, '') || '/');
    }
    const m = src.match(/matcher\s*:\s*(\[[^\]]*\]|['"`][^'"`]+['"`])/);
    if (!m) return { file: f, matchers: [/.*/], all: true, publicPaths };
    const strs = [...m[1].matchAll(/['"`]([^'"`]+)['"`]/g)].map((x) => x[1]);
    // path-to-regexp syntax: `/dashboard/:path*`, or a raw group like `/((?!api|_next).*)`.
    const matchers = strs.map((s) => {
      const body = s.includes('(') ? s : s.replace(/[.+?^${}|[\]\\]/g, '\\$&');
      try { return new RegExp('^' + body.replace(/\/:\w+\*/g, '(?:/.*)?').replace(/:\w+\*/g, '.*').replace(/:\w+/g, '[^/]+') + '$'); } catch { return null; }
    }).filter(Boolean);
    return { file: f, matchers, publicPaths };
  }
  return { file: null, matchers: [], publicPaths: [] };
}

// A first segment like [locale] / [lang] is an i18n prefix (next-intl,
// next-i18n-router, hand-rolled). Every page sits under it, so without a value
// every route would be "dynamic, needs a sample" and nothing would be scanned.
const LOCALE_PARAM = /^(locale|lang|lng|language|languageCode|localeCode|countryLocale)$/i;

/** {value, from}: the locale to scan with, read from the project's i18n setup. */
function detectLocale(root) {
  const files = [
    'src/i18n/routing.ts', 'src/i18n/routing.js', 'i18n/routing.ts', 'i18n/routing.js',
    'src/i18n/config.ts', 'i18n/config.ts', 'src/i18n.ts', 'i18n.ts', 'src/i18n.js', 'i18n.js',
    'i18n-config.ts', 'src/i18n-config.ts', 'src/config/i18n.ts', 'src/lib/i18n.ts', 'lib/i18n.ts',
    'src/i18n/settings.ts', 'i18n/settings.ts', 'next-i18next.config.js', 'next-intl.config.ts',
    'src/middleware.ts', 'middleware.ts', 'src/proxy.ts', 'proxy.ts', 'next.config.js', 'next.config.mjs', 'next.config.ts',
  ];
  for (const f of files) {
    let src;
    try { src = fs.readFileSync(path.join(root, f), 'utf8'); } catch { continue; }
    const def = src.match(/default(?:Locale|Lang|Language|Lng)\s*[:=]\s*['"`]([A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,4})?)['"`]/);
    if (def) return { value: def[1], from: f };
    const list = src.match(/\b(?:locales|languages|supportedLocales|langs)\s*[:=]\s*(?:\[|new\s+Set\(\s*\[)\s*['"`]([A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,4})?)['"`]/);
    if (list) return { value: list[1], from: f };
  }
  // Translation folders: messages/en.json, locales/en/…, public/locales/en/…
  for (const d of ['messages', 'src/messages', 'locales', 'src/locales', 'public/locales', 'dictionaries', 'src/dictionaries', 'translations', 'src/translations']) {
    let names;
    try { names = fs.readdirSync(path.join(root, d)); } catch { continue; }
    const codes = names.map((n) => n.replace(/\.(json|ts|js|ya?ml)$/, '')).filter((n) => /^[a-z]{2,3}([-_][A-Za-z0-9]{2,4})?$/.test(n));
    if (codes.length) return { value: codes.includes('en') ? 'en' : codes[0], from: d + '/' };
  }
  return { value: 'en', from: null };
}

function discoverRoutes(target) {
  const root = target.root;
  const cfg = readNextConfig(root);
  const exts = cfg.pageExtensions || ['tsx', 'ts', 'jsx', 'js'];
  const found = [];
  const rel = (f) => path.relative(root, f);

  for (const base of ['pages', 'src/pages']) {
    for (const r of walkPages(path.join(root, base), exts)) {
      found.push({ pattern: r.pattern, sources: [`next (pages router) ${rel(r.file)}`] });
    }
  }
  for (const base of ['app', 'src/app']) {
    for (const r of walkApp(path.join(root, base), exts)) {
      found.push({ pattern: r.pattern, sources: [`next (app router) ${rel(r.file)}`], guarded: r.guarded });
    }
  }
  for (const pattern of fromBuild(root)) found.push({ pattern, sources: ['next (.next build manifest)'] });

  const guard = guardMatchers(root);
  let locale = null;
  const notes = [];
  if (cfg.i18n) notes.push('next.config i18n is set — each locale prefix (/en/…) serves the same page; scan one locale unless they differ');
  const routes = found.map((r) => {
    const full = (cfg.basePath + r.pattern).replace(/\/$/, '') || '/';
    // Matchers are written against real URLs; test a representative one.
    const sample = r.pattern.replace(/:[^/]+/g, 'x');
    const open = (guard.publicPaths || []).some((pp) => sample === pp || (pp !== '/' && sample.startsWith(pp + '/')));
    const guarded = !open && (!!r.guarded || guard.matchers.some((re) => re.test(sample)));
    const route = { pattern: full, guarded, hash: false, sources: r.sources, notes: [...notes] };
    // i18n prefix: give the locale parameter a value so these pages get scanned.
    const first = (r.pattern.split('/')[1] || '').match(/^:([^*?]+)\*?\??$/);
    if (first && LOCALE_PARAM.test(first[1])) {
      locale = locale || detectLocale(root);
      route.sample = { [first[1]]: locale.value };
      route.notes.push(`:${first[1]} filled with "${locale.value}"${locale.from ? ` (from ${locale.from})` : ' (default; change it in params if your app uses another locale)'}`);
    }
    return route;
  });
  return { routes: dedupe(routes), skipped: [] };
}

module.exports = {
  id: 'next', detect, discoverRoutes,
  codeExtensions: ['.tsx', '.jsx', '.ts', '.js', '.mdx'],
  _internal: { toPattern },
};
