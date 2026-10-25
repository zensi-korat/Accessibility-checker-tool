/**
 * Dynamic KEYBOARD testing — the part axe can't do statically.
 *
 * Drives the real keyboard: presses Tab across the page, records the focus
 * order, and checks each stop for a visible focus indicator. Detects keyboard
 * traps (focus stuck on one element) and positive tabindex (broken order).
 *
 * Emits axe-shaped results ({violations, incomplete, passes}) tagged with WCAG
 * criteria, so they merge straight into the existing aggregate/report pipeline:
 *   kbd-focus-visible   → 2.4.7 Focus Visible
 *   kbd-keyboard-trap   → 2.1.2 No Keyboard Trap
 *   kbd-positive-tabindex → 2.4.3 Focus Order
 */

const HELP_URLS = {
  'kbd-focus-visible': 'https://www.w3.org/WAI/WCAG22/Understanding/focus-visible.html',
  'kbd-keyboard-trap': 'https://www.w3.org/WAI/WCAG22/Understanding/no-keyboard-trap.html',
  'kbd-positive-tabindex': 'https://www.w3.org/WAI/WCAG22/Understanding/focus-order.html',
};

function result(id, help, impact, tags, nodes) {
  return { id, help, description: help, helpUrl: HELP_URLS[id] || '', impact, tags, nodes };
}
function node(impact, html, sel, failureSummary) {
  return { impact, html: String(html || '').slice(0, 400), target: [sel], failureSummary };
}

// Collects info about the currently-focused element and records the styles
// that can carry a focus indicator. Self-contained (runs in the browser via
// page.evaluate). `i` tags the element so its UNFOCUSED styles can be read
// after the walk and compared — a focus indicator is a visible CHANGE, not the
// mere presence of an outline/box-shadow (a raised button's resting shadow is
// not a focus ring; MUI/Material/Vuetify signal focus with a background
// change, a ::before overlay or a ring on a :focus-within wrapper).
function readActive(i) {
  const el = document.activeElement;
  if (!el || el === document.body || el === document.documentElement) return null;
  const cs = getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  const name = (el.getAttribute('aria-label') || el.innerText || el.value ||
    el.getAttribute('title') || el.getAttribute('placeholder') || '').trim().replace(/\s+/g, ' ').slice(0, 40);
  // Unique selector: the same tag.class on six "Edit" row links must not look
  // like one element (that read as a keyboard trap and merged findings).
  const selOf = (e) => {
    const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : s);
    if (e.id && document.querySelectorAll('#' + esc(e.id)).length === 1) return e.tagName.toLowerCase() + '#' + esc(e.id);
    const parts = [];
    let n = e;
    while (n && n.nodeType === 1 && n !== document.body && parts.length < 8) {
      if (n.id && document.querySelectorAll('#' + esc(n.id)).length === 1) { parts.unshift('#' + esc(n.id)); break; }
      let part = n.tagName.toLowerCase();
      const p = n.parentElement;
      if (p) {
        const same = Array.from(p.children).filter((c) => c.tagName === n.tagName);
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(n) + 1) + ')';
      }
      parts.unshift(part);
      n = n.parentElement;
    }
    return parts.join(' > ');
  };
  const tag = el.tagName.toLowerCase();
  // Focus that sits on an iframe, a shadow host or a media element has really
  // moved INSIDE it (document.activeElement stays on the outer element while
  // Tab walks the embedded content), so it is neither a trap nor checkable here.
  const widget = tag === 'iframe' || tag === 'frame' || tag === 'object' || tag === 'embed'
    || tag === 'video' || tag === 'audio' || !!(el.shadowRoot && el.shadowRoot.activeElement)
    || (tag.includes('-') && !!el.shadowRoot);
  const ti = el.getAttribute('tabindex');
  const prior = el.getAttribute('data-a11y-kbd');
  if (prior === null) el.setAttribute('data-a11y-kbd', String(i));
  return {
    tag, name, sel: selOf(el), idx: prior === null ? i : Number(prior), widget,
    html: el.outerHTML.slice(0, 300).replace(/\sdata-a11y-kbd="\d+"/, ''),
    visible: rect.width > 0 && rect.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none',
    focusStyle: window.__a11yFocusStyle(el),
    tabindex: ti !== null && ti !== '' ? parseInt(ti, 10) : null,
  };
}

