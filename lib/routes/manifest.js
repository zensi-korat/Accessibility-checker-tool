/**
 * The routes manifest (a11y.routes.json) — the hand-off between `a11y
 * discover` and `a11y scan`, and the place a human reviews what gets scanned.
 *
 * Discovery never edits the human's decisions. On every re-run it:
 *   - adds routes it hasn't seen before, marked status "new";
 *   - keeps include / params / name / actions on routes already listed;
 *   - marks routes it no longer finds as status "gone" (scan skips them)
 *     rather than deleting them, so a renamed route is noticed, not lost.
 *
 * Route patterns are normalised across stacks:
 *   :id      required parameter          (/users/[id], users/:id)
 *   :id?     optional parameter          (:id? in React Router, ($id) in Remix)
 *   :slug*   catch-all, 1+ segments      ([...slug], users/*)
 *   :slug*?  optional catch-all          ([[...slug]])
 * A dynamic route is only scanned once every required parameter has a sample
 * value in `params`.
 */
const fs = require('fs');

const PARAM_SEG = /^:([A-Za-z0-9_$-]+)(\*)?(\?)?$/;

function readManifest(file) {
  const m = JSON.parse(fs.readFileSync(file, 'utf8'));
  m.routes = m.routes || [];
  return m;
}

function routeKey(r) { return `${r.hash ? '#' : ''}${r.pattern}`; }

function paramNames(pattern) {
  const names = [];
  for (const seg of pattern.split('/')) {
    const m = seg.match(PARAM_SEG);
    if (m) names.push({ name: m[1], optional: !!m[3], splat: !!m[2] });
  }
  return names;
}

/** Concrete URL path for a pattern, or null if a required sample is missing. */
function fillPattern(pattern, values = {}) {
  const out = [];
  for (const seg of pattern.split('/')) {
    const m = seg.match(PARAM_SEG);
    if (!m) { out.push(seg); continue; }
    const v = values[m[1]];
    if (v !== undefined && v !== null && v !== '') { out.push(String(v).replace(/^\/+/, '')); continue; }
    if (m[3]) continue; // optional — just omit
    return null;
  }
  const p = out.join('/').replace(/\/{2,}/g, '/');
  return p.startsWith('/') ? p : '/' + p;
}

/**
 * Match a concrete path against a pattern → params ({} for static) or null.
 * `:id?` and `:rest*?` may be absent; `:rest*` takes one or more segments.
 */
function matchPattern(pattern, urlPath) {
  const names = [];
  let re = '^';
  for (const seg of pattern.split('/').filter(Boolean)) {
    const m = seg.match(PARAM_SEG);
    if (!m) { re += '/' + seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); continue; }
    names.push(m[1]);
    const body = m[2] ? '(.+)' : '([^/]+)';
    re += m[3] ? `(?:/${body})?` : `/${body}`;
  }
  re += '/?$';
  const hit = new RegExp(re, 'i').exec(urlPath === '' ? '/' : urlPath);
  if (!hit) return null;
  const params = {};
  names.forEach((n, i) => { if (hit[i + 1] !== undefined) params[n] = decodeURIComponent(hit[i + 1]); });
  return params;
}

function defaultName(pattern) {
  if (pattern === '/' || pattern === '') return 'Home';
  return pattern.split('/').filter(Boolean).join(' / ');
}

/**
 * @param {object|null} previous  existing manifest (or null)
 * @param {object[]} found        routes from the adapters (see lib/adapters)
 * @param {object} meta           {project, stacks}
 */
function mergeManifest(previous, found, meta = {}) {
  const prev = new Map((previous ? previous.routes : []).map((r) => [routeKey(r), r]));
  const seen = new Set();
  const routes = [];

  for (const f of found) {
    const key = routeKey(f);
    if (seen.has(key)) continue;
    seen.add(key);
    const names = paramNames(f.pattern);
    const old = prev.get(key);
    const params = {};
    let sampled = false;
    // Human values win; a sample seen on the live site only fills blanks.
    for (const p of names) {
      const mine = old && old.params && old.params[p.name];
      if (mine !== undefined && mine !== null && mine !== '') params[p.name] = mine;
      else if (f.sample && f.sample[p.name] !== undefined) { params[p.name] = f.sample[p.name]; sampled = true; }
      else params[p.name] = '';
    }
    const complete = names.every((p) => p.optional || params[p.name] !== '');
    const hadNoParams = !old || !old.params || names.every((p) => !old.params[p.name]);
    // A dynamic route excluded only because it had no sample becomes
    // scannable once discovery finds one. An explicit human exclusion of a
    // route that already had params is left alone.
    const include = old
      ? (old.include || (sampled && hadNoParams && complete && f.include !== false))
      : f.include !== false && complete;
    routes.push({
      name: old ? old.name : defaultName(f.pattern),
      pattern: f.pattern,
      ...(f.hash ? { hash: true } : {}),
      include,
      ...(names.length ? { params } : {}),
      ...(sampled ? { paramsFrom: 'live site' } : old && old.paramsFrom ? { paramsFrom: old.paramsFrom } : {}),
      ...(f.guarded ? { guarded: true } : {}),
      sources: f.sources,
      ...(f.notes && f.notes.length ? { notes: f.notes } : {}),
      ...(old && old.actions ? { actions: old.actions } : {}),
      status: old ? (old.status === 'gone' ? 'returned' : 'ok') : 'new',
    });
  }
  for (const [key, old] of prev) {
    if (!seen.has(key)) routes.push({ ...old, status: 'gone' });
  }
  routes.sort((a, b) => a.pattern.localeCompare(b.pattern));

  return {
    $comment: 'Generated by `a11y discover`. Review it: set "include" to choose what is scanned, and give dynamic routes sample "params" values. Your edits are kept when discovery re-runs.',
    generatedAt: new Date().toISOString(),
    project: meta.project || '',
    stacks: meta.stacks || [],
    routes,
  };
}

/** PAGES entries for every included, still-present, fully-parameterised route. */
function pagesFromManifest(manifest, existingPages = []) {
  const taken = new Set(existingPages.map((p) => normPath(p.path)));
  const pages = [];
  for (const r of manifest.routes || []) {
    if (!r.include || r.status === 'gone') continue;
    const filled = fillPattern(r.pattern, r.params);
    if (!filled) continue;
    const p = (r.hash ? '/#' : '') + filled;
    if (taken.has(normPath(p))) continue;
    taken.add(normPath(p));
    pages.push({ name: r.name, path: p, actions: r.actions || [], ...(r.guarded ? { guarded: true } : {}) });
  }
  return pages;
}

function normPath(p) { return String(p || '').toLowerCase().replace(/\/+$/, '') || '/'; }

function writeManifest(file, manifest) {
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
}

module.exports = { readManifest, writeManifest, mergeManifest, pagesFromManifest, fillPattern, paramNames, matchPattern };
