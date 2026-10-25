/**
 * React adapter — reads client-side routes from source. Covers:
 *   - React Router v5/v6/v7 JSX:        <Route path="users" element={…}>
 *   - React Router object routes:       createBrowserRouter([...]), useRoutes([...]),
 *                                       and any exported `[{ path, element|component, … }]`
 *   - nested <Routes> mounted under a   <Route path="users/*" element={<Users/>}>
 *     `/*` parent in another file
 *   - React Router v7 framework mode:   app/routes.ts  (route/index/layout/prefix/flatRoutes)
 *   - Remix v2 flat-file routes:        app/routes/concerts.$city.tsx
 *   - TanStack Router file routes:      createFileRoute('/posts/$postId')
 *
 * Paths built from constants (`path: ROUTES.USERS`, `${BASE}/x`) are folded
 * through imports. Paths only known at runtime (`path={r.path}` inside a map)
 * are reported as skipped instead of guessed.
 */
const fs = require('fs');
const path = require('path');
const { createProject, walkFiles, isSourceFile, walk, unwrap, getProp, propName, dynamicImportOf, lineOf, readJson } = require('../routes/jsProject');
const { flatten, dedupe } = require('../routes/routeTree');

const ROUTER_DEPS = ['react-router-dom', 'react-router', '@remix-run/react', '@react-router/dev', '@tanstack/react-router'];
const ROUTE_KEYS = ['element', 'Component', 'component', 'lazy', 'children', 'loader', 'errorElement', 'render'];
const GUARD_RE = /private|protect|guard|secure|require.?auth|with.?auth|auth.?(route|layout|wrapper|guard|required|only|check)|authenticated|logged.?in|role.?(route|gate)|permission/i;
const REDIRECT_RE = /^(Navigate|Redirect)$/;

function deps(pkg) { return { ...(pkg && pkg.dependencies), ...(pkg && pkg.devDependencies) }; }

function detect(dir) {
  const pkg = readJson(path.join(dir, 'package.json'));
  const d = deps(pkg);
  if (!d.react || d.next) return null; // Next.js has its own adapter
  const router = ROUTER_DEPS.find((r) => d[r]);
  return {
    id: 'react', name: router ? `React (${router})` : 'React (no router found)', root: dir,
    evidence: [`package.json: react${router ? ', ' + router : ''}`],
  };
}

// ── JSX helpers ──────────────────────────────────────────────────────────────
function jsxName(el) {
  const n = el.openingElement ? el.openingElement.name : el.name;
  if (!n) return '';
  if (n.type === 'JSXIdentifier') return n.name;
  if (n.type === 'JSXMemberExpression') return n.property.name;
  return '';
}
function jsxAttr(el, name) {
  for (const a of el.openingElement.attributes) {
    if (a.type === 'JSXAttribute' && a.name.name === name) {
      if (a.value === null) return { type: 'BooleanLiteral', value: true };
      return a.value.type === 'JSXExpressionContainer' ? a.value.expression : a.value;
    }
  }
  return undefined;
}
function isRouteElement(el) {
  if (el.type !== 'JSXElement') return false;
  const name = jsxName(el);
  if (name === 'Route') return true;
  // <PrivateRoute path=…>, <ProtectedRoute path=…> wrappers
  return /Route$/.test(name) && name !== 'Routes' && (jsxAttr(el, 'path') !== undefined || jsxAttr(el, 'index') !== undefined);
}
/** Names of every JSX element inside an expression: <RequireAuth><Users/></RequireAuth> → [RequireAuth, Users] */
function jsxNamesIn(node) {
  const names = [];
  if (!node) return names;
  walk(node, (n) => { if (n.type === 'JSXElement') names.push(jsxName(n)); });
  return names;
}

function isTrue(n) { n = unwrap(n); return !!n && n.type === 'BooleanLiteral' && n.value === true; }

