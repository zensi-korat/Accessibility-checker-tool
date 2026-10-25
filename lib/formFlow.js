/**
 * FORM FLOW testing — 3.3.7 Redundant Entry and 3.3.4 Error Prevention.
 *
 * Both were previously written off as manual because "which flows are legal or
 * financial" and "is this the same step of the same process" sound like they
 * need human knowledge. They do — but only ONCE, and only as a declaration.
 * Everything after that is mechanical:
 *
 *   3.3.7 — asking for the same information twice is a comparison of field
 *           identities. No semantics required: normalise each field to
 *           (autocomplete token | label | type) and look for repeats within a
 *           process, where the second instance is empty and editable.
 *
 *   3.3.4 — the human decides once, in config, which URL patterns are legal /
 *           financial / data-destroying. From then on the tool asserts that
 *           each of those pages actually carries a confirmation, review step
 *           or undo. The judgement is declared; the enforcement is automated.
 *
 * This is the pattern worth generalising: let a person classify once, then
 * check it forever. It is the difference between a criterion that is audited
 * annually and one that is regression-tested on every run.
 *
 * Emits axe-shaped results:
 *   ff-redundant-entry     → 3.3.7 Redundant Entry
 *   ff-no-error-prevention → 3.3.4 Error Prevention (Legal, Financial, Data)
 */

const HELP_URLS = {
  'ff-redundant-entry': 'https://www.w3.org/WAI/WCAG22/Understanding/redundant-entry.html',
  'ff-no-error-prevention': 'https://www.w3.org/WAI/WCAG22/Understanding/error-prevention-legal-financial-data.html',
};

function result(id, help, impact, tags, nodes) {
  return { id, help, description: help, helpUrl: HELP_URLS[id] || '', impact, tags, nodes };
}
function node(impact, html, sel, failureSummary) {
  return { impact, html: String(html || '').slice(0, 400), target: [sel], failureSummary };
}

// Asking again on purpose is allowed and common — these are not redundant.
const DELIBERATE_REPEAT = /\b(confirm|re-?enter|re-?type|repeat|verify|again|match)\b/i;

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
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
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
    return (el.getAttribute('placeholder') || el.getAttribute('name') || '').trim();
  };

  const fields = [];
  for (const el of document.querySelectorAll('input, select, textarea')) {
    const type = (el.getAttribute('type') || el.tagName.toLowerCase()).toLowerCase();
    if (['hidden', 'submit', 'button', 'reset', 'image'].indexOf(type) !== -1) continue;
    if (!shown(el)) continue;
    fields.push({
      sel: selOf(el),
      label: labelFor(el).toLowerCase().replace(/[\s:*]+/g, ' ').trim().slice(0, 60),
      autocomplete: (el.getAttribute('autocomplete') || '').toLowerCase(),
      type,
      value: (el.value || '').trim(),
      readOnly: !!el.readOnly || !!el.disabled,
      form: el.closest('form') ? selOf(el.closest('form')) : '(none)',
      html: el.outerHTML.slice(0, 300),
    });
  }

  // Evidence that a consequential action is guarded. Cheap to detect and hard
  // to fake: a confirm() call, a confirmation dialog, or an undo affordance.
  const CONFIRM_RE = /\b(are you sure|confirm|confirmation|please review|review your|undo|cannot be undone|permanently)\b/i;
  let confirmEvidence = null;
  for (const el of document.querySelectorAll('[onclick], [data-confirm], [data-bs-toggle="modal"], [data-toggle="modal"]')) {
    const oc = el.getAttribute('onclick') || '';
    if (/confirm\s*\(/.test(oc) || el.hasAttribute('data-confirm')) {
      confirmEvidence = { sel: selOf(el), via: 'confirm() / data-confirm on the control' };
      break;
    }
  }
  if (!confirmEvidence) {
    for (const d of document.querySelectorAll('[role="dialog"], [role="alertdialog"], .modal, dialog')) {
      const t = (d.innerText || d.textContent || '');
      if (CONFIRM_RE.test(t)) { confirmEvidence = { sel: selOf(d), via: 'a confirmation dialog in the page' }; break; }
    }
  }
  if (!confirmEvidence) {
    for (const b of document.querySelectorAll('button, a, input[type=submit]')) {
      const t = (b.innerText || b.value || '').trim();
      if (/^(undo|revert|restore|cancel request|withdraw)$/i.test(t)) {
        confirmEvidence = { sel: selOf(b), via: 'an undo control' }; break;
      }
    }
  }

  return { fields, confirmEvidence, path: location.pathname };
}

/** Field identity: autocomplete token wins, else the label, else name+type. */
const identity = (f) => (f.autocomplete && f.autocomplete !== 'off' && f.autocomplete !== 'on')
  ? 'ac:' + f.autocomplete
  : (f.label ? 'lb:' + f.label : null);

/**
 * Per-page check. Cross-page redundancy is handled by evaluateFlowAcrossPages.
 *
 * @param {import('playwright').Page} page
 * @param {{flows?: Array<{name:string, pattern:string}>}} [opts]
 *        flows — the declared consequential set, e.g.
 *        [{ name: 'Payroll submission', pattern: '/manage/payroll' }]
 */
