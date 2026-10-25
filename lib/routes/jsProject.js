/**
 * Just enough of a JS/TS "project model" to read route definitions statically:
 * parse files, follow imports (relative + tsconfig `paths` aliases), look up
 * top-level bindings, and fold constant strings like `ROUTES.USERS` or
 * `${BASE}/users` into their values.
 *
 * This is NOT a type checker and never executes project code. Anything it
 * cannot resolve comes back as null, and the adapters turn that into a note
 * on the route instead of guessing.
 */
const fs = require('fs');
const path = require('path');
const { parse } = require('@babel/parser');

const EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', '.angular',
  'coverage', '.turbo', '.cache', 'bin', 'obj', 'storybook-static', '.svelte-kit', '.output', 'vendor']);
const TEST_FILE = /\.(test|spec|stories|e2e|cy)\.[cm]?[jt]sx?$/i;

function walkFiles(root, filter, out = []) {
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.') continue;
    const full = path.join(root, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name === '__tests__' || e.name === '__mocks__') continue;
      walkFiles(full, filter, out);
    } else if (filter(full)) out.push(full);
  }
  return out;
}

function isSourceFile(f) { return EXTS.includes(path.extname(f)) && !TEST_FILE.test(f) && !f.endsWith('.d.ts'); }

/** tsconfig/jsconfig is JSONC — strip comments and trailing commas, outside strings. */
function readJsonc(file) {
  try {
    const src = fs.readFileSync(file, 'utf8');
    let out = '', inStr = false, q = '';
    for (let i = 0; i < src.length; i++) {
      const c = src[i], n = src[i + 1];
      if (inStr) { out += c; if (c === '\\') { out += n; i++; } else if (c === q) inStr = false; continue; }
      if (c === '"' || c === "'") { inStr = true; q = c; out += c; continue; }
      if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; out += '\n'; continue; }
      if (c === '/' && n === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i++; continue; }
      out += c;
    }
    return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
  } catch { return null; }
}

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }

/** Path aliases from tsconfig.json / jsconfig.json (following one level of "extends"). */
function loadAliases(root) {
  const aliases = [];
  for (const name of ['tsconfig.json', 'tsconfig.app.json', 'jsconfig.json']) {
    const file = path.join(root, name);
    let cfg = readJsonc(file);
    if (!cfg) continue;
    let opts = cfg.compilerOptions || {};
    if (cfg.extends && typeof cfg.extends === 'string' && cfg.extends.startsWith('.')) {
      const base = readJsonc(path.resolve(root, cfg.extends.endsWith('.json') ? cfg.extends : cfg.extends + '.json'));
      if (base && base.compilerOptions) opts = { ...base.compilerOptions, ...opts, paths: { ...(base.compilerOptions.paths || {}), ...(opts.paths || {}) } };
    }
    const baseUrl = path.resolve(root, opts.baseUrl || '.');
    for (const [key, targets] of Object.entries(opts.paths || {})) {
      aliases.push({ prefix: key.replace(/\*$/, ''), wildcard: key.endsWith('*'), targets: targets.map((t) => path.resolve(baseUrl, t.replace(/\*$/, ''))) });
    }
    if (opts.baseUrl) aliases.push({ prefix: '', wildcard: true, targets: [baseUrl], bare: true });
  }
  return aliases;
}

const PARSE_PLUGINS_TS = ['typescript', 'decorators-legacy', 'classProperties', 'dynamicImport', 'importAttributes'];
const PARSE_PLUGINS_JS = ['jsx', 'decorators-legacy', 'classProperties', 'dynamicImport', 'importAttributes'];

function parseFile(file, code) {
  const ext = path.extname(file);
  const plugins = ext === '.ts' ? PARSE_PLUGINS_TS
    : ext === '.tsx' ? [...PARSE_PLUGINS_TS, 'jsx']
      : PARSE_PLUGINS_JS;
  return parse(code, { sourceType: 'unambiguous', errorRecovery: true, plugins, allowReturnOutsideFunction: true });
}

