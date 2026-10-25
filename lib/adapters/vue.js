/**
 * Vue adapter.
 *
 *   Vue Router (2–4)  route arrays: { path, component, children }, nested and
 *                     imported (`children: adminRoutes`, `...authRoutes`),
 *                     route-name constants folded like the React adapter does.
 *                     createWebHashHistory() / mode: 'hash' → /#/…;
 *                     createWebHistory('/base/') / base: '/base/' → prefix.
 *                     meta.requiresAuth / beforeEnter → guarded.
 *   Nuxt (2–4)        file routing under pages/ (app/pages/ in Nuxt 4):
 *                     [id] → :id, [[id]] → :id?, [...slug] → :slug*, (group) dropped;
 *                     definePageMeta({ middleware: 'auth' }) → guarded.
 */
const fs = require('fs');
const path = require('path');
const { createProject, walkFiles, isSourceFile, walk, unwrap, getProp, propName, lineOf, readJson } = require('../routes/jsProject');
const { flatten, dedupe } = require('../routes/routeTree');

function deps(pkg) { return { ...(pkg && pkg.dependencies), ...(pkg && pkg.devDependencies) }; }

function detect(dir) {
  const d = deps(readJson(path.join(dir, 'package.json')));
  if (d.nuxt || d['nuxt3'] || d['nuxt-edge']) return { id: 'nuxt', name: 'Nuxt', root: dir, evidence: ['package.json: nuxt'] };
  if (d.vue) return { id: 'vue', name: d['vue-router'] ? 'Vue (vue-router)' : 'Vue (no router found)', root: dir, evidence: ['package.json: vue' + (d['vue-router'] ? ', vue-router' : '')] };
  return null;
}

// ── Vue Router ───────────────────────────────────────────────────────────────
const ROUTE_KEYS = ['component', 'components', 'children', 'redirect', 'name', 'meta', 'beforeEnter', 'props', 'alias'];

function isRouteObject(o) {
  o = unwrap(o);
  if (!o || o.type !== 'ObjectExpression') return false;
  const keys = o.properties.map(propName);
  return keys.includes('path') && keys.some((k) => ROUTE_KEYS.includes(k));
}
function isRouteArray(a) { return a && a.type === 'ArrayExpression' && a.elements.some((e) => e && isRouteObject(e)); }

function truthyMeta(o, key) {
  const meta = unwrap(getProp(o, 'meta'));
  const v = meta && unwrap(getProp(meta, key));
  return !!v && !(v.type === 'BooleanLiteral' && v.value === false);
}

