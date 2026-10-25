/**
 * NON-TEXT CONTRAST — 1.4.11.
 *
 * Neither engine covers this usefully: axe has no rule at all, and IBM's only
 * contribution is style_highcontrast_visible, which is about forced-colors
 * mode rather than the 3:1 boundary requirement. So 1.4.11 has been reporting
 * "not tested" while the VPAT calls it Partially Supports.
 *
 * 1.4.11 requires that the visual information needed to identify a user
 * interface component has at least 3:1 contrast against what is adjacent to
 * it. For a form control or button, that boundary is one of two things:
 *   - a border, if it has one        → border colour vs the surface behind it
 *   - otherwise its own fill         → control background vs parent background
 *
 * Both are resolvable from computed style whenever the relevant backgrounds
 * are opaque, which they usually are for controls. Where they are not — a
 * control sitting on an image or a gradient — this reports "review" rather
 * than guessing, matching lib/contrastPixel.js.
 *
 * Deliberate exemptions, per the criterion's own scope:
 *   - disabled/inactive controls are exempt
 *   - plain inline links are not "components" for this purpose; their
 *     distinguishability is 1.4.1's job, not 1.4.11's
 *   - pure-text buttons with no border and no fill convey themselves through
 *     their text, which 1.4.3 already measures
 *
 * Emits axe-shaped results:
 *   uic-component-boundary → 1.4.11 Non-text Contrast
 */

const { ratio } = require('./contrastPixel');

const HELP_URL = 'https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html';
const TAGS = ['cat.color', 'wcag21aa', 'wcag1411'];

function result(id, help, impact, tags, nodes) {
  return { id, help, description: help, helpUrl: HELP_URL, impact, tags, nodes };
}
function node(impact, html, sel, failureSummary) {
  return { impact, html: String(html || '').slice(0, 400), target: [sel], failureSummary };
}

function probe() {
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
  const parse = (c) => {
    const m = String(c || '').match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(',').map((v) => parseFloat(v.trim()));
    return { rgb: [p[0], p[1], p[2]], a: p.length > 3 ? p[3] : 1 };
  };
  // The first opaque background colour up the tree, plus whether anything on
  // the way there makes the answer unreliable (an image or a gradient).
  const surfaceBehind = (start) => {
    let uncertain = false;
    for (let p = start; p; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') uncertain = true;
      const bg = parse(cs.backgroundColor);
      if (bg && bg.a >= 0.95) return { rgb: bg.rgb, uncertain };
    }
    return { rgb: [255, 255, 255], uncertain }; // canvas default
  };

  const SEL = 'button, input, select, textarea, [role="button"], [role="checkbox"],'
    + ' [role="radio"], [role="switch"], [role="tab"], [role="slider"], [role="combobox"]';
  const out = [];
  for (const el of document.querySelectorAll(SEL)) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue; // exempt
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (['hidden', 'image'].indexOf(type) !== -1) continue;

    const bw = Math.max(
      parseFloat(cs.borderTopWidth) || 0, parseFloat(cs.borderBottomWidth) || 0,
      parseFloat(cs.borderLeftWidth) || 0, parseFloat(cs.borderRightWidth) || 0);
    const border = parse(cs.borderTopColor);
    const fill = parse(cs.backgroundColor);
    const behind = surfaceBehind(el.parentElement);

    out.push({
      sel: selOf(el),
      html: el.outerHTML.slice(0, 300),
      borderWidth: bw,
      borderStyle: cs.borderTopStyle,
      border: border && border.a >= 0.95 ? border.rgb : null,
      fill: fill && fill.a >= 0.95 ? fill.rgb : null,
      behind: behind.rgb,
      uncertain: behind.uncertain,
      hasText: !!(el.innerText || el.value || '').trim(),
      tag: el.tagName.toLowerCase(),
    });
  }
  return out.slice(0, 200);
}

async function uiContrastChecks(page, opts = {}) {
  const out = { violations: [], incomplete: [], passes: [] };
  const need = opts.min ?? 3;
  let items;
  try { items = await page.evaluate(probe); } catch { return out; }
  if (!items || !items.length) return out; // no components — no verdict

  const hex = (c) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
  const fails = [];
  const review = [];
  let checked = 0;

  for (const it of items) {
    const drawnBorder = it.borderWidth > 0 && it.borderStyle !== 'none' && it.border;
    let r = null; let via = null; let against = null;

    if (drawnBorder) {
      r = ratio(it.border, it.behind); via = 'its border'; against = it.behind;
    } else if (it.fill) {
      // No border, so the fill is what distinguishes the control. Identical
      // fill and surround means no visible boundary at all.
      r = ratio(it.fill, it.behind); via = 'its background'; against = it.behind;
    } else {
      // Neither border nor opaque fill: a text-only control. 1.4.3 covers its
      // text, and there is no non-text information to measure here.
      continue;
    }

    if (it.uncertain) { review.push({ ...it, r, via }); continue; }
    checked += 1;
    if (r < need) fails.push({ ...it, r, via, against });
  }

  if (fails.length) {
    out.violations.push(result('uic-component-boundary',
      'Component boundary has less than 3:1 contrast against its surroundings', 'serious', TAGS,
      fails.slice(0, 20).map((f) => node('serious', f.html, f.sel,
        `This ${f.tag} is distinguished only by ${f.via} (${hex(f.via === 'its border' ? f.border : f.fill)}) against ${hex(f.against)}, measured at ${f.r.toFixed(2)}:1 — below the 3:1 required to identify a control. Darken the border or give the control a distinguishable fill.`))));
  }
  if (review.length) {
    out.incomplete.push(result('uic-component-boundary',
      'Component sits on an image or gradient — boundary contrast needs a human', null, TAGS,
      review.slice(0, 20).map((f) => node(null, f.html, f.sel,
        `This ${f.tag} sits on a background image or gradient, so the colour behind ${f.via} cannot be resolved from CSS. Check by eye that its boundary reaches 3:1.`))));
  }
  if (!fails.length && checked > 0) {
    out.passes.push(result('uic-component-boundary',
      `Component boundaries meet 3:1 on ${checked} control(s)`, null, ['wcag21aa', 'wcag1411'], []));
  }
  return out;
}

module.exports = { uiContrastChecks };
