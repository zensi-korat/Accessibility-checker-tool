/**
 * Dynamic STATUS MESSAGE testing — 4.1.3 and 3.3.1.
 *
 * Neither axe-core nor IBM's engine has a rule for 4.1.3, because the thing it
 * asks about does not exist in a static DOM: "when a status message appears
 * WITHOUT focus moving to it, is it announced to assistive technology?" The
 * message only exists after something causes it, so the test has to act first,
 * then observe.
 *
 * Method:
 *   1. snapshot every visible text node on the page
 *   2. trigger validation (fill invalid values, click submit)
 *   3. snapshot again and diff — new text is a candidate status message
 *   4. for each new message, ask two questions:
 *        did focus move to it?   → if yes, 4.1.3 does not apply, skip it
 *        is it inside a live region? → if no, it is silent to a screen reader
 *
 * Writes never leave the browser: lib/interact.js answers every non-GET with
 * 204, so the submit fires client-side validation and dies at the network
 * boundary. Field values are restored afterwards so the page is left as found.
 *
 * Emits axe-shaped results so they merge into the normal pipeline:
 *   lr-status-not-announced  → 4.1.3 Status Messages
 *   lr-error-not-associated  → 3.3.1 Error Identification
 *
 * IMPORTANT — this module never emits a pass on a page where it could not
 * trigger anything. A page with no forms produces no results at all, so the
 * aggregator reports "not tested" rather than inventing a clean bill of
 * health. Reporting absence of evidence as a pass is the exact bug that had
 * 4.1.3 showing green while the VPAT called it Partially Supports.
 */

const HELP_URLS = {
  'lr-status-not-announced': 'https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html',
  'lr-error-not-associated': 'https://www.w3.org/WAI/WCAG22/Understanding/error-identification.html',
  'lr-error-no-suggestion': 'https://www.w3.org/WAI/WCAG22/Understanding/error-suggestion.html',
};

