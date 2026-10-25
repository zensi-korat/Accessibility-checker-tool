/**
 * Angular (2+) adapter — reads `Routes` arrays from TypeScript source:
 *
 *   standalone:  provideRouter(routes), loadComponent, loadChildren: () =>
 *                import('./admin/admin.routes').then(m => m.ADMIN_ROUTES)
 *   NgModule:    RouterModule.forRoot / forChild, loadChildren to a module
 *                (followed into its RouterModule.forChild, or its *RoutingModule)
 *   legacy:      loadChildren: './admin/admin.module#AdminModule'
 *
 * Child paths are joined onto their parent's, including across lazy-loaded
 * files. redirectTo and '**' entries are not pages and are skipped; routes
 * with canActivate / canMatch / canLoad (or under a parent that has them) are
 * marked guarded. useHash / withHashLocation() switches URLs to /#/….
 *
 * AngularJS (1.x, $routeProvider / ui-router) is a different framework and is
 * not covered here.
 */
const fs = require('fs');
const path = require('path');
const { createProject, walkFiles, isSourceFile, walk, unwrap, getProp, propName, dynamicImportOf, lineOf, readJson, readJsonc } = require('../routes/jsProject');
const { flatten, dedupe } = require('../routes/routeTree');

const ROUTE_KEYS = ['component', 'loadComponent', 'loadChildren', 'children', 'redirectTo', 'canActivate', 'canMatch', 'pathMatch', 'resolve', 'title', 'data', 'outlet'];
const GUARD_KEYS = ['canActivate', 'canMatch', 'canLoad', 'canActivateChild'];

function deps(pkg) { return { ...(pkg && pkg.dependencies), ...(pkg && pkg.devDependencies) }; }

function detect(dir) {
  const hasJson = fs.existsSync(path.join(dir, 'angular.json'));
  const d = deps(readJson(path.join(dir, 'package.json')));
  if (!hasJson && !d['@angular/core']) return null;
  return {
    id: 'angular', name: 'Angular', root: dir,
    evidence: [hasJson ? 'angular.json' : null, d['@angular/core'] ? 'package.json: @angular/core' : null].filter(Boolean),
  };
}

/** Application source roots + base href from angular.json (falls back to src/). */
function appProjects(root) {
  const ng = readJsonc(path.join(root, 'angular.json'));
  const out = [];
  for (const [name, p] of Object.entries((ng && ng.projects) || {})) {
    if (p.projectType && p.projectType !== 'application') continue;
    const src = path.resolve(root, p.sourceRoot || path.join(p.root || '', 'src'));
    const opts = (p.architect || p.targets || {}).build;
    let baseHref = (opts && opts.options && opts.options.baseHref) || '';
    if (!baseHref) {
      try {
        const html = fs.readFileSync(path.join(src, 'index.html'), 'utf8');
        baseHref = (html.match(/<base\s+href=["']([^"']*)["']/i) || [])[1] || '';
      } catch { /* none */ }
    }
    out.push({ name, src, baseHref: baseHref === '/' ? '' : baseHref.replace(/\/$/, '') });
  }
  if (!out.length) out.push({ name: path.basename(root), src: fs.existsSync(path.join(root, 'src')) ? path.join(root, 'src') : root, baseHref: '' });
  return out;
}

function isRouteObject(o) {
  o = unwrap(o);
  if (!o || o.type !== 'ObjectExpression') return false;
  const keys = o.properties.map(propName);
  return (keys.includes('path') || keys.includes('matcher')) && keys.some((k) => ROUTE_KEYS.includes(k));
}
function isRouteArray(a) { return a && a.type === 'ArrayExpression' && a.elements.some((e) => e && isRouteObject(e)); }

