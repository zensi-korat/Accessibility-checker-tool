/**
 * Stack adapters (Next.js, React, Angular, Vue/Nuxt, ASP.NET Core, ASP.NET
 * Web Forms). Each one knows how to recognise one kind of project and
 * read its routes from source:
 *
 *   {
 *     id,
 *     detect(dir)           → { id, name, root, evidence[] } | null
 *     discoverRoutes(found) → { routes: Route[], skipped: {reason, source}[] }
 *     codeExtensions        → files worth indexing for file:line mapping
 *   }
 *
 * Route = { pattern, guarded, hash, include?, sources[], notes[] } — see
 * lib/routes/manifest.js for the pattern syntax.
 *
 * Detection looks at the project root and the usual monorepo / full-stack
 * sub-folders (apps/*, packages/*, client, frontend, ClientApp, …), so a .NET
 * solution with an Angular ClientApp is found as both.
 */
const fs = require('fs');
const path = require('path');

const ADAPTERS = [
  require('./next'),
  require('./react'),
  require('./angular'),
  require('./vue'),
  require('./aspnet-core'),
  require('./aspnet-webforms'),
];

const CONTAINER_DIRS = ['apps', 'packages', 'projects', 'src', 'services'];
const LEAF_DIRS = ['client', 'frontend', 'web', 'ui', 'app', 'ClientApp', 'webapp', 'website', 'portal', 'admin', 'Web'];
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'bin', 'obj', '.next', 'coverage', 'vendor']);

function listDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !SKIP.has(e.name) && !e.name.startsWith('.'))
      .map((e) => path.join(dir, e.name));
  } catch { return []; }
}

function isProjectDir(d) {
  try { return fs.readdirSync(d).some((f) => /\.(cs|vb)proj$/.test(f) || f === 'package.json'); } catch { return false; }
}

function candidateDirs(root) {
  const dirs = [root];
  for (const d of listDirs(root)) {
    const name = path.basename(d);
    if (LEAF_DIRS.includes(name)) dirs.push(d);
    if (CONTAINER_DIRS.includes(name)) dirs.push(d, ...listDirs(d));
    // .NET solutions: one folder per project, each with a *.csproj
    else if (!LEAF_DIRS.includes(name) && isProjectDir(d)) {
      dirs.push(d, ...listDirs(d).filter((s) => LEAF_DIRS.includes(path.basename(s))));
    }
  }
  return [...new Set(dirs)];
}

/** Every stack found in or under `root`. */
function detectStacks(root) {
  root = path.resolve(root);
  const found = [];
  for (const dir of candidateDirs(root)) {
    for (const a of ADAPTERS) {
      const hit = a.detect(dir);
      if (hit && !found.some((f) => f.id === hit.id && f.root === hit.root)) found.push(hit);
    }
  }
  return found;
}

function adapterFor(id) { return ADAPTERS.find((a) => a.id === id || (a.ids || []).includes(id)); }

const FALLBACK_EXTENSIONS = ['.html', '.htm', '.jsx', '.tsx', '.vue', '.svelte', '.cshtml', '.razor', '.aspx', '.ascx', '.master', '.php', '.erb'];

function codeExtensionsFor(stacks) {
  if (!stacks.length) return FALLBACK_EXTENSIONS;
  return [...new Set(stacks.flatMap((s) => adapterFor(s.id).codeExtensions))];
}

/** Run every detected adapter; tag each route with its app root when there are several. */
function discover(root, stacks = detectStacks(root)) {
  const routes = [];
  const skipped = [];
  for (const s of stacks) {
    const res = adapterFor(s.id).discoverRoutes(s);
    const relRoot = path.relative(root, s.root);
    for (const r of res.routes) {
      // "react-router src/App.tsx:12" → "react-router apps/web/src/App.tsx:12"
      const withRoot = (x) => (relRoot ? x.replace(/ ([^\s()]+\.[A-Za-z]+(?::\d+)?)$/, ` ${relRoot}/$1`) : x);
      routes.push({ ...r, sources: r.sources.map(withRoot), stack: s.id });
    }
    skipped.push(...res.skipped.map((x) => ({ ...x, stack: s.id })));
  }
  return { stacks, routes, skipped };
}

module.exports = { ADAPTERS, detectStacks, codeExtensionsFor, discover, adapterFor };