/** Strip TS-only wrappers: `x as Routes`, `x satisfies Routes`, `<Routes>x`, `x!`, parens. */
function unwrap(node) {
  while (node && ['TSAsExpression', 'TSSatisfiesExpression', 'TSTypeAssertion', 'TSNonNullExpression', 'ParenthesizedExpression'].includes(node.type)) {
    node = node.expression;
  }
  return node;
}

/** Depth-first walk; `visit(node, parents)` returns false to skip a subtree. */
function walk(node, visit, parents = []) {
  if (!node || typeof node.type !== 'string') return;
  if (visit(node, parents) === false) return;
  parents.push(node);
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'leadingComments' || key === 'trailingComments' || key === 'extra') continue;
    const v = node[key];
    if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === 'string') walk(c, visit, parents); }
    else if (v && typeof v.type === 'string') walk(v, visit, parents);
  }
  parents.pop();
}

function propName(p) {
  if (!p || (p.type !== 'ObjectProperty' && p.type !== 'ObjectMethod')) return null;
  if (p.computed) return null;
  return p.key.type === 'Identifier' ? p.key.name : p.key.type === 'StringLiteral' ? p.key.value : null;
}

function getProp(obj, name) {
  obj = unwrap(obj);
  if (!obj || obj.type !== 'ObjectExpression') return null;
  for (const p of obj.properties) if (propName(p) === name) return p.type === 'ObjectMethod' ? p : p.value;
  return null;
}

