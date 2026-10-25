/**
 * Dynamic CONTEXT-CHANGE testing — 3.2.1, 3.2.2 and 1.4.13.
 *
 * axe-core has no rule for any of these three, because each is defined by what
 * the page DOES in response to an action, not by what its markup says:
 *
 *   3.2.1 On Focus   — focusing a control must not change context
 *   3.2.2 On Input   — changing a value must not change context, unless warned
 *   1.4.13 Hover/Focus — content revealed on hover or focus must be
 *                        dismissable, hoverable and persistent
 *
 * "Change of context" per WCAG: a new window, a change of focus away from
 * where the user put it, navigation, or a substantial re-layout. Each is
 * observable from the outside, which is what makes these testable at all.
 *
 * Interaction is required, so callers should pass the lib/interact.js guard.
 * Selects are changed and restored; nothing is submitted, and any postback a
 * change triggers dies at the network boundary.
 *
 * Emits axe-shaped results:
 *   cc-focus-context-change → 3.2.1 On Focus
 *   cc-input-context-change → 3.2.2 On Input
 *   cc-hover-not-dismissable / cc-hover-not-persistent → 1.4.13
 *
 * As with lib/liveRegion.js, a page with nothing to exercise produces NO
 * result rather than a pass — absence of evidence is not evidence of absence.
 */

const HELP_URLS = {
  'cc-focus-context-change': 'https://www.w3.org/WAI/WCAG22/Understanding/on-focus.html',
  'cc-input-context-change': 'https://www.w3.org/WAI/WCAG22/Understanding/on-input.html',
  'cc-hover-not-dismissable': 'https://www.w3.org/WAI/WCAG22/Understanding/content-on-hover-or-focus.html',
  'cc-hover-not-persistent': 'https://www.w3.org/WAI/WCAG22/Understanding/content-on-hover-or-focus.html',
};

function result(id, help, impact, tags, nodes) {
  return { id, help, description: help, helpUrl: HELP_URLS[id] || '', impact, tags, nodes };
}
function node(impact, html, sel, failureSummary) {
  return { impact, html: String(html || '').slice(0, 400), target: [sel], failureSummary };
}

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

  // A fingerprint of "where the user is". Any difference between two readings
  // taken around a single action is a change of context.
  if (mode === 'context') {
    const active = document.activeElement;
    const dialogs = document.querySelectorAll('dialog[open], [role="dialog"], [role="alertdialog"], .modal.show, .modal.in');
    let visibleDialogs = 0;
    for (const d of dialogs) if (shown(d)) visibleDialogs += 1;
    return {
      url: location.href,
      active: active ? selOf(active) : null,
      dialogs: visibleDialogs,
      title: document.title,
    };
  }

  if (mode === 'selects') {
    const out = [];
    for (const el of document.querySelectorAll('select')) {
      if (!shown(el) || el.disabled) continue;
      const opts = [];
      for (const o of el.options) if (!o.disabled) opts.push(o.value);
      if (opts.length < 2) continue;
      out.push({ sel: selOf(el), value: el.value, options: opts, html: el.outerHTML.slice(0, 300) });
    }
    return out.slice(0, 12);
  }

  // Triggers that reveal content on hover or focus.
  if (mode === 'hoverTriggers') {
    const out = [];
    const seen = new Set();
    const push = (el, kind) => {
      const s = selOf(el);
      if (seen.has(s) || !shown(el)) return;
      seen.add(s);
      out.push({ sel: s, kind, html: el.outerHTML.slice(0, 300), title: el.getAttribute('title') || '' });
    };
    // A bare title attribute is a guaranteed 1.4.13 failure: the browser's
    // native tooltip cannot be dismissed with Escape and cannot be hovered.
    for (const el of document.querySelectorAll('[title]:not(iframe):not(frame)')) {
      if ((el.getAttribute('title') || '').trim()) push(el, 'title-attribute');
    }
    for (const el of document.querySelectorAll(
      '[data-toggle="tooltip"], [data-bs-toggle="tooltip"], [data-toggle="popover"], [data-bs-toggle="popover"], [data-tooltip]')) {
      push(el, 'js-tooltip');
    }
    return out.slice(0, 10);
  }

  // The set of visible elements, used to spot a tooltip appearing.
  if (mode === 'visible') {
    const out = [];
    const all = document.body ? document.body.querySelectorAll('*') : [];
    for (const el of all) if (shown(el)) out.push(selOf(el));
    return out;
  }

  if (mode === 'isVisible') {
    const el = document.querySelector(arg.sel);
    return !!(el && shown(el));
  }

  return null;
}

