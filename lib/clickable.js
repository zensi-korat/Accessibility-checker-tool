/**
 * KEYBOARD REACHABILITY check — closes the gap axe-core and IBM Equal Access
 * both miss: an element that responds to a mouse click but cannot be reached
 * or activated by keyboard.
 *
 * This is the defect class the Engineering Addendum (§4.3) called out as its
 * most severe finding: a `<th onclick=...>` opening a shift template, with no
 * role, no tabindex and no key handler — making the page's primary action
 * impossible for a keyboard-only user. Verified: neither engine flags it.
 *
 * Detection strategy (all in-page, no CDP — works with jQuery delegation,
 * which CDP's getEventListeners cannot see because the listener lives on
 * `document`, not the element):
 *
 *   1. inline `onclick` attribute
 *   2. jQuery DIRECT handlers        — jQuery._data(el, 'events').click
 *   3. jQuery DELEGATED handlers     — jQuery._data(document|body, 'events')
 *                                      then match each handler's selector
 *   4. native addEventListener       — only detectable if we monkey-patch
 *                                      BEFORE page scripts run (see
 *                                      instrumentListeners)
 *
 * An element is FOCUSABLE if it is a natively-interactive element, has
 * tabindex >= 0, or carries an interactive ARIA role. Anything with a click
 * handler that is not focusable is reported against WCAG 2.1.1 (Keyboard,
 * Level A).
 *
 * False-positive guards: skips elements that merely CONTAIN a focusable
 * control (the handler is probably a convenience wrapper around a real
 * button), skips hidden/zero-size elements, and skips `label` elements
 * (clicking a label legitimately activates its associated input).
 */

const HELP_URL = 'https://www.w3.org/WAI/WCAG22/Understanding/keyboard.html';

function result(id, help, impact, tags, nodes) {
  return { id, help, description: help, helpUrl: HELP_URL, impact, tags, nodes };
}
function node(impact, html, sel, failureSummary) {
  return { impact, html: String(html || '').slice(0, 400), target: [sel], failureSummary };
}

/**
 * Must run BEFORE the page's own scripts so we can observe
 * addEventListener('click', ...) registrations. Playwright's
 * addInitScript runs on every navigation prior to page scripts.
 */
async function instrumentListeners(page) {
  await page.addInitScript(() => {
    // Record elements that register a click/keydown listener natively.
    window.__a11yClickEls = new WeakSet();
    window.__a11yKeyEls = new WeakSet();
    // 2.5.2 Pointer Cancellation needs to know which elements act on the DOWN
    // half of a press, which also handle the up/click half, and which are part
    // of a drag — where acting on down is essential and therefore exempt.
    window.__a11yUpEls = new WeakSet();
    window.__a11yDragEls = new WeakSet();
    window.__a11yDownList = []; // strong refs: the candidate list must survive
    const orig = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (type, fn, opts) {
      try {
        if (this instanceof Element) {
          if (type === 'click') window.__a11yClickEls.add(this);
          else if (type === 'keydown' || type === 'keypress' || type === 'keyup') window.__a11yKeyEls.add(this);
          else if (type === 'mousedown' || type === 'pointerdown' || type === 'touchstart') {
            if (window.__a11yDownList.indexOf(this) === -1) window.__a11yDownList.push(this);
          } else if (type === 'mouseup' || type === 'pointerup' || type === 'touchend') {
            window.__a11yUpEls.add(this);
          } else if (type === 'dragstart' || type === 'mousemove' || type === 'pointermove' || type === 'touchmove') {
            window.__a11yDragEls.add(this);
          }
        }
      } catch (e) { /* never break the page */ }
      return orig.call(this, type, fn, opts);
    };
  }).catch(() => {});
}

