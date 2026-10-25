/**
 * Ask the running app where an element came from, instead of grepping for it.
 *
 * Development builds of most UI frameworks leave the answer on the DOM node:
 *
 *   React ≤18  fiber._debugSource            → exact file:line of the JSX
 *   React 19   fiber._debugStack              → creating call site (file:line in dev server URL)
 *   Vue 3      el.__vueParentComponent.type.__file   → component file
 *   Vue 2      el.__vue__.$options.__file            → component file
 *   Angular    ng.getOwningComponent(el)      → component class (dev mode only)
 *   Svelte     el.__svelte_meta.loc           → exact file:line
 *   any        data-inspector-relative-path / data-inspector-line (react-dev-inspector),
 *              data-sentry-source-file / data-sentry-component (Sentry's annotate plugin),
 *              data-source="file:line", data-component
 *
 * Production builds strip all of this; then nothing is attached and the
 * report falls back to lib/codeMap.js's text search. Results are attached to
 * each axe node as `node.runtimeSource` so they survive the scan cache.
 */

// Runs IN THE BROWSER — must be self-contained.
function browserLocate(selectors) {
  const MAX_UP = 25;
  const pick = (o, k) => { try { return o && o[k]; } catch (e) { return undefined; } };
  const fiberOf = (el) => {
    for (const k of Object.keys(el)) if (k.indexOf('__reactFiber$') === 0 || k.indexOf('__reactInternalInstance$') === 0) return el[k];
    return null;
  };
  const compName = (type) => (type && (type.displayName || type.name)) || null;

  const fromReact = (el) => {
    const fiber = fiberOf(el);
    if (!fiber) return null;
    let component = null;
    for (let f = fiber; f && !component; f = f.return) if (typeof f.type === 'function' || (f.type && typeof f.type === 'object' && f.type.render)) component = compName(f.type) || compName(f.type.render);
    for (let f = fiber, i = 0; f && i < 40; f = f._debugOwner || f.return, i++) {
      const ds = f._debugSource;
      if (ds && ds.fileName) return { framework: 'react', file: ds.fileName, line: ds.lineNumber || null, component, exact: f === fiber };
    }
    // React 19: an Error captured where the element was created.
    for (let f = fiber, i = 0; f && i < 40; f = f.return, i++) {
      const st = f._debugStack && f._debugStack.stack;
      if (!st) continue;
      const frames = st.split('\n').slice(1);
      for (const fr of frames) {
        if (/node_modules|react-stack-top-frame|react_jsx|jsx-dev-runtime|\.vite\/deps|chunk-/.test(fr)) continue;
        const m = fr.match(/\(?((?:https?|file|webpack[^:]*):\/\/[^\s)]+?|\/[^\s)]+?):(\d+):(\d+)\)?\s*$/);
        if (m) return { framework: 'react', file: m[1], line: Number(m[2]), component, exact: false };
      }
    }
    return component ? { framework: 'react', file: null, line: null, component, exact: false } : null;
  };

  const fromVue = (el) => {
    const inst = pick(el, '__vueParentComponent');
    if (inst && inst.type) {
      return { framework: 'vue', file: inst.type.__file || null, line: null, component: inst.type.__name || inst.type.name || null, exact: false };
    }
    const v2 = pick(el, '__vue__');
    if (v2 && v2.$options) return { framework: 'vue', file: v2.$options.__file || null, line: null, component: v2.$options.name || null, exact: false };
    return null;
  };

  const fromAngular = (el) => {
    const ng = window.ng;
    if (!ng || typeof ng.getOwningComponent !== 'function') return null;
    let c = null;
    try { c = ng.getComponent(el) || ng.getOwningComponent(el); } catch (e) { return null; }
    if (!c || !c.constructor) return null;
    return { framework: 'angular', file: null, line: null, component: c.constructor.name.replace(/^_/, ''), exact: false };
  };

  const fromSvelte = (el) => {
    const meta = pick(el, '__svelte_meta');
    if (meta && meta.loc) return { framework: 'svelte', file: meta.loc.file, line: meta.loc.line, component: null, exact: true, zeroBased: !('parent' in meta) };
    return null;
  };

  const fromAttrs = (el) => {
    const a = (n) => el.getAttribute && el.getAttribute(n);
    if (a('data-inspector-relative-path')) return { framework: 'attr', file: a('data-inspector-relative-path'), line: Number(a('data-inspector-line')) || null, component: null, exact: true };
    if (a('data-source')) { const m = a('data-source').match(/^(.+?):(\d+)/); if (m) return { framework: 'attr', file: m[1], line: Number(m[2]), component: null, exact: true }; }
    if (a('data-sentry-source-file')) return { framework: 'attr', file: a('data-sentry-source-file'), line: null, component: a('data-sentry-component'), exact: false };
    if (a('data-sentry-component') || a('data-component')) return { framework: 'attr', file: null, line: null, component: a('data-sentry-component') || a('data-component'), exact: false };
    return null;
  };

  const locate = (start) => {
    // The element itself first (exact JSX/Svelte location), then ancestors.
    for (let el = start, up = 0; el && el.nodeType === 1 && up < MAX_UP; el = el.parentElement, up++) {
      const hit = fromAttrs(el) || fromSvelte(el) || fromReact(el) || fromVue(el) || fromAngular(el);
      if (hit && (hit.file || hit.component)) {
        if (up > 0) hit.exact = false;
        return hit;
      }
    }
    return null;
  };

  return selectors.map((sel) => {
    try {
      const el = document.querySelector(sel);
      return el ? locate(el) : null;
    } catch (e) { return null; }
  });
}

/**
 * Attach node.runtimeSource to violation/incomplete nodes. Cheap no-op on
 * production builds; capped so a page with thousands of nodes stays fast.
 */
async function attachRuntimeSources(page, results, opts = {}) {
  const max = opts.max || 300;
  const nodes = [];
  for (const group of [results.violations || [], results.incomplete || []]) {
    for (const r of group) for (const n of r.nodes || []) {
      const t = Array.isArray(n.target) ? n.target[n.target.length - 1] : n.target;
      // Targets inside iframes/shadow DOM are arrays of selectors; only the
      // top-level document is inspected.
      if (typeof t === 'string' && (!Array.isArray(n.target) || n.target.length === 1) && nodes.length < max) nodes.push({ n, sel: t });
    }
  }
  if (!nodes.length) return 0;
  const found = await page.evaluate(browserLocate, nodes.map((x) => x.sel));
  let count = 0;
  found.forEach((hit, i) => { if (hit) { nodes[i].n.runtimeSource = hit; count++; } });
  return count;
}

module.exports = { attachRuntimeSources, browserLocate };