/** Compare two context fingerprints; returns a reason string or null. */
function contextDiff(before, after) {
  if (!before || !after) return null;
  if (before.url !== after.url) return `navigated from ${before.url} to ${after.url}`;
  if (after.dialogs > before.dialogs) return 'a modal dialog opened';
  if (before.title !== after.title) return `the page title changed to "${after.title}"`;
  return null;
}

async function contextChangeChecks(page, opts = {}) {
  const out = { violations: [], incomplete: [], passes: [] };
  const guard = opts.guard || null;
  const maxTabs = opts.maxTabs || 25;
  const ctx = page.context();

  if (guard) guard.lock();
  try {
    // ── 3.2.1 On Focus ─────────────────────────────────────────────────────
    // Tab through the page; merely arriving on a control must change nothing.
    const focusOffenders = [];
    let tabbed = 0;
    await page.evaluate(() => { try { document.activeElement.blur(); } catch (e) {} window.scrollTo(0, 0); }).catch(() => {});
    // One context read per Tab, not two: the reading taken after a Tab is the
    // correct baseline for the next one. Halving these round trips matters —
    // instrumentation showed this walk dominating the whole per-page cost.
    let before = await page.evaluate(probe, 'context').catch(() => null);
    for (let i = 0; i < maxTabs && before; i++) {
      const pagesBefore = ctx.pages().length;
      await page.keyboard.press('Tab').catch(() => {});
      await page.waitForTimeout(70);
      const after = await page.evaluate(probe, 'context').catch(() => null);
      if (!after) break;
      tabbed += 1;
      let reason = contextDiff(before, after);
      if (!reason && ctx.pages().length > pagesBefore) reason = 'a new window or tab opened';
      if (reason) {
        focusOffenders.push({ sel: after.active || before.active || 'unknown', reason });
        break; // the page moved under us; the rest of the walk is meaningless
      }
      before = after;
    }
    if (focusOffenders.length) {
      out.violations.push(result('cc-focus-context-change',
        'Moving focus to a control changed the context', 'serious',
        ['cat.semantics', 'wcag2a', 'wcag321'],
        focusOffenders.map((o) => node('serious', '', o.sel,
          `Tabbing onto this control ${o.reason}. Focus alone must not navigate, open a window or open a dialog — move that behaviour to activation (click/Enter).`))));
    } else if (tabbed > 2) {
      out.passes.push(result('cc-focus-context-change',
        'Focusing controls does not change context', null, ['wcag2a', 'wcag321'], []));
    }

    // ── 3.2.2 On Input ─────────────────────────────────────────────────────
    // Changing a select's value must not navigate or open anything. Any
    // postback this triggers is stopped by the guard, so only the client-side
    // consequence is observed.
    const selects = await page.evaluate(probe, 'selects').catch(() => []);
    const inputOffenders = [];
    for (const s of selects) {
      const alt = s.options.find((v) => v !== s.value);
      if (alt === undefined) continue;
      const before = await page.evaluate(probe, 'context').catch(() => null);
      const pagesBefore = ctx.pages().length;
      try {
        await page.selectOption(s.sel, alt, { timeout: 2000 });
      } catch { continue; }
      await page.waitForTimeout(400);
      const after = await page.evaluate(probe, 'context').catch(() => null);
      let reason = contextDiff(before, after);
      if (!reason && ctx.pages().length > pagesBefore) reason = 'a new window or tab opened';
      if (reason) inputOffenders.push({ sel: s.sel, html: s.html, reason });
      // Put it back regardless of outcome.
      await page.selectOption(s.sel, s.value, { timeout: 2000 }).catch(() => {});
      await page.waitForTimeout(150);
    }
    if (inputOffenders.length) {
      out.violations.push(result('cc-input-context-change',
        'Changing a value changed the context without warning', 'serious',
        ['cat.semantics', 'wcag2a', 'wcag322'],
        inputOffenders.slice(0, 10).map((o) => node('serious', o.html, o.sel,
          `Selecting a different option ${o.reason}. Either wait for an explicit Submit, or tell the user before the control that changing it will do this.`))));
    } else if (selects.length) {
      out.passes.push(result('cc-input-context-change',
        'Changing values does not change context', null, ['wcag2a', 'wcag322'], []));
    }

    // ── 1.4.13 Content on Hover or Focus ───────────────────────────────────
    const triggers = await page.evaluate(probe, 'hoverTriggers').catch(() => []);
    const nativeTitles = triggers.filter((t) => t.kind === 'title-attribute');
    const jsTips = triggers.filter((t) => t.kind === 'js-tooltip');

    if (nativeTitles.length) {
      // No behavioural test needed: the browser's own tooltip is by definition
      // not dismissable without moving the pointer, and not hoverable.
      out.violations.push(result('cc-hover-not-dismissable',
        'Tooltip uses the native title attribute, which cannot be dismissed or hovered', 'moderate',
        ['cat.semantics', 'wcag21aa', 'wcag1413'],
        nativeTitles.slice(0, 10).map((t) => node('moderate', t.html, t.sel,
          `This element shows a browser tooltip from title="${t.title.slice(0, 60)}". Native tooltips cannot be dismissed with Escape and disappear if the pointer moves toward them, so they fail Dismissable and Hoverable. Replace with a scripted tooltip that stays open and closes on Escape.`))));
    }

    const notPersistent = [];
    const notDismissable = [];
    for (const t of jsTips) {
      const before = await page.evaluate(probe, 'visible').catch(() => []);
      try { await page.hover(t.sel, { timeout: 2000 }); } catch { continue; }
      await page.waitForTimeout(500);
      const after = await page.evaluate(probe, 'visible').catch(() => []);
      const beforeSet = new Set(before);
      const appeared = after.filter((s) => !beforeSet.has(s));
      if (!appeared.length) continue; // nothing revealed — nothing to judge
      const tip = appeared[appeared.length - 1];

      // Persistent: still there a moment later without moving the pointer.
      await page.waitForTimeout(1200);
      if (!(await page.evaluate(probe, { mode: 'isVisible', sel: tip }).catch(() => false))) {
        notPersistent.push({ ...t, tip });
        continue;
      }
      // Dismissable: Escape must close it without moving the pointer.
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(350);
      if (await page.evaluate(probe, { mode: 'isVisible', sel: tip }).catch(() => false)) {
        notDismissable.push({ ...t, tip });
      }
      // Move the pointer away so the next trigger starts clean.
      await page.mouse.move(0, 0).catch(() => {});
      await page.waitForTimeout(200);
    }

    if (notDismissable.length) {
      out.violations.push(result('cc-hover-not-dismissable',
        'Content shown on hover cannot be dismissed with Escape', 'moderate',
        ['cat.semantics', 'wcag21aa', 'wcag1413'],
        notDismissable.slice(0, 10).map((t) => node('moderate', t.html, t.sel,
          `Hovering this element reveals ${t.tip}, which is still visible after pressing Escape. Content revealed on hover must be dismissable without moving the pointer.`))));
    }
    if (notPersistent.length) {
      out.violations.push(result('cc-hover-not-persistent',
        'Content shown on hover disappears on its own', 'moderate',
        ['cat.semantics', 'wcag21aa', 'wcag1413'],
        notPersistent.slice(0, 10).map((t) => node('moderate', t.html, t.sel,
          `The content revealed by hovering this element (${t.tip}) vanished while the pointer was still on the trigger. It must remain visible until dismissed, the pointer leaves, or it stops being valid.`))));
    }
    if (!nativeTitles.length && !notDismissable.length && !notPersistent.length && jsTips.length) {
      out.passes.push(result('cc-hover-not-dismissable',
        'Hover content is dismissable and persistent', null, ['wcag21aa', 'wcag1413'], []));
    }
  } finally {
    if (guard) guard.unlock();
  }

  return out;
}

module.exports = { contextChangeChecks };
