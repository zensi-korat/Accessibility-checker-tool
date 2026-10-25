/**
 * Structural HEADINGS AND LABELS testing — 2.4.6.
 *
 * Neither axe nor IBM covers 2.4.6 meaningfully (IBM's heading_content_exists
 * only checks a heading is non-empty), so the criterion has been reporting
 * "not tested" on every page.
 *
 * "Descriptive" is a semantic judgement no tool can make. But most real 2.4.6
 * failures are not subtle — they are structural, and structure is decidable:
 * an empty heading, two <h1>s, a placeholder left in, two fields in one form
 * sharing a label. Checking those turns 2.4.6 from untested into a real
 * verdict on the mechanical half, leaving a human only the question of whether
 * genuinely-distinct text is genuinely descriptive.
 *
 * Emits axe-shaped results:
 *   hl-heading-empty        → heading with no accessible text
 *   hl-heading-placeholder  → "Untitled", "Section", "TBD", a bare number
 *   hl-heading-duplicate    → sibling headings at one level with identical text
 *   hl-h1-count             → zero or multiple <h1> on a page
 *   hl-label-duplicate      → two controls in one form sharing a label
 *   hl-label-generic        → "Field 1", "Input", "Text"
 */

const HELP_URL = 'https://www.w3.org/WAI/WCAG22/Understanding/headings-and-labels.html';

function result(id, help, impact, tags, nodes) {
  return { id, help, description: help, helpUrl: HELP_URL, impact, tags, nodes };
}
function node(impact, html, sel, failureSummary) {
  return { impact, html: String(html || '').slice(0, 400), target: [sel], failureSummary };
}
const TAGS = ['cat.semantics', 'wcag2aa', 'wcag246'];

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
  const shown = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    // Visually-hidden-but-screen-reader-available text is legitimate, so a
    // zero-size box is not on its own a reason to ignore a heading.
    return true;
  };
  const textOf = (el) => (
    el.getAttribute('aria-label') || el.innerText || el.textContent || ''
  ).trim().replace(/\s+/g, ' ');

  const headings = [];
  for (const el of document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]')) {
    if (!shown(el)) continue;
    const lvl = el.getAttribute('aria-level')
      || (/^h[1-6]$/i.test(el.tagName) ? el.tagName[1] : null);
    headings.push({
      sel: selOf(el),
      level: lvl ? parseInt(lvl, 10) : null,
      text: textOf(el).slice(0, 120),
      html: el.outerHTML.slice(0, 300),
    });
  }

  // Accessible name for a form control, by the usual resolution order.
  const labelFor = (el) => {
    const al = el.getAttribute('aria-label');
    if (al && al.trim()) return al.trim();
    const lb = el.getAttribute('aria-labelledby');
    if (lb) {
      const t = lb.split(/\s+/).map((id) => {
        const n = document.getElementById(id);
        return n ? (n.innerText || n.textContent || '') : '';
      }).join(' ').trim();
      if (t) return t.replace(/\s+/g, ' ');
    }
    if (el.id) {
      const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (l) return (l.innerText || l.textContent || '').trim().replace(/\s+/g, ' ');
    }
    const w = el.closest('label');
    if (w) return (w.innerText || w.textContent || '').trim().replace(/\s+/g, ' ');
    const t = el.getAttribute('title');
    return t ? t.trim() : '';
  };

  const controls = [];
  for (const el of document.querySelectorAll('input,select,textarea')) {
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (['hidden', 'submit', 'button', 'reset', 'image'].indexOf(type) !== -1) continue;
    if (!shown(el)) continue;
    const form = el.closest('form, fieldset');
    controls.push({
      sel: selOf(el),
      label: labelFor(el).slice(0, 120),
      scope: form ? selOf(form) : '(no form)',
      html: el.outerHTML.slice(0, 300),
    });
  }

  return { headings, controls, title: document.title.trim(), h1: document.querySelectorAll('h1').length };
}

// Text that is present but says nothing. Deliberately conservative — these are
// placeholders nobody intends to ship, not merely terse headings.
const PLACEHOLDER = /^(untitled|title|heading|header|section|subsection|new|tbd|todo|placeholder|lorem(\s+ipsum)?|test|xxx+|n\/?a|-+|\d+(\.\d+)*)$/i;
const GENERIC_LABEL = /^(field|input|text|value|select|option|choose|enter|type|item)(\s*\d+)?$/i;

