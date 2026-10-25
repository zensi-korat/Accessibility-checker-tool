/**
 * ASP.NET Web Forms adapter. Without a route table a URL is the file path, so
 * every .aspx file is a page. Walks the whole project.
 *
 * Names that look like callbacks/exports/print variants are listed with
 * include:false — guessing wrong either way is worse than asking a human.
 * MapPageRoute() routes in Global.asax / RouteConfig are not read yet.
 */
const fs = require('fs');
const path = require('path');

const SKIP = new Set(['bin', 'obj', 'packages', 'node_modules', '.git', '.vs', 'aspnet_client']);
const WEAK_SIGNAL = /callback|printable|extract|export|_file$|logs?$|handler|download|ajax/i;

function findAspx(dir, rel = [], out = [], limit = Infinity) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (out.length >= limit) return out;
    if (e.isDirectory()) {
      if (SKIP.has(e.name) || e.name.startsWith('.')) continue;
      findAspx(path.join(dir, e.name), [...rel, e.name], out, limit);
    } else if (/\.aspx$/i.test(e.name)) {
      out.push({ rel: [...rel, e.name], file: path.join(dir, e.name) });
    }
  }
  return out;
}

function detect(dir) {
  const hasConfig = fs.existsSync(path.join(dir, 'web.config')) || fs.existsSync(path.join(dir, 'Web.config'));
  if (!hasConfig) return null;
  if (!findAspx(dir, [], [], 1).length) return null;
  return { id: 'aspnet-webforms', name: 'ASP.NET Web Forms', root: dir, evidence: ['web.config', '*.aspx files'] };
}

function discoverRoutes(target) {
  const routes = findAspx(target.root).map((f) => {
    const name = f.rel[f.rel.length - 1].replace(/\.aspx$/i, '');
    const weak = WEAK_SIGNAL.test(name);
    return {
      pattern: '/' + f.rel.join('/'),
      guarded: false,
      hash: false,
      include: !weak,
      sources: [`webforms ${path.relative(target.root, f.file)}`],
      notes: weak ? ['name suggests a callback/export/print endpoint — confirm it is a real page before scanning'] : [],
    };
  });
  return { routes, skipped: [] };
}

module.exports = {
  id: 'aspnet-webforms', detect, discoverRoutes,
  codeExtensions: ['.aspx', '.ascx', '.master'],
};