// Installed once before the walk: a style snapshot of the element, its
// ::before/::after and up to three ancestors (focus-within rings). Outlines and
// borders that are transparent or zero-width are normalised away, so
// `outline: 2px solid transparent` doesn't count as visible.
function installStyleReader() {
  const transparent = (c) => !c || c === 'transparent' || /rgba\([^)]*,\s*0(\.0+)?\)$/.test(c);
  const outline = (cs) => (cs.outlineStyle === 'none' || !(parseFloat(cs.outlineWidth) > 0) || transparent(cs.outlineColor)
    ? 'none' : `${cs.outlineStyle} ${cs.outlineWidth} ${cs.outlineColor} ${cs.outlineOffset}`);
  const border = (cs) => ['Top', 'Right', 'Bottom', 'Left'].map((s) => (cs[`border${s}Style`] === 'none' || !(parseFloat(cs[`border${s}Width`]) > 0) || transparent(cs[`border${s}Color`])
    ? 'none' : `${cs[`border${s}Width`]} ${cs[`border${s}Color`]}`)).join('|');
  const pseudo = (el, which) => {
    const cs = getComputedStyle(el, which);
    if (!cs.content || cs.content === 'none' || cs.content === 'normal') return 'none';
    return [cs.content, cs.opacity, cs.backgroundColor, cs.boxShadow, outline(cs), border(cs), cs.transform, cs.width, cs.height].join(';');
  };
  window.__a11yFocusStyle = (el) => {
    const cs = getComputedStyle(el);
    const self = [outline(cs), cs.boxShadow, cs.backgroundColor, cs.backgroundImage, border(cs), cs.color,
      cs.textDecorationLine, cs.textDecorationColor, cs.opacity, cs.transform, cs.filter,
      pseudo(el, '::before'), pseudo(el, '::after')].join('§');
    const anc = [];
    let a = el.parentElement;
    for (let k = 0; a && a !== document.body && k < 3; k++, a = a.parentElement) {
      const ac = getComputedStyle(a);
      anc.push([outline(ac), ac.boxShadow, ac.backgroundColor, border(ac), pseudo(a, '::before'), pseudo(a, '::after')].join(';'));
    }
    return self + '#' + anc.join('#');
  };
  // Transitions would make the snapshot catch a ring half-drawn.
  const st = document.createElement('style');
  st.id = '__a11y-kbd-notransition';
  st.textContent = '*,*::before,*::after{transition:none!important;animation-play-state:paused!important}';
  document.head.appendChild(st);
}

