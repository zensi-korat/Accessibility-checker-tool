/**
 * ASP.NET Core adapter: Razor Pages, MVC controllers with views, and Blazor.
 *
 *   Razor Pages  Pages/Users/Edit.cshtml with `@page "{id:int}"` → /Users/Edit/:id
 *                Areas/Admin/Pages/... → /Admin/...; `@page "/custom"` overrides the path
 *   Blazor       any .razor file with `@page "/counter/{n:int?}"` (several allowed)
 *   MVC          [Route]/[HttpGet] attribute routes, else the conventional
 *                {controller=Home}/{action=Index}/{id?} pattern; only actions that
 *                can render a page (no [HttpPost]/[HttpPut]/…, not [ApiController])
 *
 * C# is read with patterns, not a compiler, so unusual formatting can be
 * missed — that is what `a11y discover --live` is for. [Authorize] (class or
 * action, or `@attribute [Authorize]`) marks routes guarded; [AllowAnonymous]
 * lifts it.
 */
const fs = require('fs');
const path = require('path');

const SKIP = new Set(['bin', 'obj', 'node_modules', '.git', '.vs', 'wwwroot', 'TestResults', 'packages']);

function walk(dir, test, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.isDirectory()) { if (!SKIP.has(e.name) && !e.name.startsWith('.')) walk(path.join(dir, e.name), test, out); }
    else if (test(e.name)) out.push(path.join(dir, e.name));
  }
  return out;
}
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };

function detect(dir) {
  let proj;
  try { proj = fs.readdirSync(dir).find((f) => f.endsWith('.csproj')); } catch { return null; }
  if (!proj) return null;
  const csproj = read(path.join(dir, proj));
  const web = /Sdk="Microsoft\.NET\.Sdk\.(Web|BlazorWebAssembly|Razor)"/.test(csproj);
  if (!web) return null;
  return { id: 'aspnet-core', name: 'ASP.NET Core', root: dir, evidence: [`${proj} (${csproj.match(/Sdk="([^"]+)"/)[1]})`] };
}

/** `{id:int?}` → `:id?`, `{*slug}` → `:slug*`, `{**path}` → `:path*` */
function template(t) {
  return t.split('/').map((seg) => seg.replace(/^\{\*{1,2}([A-Za-z_]\w*)[^}]*\}$/, ':$1*')
    .replace(/^\{([A-Za-z_]\w*)(?::[^}?=]*)?(?:=[^}?]*)?(\?)?\}$/, (m, name, opt) => `:${name}${opt || (m.includes('=') ? '?' : '')}`)).join('/');
}

function joinUrl(...parts) {
  return '/' + parts.filter(Boolean).join('/').split('/').filter(Boolean).join('/');
}