function createProject(root) {
  root = path.resolve(root);
  const aliases = loadAliases(root);
  const cache = new Map();

  function load(file) {
    if (cache.has(file)) return cache.get(file);
    let mod = null;
    try {
      const code = fs.readFileSync(file, 'utf8');
      const ast = parseFile(file, code);
      mod = { file, code, ast, bindings: new Map(), imports: new Map(), exports: new Map(), reexportAll: [] };
      indexModule(mod);
    } catch { mod = null; }
    cache.set(file, mod);
    return mod;
  }

  function indexModule(mod) {
    for (let stmt of mod.ast.program.body) {
      let exported = false;
      if (stmt.type === 'ExportNamedDeclaration') {
        if (stmt.source) {
          for (const s of stmt.specifiers) {
            mod.exports.set(s.exported.name || s.exported.value, { from: stmt.source.value, imported: s.local ? (s.local.name || s.local.value) : 'default' });
          }
          continue;
        }
        for (const s of stmt.specifiers || []) mod.exports.set(s.exported.name || s.exported.value, { local: s.local.name });
        if (!stmt.declaration) continue;
        stmt = stmt.declaration;
        exported = true;
      } else if (stmt.type === 'ExportAllDeclaration') {
        mod.reexportAll.push(stmt.source.value);
        continue;
      } else if (stmt.type === 'ExportDefaultDeclaration') {
        const d = stmt.declaration;
        if (d.type === 'Identifier') mod.exports.set('default', { local: d.name });
        else {
          mod.exports.set('default', { node: d });
          if (d.id && d.id.name) mod.bindings.set(d.id.name, d);
        }
        continue;
      } else if (stmt.type === 'ImportDeclaration') {
        for (const s of stmt.specifiers) {
          const imported = s.type === 'ImportDefaultSpecifier' ? 'default'
            : s.type === 'ImportNamespaceSpecifier' ? '*' : (s.imported.name || s.imported.value);
          mod.imports.set(s.local.name, { from: stmt.source.value, imported });
        }
        continue;
      }
      if (stmt.type === 'VariableDeclaration') {
        for (const d of stmt.declarations) {
          if (d.id.type === 'Identifier') {
            mod.bindings.set(d.id.name, d.init);
            if (exported) mod.exports.set(d.id.name, { local: d.id.name });
          }
        }
      } else if ((stmt.type === 'FunctionDeclaration' || stmt.type === 'ClassDeclaration' || stmt.type === 'TSEnumDeclaration') && stmt.id) {
        mod.bindings.set(stmt.id.name, stmt);
        if (exported) mod.exports.set(stmt.id.name, { local: stmt.id.name });
      }
    }
  }

  function resolveFile(base) {
    const tries = [base, ...EXTS.map((e) => base + e), ...EXTS.map((e) => path.join(base, 'index' + e))];
    for (const t of tries) {
      try { if (fs.statSync(t).isFile()) return t; } catch { /* next */ }
    }
    // `import './x.js'` that is really x.ts (TS ESM style)
    const m = base.match(/\.[cm]?js$/);
    if (m) return resolveFile(base.slice(0, -m[0].length));
    return null;
  }

  function resolveImport(fromFile, spec) {
    if (!spec || typeof spec !== 'string') return null;
    if (spec.startsWith('.')) return resolveFile(path.resolve(path.dirname(fromFile), spec));
    // `paths` aliases first, then bare baseUrl imports; a package name simply
    // fails to resolve to a file and falls through to null.
    for (const a of aliases) {
      if (a.wildcard ? spec.startsWith(a.prefix) : spec === a.prefix) {
        const rest = a.wildcard ? spec.slice(a.prefix.length) : '';
        for (const t of a.targets) {
          const f = resolveFile(path.join(t, rest));
          if (f) return f;
        }
      }
    }
    return null;
  }

  /** The node bound to `name` in `file` (following imports). → {node, file} | null */
  function lookup(file, name, seen = new Set()) {
    const key = file + '#' + name;
    if (seen.has(key)) return null;
    seen.add(key);
    const mod = load(file);
    if (!mod) return null;
    if (mod.bindings.has(name)) return { node: mod.bindings.get(name), file };
    const imp = mod.imports.get(name);
    if (imp) {
      const target = resolveImport(file, imp.from);
      if (!target) return null;
      if (imp.imported === '*') return { namespace: true, file: target };
      return lookupExport(target, imp.imported, seen);
    }
    return null;
  }

  function lookupExport(file, name, seen = new Set()) {
    const mod = load(file);
    if (!mod) return null;
    const ex = mod.exports.get(name);
    if (ex) {
      if (ex.node) return { node: ex.node, file };
      if (ex.local) return lookup(file, ex.local, seen);
      if (ex.from) { const t = resolveImport(file, ex.from); return t ? lookupExport(t, ex.imported, seen) : null; }
    }
    for (const from of mod.reexportAll) {
      const t = resolveImport(file, from);
      const hit = t && lookupExport(t, name, seen);
      if (hit) return hit;
    }
    return null;
  }

  /** Fold a node to a constant string, or null. */
  function evalString(node, file, depth = 0) {
    node = unwrap(node);
    if (!node || depth > 12) return null;
    switch (node.type) {
      case 'StringLiteral': return node.value;
      case 'NumericLiteral': return String(node.value);
      case 'TemplateLiteral': {
        let s = '';
        for (let i = 0; i < node.quasis.length; i++) {
          s += node.quasis[i].value.cooked;
          if (i < node.expressions.length) {
            const v = evalString(node.expressions[i], file, depth + 1);
            if (v === null) return null;
            s += v;
          }
        }
        return s;
      }
      case 'BinaryExpression': {
        if (node.operator !== '+') return null;
        const l = evalString(node.left, file, depth + 1), r = evalString(node.right, file, depth + 1);
        return l === null || r === null ? null : l + r;
      }
      case 'Identifier': {
        const b = lookup(file, node.name);
        return b && b.node ? evalString(b.node, b.file, depth + 1) : null;
      }
      case 'MemberExpression': {
        const prop = node.computed ? evalString(node.property, file, depth + 1) : node.property.name;
        if (prop === null || prop === undefined) return null;
        const obj = resolveObject(node.object, file, depth + 1);
        if (!obj) return null;
        if (obj.namespace) { const b = lookupExport(obj.file, prop); return b && b.node ? evalString(b.node, b.file, depth + 1) : null; }
        if (obj.node.type === 'TSEnumDeclaration') {
          const m = (obj.node.members || obj.node.body.members).find((x) => (x.id.name || x.id.value) === prop);
          return m && m.initializer ? evalString(m.initializer, obj.file, depth + 1) : null;
        }
        const v = getProp(obj.node, prop);
        return v ? evalString(v, obj.file, depth + 1) : null;
      }
      default: return null;
    }
  }

  /** Resolve an expression to the object/enum/namespace it denotes. */
  function resolveObject(node, file, depth = 0) {
    node = unwrap(node);
    if (!node || depth > 12) return null;
    if (node.type === 'ObjectExpression' || node.type === 'TSEnumDeclaration') return { node, file };
    if (node.type === 'Identifier') {
      const b = lookup(file, node.name);
      if (!b) return null;
      if (b.namespace) return b;
      return b.node ? resolveObject(b.node, b.file, depth + 1) : null;
    }
    if (node.type === 'MemberExpression' && !node.computed) {
      const o = resolveObject(node.object, file, depth + 1);
      if (!o) return null;
      if (o.namespace) { const b = lookupExport(o.file, node.property.name); return b && b.node ? resolveObject(b.node, b.file, depth + 1) : null; }
      const v = getProp(o.node, node.property.name);
      return v ? resolveObject(v, o.file, depth + 1) : null;
    }
    return null;
  }

  /** Resolve an identifier/member/array expression to an ArrayExpression. */
  function resolveArray(node, file, depth = 0) {
    node = unwrap(node);
    if (!node || depth > 12) return null;
    if (node.type === 'ArrayExpression') return { node, file };
    if (node.type === 'Identifier') {
      const b = lookup(file, node.name);
      return b && b.node ? resolveArray(b.node, b.file, depth + 1) : null;
    }
    if (node.type === 'MemberExpression' && !node.computed) {
      const o = resolveObject(node.object, file, depth + 1);
      if (!o) return null;
      if (o.namespace) { const b = lookupExport(o.file, node.property.name); return b && b.node ? resolveArray(b.node, b.file, depth + 1) : null; }
      const v = getProp(o.node, node.property.name);
      return v ? resolveArray(v, o.file, depth + 1) : null;
    }
    return null;
  }

  return { root, load, resolveImport, lookup, lookupExport, evalString, resolveArray, resolveObject, rel: (f) => path.relative(root, f) };
}

