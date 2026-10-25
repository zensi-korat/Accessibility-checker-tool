/**
 * Stack-neutral route tree: adapters turn their framework's route syntax into
 * RouteNodes, this module stitches nodes from different files together and
 * flattens the tree into URL patterns.
 *
 * RouteNode = {
 *   path:      string | null     segment(s) as written; null = pathless layout
 *   unresolved: boolean          path is an expression we could not fold
 *   index:     boolean           renders at the parent's URL
 *   renders:   boolean           has its own page component
 *   redirect:  boolean           only redirects — not a page
 *   wildcard:  boolean           a not-found catch-all — not a page
 *   guarded:   boolean           behind an auth/permission guard
 *   children:  RouteNode[]       inline children
 *   refs:      Ref[]             children defined elsewhere (another array/file)
 *   file, line
 * }
 * Ref = { key, load: () => RouteNode[] }  — `key` identifies the target so a
 * definition reachable from a parent is never also treated as a root.
 */

/** Join a child segment onto its parent's URL. `absolute` children (React Router) keep their own. */
function joinPath(parent, child) {
  if (child === null || child === undefined || child === '') return parent || '/';
  if (child.startsWith('/')) return normalise(child);
  return normalise(`${parent || ''}/${child}`);
}

function normalise(p) {
  let s = ('/' + p).replace(/\/{2,}/g, '/');
  if (s.length > 1) s = s.replace(/\/+$/, '');
  return s;
}

/**
 * Convert framework params to the manifest's canonical form. React Router and
 * Angular already use `:id`; a trailing `*` becomes the `:rest*` catch-all.
 */
function canonicalise(pattern) {
  return pattern.split('/').map((seg) => {
    if (seg === '*') return ':rest*';
    return seg;
  }).join('/');
}

/**
 * Flatten root nodes into routes.
 * @param {RouteNode[]} roots
 * @param {{adapter:string, rel:(f:string)=>string, prefix?:string, hash?:boolean}} opts
 * @returns {{routes:object[], skipped:object[]}}
 */
function flatten(roots, opts) {
  const routes = [];
  const skipped = [];
  const prefix = opts.prefix || '';
  const src = (n) => `${opts.adapter} ${opts.rel(n.file)}${n.line ? ':' + n.line : ''}`;

  const visit = (node, parentPath, guarded, stack) => {
    if (stack.has(node)) return;
    stack.add(node);
    const isGuarded = guarded || !!node.guarded;
    if (node.redirect) { skipped.push({ reason: 'redirect', source: src(node) }); stack.delete(node); return; }
    if (node.wildcard) { skipped.push({ reason: 'not-found catch-all', source: src(node) }); stack.delete(node); return; }
    if (node.unresolved) {
      skipped.push({ reason: 'path is a runtime expression — add it to PAGES by hand', source: src(node) });
      stack.delete(node);
      return;
    }
    const full = node.index ? (parentPath || '/') : joinPath(parentPath, node.path);
    const kids = [...(node.children || [])];
    for (const r of node.refs || []) {
      try { kids.push(...r.load()); } catch { /* unresolved ref — children simply missing */ }
    }
    // A `users/*` mount whose nested routes were found is fully described by
    // them; without them, keep it so the human sees an unexplored subtree.
    const splatMount = /\/\*$/.test(full) || full === '/*';
    const base = splatMount && kids.length ? full.replace(/\/?\*$/, '') || '/' : full;
    if (node.renders && (node.path !== null || node.index) && !(splatMount && kids.length)) {
      routes.push({
        pattern: canonicalise(normalise(prefix + base)),
        guarded: isGuarded,
        hash: !!opts.hash,
        sources: [src(node)],
        notes: splatMount ? ['catch-all mount — nested routes could not be resolved statically'] : [],
      });
    }
    for (const k of kids) visit(k, base, isGuarded, stack);
    stack.delete(node);
  };

  for (const r of roots) visit(r, '', false, new Set());
  return { routes, skipped };
}

/** Merge duplicates (same pattern from several definitions/sources). */
function dedupe(routes) {
  const by = new Map();
  for (const r of routes) {
    const key = `${r.hash ? '#' : ''}${r.pattern}`;
    const prev = by.get(key);
    if (!prev) { by.set(key, { ...r, sources: [...r.sources], notes: [...(r.notes || [])] }); continue; }
    for (const s of r.sources) if (!prev.sources.includes(s)) prev.sources.push(s);
    for (const n of r.notes || []) if (!prev.notes.includes(n)) prev.notes.push(n);
    // Guarded only if every definition says so; one public path makes it public.
    prev.guarded = prev.guarded && r.guarded;
    if (r.include === false) prev.include = false;
  }
  return [...by.values()];
}

module.exports = { flatten, dedupe, joinPath, normalise, canonicalise };