// ── 3.3.3 Error Suggestion ─────────────────────────────────────────────────
// "Is this advice useful?" is a judgement, but the common failure is not
// subtle: a message that says only THAT something is wrong and never says
// what would be right. "Invalid date." vs "Enter the date as DD/MM/YYYY."
// That distinction is decidable from the message text.
//
// Scope: every message collected here came from submitting an INVALID form,
// so they are all errors. A message that only says a value is MISSING needs no
// suggestion — "Email is required" already states the correction. Everything
// else is about the value being wrong, and must say what right looks like.
const MISSING_ONLY = /\b(required|mandatory|cannot be (?:blank|empty)|must not be (?:blank|empty)|missing)\b/i;
// Guidance means CONCRETE correction information. A bare imperative
// ("Please enter a valid email") is not guidance — it restates the problem.
const HAS_GUIDANCE = [
  /\b(e\.?g\.?|for example|such as|example)\b/i,              // worked example
  /\bformat\b/i,                                              // names the format
  /\b(at least|at most|no more than|no fewer than|minimum|maximum|between)\b/i,
  /\b\d+\s*(characters?|digits?|letters?|numbers?|symbols?)\b/i, // explicit length
  /\b(must (?:be|contain|include|start|end)|should (?:be|contain|include))\b/i,
  /(DD|MM|YYYY|dd\/mm|mm\/dd|yyyy|hh:mm)/,                      // a format mask
  /\b(one of|options are|allowed values?|valid values?)\b/i,     // enumerated set
  /[\w.+-]+@[\w-]+\.[\w.]+/,                                   // a literal sample address
  /\d{1,4}[\/-]\d{1,2}[\/-]\d{1,4}/,                            // a literal sample date
];
const suggestsFix = (t) => HAS_GUIDANCE.some((re) => re.test(t));
// Some apps still show their success text when the guard answers a submit
// with 204. That is a status message (4.1.3 applies) but not an error, so it
// is kept out of 3.3.1 / 3.3.3.
const SUCCESS = /\b(thank(s| you)|success(fully)?|sent|saved|submitted|received|done|completed?|updated)\b/i;
const ERROR_WORDS = /\b(error|invalid|required|must|fail(ed)?|wrong|incorrect|missing|please|enter|cannot|can't|not valid)\b/i;
const isSuccess = (t) => SUCCESS.test(t) && !ERROR_WORDS.test(t);

function result(id, help, impact, tags, nodes) {
  return { id, help, description: help, helpUrl: HELP_URLS[id] || '', impact, tags, nodes };
}
function node(impact, html, sel, failureSummary) {
  return { impact, html: String(html || '').slice(0, 400), target: [sel], failureSummary };
}

/** Everything that runs in the browser. One function, mode-switched. */
function probe(arg) {
  const mode = typeof arg === 'string' ? arg : arg.mode;
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
    if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity || '1') < 0.02) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const ownText = (el) => {
    let t = '';
    for (const n of el.childNodes) if (n.nodeType === 3) t += n.nodeValue;
    return t.trim().replace(/\s+/g, ' ');
  };
  // A live region can be declared on the message itself or on any ancestor
  // container, so this has to walk up rather than check one element.
  const LIVE_ROLES = ['status', 'alert', 'log', 'progressbar', 'marquee', 'timer'];
  const liveInfo = (el) => {
    for (let p = el; p && p !== document.documentElement; p = p.parentElement) {
      const role = (p.getAttribute('role') || '').toLowerCase();
      if (LIVE_ROLES.indexOf(role) !== -1) return { live: true, via: 'role="' + role + '"' };
      const lv = (p.getAttribute('aria-live') || '').toLowerCase();
      if (lv === 'polite' || lv === 'assertive') return { live: true, via: 'aria-live="' + lv + '"' };
    }
    return { live: false, via: null };
  };
  // Is this message wired to a form control, so a screen-reader user hears it
  // when they land on the field? That is what 3.3.1 asks beyond "is it visible".
  const associatedField = (el) => {
    // The reference may point at the message itself, at a wrapper around it
    // (<div id="email-help"><p class="error">…</p></div>) or at an element
    // inside it.
    for (const f of document.querySelectorAll('[aria-describedby], [aria-errormessage]')) {
      const ids = ((f.getAttribute('aria-describedby') || '') + ' ' + (f.getAttribute('aria-errormessage') || '')).split(/\s+/).filter(Boolean);
      for (const id of ids) {
        const ref = document.getElementById(id);
        if (ref && (ref === el || ref.contains(el) || el.contains(ref))) return { sel: selOf(f), via: 'aria-describedby/errormessage', field: f };
      }
    }
    const fs = el.closest('label');
    if (fs) {
      const f = fs.getAttribute('for');
      if (f && document.getElementById(f)) return { sel: '#' + f, via: 'wrapping <label>' };
    }
    return null;
  };

  if (mode === 'snapshot') {
    const out = [];
    const all = document.body ? document.body.querySelectorAll('*') : [];
    for (const el of all) {
      if (!shown(el)) continue;
      const t = ownText(el);
      if (t) out.push(selOf(el) + '\u0000' + t);
    }
    return out;
  }

  if (mode === 'diff') {
    const before = new Set(arg.before);
    const out = [];
    const active = document.activeElement;
    const all = document.body ? document.body.querySelectorAll('*') : [];
    for (const el of all) {
      if (!shown(el)) continue;
      const t = ownText(el);
      if (!t) continue;
      const key = selOf(el) + '\u0000' + t;
      if (before.has(key)) continue;
      const li = liveInfo(el);
      // If focus moved into the new content the user is already there, so
      // 4.1.3 explicitly does not apply — it governs messages that appear
      // without receiving focus.
      let focused = !!(active && (active === el || el.contains(active)));
      const assoc = associatedField(el);
      // The common correct pattern (react-hook-form, Formik, Angular forms):
      // focus moves to the first invalid field and the error is wired to it
      // with aria-describedby / aria-errormessage, so the screen reader reads
      // it on arrival. The user's focus is on the message's field — not a
      // silent status message.
      if (!focused && assoc && active && active !== document.body) {
        const invalidField = active.getAttribute('aria-invalid') === 'true' || (active.matches && active.matches(':invalid'));
        if (assoc.field === active || (invalidField && active.form && assoc.field.form === active.form)) focused = true;
      }
      out.push({
        sel: selOf(el),
        text: t.slice(0, 160),
        html: el.outerHTML.slice(0, 300),
        live: li.live,
        via: li.via,
        focused,
        assoc: assoc ? assoc.sel : null,
        assocVia: assoc ? assoc.via : null,
      });
    }
    return out;
  }

  if (mode === 'forms') {
    const out = [];
    const forms = document.querySelectorAll('form');
    let i = 0;
    for (const f of forms) {
      if (!shown(f)) continue;
      const fields = [];
      for (const el of f.querySelectorAll('input, select, textarea')) {
        const type = (el.getAttribute('type') || el.tagName.toLowerCase()).toLowerCase();
        if (['hidden', 'submit', 'button', 'reset', 'image', 'file', 'password'].indexOf(type) !== -1) continue;
        if (el.disabled || el.readOnly) continue;
        if (!shown(el)) continue;
        fields.push({
          sel: selOf(el), type,
          required: el.hasAttribute('required') || el.getAttribute('aria-required') === 'true',
          value: el.value,
        });
      }
      if (!fields.length) continue;
      const btn = f.querySelector('button[type=submit], input[type=submit], button:not([type])');
      out.push({
        sel: selOf(f),
        index: i,
        fields: fields.slice(0, 20),
        submitSel: btn ? selOf(btn) : null,
        submitLabel: btn ? (btn.innerText || btn.value || '').trim().slice(0, 60) : '',
      });
      i += 1;
    }
    return out;
  }

  return null;
}