function isRouteObject(o) {
  o = unwrap(o);
  if (!o || o.type !== 'ObjectExpression') return false;
  const keys = o.properties.map(propName);
  return (keys.includes('path') || keys.includes('index')) && keys.some((k) => ROUTE_KEYS.includes(k));
}
function isRouteArray(a) {
  return a && a.type === 'ArrayExpression' && a.elements.some((e) => e && isRouteObject(e));
}

/** Pick out the plain React-Router routes of a project. */
function discoverRouter(project, root) {
  const files = walkFiles(root, isSourceFile).filter((f) => {
    try { return /react-router|@remix-run|\bpath\s*:|<Route\b/.test(fs.readFileSync(f, 'utf8')); } catch { return false; }
  });
  const consumed = new Set();       // keys of arrays / files reachable from a parent route
  const arrayCache = new Map();     // array key → RouteNode[]
  const jsxRootCache = new Map();   // file → RouteNode[]
  let hash = false;
  let basename = '';

  const keyOf = (file, node) => `${file}:${node.start}`;

  function componentFile(name, file) {
    if (!name) return null;
    const b = project.lookup(file, name);
    if (!b || !b.node) return null;
    const dyn = b.node.type === 'CallExpression' ? dynamicImportOf(b.node) : null;
    if (dyn) return project.resolveImport(b.file, dyn.spec);
    return b.file;
  }

  // `users/*` → look for nested <Routes> in the component it renders.
  function mountRefs(names, file) {
    const refs = [];
    for (const name of names) {
      const target = componentFile(name, file);
      if (!target || target === file) continue;
      const roots = jsxRoots(target);
      if (!roots.length) continue;
      const key = 'jsx:' + target;
      consumed.add(key);
      refs.push({ key, load: () => jsxRoots(target) });
    }
    return refs;
  }

  function arrayRef(expr, file) {
    const hit = project.resolveArray(expr, file);
    if (!hit || !isRouteArray(hit.node)) return null;
    const key = keyOf(hit.file, hit.node);
    consumed.add(key);
    return { key, load: () => convertArray(hit.node, hit.file) };
  }

  function convertArray(arr, file) {
    const key = keyOf(file, arr);
    if (arrayCache.has(key)) return arrayCache.get(key);
    const out = [];
    arrayCache.set(key, out); // set first: guards self-reference
    for (const el of arr.elements) {
      if (!el) continue;
      if (el.type === 'SpreadElement') {
        const ref = arrayRef(el.argument, file);
        if (ref) out.push({ path: null, renders: false, children: [], refs: [ref], file, line: lineOf(el) });
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
    const element = getProp(o, 'element');
    const comp = unwrap(getProp(o, 'Component') || getProp(o, 'component'));
    const names = [...jsxNamesIn(element), ...(comp && comp.type === 'Identifier' ? [comp.name] : [])];
    const loader = unwrap(getProp(o, 'loader'));
    const node = {
      path: p, unresolved: !!pathNode && p === null, index: isTrue(getProp(o, 'index')),
      renders: !!(element || comp || getProp(o, 'lazy')),
      redirect: names.length > 0 && REDIRECT_RE.test(names[0]),
      guarded: names.some((n) => GUARD_RE.test(n)) || (!!loader && loader.type === 'Identifier' && GUARD_RE.test(loader.name)),
      children: [], refs: [], file, line: lineOf(o),
    };
    const kids = unwrap(getProp(o, 'children'));
    if (kids && kids.type === 'ArrayExpression') node.children = convertArray(kids, file);
    else if (kids) { const r = arrayRef(kids, file); if (r) node.refs.push(r); }
    if (p && /(^|\/)\*$/.test(p)) node.refs.push(...mountRefs(names, file));
    node.wildcard = (p === '*' || p === '/*') && !node.refs.length && !node.children.length;
    return node;
  }

  function convertJsx(el, file) {
    const pathNode = jsxAttr(el, 'path');
    const p = pathNode !== undefined ? project.evalString(pathNode, file) : null;
    const element = jsxAttr(el, 'element');
    const render = jsxAttr(el, 'render');
    const comp = unwrap(jsxAttr(el, 'Component') || jsxAttr(el, 'component'));
    const names = [...jsxNamesIn(element), ...jsxNamesIn(render), ...(comp && comp.type === 'Identifier' ? [comp.name] : [])];
    const ownName = jsxName(el);
    const node = {
      path: p, unresolved: pathNode !== undefined && p === null, index: jsxAttr(el, 'index') !== undefined && isTrue(jsxAttr(el, 'index')),
      // v5 <Route path> with children-as-content also renders
      renders: !!(element || render || comp) || (ownName !== 'Route') || el.children.some((c) => c.type === 'JSXElement' && !isRouteElement(c)),
      redirect: names.length > 0 && REDIRECT_RE.test(names[0]),
      guarded: GUARD_RE.test(ownName) || names.some((n) => GUARD_RE.test(n)),
      children: [], refs: [], file, line: lineOf(el),
    };
    // Child <Route>s anywhere under this element, not crossing another <Route>.
    for (const c of el.children) collectJsxRoutes(c, file, node.children);
    if (p && /(^|\/)\*$/.test(p)) node.refs.push(...mountRefs(names, file));
    node.wildcard = (p === '*' || p === '/*') && !node.refs.length && !node.children.length;
    return node;
  }

  function collectJsxRoutes(n, file, out) {
    walk(n, (x) => {
      if (isRouteElement(x)) { out.push(convertJsx(x, file)); return false; }
      return undefined;
    });
  }

  function jsxRoots(file) {
    if (jsxRootCache.has(file)) return jsxRootCache.get(file);
    const out = [];
    jsxRootCache.set(file, out);
    const mod = project.load(file);
    if (mod) collectJsxRoutes(mod.ast.program, file, out);
    return out;
  }

  // Pass 1 — convert every definition so cross-file references get marked.
  const topArrays = [];
  for (const file of files) {
    const mod = project.load(file);
    if (!mod) continue;
    jsxRoots(file);
    walk(mod.ast.program, (n, parents) => {
      if (n.type === 'JSXOpeningElement' && ['HashRouter'].includes(n.name.name)) hash = true;
      if (n.type === 'JSXOpeningElement' && /Router$/.test(n.name.name || '')) {
        const b = n.attributes.find((a) => a.type === 'JSXAttribute' && a.name.name === 'basename');
        if (b && b.value) basename = project.evalString(b.value.type === 'JSXExpressionContainer' ? b.value.expression : b.value, file) || basename;
      }
      if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && /^create(Browser|Hash|Memory)Router$/.test(n.callee.name)) {
        if (n.callee.name === 'createHashRouter') hash = true;
        const opts = n.arguments[1] && getProp(n.arguments[1], 'basename');
        if (opts) basename = project.evalString(opts, file) || basename;
      }
      if (n.type === 'ArrayExpression' && isRouteArray(n)) {
        // Arrays that are the inline `children` of a route object belong to it.
        const parent = parents[parents.length - 1];
        const grand = parents[parents.length - 2];
        if (parent && parent.type === 'ObjectProperty' && propName(parent) === 'children' && grand && isRouteObject(grand)) return undefined;
        topArrays.push({ node: n, file });
        convertArray(n, file);
      }
      return undefined;
    });
  }

  // Pass 2 — roots are the definitions nothing else points at.
  const roots = [];
  for (const { node, file } of topArrays) if (!consumed.has(keyOf(file, node))) roots.push(...arrayCache.get(keyOf(file, node)));
  for (const file of files) if (!consumed.has('jsx:' + file)) roots.push(...jsxRoots(file));

  const { routes, skipped } = flatten(roots, { adapter: 'react-router', rel: project.rel, prefix: basename, hash });
  if (hash) for (const r of routes) r.notes.push('hash routing — scanned as /#/…');
  return { routes, skipped, hash, basename };
}

// ── React Router v7 framework mode / Remix ──────────────────────────────────
function hasDefaultExport(file) {
  try { return /export\s+default\b|export\s*\{[^}]*\bas\s+default\b/.test(fs.readFileSync(file, 'utf8')); } catch { return false; }
}

/** Remix / React Router flat-file name → RouteNode-ish path ('' = index). */
function flatNameToPath(name) {
  const segs = [];
  let cur = '', inEsc = false;
  for (const ch of name) {
    if (ch === '[') { inEsc = true; continue; }
    if (ch === ']') { inEsc = false; continue; }
    if (ch === '.' && !inEsc) { segs.push(cur); cur = ''; continue; }
    cur += inEsc ? ch.replace(/[$_().]/g, (c) => `\u0000${c}`) : ch;
  }
  segs.push(cur);
  const out = [];
  let index = false;
  for (const raw of segs) {
    if (raw === '_index') { index = true; continue; }
    if (raw.startsWith('_')) continue; // pathless layout
    const s = raw.endsWith('_') ? raw.slice(0, -1) : raw;
    let seg;
    if (s === '$') seg = ':rest*';
    else if (/^\(\$(.+)\)$/.test(s)) seg = ':' + s.slice(2, -1) + '?';
    else if (/^\(.+\)$/.test(s)) continue; // optional static segment — scanned without it
    else if (s.startsWith('$')) seg = ':' + s.slice(1);
    else seg = s;
    out.push(seg.replace(/\u0000/g, ''));
  }
  return { path: out.join('/'), index, pathless: !out.length && !index };
}

function flatRoutesNodes(routesDir, project) {
  const nodes = [];
  let entries = [];
  try { entries = fs.readdirSync(routesDir, { withFileTypes: true }); } catch { return nodes; }
  for (const e of entries) {
    let name, file;
    if (e.isDirectory()) {
      file = ['route', 'index'].flatMap((b) => ['.tsx', '.ts', '.jsx', '.js'].map((x) => path.join(routesDir, e.name, b + x))).find((f) => fs.existsSync(f));
      if (!file) continue;
      name = e.name;
    } else {
      if (!/\.(tsx|ts|jsx|js|mdx|md)$/.test(e.name) || /\.(test|spec)\./.test(e.name)) continue;
      name = e.name.replace(/\.(tsx|ts|jsx|js|mdx|md)$/, '');
      file = path.join(routesDir, e.name);
    }
    const r = flatNameToPath(name);
    if (r.pathless) continue;
    const resource = !hasDefaultExport(file);
    nodes.push({
      path: r.path || '', index: r.index && !r.path, renders: !resource, children: [], refs: [], file, line: 1,
      redirect: false, wildcard: false, guarded: false,
    });
  }
  return nodes;
}

function discoverFramework(project, root) {
  let appDir = path.join(root, 'app');
  for (const cfg of ['react-router.config.ts', 'react-router.config.js', 'remix.config.js', 'vite.config.ts', 'vite.config.js']) {
    try {
      const m = fs.readFileSync(path.join(root, cfg), 'utf8').match(/appDirectory\s*:\s*['"`]([^'"`]+)/);
      if (m) { appDir = path.resolve(root, m[1]); break; }
    } catch { /* not there */ }
  }
  const routesFile = ['routes.ts', 'routes.js', 'routes.tsx'].map((f) => path.join(appDir, f)).find((f) => fs.existsSync(f));
  const routesDir = path.join(appDir, 'routes');
  let roots = [];
  if (routesFile) {
    const exp = project.lookupExport(routesFile, 'default');
    const arr = exp && project.resolveArray(exp.node, exp.file);
    if (arr) roots = convertConfig(arr.node, routesFile, appDir, project);
  } else if (fs.existsSync(routesDir)) {
    roots = flatRoutesNodes(routesDir, project); // Remix v2 convention
  } else {
    return null;
  }
  return flatten(roots, { adapter: routesFile ? 'react-router (routes.ts)' : 'remix (flat routes)', rel: project.rel });
}

function convertConfig(arr, file, appDir, project) {
  const out = [];
  for (const el0 of arr.elements) {
    if (!el0) continue;
    let el = unwrap(el0.type === 'SpreadElement' ? el0.argument : el0);
    if (el.type === 'AwaitExpression') el = unwrap(el.argument);
    if (el.type !== 'CallExpression' || el.callee.type !== 'Identifier') continue;
    const fn = el.callee.name;
    const args = el.arguments;
    const last = unwrap(args[args.length - 1]);
    const kids = last && last.type === 'ArrayExpression' ? convertConfig(last, file, appDir, project) : [];
    const str = (n) => (n ? project.evalString(n, file) : null);
    const base = { children: kids, refs: [], file, line: lineOf(el), redirect: false, wildcard: false, guarded: false };
    if (fn === 'route') out.push({ ...base, path: str(args[0]), unresolved: str(args[0]) === null, renders: true });
    else if (fn === 'index') out.push({ ...base, path: null, index: true, renders: true });
    else if (fn === 'layout') out.push({ ...base, path: null, renders: false });
    else if (fn === 'prefix') out.push({ ...base, path: str(args[0]), unresolved: str(args[0]) === null, renders: false });
    else if (fn === 'flatRoutes') {
      const opt = args[0] && getProp(args[0], 'rootDirectory');
      const dir = path.resolve(appDir, (opt && str(opt)) || 'routes');
      out.push(...flatRoutesNodes(dir, project));
    }
  }
  return out;
}

// ── TanStack Router ─────────────────────────────────────────────────────────
function discoverTanStack(project, root) {
  const files = walkFiles(root, isSourceFile).filter((f) => {
    try { return /createFileRoute\s*\(/.test(fs.readFileSync(f, 'utf8')); } catch { return false; }
  });
  const routes = [];
  for (const file of files) {
    const mod = project.load(file);
    if (!mod) continue;
    walk(mod.ast.program, (n) => {
      if (n.type !== 'CallExpression' || n.callee.type !== 'Identifier' || n.callee.name !== 'createFileRoute') return;
      const raw = n.arguments[0] ? project.evalString(n.arguments[0], file) : null;
      if (raw === null || /^\/?__root/.test(raw)) return;
      const segs = raw.split('/').filter(Boolean)
        .filter((s) => !s.startsWith('_') && !/^\(.+\)$/.test(s))
        .map((s) => (s === '$' ? ':rest*' : s.startsWith('$') ? ':' + s.slice(1) : s.replace(/_$/, '')));
      routes.push({ pattern: '/' + segs.join('/'), guarded: /_auth|_authenticated|_protected/i.test(raw), hash: false, sources: [`tanstack-router ${project.rel(file)}:${lineOf(n)}`], notes: [] });
    });
  }
  return { routes, skipped: [] };
}

function discoverRoutes(target) {
  const root = target.root;
  const project = createProject(root);
  const d = deps(readJson(path.join(root, 'package.json')));
  const results = [];
  if (d['@react-router/dev'] || d['@remix-run/dev']) {
    const fw = discoverFramework(project, root);
    if (fw) results.push(fw);
  }
  if (d['@tanstack/react-router']) results.push(discoverTanStack(project, root));
  if (!results.some((r) => r.routes.length)) results.push(discoverRouter(project, root));

  let routes = dedupe(results.flatMap((r) => r.routes));
  const skipped = results.flatMap((r) => r.skipped || []);
  if (!routes.length) {
    routes = [{ pattern: '/', guarded: false, hash: false, sources: ['react (no routes found — single-page app)'], notes: ['No route definitions found. If this app has more screens, add them to PAGES by hand.'] }];
  }
  return { routes, skipped };
}

module.exports = {
  id: 'react', detect, discoverRoutes,
  codeExtensions: ['.tsx', '.jsx', '.ts', '.js'],
  _internal: { flatNameToPath },
};