// Runs in the browser. Self-contained.
function findUnreachable() {
  const FOCUSABLE_TAGS = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY', 'AUDIO', 'VIDEO', 'IFRAME']);
  const INTERACTIVE_ROLES = new Set(['button', 'link', 'checkbox', 'radio', 'tab', 'menuitem', 'menuitemcheckbox',
    'menuitemradio', 'option', 'switch', 'textbox', 'combobox', 'slider', 'spinbutton', 'searchbox', 'treeitem']);

  const isFocusable = (el) => {
    if (el.hasAttribute('tabindex') && parseInt(el.getAttribute('tabindex'), 10) >= 0) return true;
    if (FOCUSABLE_TAGS.has(el.tagName)) {
      if (el.tagName === 'A' && !el.hasAttribute('href')) return false;
      if (el.disabled) return false;
      return true;
    }
    if (el.isContentEditable) return true;
    // A web component whose real control lives in its shadow root (Ionic
    // <ion-button>, Shoelace <sl-button>) is reachable through that control.
    if (el.shadowRoot) {
      try {
        if (el.shadowRoot.querySelector('a[href],button:not([disabled]),input:not([disabled]),select,textarea,[tabindex]:not([tabindex="-1"])')) return true;
      } catch (e) { /* ignore */ }
    }
    // A role alone doesn't make it focusable, but role + tabindex does; a
    // role WITHOUT tabindex is itself a defect we still want to report.
    return false;
  };
  // Nobody can operate a disabled control, so it is not a keyboard-only gap.
  const isDisabled = (el) => el.disabled === true || el.getAttribute('aria-disabled') === 'true'
    || !!el.closest('fieldset[disabled]');
  // Hidden from assistive tech / inert: not this check's concern (axe's
  // aria-hidden-focus covers focusable content inside aria-hidden).
  const isHiddenTree = (el) => !!el.closest('[aria-hidden="true"],[inert]');
  // An icon/span with its own handler INSIDE a real button or link: the
  // keyboard reaches the action through the ancestor.
  const INTERACTIVE_ANCESTOR = 'a[href],button,summary,label,select,textarea,input,[contenteditable="true"],'
    + '[role="button"],[role="link"],[role="menuitem"],[role="tab"],[role="option"],[role="checkbox"],[role="switch"],'
    + '[tabindex]:not([tabindex="-1"])';
  const inInteractiveAncestor = (el) => !!(el.parentElement && el.parentElement.closest(INTERACTIVE_ANCESTOR));
  // React 17+ attaches listeners to the root container, so neither inline
  // attributes nor the addEventListener patch see a component's onClick. The
  // props live on the element under __reactProps$<hash> (React 16:
  // __reactEventHandlers$<hash>). Vue 3 keeps its invokers on el._vei.
  const frameworkProps = (el) => {
    const keys = Object.keys(el);
    for (const k of keys) {
      if (k.startsWith('__reactProps$') || k.startsWith('__reactEventHandlers$')) return el[k] || null;
    }
    if (el._vei) return el._vei;
    return null;
  };
  const CLICK_PROPS = ['onClick', 'onMouseDown', 'onMouseUp', 'onPointerDown', 'onPointerUp'];
  const KEY_PROPS = ['onKeyDown', 'onKeyUp', 'onKeyPress'];
  const hasProp = (props, names) => !!props && names.some((n) => typeof props[n] === 'function'
    || (props[n] && typeof props[n] === 'object' && typeof props[n].value === 'function'));

  const isVisible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && !isHiddenTree(el);
  };

  // Unique, ADDRESSABLE selector. A bare tag.class pair is not unique — on this
  // application 60% of elements carry no id, so several controls collapsed onto
  // one selector, which silently made the interactive checks act on the wrong
  // element and skip the rest. Uniqueness here is correctness, not polish.
  // Readability still matters, so the short readable form is preferred whenever
  // it genuinely identifies one element; the structural path is the fallback.
  const selOf = (el) => {
    const tag = el.tagName.toLowerCase();
    // getElementById returns the first match, so this also guarantees '#id'
    // resolves back to THIS element even on pages with duplicated ids.
    if (el.id && document.getElementById(el.id) === el) return tag + '#' + el.id;
    const classesOf = (n, take) => (typeof n.className === 'string' && n.className.trim())
      ? '.' + n.className.trim().split(/\s+/).slice(0, take).join('.') : '';
    const cls = classesOf(el, 2);
    if (cls) {
      try { if (document.querySelectorAll(tag + cls).length === 1) return tag + cls; } catch (e) {}
    }
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentElement) {
      const t = n.tagName.toLowerCase();
      if (n.id && document.getElementById(n.id) === n) { parts.unshift(t + '#' + n.id); break; }
      let p = t + classesOf(n, 1);
      const par = n.parentElement;
      if (par) {
        const sibs = [];
        for (const ch of par.children) if (ch.tagName === n.tagName) sibs.push(ch);
        if (sibs.length > 1) p += ':nth-of-type(' + (sibs.indexOf(n) + 1) + ')';
      }
      parts.unshift(p);
    }
    return parts.join(' > ');
  };

  // ── Gather click-handler signals ──────────────────────────────────────────
  const $ = window.jQuery || window.$;
  const candidates = new Map(); // el -> Set of reasons

  const add = (el, reason) => {
    if (!el || !(el instanceof Element)) return;
    if (!candidates.has(el)) candidates.set(el, new Set());
    candidates.get(el).add(reason);
  };

  // 1. inline onclick
  document.querySelectorAll('[onclick]').forEach((el) => add(el, 'inline onclick'));

  // 2/3. jQuery direct + delegated.
  // Delegation can be rooted at ANY element, not just document/body — e.g.
  // DataTables binds sort handlers delegated on the <table>. So we inspect
  // every element's jQuery event store, and for handlers that carry a
  // `.selector` (= delegated) we resolve that selector WITHIN that root and
  // attribute the handler to the matched descendants, not to the container.
  if ($ && $._data) {
    const roots = [document, document.documentElement, document.body]
      .concat(Array.from(document.querySelectorAll('*')));
    roots.forEach((root) => {
      if (!root) return;
      let ev;
      try { ev = $._data(root, 'events'); } catch (e) { return; }
      if (!ev || !ev.click) return;
      ev.click.forEach((h) => {
        if (h && h.selector) {
          // delegated → the real targets are descendants matching the selector
          try {
            const scope = root.querySelectorAll ? root : document;
            scope.querySelectorAll(h.selector).forEach((el) => add(el, 'jQuery delegated: ' + h.selector));
          } catch (e) { /* invalid selector */ }
        } else if (root instanceof Element) {
          // direct bind on this element
          add(root, 'jQuery .on(click)');
        }
      });
    });
  }

  // 4. native addEventListener (needs instrumentListeners to have run first)
  if (window.__a11yClickEls) {
    document.querySelectorAll('*').forEach((el) => {
      try { if (window.__a11yClickEls.has(el)) add(el, 'addEventListener(click)'); } catch (e) { /* ignore */ }
    });
  }

  // 5. framework props (React / Vue 3 — see frameworkProps)
  document.querySelectorAll('body *').forEach((el) => {
    try {
      const props = frameworkProps(el);
      if (hasProp(props, CLICK_PROPS)) add(el, props._vei || el._vei ? 'Vue @click' : 'React onClick');
    } catch (e) { /* ignore */ }
  });

  // ── Filter to genuine keyboard-unreachable defects ────────────────────────
  const hasKeyHandler = (el) => {
    if (el.hasAttribute('onkeydown') || el.hasAttribute('onkeypress') || el.hasAttribute('onkeyup')) return true;
    if (window.__a11yKeyEls) { try { if (window.__a11yKeyEls.has(el)) return true; } catch (e) {} }
    try { if (hasProp(frameworkProps(el), KEY_PROPS)) return true; } catch (e) { /* ignore */ }
    if ($ && $._data) {
      try {
        const ev = $._data(el, 'events');
        if (ev && (ev.keydown || ev.keypress || ev.keyup)) return true;
      } catch (e) { /* ignore */ }
    }
    return false;
  };

  const out = [];
  const review = [];
  candidates.forEach((reasons, el) => {
    if (!isVisible(el)) return;
    if (el.tagName === 'LABEL') return;                 // label click → activates its input, legitimately
    if (isDisabled(el)) return;                         // nobody can operate it
    if (isFocusable(el)) return;                        // reachable by keyboard already
    if (hasKeyHandler(el)) return;                      // author provided a keyboard path
    if (inInteractiveAncestor(el)) return;              // icon inside a <button>/<a>: reached via the ancestor

    const role = (el.getAttribute('role') || '').toLowerCase();
    const hasInteractiveRole = INTERACTIVE_ROLES.has(role);
    const rec = {
      html: el.outerHTML.slice(0, 300),
      sel: selOf(el),
      tag: el.tagName.toLowerCase(),
      reasons: Array.from(reasons).slice(0, 3),
      hasInteractiveRole,
      text: (el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 60),
    };

    // Containing a focusable descendant does NOT prove the element is safe.
    // It may be a convenience wrapper around a real control (benign), or it
    // may carry its OWN distinct action that only a mouse can trigger — e.g.
    // a table cell whose click opens an editor, which happens to contain an
    // unrelated colour-picker button. We cannot tell these apart reliably,
    // so we surface them as "needs review" rather than dropping them (which
    // previously produced a false negative) or failing them outright.
    const focusableChild = el.querySelector('a[href],button,input,select,textarea,[tabindex]');
    // A listener on a big container (list, table, form, section…) is almost
    // always event DELEGATION for its children, not an action of its own.
    const CONTAINERS = new Set(['BODY', 'MAIN', 'SECTION', 'ARTICLE', 'NAV', 'HEADER', 'FOOTER', 'ASIDE', 'FORM',
      'TABLE', 'TBODY', 'THEAD', 'UL', 'OL', 'DL']);
    const r = el.getBoundingClientRect();
    const big = r.width * r.height > 0.25 * window.innerWidth * window.innerHeight;
    const viaListenerOnly = Array.from(reasons).every((x) => /addEventListener|React|Vue/.test(x));
    const appRoot = el.matches('#root,#app,#__next,#__nuxt,[data-reactroot],[ng-version],[data-v-app]');
    if (viaListenerOnly && (appRoot || CONTAINERS.has(el.tagName) || (big && el.children.length > 2))) {
      rec.delegated = true;
      review.push(rec);
      return;
    }
    if (focusableChild) {
      rec.childName = (focusableChild.getAttribute('aria-label') || focusableChild.getAttribute('title')
        || (focusableChild.innerText || '').trim()).replace(/\s+/g, ' ').slice(0, 40);
      rec.childTag = focusableChild.tagName.toLowerCase();
      review.push(rec);
      return;
    }
    out.push(rec);
  });

  // ── Second defect class: interactive ARIA role, but not focusable ─────────
  // Independent of handler detection (which is inherently incomplete): an
  // element announced to assistive tech as a button/tab/menuitem that the
  // keyboard cannot reach is a 2.1.1 failure regardless of how its handler
  // is wired. Guard against ROVING TABINDEX — a legitimate pattern where only
  // one item in a composite widget has tabindex="0" and siblings use "-1"
  // plus arrow-key navigation.
  const ROVING_ROLES = new Set(['tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'radio', 'treeitem']);
  const roleOut = [];
  document.querySelectorAll('[role]').forEach((el) => {
    const role = (el.getAttribute('role') || '').toLowerCase();
    if (!INTERACTIVE_ROLES.has(role)) return;
    if (!isVisible(el)) return;
    if (isDisabled(el)) return;
    if (el.hasAttribute('tabindex')) return;            // author is managing focus explicitly
    if (FOCUSABLE_TAGS.has(el.tagName)) return;         // native element already focusable
    if (el.isContentEditable) return;
    if (el.getAttribute('aria-disabled') === 'true') return;
    // Roving-tabindex guard: if any sibling with the same role carries
    // tabindex, the widget is managing focus and this is likely intentional.
    if (ROVING_ROLES.has(role)) {
      const scope = el.closest('[role="tablist"],[role="menu"],[role="menubar"],[role="listbox"],[role="radiogroup"],[role="tree"]') || el.parentElement;
      if (scope && scope.querySelector(`[role="${role}"][tabindex]`)) return;
    }
    // aria-activedescendant widgets (combobox/listbox/tree/grid — Downshift,
    // Headless UI, react-select, CDK listbox): DOM focus stays on the owner and
    // the active item is announced via aria-activedescendant. The items are
    // correctly NOT focusable themselves.
    const OWNER = '[role="listbox"],[role="tree"],[role="grid"],[role="treegrid"],[role="menu"],[role="menubar"],'
      + '[role="tablist"],[role="radiogroup"],[role="combobox"]';
    const owner = el.closest(OWNER);
    if (owner && owner !== el) {
      if (owner.hasAttribute('aria-activedescendant') || isFocusable(owner)) return;
      if (owner.id) {
        const esc = window.CSS && CSS.escape ? CSS.escape(owner.id) : owner.id;
        try {
          if (document.querySelector(`[aria-activedescendant][aria-controls~="${esc}"],[aria-activedescendant][aria-owns~="${esc}"]`)) return;
        } catch (e) { /* ignore */ }
      }
    }
    if (el.id) {
      try { if (document.querySelector(`[aria-activedescendant="${window.CSS && CSS.escape ? CSS.escape(el.id) : el.id}"]`)) return; } catch (e) { /* ignore */ }
    }
    if (candidates.has(el)) return;                     // already reported above, don't double-count
    roleOut.push({
      html: el.outerHTML.slice(0, 300),
      sel: selOf(el),
      tag: el.tagName.toLowerCase(),
      role,
      text: (el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 60),
    });
  });

  return { handlers: out.slice(0, 40), review: review.slice(0, 40), roles: roleOut.slice(0, 40) };
}

/**
 * @param {import('playwright').Page} page
 * @returns {Promise<{violations: Array, incomplete: Array, passes: Array}>}
 */
async function clickableChecks(page) {
  const out = { violations: [], incomplete: [], passes: [] };
  let found;
  try { found = await page.evaluate(findUnreachable); }
  catch (e) { return out; }
  if (!found) return out;

  const handlers = found.handlers || [];
  const review = found.review || [];
  const roles = found.roles || [];

  if (handlers.length) {
    out.violations.push(result(
      'kbd-click-not-focusable',
      'Element responds to mouse click but cannot be reached or activated by keyboard',
      'critical',
      ['cat.keyboard', 'wcag2a', 'wcag211'],
      handlers.map((f) => node('critical', f.html, f.sel,
        `This <${f.tag}> has a click handler (${f.reasons.join('; ')}) but is not keyboard-focusable`
        + (f.hasInteractiveRole ? ' — it has an interactive ARIA role but no tabindex, so assistive tech announces it as actionable while the keyboard cannot reach it.' : ' and has no interactive role.')
        + ' A keyboard-only user cannot perform this action.'
        + ' Fix: use a native <button>, or add tabindex="0" + role + an Enter/Space keydown handler.')),
    ));
  } else {
    out.passes.push(result('kbd-click-not-focusable',
      'All click-handling elements are keyboard reachable', null, ['wcag2a', 'wcag211'], []));
  }

  if (review.length) {
    out.incomplete.push(result(
      'kbd-click-not-focusable-review',
      'Element has its own click handler and is not keyboard-focusable, but contains a focusable control',
      'serious',
      ['cat.keyboard', 'wcag2a', 'wcag211'],
      review.map((f) => node('serious', f.html, f.sel,
        f.delegated
          ? `This <${f.tag}> has a click listener (${f.reasons.join('; ')}) on a container or app root, which usually means it delegates clicks for its children. `
            + 'Verify the children it acts on are keyboard reachable (buttons/links or tabindex + key handling).'
          : `This <${f.tag}> has its own click handler (${f.reasons.join('; ')}) and is not keyboard-focusable. `
        + `It contains a focusable <${f.childTag}>${f.childName ? ` ("${f.childName}")` : ''}, which may or may not perform the same action. `
        + 'Verify manually: if the container performs a DISTINCT action (e.g. opening an editor) that the inner control does not, keyboard users cannot reach it and this is a 2.1.1 failure. '
        + 'If an equivalent keyboard-reachable control for the same action exists elsewhere in the row or view, the functionality is operable and this is a redundant mouse-only affordance rather than a blocker.')),
    ));
  }

  if (roles.length) {
    out.violations.push(result(
      'kbd-role-not-focusable',
      'Element has an interactive ARIA role but is not keyboard-focusable',
      'serious',
      ['cat.keyboard', 'wcag2a', 'wcag211'],
      roles.map((f) => node('serious', f.html, f.sel,
        `This <${f.tag}> declares role="${f.role}", so assistive technology announces it as an interactive control, `
        + 'but it has no tabindex and is not a natively focusable element — keyboard and screen-reader users cannot reach it. '
        + 'Fix: add tabindex="0" (plus Enter/Space key handling), or use the native element for this role.')),
    ));
  } else {
    out.passes.push(result('kbd-role-not-focusable',
      'All elements with interactive ARIA roles are keyboard reachable', null, ['wcag2a', 'wcag211'], []));
  }
  return out;
}

module.exports = { clickableChecks, instrumentListeners };
