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

// Collects info about the currently-focused element. Self-contained (runs in
// the browser via page.evaluate).
function readActive() {
  const el = document.activeElement;
  if (!el || el === document.body || el === document.documentElement) return null;
  const cs = getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  const name = (el.getAttribute('aria-label') || el.innerText || el.value ||
    el.getAttribute('title') || el.getAttribute('placeholder') || '').trim().replace(/\s+/g, ' ').slice(0, 40);
  let sel = el.tagName.toLowerCase();
  if (el.id) sel += '#' + el.id;
  else if (typeof el.className === 'string' && el.className.trim()) {
    sel += '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.');
  }
  // Focus indicator: during a REAL keyboard Tab, :focus-visible matches, so the
  // computed outline / box-shadow already includes any focus ring. If both are
  // absent the element has no visible indicator on keyboard focus.
  const hasOutline = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0;
  const hasShadow = !!cs.boxShadow && cs.boxShadow !== 'none';
  const ti = el.getAttribute('tabindex');
  return {
    tag: el.tagName.toLowerCase(), name, sel,
    html: el.outerHTML.slice(0, 300),
    visible: rect.width > 0 && rect.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none',
    hasIndicator: hasOutline || hasShadow,
    tabindex: ti !== null && ti !== '' ? parseInt(ti, 10) : null,
  };
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

  const path = [];
  let lastSig = null;
  let stuck = 0;
  let trapAt = null;

  for (let i = 0; i < maxTabs; i++) {
    await page.keyboard.press('Tab').catch(() => {});
    let info;
    try { info = await page.evaluate(readActive); } catch (e) { info = null; }
    if (!info) { lastSig = null; stuck = 0; continue; }
    const sig = info.sel + '|' + info.name;
    if (sig === lastSig) stuck += 1; else stuck = 0;
    lastSig = sig;
    if (stuck >= 4 && !trapAt) { trapAt = info; break; } // focus not advancing → trap
    path.push(info);
  }

  // 2.4.7 Focus Visible — stops with no visible indicator.
  const noIndicator = [];
  const seen = new Set();
  for (const p of path) {
    if (!p.visible) continue;
    if (p.hasIndicator) continue;
    if (seen.has(p.sel)) continue;
    seen.add(p.sel);
    noIndicator.push(p);
  }
  if (noIndicator.length) {
    out.violations.push(result('kbd-focus-visible',
      'Keyboard-focusable element has no visible focus indicator', 'serious',
      ['cat.keyboard', 'wcag2aa', 'wcag247'],
      noIndicator.slice(0, 20).map((p) => node('serious', p.html, p.sel,
        'This element received keyboard focus but showed no visible outline or box-shadow. Add a visible :focus-visible style.'))));
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