function discoverRouter(root) {
  const project = createProject(root);
  const files = walkFiles(root, (f) => isSourceFile(f)).filter((f) => {
    try { return /vue-router|\bpath\s*:/.test(fs.readFileSync(f, 'utf8')); } catch { return false; }
  });
  const consumed = new Set();
  const cache = new Map();
  let hash = false, base = '';
  const keyOf = (file, node) => `${file}:${node.start}`;

  function arrayRef(expr, file) {
    const hit = project.resolveArray(expr, file);
    if (!hit || !isRouteArray(hit.node)) return null;
    const key = keyOf(hit.file, hit.node);
    consumed.add(key);
    return { key, load: () => convertArray(hit.node, hit.file) };
  }

  function convertArray(arr, file) {
    const key = keyOf(file, arr);
    if (cache.has(key)) return cache.get(key);
    const out = [];
    cache.set(key, out);
    for (const el of arr.elements) {
      if (!el) continue;
      if (el.type === 'SpreadElement') {
        const r = arrayRef(el.argument, file);
        if (r) out.push({ path: null, renders: false, children: [], refs: [r], file, line: lineOf(el) });
        continue;
      }
      let obj = unwrap(el), objFile = file;
      if (obj.type === 'Identifier' || obj.type === 'MemberExpression') {
        const hit = project.resolveObject(obj, file);
        if (!hit) continue;
        obj = hit.node; objFile = hit.file;
      }
      if (isRouteObject(obj)) out.push(convertObject(obj, objFile));
    }
    return out;
  }

  function convertObject(o, file) {
    const pathNode = getProp(o, 'path');
    const p = pathNode ? project.evalString(pathNode, file) : null;
    // Vue Router 4 catch-all: '/:pathMatch(.*)*'; Vue Router 3: '*'
    const wildcard = p === '*' || /^\/?:[^/(]+\(\.\*\)\*?$/.test(p || '');
    const node = {
      path: p === '' ? null : p,
      index: p === '',
      unresolved: !!pathNode && p === null,
      renders: !!(getProp(o, 'component') || getProp(o, 'components')),
      redirect: !!getProp(o, 'redirect') && !getProp(o, 'component'),
      wildcard,
      guarded: truthyMeta(o, 'requiresAuth') || truthyMeta(o, 'auth') || truthyMeta(o, 'requiresLogin') || !!getProp(o, 'beforeEnter'),
      children: [], refs: [], file, line: lineOf(o),
    };
    const kids = unwrap(getProp(o, 'children'));
    if (kids && kids.type === 'ArrayExpression') node.children = convertArray(kids, file);
    else if (kids) { const r = arrayRef(kids, file); if (r) node.refs.push(r); }
    return node;
  }

  const topArrays = [];
  for (const file of files) {
    const mod = project.load(file);
    if (!mod) continue;
    walk(mod.ast.program, (n, parents) => {
      if (n.type === 'CallExpression' && n.callee.type === 'Identifier') {
        if (n.callee.name === 'createWebHashHistory') hash = true;
        if (/^createWeb(Hash)?History$/.test(n.callee.name) && n.arguments[0]) base = project.evalString(n.arguments[0], file) || base;
      }
      if (n.type === 'ObjectProperty' && propName(n) === 'mode' && project.evalString(n.value, file) === 'hash') hash = true;
      if (n.type === 'ObjectProperty' && propName(n) === 'base') {
        const v = project.evalString(n.value, file);
        if (v && v.startsWith('/')) base = v;
      }
      if (n.type === 'ArrayExpression' && isRouteArray(n)) {
        const parent = parents[parents.length - 1];
        const grand = parents[parents.length - 2];
        if (parent && parent.type === 'ObjectProperty' && propName(parent) === 'children' && grand && isRouteObject(grand)) return undefined;
        topArrays.push({ node: n, file });
        convertArray(n, file);
      }
      return undefined;
    });
  }
  const roots = [];
  for (const { node, file } of topArrays) if (!consumed.has(keyOf(file, node))) roots.push(...cache.get(keyOf(file, node)));
  const prefix = hash ? '' : (base || '').replace(/\/+$/, '');
  const { routes, skipped } = flatten(roots, { adapter: 'vue-router', rel: project.rel, prefix, hash });
  if (hash) for (const r of routes) r.notes.push('hash routing — scanned as /#/…');
  return { routes: dedupe(routes), skipped };
}

// ── Nuxt ─────────────────────────────────────────────────────────────────────
function nuxtSegment(s) {
  if (/^\(.+\)$/.test(s)) return null;
  let m;
  if ((m = s.match(/^\[\.\.\.(.+)\]$/))) return `:${m[1]}*`;
  if ((m = s.match(/^\[\[(.+)\]\]$/))) return `:${m[1]}?`;
  if ((m = s.match(/^\[(.+)\]$/))) return `:${m[1]}`;
  if ((m = s.match(/^_(.+)$/))) return `:${m[1]}`; // Nuxt 2: _id.vue
  return s;
}

/**
 * middleware/*.global.ts runs before every route. If it looks auth-related,
 * every page is guarded except the paths it lets through (`to.path === '/login'`).
 */
function nuxtGlobalGuard(root) {
  for (const d of ['app/middleware', 'middleware', 'src/middleware']) {
    let names;
    try { names = fs.readdirSync(path.join(root, d)); } catch { continue; }
    for (const n of names.filter((x) => /\.global\.[cm]?[jt]s$/.test(x))) {
      let src = '';
      try { src = fs.readFileSync(path.join(root, d, n), 'utf8'); } catch { continue; }
      if (!/auth|session|token|loggedIn|isAuthenticated|useUser|navigateTo\(\s*['"`]\/(?:login|signin|sign-in)/i.test(src)) continue;
      const open = [...src.matchAll(/\bto\.(?:path|fullPath|name)\s*(?:===?|!==?)\s*['"`]([^'"`]+)['"`]|['"`](\/[\w\-/]*)['"`]\s*(?:===?|!==?)\s*to\.path|\[([^\]]*)\]\s*\.includes\(\s*to\.(?:path|name)/g)]
        .flatMap((m) => (m[3] ? [...m[3].matchAll(/['"`]([^'"`]+)['"`]/g)].map((x) => x[1]) : [m[1] || m[2]]));
      return { file: path.join(d, n), open: open.map((x) => (x.startsWith('/') ? x : '/' + x)) };
    }
  }
  return null;
}

function discoverNuxt(root) {
  const routes = [];
  const pagesDir = ['app/pages', 'pages', 'src/pages'].map((d) => path.join(root, d)).find((d) => fs.existsSync(d));
  if (!pagesDir) return { routes, skipped: [] };
  const globalGuard = nuxtGlobalGuard(root);
  const files = walkFiles(pagesDir, (f) => /\.(vue|tsx|jsx)$/.test(f));
  for (const file of files) {
    const rel = path.relative(pagesDir, file).replace(/\.(vue|tsx|jsx)$/, '').split(path.sep);
    if (rel[rel.length - 1] === 'index') rel.pop();
    const segs = rel.map(nuxtSegment).filter((s) => s !== null);
    let src = '';
    try { src = fs.readFileSync(file, 'utf8'); } catch { /* unreadable */ }
    const pattern = '/' + segs.join('/');
    const optOut = /definePageMeta\s*\(\s*\{[^}]*\bauth\s*:\s*false/is.test(src);
    const guarded = /definePageMeta\s*\(\s*\{[^}]*middleware\s*:\s*[^}]*auth/is.test(src) || /middleware\s*:\s*['"`][^'"`]*auth/i.test(src)
      || (!!globalGuard && !optOut && !globalGuard.open.includes(pattern));
    const notes = globalGuard && guarded ? [`guarded by global middleware ${globalGuard.file}`] : [];
    routes.push({ pattern, guarded, hash: false, sources: [`nuxt ${path.relative(root, file)}`], notes });
  }
  return { routes: dedupe(routes), skipped: [] };
}

function discoverRoutes(target) {
  const res = target.id === 'nuxt' ? discoverNuxt(target.root) : discoverRouter(target.root);
  if (!res.routes.length) {
    res.routes = [{ pattern: '/', guarded: false, hash: false, sources: ['vue (no routes found — single-page app)'], notes: ['No route definitions found. If this app has more screens, add them to PAGES by hand or run `a11y discover --live`.'] }];
  }
  return res;
}

module.exports = {
  id: 'vue', ids: ['vue', 'nuxt'], detect, discoverRoutes,
  codeExtensions: ['.vue', '.ts', '.js'],
};