/** `() => import('./x')`, `import('./x').then(m => m.Y)`, `lazy(() => import('./x'))` → {spec, member} */
function dynamicImportOf(node) {
  node = unwrap(node);
  if (!node) return null;
  if (node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression') {
    let body = node.body;
    if (body.type === 'BlockStatement') {
      const ret = body.body.find((s) => s.type === 'ReturnStatement');
      body = ret && ret.argument;
    }
    return dynamicImportOf(body);
  }
  if (node.type === 'AwaitExpression') return dynamicImportOf(node.argument);
  if (node.type === 'CallExpression') {
    if (node.callee.type === 'Import' && node.arguments[0]) {
      const a = unwrap(node.arguments[0]);
      return a.type === 'StringLiteral' ? { spec: a.value, member: null } : null;
    }
    // import('./x').then(m => m.Y)
    if (node.callee.type === 'MemberExpression' && node.callee.property.name === 'then') {
      const inner = dynamicImportOf(node.callee.object);
      if (!inner) return null;
      const fn = unwrap(node.arguments[0]);
      let member = null;
      if (fn && (fn.type === 'ArrowFunctionExpression' || fn.type === 'FunctionExpression')) {
        let b = fn.body;
        if (b.type === 'BlockStatement') { const r = b.body.find((s) => s.type === 'ReturnStatement'); b = r && r.argument; }
        b = unwrap(b);
        if (b && b.type === 'MemberExpression' && !b.computed) member = b.property.name;
      }
      return { ...inner, member };
    }
    // lazy(() => import('./x')), React.lazy(...), loadable(...)
    for (const a of node.arguments) {
      const inner = dynamicImportOf(a);
      if (inner) return inner;
    }
  }
  return null;
}

function lineOf(node) { return node && node.loc ? node.loc.start.line : null; }

module.exports = { createProject, walkFiles, isSourceFile, walk, unwrap, getProp, propName, dynamicImportOf, lineOf, readJson, readJsonc, SKIP_DIRS };