async function keyboardChecks(page, opts = {}) {
  const maxTabs = opts.maxTabs || 40;
  const out = { violations: [], incomplete: [], passes: [] };

  // Start from the top of the document.
  await page.evaluate(() => {
    if (document.activeElement && document.activeElement !== document.body) {
      try { document.activeElement.blur(); } catch (e) {}
    }
    window.scrollTo(0, 0);
  }).catch(() => {});
  const ready = await page.evaluate(installStyleReader).then(() => true).catch(() => false);
  if (!ready) return out;

  const path = [];
  let lastSig = null;
  let stuck = 0;
  let widgetStuck = 0;
  let trapAt = null;
  let widgetTrapAt = null;

  for (let i = 0; i < maxTabs; i++) {
    await page.keyboard.press('Tab').catch(() => {});
    let info;
    try { info = await page.evaluate(readActive, i); } catch (e) { info = null; }
    if (!info) { lastSig = null; stuck = 0; widgetStuck = 0; continue; }
    const sig = info.sel;
    const repeat = sig === lastSig;
    if (repeat) {
      // Inside an iframe / web component / media player, Tab legitimately
      // stays on the outer element for many presses.
      if (info.widget) widgetStuck += 1; else stuck += 1;
    } else { stuck = 0; widgetStuck = 0; }
    lastSig = sig;
    if (stuck >= 4 && !trapAt) { trapAt = info; break; } // focus not advancing → trap
    if (widgetStuck >= 15 && !widgetTrapAt) { widgetTrapAt = info; break; }
    if (repeat) continue; // same stop again — already recorded
    path.push(info);
  }

  // Unfocused styles of every stop, read after the walk with focus cleared.
  let unfocused = {};
  try {
    unfocused = await page.evaluate(() => {
      if (document.activeElement && document.activeElement !== document.body) {
        try { document.activeElement.blur(); } catch (e) {}
      }
      const o = {};
      for (const el of document.querySelectorAll('[data-a11y-kbd]')) {
        o[el.getAttribute('data-a11y-kbd')] = window.__a11yFocusStyle(el);
        el.removeAttribute('data-a11y-kbd');
      }
      const st = document.getElementById('__a11y-kbd-notransition');
      if (st) st.remove();
      return o;
    });
  } catch (e) { unfocused = {}; }
  for (const p of path) {
    const before = unfocused[String(p.idx)];
    // No baseline (element re-rendered/removed) → no verdict either way.
    p.hasIndicator = before === undefined ? null : before !== p.focusStyle;
  }

  // 2.4.7 Focus Visible — stops with no visible indicator.
  const noIndicator = [];
  const seen = new Set();
  for (const p of path) {
    if (!p.visible || p.widget) continue;
    if (p.hasIndicator !== false) continue;
    if (seen.has(p.sel)) continue;
    seen.add(p.sel);
    noIndicator.push(p);
  }
  if (noIndicator.length) {
    out.violations.push(result('kbd-focus-visible',
      'Keyboard-focusable element has no visible focus indicator', 'serious',
      ['cat.keyboard', 'wcag2aa', 'wcag247'],
      noIndicator.slice(0, 20).map((p) => node('serious', p.html, p.sel,
        'This element received keyboard focus but nothing about it (or its wrapper) changed visibly: no outline, ring, background, border or underline change. Add a visible :focus-visible style.'))));
  } else if (path.length) {
    out.passes.push(result('kbd-focus-visible', 'Focus indicators visible on keyboard focus', null, ['wcag2aa', 'wcag247'], []));
  }

  // 2.1.2 No Keyboard Trap.
  if (trapAt) {
    out.incomplete.push(result('kbd-keyboard-trap',
      'Possible keyboard trap — focus did not advance past this element', 'critical',
      ['cat.keyboard', 'wcag2a', 'wcag212'],
      [node('critical', trapAt.html, trapAt.sel,
        'Pressing Tab repeatedly kept focus on this element. Verify a keyboard user can Tab past it (and out of any dialog).')]));
  } else if (widgetTrapAt) {
    out.incomplete.push(result('kbd-keyboard-trap',
      'Focus stayed inside an embedded widget for many Tab presses', 'serious',
      ['cat.keyboard', 'wcag2a', 'wcag212'],
      [node('serious', widgetTrapAt.html, widgetTrapAt.sel,
        'Focus moved into this iframe / embedded component and stayed there for 15+ Tab presses. Verify a keyboard user can Tab back out of it.')]));
  } else if (path.length) {
    out.passes.push(result('kbd-keyboard-trap', 'No keyboard trap detected in tab sequence', null, ['wcag2a', 'wcag212'], []));
  }

  // 2.4.3 Focus Order — positive tabindex breaks natural order.
  const positives = [];
  const seenTi = new Set();
  for (const p of path) {
    if (p.tabindex && p.tabindex > 0 && !seenTi.has(p.sel)) { seenTi.add(p.sel); positives.push(p); }
  }
  if (positives.length) {
    out.violations.push(result('kbd-positive-tabindex',
      'Positive tabindex found — overrides natural focus order', 'moderate',
      ['cat.keyboard', 'wcag2a', 'wcag243'],
      positives.slice(0, 15).map((p) => node('moderate', p.html, p.sel,
        'Use tabindex="0" (in natural order) or "-1" (programmatic only). Positive values create a brittle, confusing focus order.'))));
  } else if (path.length) {
    out.passes.push(result('kbd-positive-tabindex', 'No positive tabindex in focus order', null, ['wcag2a', 'wcag243'], []));
  }

  return out;
}

module.exports = { keyboardChecks };
