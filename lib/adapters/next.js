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
 * middleware.ts that looks auth-related marks the routes its matcher covers
 * as guarded.
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

function walkApp(dir, exts, rel = [], out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.isDirectory()) {
      const n = e.name;
      if (n.startsWith('_') || n.startsWith('.') || n.startsWith('@') || /^\(\.{1,3}\)/.test(n) || /^\(\.\.\)/.test(n)) continue;
      if (n === 'node_modules') continue;
      walkApp(path.join(dir, n), exts, [...rel, n], out);
      continue;
    }
    if (exts.some((x) => e.name === `page.${x}`)) out.push({ pattern: toPattern(rel), file: path.join(dir, e.name) });
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
    if (/^\/(api|_next|_app|_error|_document|_not-found|404|500)(\/|$)/.test(p)) continue;
    out.push(toPattern(p.split('/').filter(Boolean)));
  }
  return out;
}

/** middleware.ts matcher → regexes, only if the middleware looks auth-related. */
function guardMatchers(root) {
  for (const f of ['middleware.ts', 'middleware.js', 'src/middleware.ts', 'src/middleware.js']) {
    let src;
    try { src = fs.readFileSync(path.join(root, f), 'utf8'); } catch { continue; }
    if (!/auth|session|token|clerk|getServerSession|withAuth|cookies\(\)/i.test(src)) return { file: f, matchers: [] };
    const m = src.match(/matcher\s*:\s*(\[[^\]]*\]|['"`][^'"`]+['"`])/);
    if (!m) return { file: f, matchers: [/.*/], all: true };
    const strs = [...m[1].matchAll(/['"`]([^'"`]+)['"`]/g)].map((x) => x[1]);
    // path-to-regexp syntax: `/dashboard/:path*`, or a raw group like `/((?!api|_next).*)`.
    const matchers = strs.map((s) => {
      const body = s.includes('(') ? s : s.replace(/[.+?^${}|[\]\\]/g, '\\$&');
      try { return new RegExp('^' + body.replace(/\/:\w+\*/g, '(?:/.*)?').replace(/:\w+\*/g, '.*').replace(/:\w+/g, '[^/]+') + '$'); } catch { return null; }
    }).filter(Boolean);
    return { file: f, matchers };
  }
  return { file: null, matchers: [] };
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
      found.push({ pattern: r.pattern, sources: [`next (app router) ${rel(r.file)}`] });
    }
  }
  for (const pattern of fromBuild(root)) found.push({ pattern, sources: ['next (.next build manifest)'] });

  const guard = guardMatchers(root);
  const notes = [];
  if (cfg.i18n) notes.push('next.config i18n is set — each locale prefix (/en/…) serves the same page; scan one locale unless they differ');
  const routes = found.map((r) => {
    const full = (cfg.basePath + r.pattern).replace(/\/$/, '') || '/';
    // Matchers are written against real URLs; test a representative one.
    const sample = r.pattern.replace(/:[^/]+/g, 'x');
    const guarded = guard.matchers.some((re) => re.test(sample));
    return { pattern: full, guarded, hash: false, sources: r.sources, notes: [...notes] };
  });
  return { routes: dedupe(routes), skipped: [] };
}

module.exports = {
  id: 'next', detect, discoverRoutes,
  codeExtensions: ['.tsx', '.jsx', '.ts', '.js', '.mdx'],
  _internal: { toPattern },
};