function discoverApp(app, root) {
  const project = createProject(root);
  const files = walkFiles(app.src, isSourceFile).filter((f) => {
    try { return /Routes|RouterModule|provideRouter|loadChildren|\bpath\s*:/.test(fs.readFileSync(f, 'utf8')); } catch { return false; }
  });
  const consumed = new Set();
  const cache = new Map();
  let hash = false;
  const keyOf = (file, node) => `${file}:${node.start}`;

  function arrayRef(expr, file) {
    const hit = project.resolveArray(expr, file);
    if (!hit || !isRouteArray(hit.node)) return null;
    return refFor(hit.node, hit.file);
  }
  function refFor(arr, file) {
    const key = keyOf(file, arr);
    consumed.add(key);
    return { key, load: () => convertArray(arr, file) };
  }

  /** Route arrays a (lazy) NgModule registers: RouterModule.forChild(x), or via its routing module. */
  function moduleRoutes(file, depth = 0) {
    const mod = project.load(file);
    if (!mod || depth > 2) return [];
    const refs = [];
    walk(mod.ast.program, (n) => {
      if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && !n.callee.computed
        && /^for(Child|Root)$/.test(n.callee.property.name) && n.arguments[0]) {
        const r = arrayRef(n.arguments[0], file);
        if (r) refs.push(r);
      }
    });
    if (refs.length) return refs;
    for (const [local, imp] of mod.imports) {
      if (!/Routing/i.test(local)) continue;
      const target = project.resolveImport(file, imp.from);
      if (target && target !== file) refs.push(...moduleRoutes(target, depth + 1));
    }
    return refs;
  }

  function lazyRefs(node, file) {
    node = unwrap(node);
    if (!node) return [];
    let targetFile = null, member = null;
    if (node.type === 'StringLiteral') {
      // Pre-v8 syntax: 'app/admin/admin.module#AdminModule' (relative to file, or to the source root)
      const [spec, m] = node.value.split('#');
      member = m || null;
      targetFile = project.resolveImport(file, spec.startsWith('.') ? spec : './' + spec)
        || project.resolveImport(path.join(app.src, 'x'), './' + spec)
        || project.resolveImport(path.join(root, 'x'), './' + spec);
    } else {
      const dyn = dynamicImportOf(node);
      if (!dyn) return [];
      targetFile = project.resolveImport(file, dyn.spec);
      member = dyn.member;
    }
    if (!targetFile) return [];
    const exp = project.lookupExport(targetFile, member || 'default');
    if (exp && exp.node) {
      const n = unwrap(exp.node);
      if (n.type === 'ClassDeclaration' || n.type === 'ClassExpression') return moduleRoutes(exp.file);
      const arr = project.resolveArray(n, exp.file);
      if (arr && isRouteArray(arr.node)) return [refFor(arr.node, arr.file)];
    }
    return moduleRoutes(targetFile);
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
    const node = {
      path: p === null ? null : p,
      unresolved: (!!pathNode && p === null) || !!getProp(o, 'matcher'),
      index: false,
      renders: !!(getProp(o, 'component') || getProp(o, 'loadComponent')),
      redirect: !!getProp(o, 'redirectTo'),
      wildcard: p === '**',
      guarded: GUARD_KEYS.some((k) => {
        const v = unwrap(getProp(o, k));
        return v && !(v.type === 'ArrayExpression' && v.elements.length === 0);
      }),
      children: [], refs: [], file, line: lineOf(o),
    };
    // Angular paths are always relative; '' renders at the parent's URL.
    if (node.path === '') node.index = true;
    if (getProp(o, 'outlet')) { node.renders = false; return node; } // secondary outlet, not a URL of its own
    const kids = unwrap(getProp(o, 'children'));
    if (kids && kids.type === 'ArrayExpression') node.children = convertArray(kids, file);
    else if (kids) { const r = arrayRef(kids, file); if (r) node.refs.push(r); }
    const lc = getProp(o, 'loadChildren');
    if (lc) node.refs.push(...lazyRefs(lc, file));
    return node;
  }

  const topArrays = [];
  for (const file of files) {
    const mod = project.load(file);
    if (!mod) continue;
    walk(mod.ast.program, (n, parents) => {
      if (n.type === 'ObjectProperty' && propName(n) === 'useHash' && unwrap(n.value).value === true) hash = true;
      if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === 'withHashLocation') hash = true;
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
  // Second sweep: references created while converting later files may consume earlier arrays.
  const roots = [];
  for (const { node, file } of topArrays) if (!consumed.has(keyOf(file, node))) roots.push(...cache.get(keyOf(file, node)));

  // With hash routing the base href sits before the '#', i.e. it belongs in BASE_URL.
  const { routes, skipped } = flatten(roots, { adapter: 'angular', rel: project.rel, prefix: hash ? '' : app.baseHref, hash });
  if (hash) for (const r of routes) r.notes.push('hash routing — scanned as /#/…');
  return { routes, skipped };
}

function discoverRoutes(target) {
  const apps = appProjects(target.root);
  const results = apps.map((a) => discoverApp(a, target.root));
  return { routes: dedupe(results.flatMap((r) => r.routes)), skipped: results.flatMap((r) => r.skipped) };
}

module.exports = {
  id: 'angular', detect, discoverRoutes,
  codeExtensions: ['.html', '.ts'],
};
