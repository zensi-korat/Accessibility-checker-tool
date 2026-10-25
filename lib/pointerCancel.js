/**
 * POINTER CANCELLATION — 2.5.2.
 *
 * The criterion: for anything operable with a single pointer, the action must
 * not complete on the DOWN half of the press. Pressing down, changing your
 * mind, dragging off the control and releasing must abort it. This protects
 * anyone who mis-taps — which is most people some of the time, and people with
 * tremor or limited dexterity all of the time.
 *
 * Neither axe nor IBM has a rule for this, because a static DOM cannot say
 * WHEN a handler fires. But it is directly observable if you press the control
 * and then refuse to release on it.
 *
 * Two stages, and the second is the authority:
 *
 *   1. CANDIDATES — lib/clickable.js instruments addEventListener, so we know
 *      which elements registered mousedown/pointerdown/touchstart. That is
 *      only a suspicion: plenty of down-handlers are harmless (focus
 *      management, ripple effects, opening a menu that closes again).
 *
 *   2. PROOF — press down on the candidate, move the pointer far away, release
 *      somewhere else, then compare a before/after fingerprint of the page. If
 *      anything changed, the action ran on the down-event and could not be
 *      aborted. If nothing changed, it passes regardless of what listeners it
 *      registered.
 *
 * Exemptions, per the criterion's own wording ("unless completing on the
 * down-event is essential"): sliders, carousels (Swiper, Slick, Glide,
 * Splide… whose swipe listeners sit on document), drawing canvases, drag
 * sources, and anything that also listens for move events — for those,
 * acting on down IS the function. Pages whose content changes on its own
 * (autoplay carousels, clocks, tickers) are measured against that drift so it
 * is not mistaken for an effect of the press.
 *
 * Writes cannot escape: lib/interact.js answers every non-GET with 204.
 *
 * Emits axe-shaped results:
 *   pc-down-event-action → 2.5.2 Pointer Cancellation
 */

const HELP_URL = 'https://www.w3.org/WAI/WCAG22/Understanding/pointer-cancellation.html';
const TAGS = ['cat.sensory-and-visual-cues', 'wcag2a', 'wcag252'];

function result(id, help, impact, tags, nodes) {
  return { id, help, description: help, helpUrl: HELP_URL, impact, tags, nodes };
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
    return r.width > 3 && r.height > 3 && r.top >= 0 && r.left >= 0
      && r.bottom <= window.innerHeight && r.right <= window.innerWidth;
  };

  if (mode === 'candidates') {
    // Where acting on the down-event is essential, so the criterion does not
    // apply: the press IS the interaction.
    const ESSENTIAL = 'canvas, input[type=range], [role="slider"], [role="scrollbar"],'
      + ' [draggable="true"], [contenteditable="true"], select, [role="listbox"],'
      + ' .swiper, .swiper-container, .slick-slider, .glide, .splide, .flickity-enabled, .owl-carousel,'
      + ' .embla, .keen-slider, .carousel, [aria-roledescription="carousel"], [aria-roledescription="slide"]';
    const out = [];
    const seen = new Set();

    const consider = (el, why) => {
      if (!(el instanceof Element) || !shown(el)) return;
      if (el.matches(ESSENTIAL) || el.closest(ESSENTIAL)) return;
      try { if (window.__a11yDragEls && window.__a11yDragEls.has(el)) return; } catch (e) {}
      const s = selOf(el);
      if (seen.has(s)) return;
      seen.add(s);
      const r = el.getBoundingClientRect();
      out.push({
        sel: s, why,
        html: el.outerHTML.slice(0, 300),
        x: Math.round(r.left + r.width / 2),
        y: Math.round(r.top + r.height / 2),
        alsoUp: !!(window.__a11yUpEls && window.__a11yUpEls.has(el)),
      });
    };

    // Registered via addEventListener (captured by instrumentListeners).
    const list = window.__a11yDownList || [];
    for (const el of list) consider(el, 'a mousedown/pointerdown listener');
    // Registered inline in the markup — common in legacy WebForms.
    for (const el of document.querySelectorAll('[onmousedown], [onpointerdown], [ontouchstart]')) {
      consider(el, 'an inline on-mousedown attribute');
    }
    return out.slice(0, 12);
  }

  // A place to drag to and release that hovers nothing interactive (moving to
  // the top-left corner opened logo/menu flyouts there), as far as possible
  // from the control being pressed.
  if (mode === 'parking') {
    const W = window.innerWidth; const H = window.innerHeight;
    const pts = [[W - 10, H - 10], [10, H - 10], [W - 10, Math.round(H / 2)], [Math.round(W / 2), H - 10], [W - 10, 10], [10, 10]];
    const INTERACTIVE = 'a, button, input, select, textarea, summary, label, [role], [tabindex], [onclick], [onmouseover], [onmouseenter], nav, header, [aria-haspopup]';
    const ok = pts.filter(([x, y]) => {
      const el = document.elementFromPoint(x, y);
      return !el || el === document.body || el === document.documentElement || !el.closest(INTERACTIVE);
    });
    const from = arg.from || [0, 0];
    const pool = ok.length ? ok : pts;
    pool.sort((a, b) => Math.hypot(b[0] - from[0], b[1] - from[1]) - Math.hypot(a[0] - from[0], a[1] - from[1]));
    return pool[0];
  }

  if (mode === 'fingerprint') {
    // Cheap but sensitive: anything the press did to the page shows up as a
    // change in one of these.
    const dialogs = document.querySelectorAll(
      'dialog[open], [role="dialog"], [role="alertdialog"], .modal.show, .modal.in');
    let openDialogs = 0;
    for (const d of dialogs) {
      const cs = getComputedStyle(d);
      if (cs.display !== 'none' && cs.visibility !== 'hidden') openDialogs += 1;
    }
    const text = (document.body ? document.body.innerText || '' : '').replace(/\s+/g, ' ');
    let h = 0;
    for (let i = 0; i < text.length; i++) { h = ((h << 5) - h + text.charCodeAt(i)) | 0; }
    return {
      url: location.href,
      title: document.title,
      dialogs: openDialogs,
      textHash: h,
      textLen: text.length,
      inputs: [...document.querySelectorAll('input,select,textarea')].map((e) => e.value).join('').length,
    };
  }

  return null;
}