async function formFlowChecks(page, opts = {}) {
  const out = { violations: [], incomplete: [], passes: [], signature: null };
  let d;
  try { d = await page.evaluate(probe); } catch { return out; }
  if (!d) return out;

  // Expose this page's field identities so the cross-page pass can use them.
  out.signature = {
    path: d.path,
    fields: d.fields.map((f) => ({ id: identity(f), sel: f.sel, prefilled: !!f.value, readOnly: f.readOnly })),
  };

  // ── 3.3.7, same page ────────────────────────────────────────────────────
  // The same information asked for twice on one screen, both empty and both
  // editable, with no "confirm/repeat" wording to justify it.
  if (d.fields.length) {
    const byId = new Map();
    for (const f of d.fields) {
      const id = identity(f);
      if (!id) continue;
      if (DELIBERATE_REPEAT.test(f.label)) continue; // "Confirm email" is fine
      if (f.readOnly || f.value) continue;           // already answered for the user
      if (!byId.has(id)) byId.set(id, []);
      byId.get(id).push(f);
    }
    const dupes = [...byId.values()].filter((g) => g.length > 1);
    if (dupes.length) {
      out.violations.push(result('ff-redundant-entry',
        'The same information is requested more than once', 'moderate',
        ['cat.forms', 'wcag22a', 'wcag337'],
        dupes.slice(0, 10).map((g) => node('moderate', g[0].html, g[0].sel,
          `${g.length} empty, editable fields on this page ask for the same thing ("${g[0].label || g[0].autocomplete}"). Populate the later one automatically, offer a "same as above" option, or make it read-only. Re-entry is only allowed when it is essential, the value has changed, or the earlier value is no longer valid.`))));
    } else {
      out.passes.push(result('ff-redundant-entry',
        'No information is requested twice on this page', null, ['wcag22a', 'wcag337'], []));
    }
  }

  // ── 3.3.4 Error Prevention ──────────────────────────────────────────────
  // Only evaluated on pages the team has DECLARED consequential. Without that
  // declaration the criterion is silent rather than guessed at — the tool
  // cannot know that "Submit" means payroll.
  const flows = opts.flows || [];
  const hit = flows.find((f) => {
    try { return new RegExp(f.pattern, 'i').test(d.path); } catch { return d.path.includes(f.pattern); }
  });
  if (hit) {
    if (d.confirmEvidence) {
      out.passes.push(result('ff-no-error-prevention',
        `Consequential flow "${hit.name}" has a confirmation or undo mechanism`,
        null, ['wcag2aa', 'wcag334'], []));
    } else {
      out.violations.push(result('ff-no-error-prevention',
        'Consequential action has no confirmation, review step or undo', 'serious',
        ['cat.forms', 'wcag2aa', 'wcag334'],
        [node('serious', '', 'body',
          `This page is declared as the consequential flow "${hit.name}", but no confirmation dialog, review step or undo control was found. Submissions that are legal, financial, or that delete user data must be reversible, checked, or confirmed before they commit.`)]));
    }
  }

  return out;
}

/**
 * 3.3.7 across pages of one process. Two pages belong to the same process when
 * they share a path prefix — for a file-routed app that is the section, which
 * is the closest mechanical proxy for "the same multi-step flow".
 *
 * @param {Record<string, {path: string, fields: Array}>} signatures  page -> signature
 */
function evaluateFlowAcrossPages(signatures, opts = {}) {
  const depth = opts.depth || 2;
  const out = {};
  const prefixOf = (p) => '/' + String(p || '').split('/').filter(Boolean).slice(0, depth).join('/');

  const groups = new Map();
  for (const [page, sig] of Object.entries(signatures)) {
    if (!sig || !sig.fields) continue;
    const k = prefixOf(sig.path);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push({ page, sig });
  }

  for (const [prefix, members] of groups) {
    if (members.length < 2) continue; // not a multi-step flow
    const seen = new Map(); // identity -> first page that asked
    for (const { page, sig } of members) {
      for (const f of sig.fields) {
        if (!f.id) continue;
        if (!seen.has(f.id)) { seen.set(f.id, page); continue; }
        const first = seen.get(f.id);
        if (first === page) continue;
        // Asked before, and this page asks again without pre-filling it.
        if (f.prefilled || f.readOnly) continue;
        out[page] = out[page] || { violations: [], passes: [] };
        out[page].violations.push(result('ff-redundant-entry',
          'Information already collected earlier in this process is requested again', 'moderate',
          ['cat.forms', 'wcag22a', 'wcag337'],
          [node('moderate', '', f.sel,
            `"${f.id.replace(/^(ac|lb):/, '')}" was already collected on "${first}" within ${prefix}, and this page asks for it again with an empty, editable field. Pre-populate it from the earlier step, or make it selectable from the previously entered value.`)]));
      }
    }
  }
  return out;
}

module.exports = { formFlowChecks, evaluateFlowAcrossPages, identity };