async function headingChecks(page) {
  const out = { violations: [], incomplete: [], passes: [] };
  let d;
  try { d = await page.evaluate(probe); } catch { return out; }
  if (!d) return out;
  // Nothing to judge on this page — emit no verdict rather than a pass.
  if (!d.headings.length && !d.controls.length) return out;

  const bad = [];

  // ── Empty headings ──────────────────────────────────────────────────────
  const empty = d.headings.filter((h) => !h.text);
  if (empty.length) {
    bad.push('empty');
    out.violations.push(result('hl-heading-empty',
      'Heading has no text', 'serious', TAGS,
      empty.slice(0, 15).map((h) => node('serious', h.html, h.sel,
        'This heading contains no text, so it describes nothing and still appears in the screen-reader heading list. Give it text or remove the heading markup.'))));
  }

  // ── Placeholder headings ────────────────────────────────────────────────
  const placeholder = d.headings.filter((h) => h.text && (PLACEHOLDER.test(h.text) || h.text.length < 2));
  if (placeholder.length) {
    bad.push('placeholder');
    out.violations.push(result('hl-heading-placeholder',
      'Heading text is a placeholder', 'moderate', TAGS,
      placeholder.slice(0, 15).map((h) => node('moderate', h.html, h.sel,
        `The heading reads "${h.text}", which does not describe the section it introduces. Replace it with the topic of the content beneath it.`))));
  }

  // ── Duplicate sibling headings at the same level ────────────────────────
  // Repeating a heading at one level makes them useless for navigation: a
  // screen-reader user hears "Details, Details, Details" and cannot choose.
  const byLevel = new Map();
  for (const h of d.headings) {
    if (!h.text || !h.level) continue;
    const k = h.level + '|' + h.text.toLowerCase();
    if (!byLevel.has(k)) byLevel.set(k, []);
    byLevel.get(k).push(h);
  }
  const dupes = [...byLevel.values()].filter((g) => g.length > 1);
  if (dupes.length) {
    bad.push('duplicate');
    out.violations.push(result('hl-heading-duplicate',
      'Several headings at the same level share identical text', 'moderate', TAGS,
      dupes.slice(0, 10).map((g) => node('moderate', g[0].html, g[0].sel,
        `"${g[0].text}" appears ${g.length} times as an h${g[0].level}. Repeated identical headings cannot be told apart in a screen reader's heading list — qualify each one.`))));
  }

  // ── h1 count ────────────────────────────────────────────────────────────
  // This is the common duplicate-H1 shape (site title and page title both <h1>).
  if (d.headings.length && d.h1 !== 1) {
    bad.push('h1');
    out.violations.push(result('hl-h1-count',
      d.h1 === 0 ? 'Page has no h1' : 'Page has more than one h1', 'moderate', TAGS,
      [node('moderate', '', 'h1',
        d.h1 === 0
          ? 'No <h1> on this page, so there is no top-level label for what the page is about. Add one that names the page.'
          : `${d.h1} <h1> elements on this page. Exactly one should name the page; the rest should be h2 or lower so the outline is unambiguous.`)]));
  }

  // ── Duplicate labels within one form ────────────────────────────────────
  const byScope = new Map();
  for (const c of d.controls) {
    if (!c.label) continue;
    const k = c.scope + '|' + c.label.toLowerCase();
    if (!byScope.has(k)) byScope.set(k, []);
    byScope.get(k).push(c);
  }
  const dupLabels = [...byScope.values()].filter((g) => g.length > 1);
  if (dupLabels.length) {
    bad.push('dup-label');
    out.violations.push(result('hl-label-duplicate',
      'Several fields in the same form share a label', 'serious', TAGS,
      dupLabels.slice(0, 10).map((g) => node('serious', g[0].html, g[0].sel,
        `${g.length} controls inside ${g[0].scope} are all labelled "${g[0].label}". A user cannot tell which is which — qualify each (for example "Start date" and "End date").`))));
  }

  // ── Generic labels ──────────────────────────────────────────────────────
  const generic = d.controls.filter((c) => c.label && GENERIC_LABEL.test(c.label));
  if (generic.length) {
    bad.push('generic-label');
    out.violations.push(result('hl-label-generic',
      'Field label does not say what the field is for', 'moderate', TAGS,
      generic.slice(0, 10).map((c) => node('moderate', c.html, c.sel,
        `This field is labelled "${c.label}", which names the widget rather than the data. Say what should be entered.`))));
  }

  if (!bad.length) {
    out.passes.push(result('hl-heading-empty',
      'Headings and labels are present, distinct and non-placeholder', null, ['wcag2aa', 'wcag246'], []));
  }
  return out;
}

module.exports = { headingChecks, PLACEHOLDER, GENERIC_LABEL };