const changed = (a, b, selfChanging = false) => {
  if (!a || !b) return null;
  if (a.url !== b.url) return 'the page navigated';
  if (!selfChanging && a.title !== b.title) return 'the page title changed';
  if (b.dialogs > a.dialogs) return 'a dialog opened';
  if (a.inputs !== b.inputs) return 'a form value changed';
  // Text can jitter on live pages (clocks, counters); require a real change,
  // and none at all is trusted on a page that changes text by itself.
  if (!selfChanging && a.textHash !== b.textHash && Math.abs(a.textLen - b.textLen) > 12) return 'the page content changed';
  return null;
};

/**
 * @param {import('playwright').Page} page
 * @param {{guard?: object, max?: number, log?: Function}} [opts]
 */
async function pointerCancelChecks(page, opts = {}) {
  const out = { violations: [], incomplete: [], passes: [] };
  const guard = opts.guard || null;
  const max = opts.max || 8;

  let candidates;
  try { candidates = await page.evaluate(probe, 'candidates'); } catch { return out; }
  // No control acts on a down-event → nothing for this criterion to judge on
  // this page. Emit no verdict rather than a pass.
  if (!candidates || !candidates.length) return out;

  const fails = [];
  let tested = 0;

  // Does the page change on its own? Two readings with no interaction, as far
  // apart as a press takes. Autoplay carousels and clocks would otherwise look
  // like the press did something.
  const idleA = await page.evaluate(probe, 'fingerprint').catch(() => null);
  await page.waitForTimeout(700);
  const idleB = await page.evaluate(probe, 'fingerprint').catch(() => null);
  const selfChanging = !!(idleA && idleB && (idleA.textHash !== idleB.textHash || idleA.title !== idleB.title));

  if (guard) guard.lock();
  try {
    for (const c of candidates.slice(0, max)) {
      const park = await page.evaluate(probe, { mode: 'parking', from: [c.x, c.y] }).catch(() => null) || [2, 2];
      const before = await page.evaluate(probe, 'fingerprint').catch(() => null);
      if (!before) continue;
      try {
        // Press ON the control, then leave without releasing on it. A correct
        // implementation treats this as an abort and does nothing at all.
        await page.mouse.move(c.x, c.y);
        await page.mouse.down();
        await page.waitForTimeout(120);
        await page.mouse.move(park[0], park[1], { steps: 8 }); // drag well clear, onto nothing interactive
        await page.waitForTimeout(120);
        await page.mouse.up();
      } catch { continue; }
      await page.waitForTimeout(350);
      const after = await page.evaluate(probe, 'fingerprint').catch(() => null);
      if (!after) continue;
      tested += 1;
      const what = changed(before, after, selfChanging);
      if (what) fails.push({ ...c, what });
      // Leave the pointer somewhere harmless before the next candidate.
      await page.mouse.move(park[0], park[1]).catch(() => {});
      await page.waitForTimeout(100);
    }
  } finally {
    if (guard) guard.unlock();
  }

  if (fails.length) {
    out.violations.push(result('pc-down-event-action',
      'Action completes on press rather than release, so it cannot be aborted', 'serious',
      TAGS,
      fails.slice(0, 10).map((f) => node('serious', f.html, f.sel,
        `Pressing this control and dragging away before releasing still caused an effect — ${f.what}. Because it has ${f.why}, the action runs on the down-event, so a user who presses it by mistake cannot cancel. Move the behaviour to the click (or up) event, or provide an undo.`))));
  } else if (tested > 0) {
    out.passes.push(result('pc-down-event-action',
      `Pressing and dragging away aborts cleanly on ${tested} control(s) that listen for a down-event`,
      null, ['wcag2a', 'wcag252'], []));
  }
  return out;
}

module.exports = { pointerCancelChecks };