// Values chosen to be invalid for their input type, so typed fields produce a
// format error rather than silently accepting the text.
const BAD_VALUE = {
  email: 'not-an-email',
  url: 'not a url',
  tel: 'zz',
  number: 'abc',
  date: '99/99/9999',
  default: 'zz',
};

/**
 * @param {import('playwright').Page} page
 * @param {{guard?: object, maxForms?: number, log?: Function}} [opts]
 */
async function liveRegionChecks(page, opts = {}) {
  const out = { violations: [], incomplete: [], passes: [] };
  const log = opts.log || (() => {});
  const guard = opts.guard || null;
  const maxForms = opts.maxForms || 3;
  const { looksDestructive } = require('./interact');

  let forms = [];
  try { forms = await page.evaluate(probe, 'forms'); } catch { return out; }
  if (!forms.length) return out; // nothing to trigger — emit NOTHING, not a pass

  const messages = [];
  const restore = [];

  if (guard) guard.lock();
  try {
    for (const form of forms.slice(0, maxForms)) {
      // Never drive a form whose own submit says it destroys something. The
      // network guard would stop it anyway; this avoids the wasted attempt.
      if (looksDestructive(form.submitLabel)) {
        log(`      ↷ skipped form ${form.sel} (submit labelled "${form.submitLabel}")`);
        continue;
      }

      const before = await page.evaluate(probe, 'snapshot');

      for (const f of form.fields) {
        try {
          const loc = page.locator(f.sel).first();
          if (f.required) {
            // Empty a required field so submitting reports it as missing.
            await loc.fill('', { timeout: 1500 });
          } else {
            await loc.fill(BAD_VALUE[f.type] || BAD_VALUE.default, { timeout: 1500 });
          }
          restore.push({ sel: f.sel, value: f.value });
        } catch { /* field not fillable (custom widget) — skip it */ }
      }

      // Native constraint validation would refuse to submit an empty required
      // field or a malformed email, so the app's own submit handler — the
      // thing that renders the message we are here to inspect — would never
      // run. Suppressing it costs nothing: the browser's built-in bubbles are
      // not DOM text, are not what 4.1.3 governs, and are announced by the
      // browser anyway. Restored immediately afterwards.
      await page.evaluate((sel) => {
        const f = document.querySelector(sel);
        if (f) { f.__a11yHadNoValidate = f.noValidate; f.noValidate = true; }
      }, form.sel).catch(() => {});

      if (form.submitSel) {
        await page.locator(form.submitSel).first().click({ timeout: 2500 }).catch(() => {});
      }
      await page.waitForTimeout(600);

      await page.evaluate((sel) => {
        const f = document.querySelector(sel);
        if (f && '__a11yHadNoValidate' in f) { f.noValidate = f.__a11yHadNoValidate; delete f.__a11yHadNoValidate; }
      }, form.sel).catch(() => {});

      const added = await page.evaluate(probe, { mode: 'diff', before });
      for (const m of added) if (m.text.length >= 3) messages.push(m);
    }
  } finally {
    // Put every field back the way we found it, so the page is left as found
    // for the checks that run after this one.
    for (const r of restore) {
      await page.locator(r.sel).first().fill(r.value, { timeout: 1500 }).catch(() => {});
    }
    if (guard) guard.unlock();
  }

  if (!messages.length) return out; // triggered, but nothing appeared — no verdict

  // ── 4.1.3 Status Messages ────────────────────────────────────────────────
  // Only messages that did NOT take focus are in scope.
  const unfocused = messages.filter((m) => !m.focused);
  const silent = unfocused.filter((m) => !m.live);
  const announced = unfocused.filter((m) => m.live);

  if (silent.length) {
    out.violations.push(result('lr-status-not-announced',
      'Status message appears without being announced to assistive technology', 'serious',
      ['cat.aria', 'wcag21aa', 'wcag413'],
      silent.slice(0, 15).map((m) => node('serious', m.html, m.sel,
        `After submitting the form this text appeared without focus moving to it ("${m.text}"), and it is not inside a live region — a screen reader user is never told about it. Add role="status" (or role="alert" for errors) to the container, or aria-live="polite".`))));
  } else if (announced.length) {
    out.passes.push(result('lr-status-not-announced',
      'Status messages are announced via a live region', null, ['wcag21aa', 'wcag413'], []));
  }

  // ── 3.3.1 Error Identification ───────────────────────────────────────────
  // Messages produced by submitting an invalid form, minus success text.
  // 3.3.1 itself only requires the error to be identified and described in
  // text — which a visible message does. Linking it to the field is the
  // robust way to do that for screen-reader users (and matters for 1.3.1),
  // so an unlinked message is a review item, not a confirmed failure.
  const errors = messages.filter((m) => !isSuccess(m.text));
  const unlinked = errors.filter((m) => !m.assoc);
  if (unlinked.length) {
    out.incomplete.push(result('lr-error-not-associated',
      'Validation error is not programmatically linked to its field', 'moderate',
      ['cat.forms', 'wcag2a', 'wcag331'],
      unlinked.slice(0, 15).map((m) => node('moderate', m.html, m.sel,
        `This error text ("${m.text}") is shown visually but no field references it. Give the message an id and point the field at it with aria-describedby (or aria-errormessage plus aria-invalid="true"), so it is read out when the field takes focus.`))));
  } else if (errors.length) {
    out.passes.push(result('lr-error-not-associated',
      'Validation errors are linked to their fields', null, ['wcag2a', 'wcag331'], []));
  }

  // ── 3.3.3 Error Suggestion ───────────────────────────────────────────────
  // Only messages complaining about format/validity are in scope; a
  // "this is required" message carries its own correction.
  const formatErrors = errors.filter((m) => !MISSING_ONLY.test(m.text));
  const unhelpful = formatErrors.filter((m) => !suggestsFix(m.text));
  if (unhelpful.length) {
    out.violations.push(result('lr-error-no-suggestion',
      'Validation error says what is wrong but not how to fix it', 'moderate',
      ['cat.forms', 'wcag2aa', 'wcag333'],
      unhelpful.slice(0, 15).map((m) => node('moderate', m.html, m.sel,
        `This message ("${m.text}") reports that the value is wrong without saying what a correct value looks like. Add the expected format or rule — for example "Enter the date as DD/MM/YYYY (e.g. 14/03/2026)" or "Must be at least 8 characters and contain a number".`))));
  } else if (formatErrors.length) {
    out.passes.push(result('lr-error-no-suggestion',
      'Format errors include a correction hint', null, ['wcag2aa', 'wcag333'], []));
  }
  // No format errors at all → no verdict for 3.3.3 on this page.

  return out;
}

module.exports = { liveRegionChecks };
