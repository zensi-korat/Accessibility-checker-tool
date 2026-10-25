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
    // A heading inside a hidden ancestor (closed modal template) or an
    // aria-hidden / inert subtree is not part of the page's outline.
    if (el.checkVisibility && !el.checkVisibility()) return false;
    if (el.closest('[aria-hidden="true"],[inert]')) return false;
    // Visually-hidden-but-screen-reader-available text is legitimate, so a
    // zero-size box is not on its own a reason to ignore a heading.
    return true;
  };
  // Accessible name, not just innerText: a linked logo heading
  // <h1><a><img alt="Acme"></a></h1> is named "Acme", not empty.
  const textOf = (el) => {
    const lb = el.getAttribute('aria-labelledby');
    if (lb) {
      const t = lb.split(/\s+/).map((id) => { const n = document.getElementById(id); return n ? (n.textContent || '') : ''; }).join(' ').trim();
      if (t) return t.replace(/\s+/g, ' ');
    }
    const al = el.getAttribute('aria-label');
    if (al && al.trim()) return al.trim().replace(/\s+/g, ' ');
    const own = (el.innerText || el.textContent || '').trim();
    const alts = [];
    for (const n of el.querySelectorAll('img[alt],[role="img"][aria-label],svg[aria-label],svg > title,input[type="image"][alt]')) {
      if (n.closest('[aria-hidden="true"]')) continue;
      const v = n.tagName.toLowerCase() === 'title' ? n.textContent : (n.getAttribute('alt') || n.getAttribute('aria-label'));
      if (v && v.trim()) alts.push(v.trim());
    }
    return [own].concat(alts).filter(Boolean).join(' ').replace(/\s+/g, ' ');
  };

  const headings = [];
  for (const el of document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]')) {
    if (!shown(el)) continue;
    const lvl = el.getAttribute('aria-level')
      || (/^h[1-6]$/i.test(el.tagName) ? el.tagName[1] : null);
    // Section the heading belongs to: repeated card headings ("Details" in
    // every card) are distinct by context, so duplicates only count when they
    // share a section.
    const sec = el.parentElement && (el.parentElement.closest('section,article,aside,nav,main,form,dialog,li,td,'
      + '[role="region"],[role="dialog"],[role="article"],[role="listitem"],[role="tabpanel"]') || el.parentElement);
    headings.push({
      sel: selOf(el),
      scope: sec && sec !== document.body ? selOf(sec) : 'body',
      parent: el.parentElement && el.parentElement !== document.body ? selOf(el.parentElement) : 'body',
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
      row: !!el.closest('tr, li, [role="row"], [role="listitem"]'),
      label: labelFor(el).slice(0, 120),
      scope: form ? selOf(form) : '(no form)',
      html: el.outerHTML.slice(0, 300),
    });
  }

  const h1 = Array.prototype.filter.call(document.querySelectorAll('h1'), shown).length;
  return { headings, controls, title: document.title.trim(), h1 };
}

// Text that is present but says nothing. Deliberately conservative — these are
// placeholders nobody intends to ship, not merely terse headings.
const PLACEHOLDER = /^(untitled|title|heading|header|section|subsection|new|tbd|todo|placeholder|lorem(\s+ipsum)?|test|xxx+|n\/?a|-+|\d+(\.\d+)*)$/i;
// The subset no one ships on purpose. The rest of PLACEHOLDER (a bare number,
// a single letter, "Section", "New") is often legitimate — dashboard stat
// headings ("42"), A–Z index headings ("A") — so those only go to review.
const STRONG_PLACEHOLDER = /^(untitled|tbd|todo|placeholder|lorem(\s+ipsum)?|xxx+|heading|title)$/i;
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
  const placeholder = d.headings.filter((h) => h.text && STRONG_PLACEHOLDER.test(h.text));
  if (placeholder.length) {
    bad.push('placeholder');
    out.violations.push(result('hl-heading-placeholder',
      'Heading text is a placeholder', 'moderate', TAGS,
      placeholder.slice(0, 15).map((h) => node('moderate', h.html, h.sel,
        `The heading reads "${h.text}", which does not describe the section it introduces. Replace it with the topic of the content beneath it.`))));
  }
  const terse = d.headings.filter((h) => h.text && !STRONG_PLACEHOLDER.test(h.text)
    && (PLACEHOLDER.test(h.text) || h.text.length < 2));
  if (terse.length) {
    out.incomplete.push(result('hl-heading-placeholder',
      'Heading text may be a placeholder', 'minor', TAGS,
      terse.slice(0, 15).map((h) => node('minor', h.html, h.sel,
        `The heading reads "${h.text}". That is fine for a stat tile or an A–Z index, but not if it was left in as a placeholder — check it describes the content beneath it.`))));
  }

  // ── Duplicate sibling headings at the same level ────────────────────────
  // Repeating a heading at one level makes them useless for navigation: a
  // screen-reader user hears "Details, Details, Details" and cannot choose.
  const byLevel = new Map();
  for (const h of d.headings) {
    if (!h.text || !h.level) continue;
    const k = h.scope + '|' + h.level + '|' + h.text.toLowerCase();
    if (!byLevel.has(k)) byLevel.set(k, []);
    byLevel.get(k).push(h);
  }
  const dupes = [...byLevel.values()].filter((g) => g.length > 1);
  if (dupes.length) {
    // Identical text in one section may still be justified by visual context
    // (e.g. two "Details" panels side by side), so this is a review item.
    out.incomplete.push(result('hl-heading-duplicate',
      'Several headings at the same level share identical text', 'moderate', TAGS,
      dupes.slice(0, 10).map((g) => node('moderate', g[0].html, g[0].sel,
        `"${g[0].text}" appears ${g.length} times as an h${g[0].level}. Repeated identical headings cannot be told apart in a screen reader's heading list — qualify each one.`))));
  }

  // ── h1 count ────────────────────────────────────────────────────────────
  // This is the common duplicate-H1 shape (site title and page title both <h1>).
  // Not a 2.4.6 failure in itself (WCAG requires headings to be descriptive,
  // not a single h1 — axe treats this as best practice), so it is review only.
  if (d.headings.length && d.h1 !== 1) {
    out.incomplete.push(result('hl-h1-count',
      d.h1 === 0 ? 'Page has no h1' : 'Page has more than one h1', 'minor', TAGS,
      [node('minor', '', 'h1',
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
  const dupGroups = [...byScope.values()].filter((g) => g.length > 1);
  // Repeated rows (a cart's "Quantity" per line item, an editable table) take
  // their context from the row, so those only go to review.
  const dupLabels = dupGroups.filter((g) => !g.every((c) => c.row));
  const dupRows = dupGroups.filter((g) => g.every((c) => c.row));
  if (dupRows.length) {
    out.incomplete.push(result('hl-label-duplicate',
      'Fields in repeated rows share a label', 'minor', TAGS,
      dupRows.slice(0, 10).map((g) => node('minor', g[0].html, g[0].sel,
        `${g.length} controls in repeated rows of ${g[0].scope} are all labelled "${g[0].label}". Check each one's accessible name also identifies its row (e.g. aria-label="Quantity for Blue mug").`))));
  }
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

module.exports = { headingChecks, PLACEHOLDER, STRONG_PLACEHOLDER, GENERIC_LABEL };