const isAuthorized = (txt) => /\[\s*Authorize\b/.test(txt) && !/\[\s*AllowAnonymous\b/.test(txt);

function razorPages(root, rel, conventions) {
  const routes = [];
  for (const pagesDir of [path.join(root, 'Pages'), ...listAreas(root).map((a) => path.join(root, 'Areas', a, 'Pages'))]) {
    const area = pagesDir.includes(`${path.sep}Areas${path.sep}`) ? pagesDir.split(path.sep).slice(-2, -1)[0] : null;
    for (const file of walk(pagesDir, (n) => n.endsWith('.cshtml') && !n.startsWith('_'))) {
      const src = read(file);
      const m = src.match(/^\s*@page\b[ \t]*(?:"([^"]*)")?/m);
      if (!m) continue; // partial or layout, not a page
      const relPath = path.relative(pagesDir, file).replace(/\.cshtml$/, '').split(path.sep);
      if (relPath[relPath.length - 1] === 'Index') relPath.pop();
      const tpl = m[1] ? template(m[1]) : '';
      const url = tpl.startsWith('/') ? joinUrl(tpl) : joinUrl(area, ...relPath, tpl);
      const code = read(file + '.cs');
      // AuthorizeFolder("/Admin") covers /Admin and everything under it.
      const pagePath = '/' + relPath.join('/');
      const folderGuard = conventions.some((c) => pagePath === c || pagePath.startsWith(c + '/'));
      routes.push({ pattern: url, guarded: isAuthorized(code) || folderGuard, hash: false, sources: [`razor-pages ${rel(file)}`], notes: [] });
    }
  }
  return routes;
}

function listAreas(root) {
  try { return fs.readdirSync(path.join(root, 'Areas'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return []; }
}

/** AuthorizeFolder("/Admin") / AuthorizePage("/Secret") conventions in Program.cs / Startup.cs. */
function authConventions(root) {
  const txt = ['Program.cs', 'Startup.cs'].map((f) => read(path.join(root, f))).join('\n');
  return [...txt.matchAll(/Authorize(?:Area)?(?:Folder|Page)\(\s*(?:"[^"]*"\s*,\s*)?"([^"]+)"/g)].map((m) => m[1].replace(/\/$/, ''));
}

function blazor(root, rel) {
  const routes = [];
  for (const file of walk(root, (n) => n.endsWith('.razor'))) {
    const src = read(file);
    const guarded = /@attribute\s+\[\s*Authorize\b/.test(src);
    for (const m of src.matchAll(/^\s*@page\s+"([^"]+)"/gm)) {
      routes.push({ pattern: joinUrl(template(m[1])), guarded, hash: false, sources: [`blazor ${rel(file)}`], notes: [] });
    }
  }
  return routes;
}

const NON_GET = /\[\s*Http(Post|Put|Patch|Delete)\b/;
const ACTION_RE = /((?:\s*\[[^\]]*\]\s*)*)\s*public\s+(?:async\s+)?(?:virtual\s+)?(?:Task<\s*)?(IActionResult|ActionResult|ViewResult|PartialViewResult)\s*>?\s+(\w+)\s*\(([^)]*)\)/g;

function mvc(root, rel) {
  const routes = [];
  for (const file of walk(root, (n) => /Controller\.cs$/.test(n))) {
    const src = read(file);
    const cls = src.match(/((?:\s*\[[^\]]*\]\s*)*)\s*public\s+(?:sealed\s+|abstract\s+|partial\s+)*class\s+(\w+)Controller\b/);
    if (!cls) continue;
    const classAttrs = cls[1] || '';
    if (/\[\s*ApiController\b/.test(classAttrs) || /:\s*ControllerBase\b/.test(src)) continue; // JSON API, no pages
    const controller = cls[2];
    const area = (classAttrs.match(/\[\s*Area\(\s*"([^"]+)"/) || [])[1] || null;
    const classRoute = (classAttrs.match(/\[\s*Route\(\s*"([^"]*)"/) || [])[1];
    const classAuth = isAuthorized(classAttrs);
    const body = src.slice(cls.index + cls[0].length);
    for (const m of body.matchAll(ACTION_RE)) {
      const attrs = m[1] || '';
      const action = m[3];
      if (NON_GET.test(attrs) || /\[\s*NonAction\b/.test(attrs) || m[2] === 'PartialViewResult') continue;
      const line = src.slice(0, cls.index + cls[0].length + m.index + m[0].indexOf(action)).split('\n').length;
      const tokens = (t) => t.replace(/\[controller\]/gi, controller).replace(/\[action\]/gi, action).replace(/\[area\]/gi, area || '');
      const attrRoute = (attrs.match(/\[\s*(?:Route|HttpGet)\(\s*"([^"]*)"/) || [])[1];
      let url;
      if (attrRoute !== undefined && attrRoute.startsWith('/')) url = joinUrl(template(tokens(attrRoute)));
      else if (attrRoute !== undefined || classRoute !== undefined) url = joinUrl(template(tokens(classRoute || '')), template(tokens(attrRoute || '')));
      else {
        // Conventional: {area}/{controller=Home}/{action=Index}/{id?}
        const hasId = /\b(int|long|Guid|string)\??\s+id\b/.test(m[4]);
        const segs = [area];
        const isHome = controller === 'Home' && !area;
        if (!(isHome && action === 'Index')) segs.push(controller);
        if (action !== 'Index') segs.push(action);
        url = joinUrl(...segs, hasId ? ':id?' : '');
      }
      const guarded = (classAuth || isAuthorized(attrs)) && !/\[\s*AllowAnonymous\b/.test(attrs);
      routes.push({ pattern: url, guarded, hash: false, sources: [`mvc ${rel(file)}:${line}`], notes: [] });
    }
  }
  return routes;
}

function discoverRoutes(target) {
  const root = target.root;
  const rel = (f) => path.relative(root, f);
  const conventions = authConventions(root);
  const routes = [...razorPages(root, rel, conventions), ...blazor(root, rel), ...mvc(root, rel)];
  const { dedupe } = require('../routes/routeTree');
  return { routes: dedupe(routes), skipped: [] };
}

module.exports = {
  id: 'aspnet-core', detect, discoverRoutes,
  codeExtensions: ['.cshtml', '.razor', '.cs'],
  _internal: { template },
};
