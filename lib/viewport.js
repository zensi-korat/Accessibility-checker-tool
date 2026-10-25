/**
 * Dynamic VIEWPORT testing — the criteria that only fail at a size the scan
 * never visits. axe-core analyses one fixed viewport, so reflow, zoom and
 * spacing failures are structurally invisible to it.
 *
 * Emits axe-shaped results ({violations, incomplete, passes}) tagged with WCAG
 * criteria, so they merge straight into the existing aggregate/report pipeline:
 *   vp-reflow        → 1.4.10 Reflow
 *   vp-resize-text   → 1.4.4  Resize Text
 *   vp-text-spacing  → 1.4.12 Text Spacing
 *   vp-orientation   → 1.3.4  Orientation
 *
 * ── Why resizing the viewport IS browser zoom ──────────────────────────────
 * Browser zoom scales the CSS pixel, so a 1280px-wide window at 200% zoom
 * reports a 640px CSS viewport and fires the 640px media queries. Halving the
 * viewport reproduces that exactly. 1.4.10's "400% zoom" at 1280x1024 is
 * likewise 320x256 CSS px, which is why the spec states the criterion in those
 * terms. So these are faithful emulations, not approximations.
 *
 * Caveat worth knowing: we resize without reloading, to preserve any revealed
 * state (open modals, expanded panels) and to keep the per-page cost near zero.
 * Layout and media queries re-evaluate on resize, but responsive behaviour that
 * only initialises on load will not re-run. A JS-driven layout that reads the
 * width once at startup can therefore pass here and fail on a real reload.
 */

const HELP_URLS = {
  'vp-reflow': 'https://www.w3.org/WAI/WCAG22/Understanding/reflow.html',
  'vp-resize-text': 'https://www.w3.org/WAI/WCAG22/Understanding/resize-text.html',
  'vp-text-spacing': 'https://www.w3.org/WAI/WCAG22/Understanding/text-spacing.html',
  'vp-orientation': 'https://www.w3.org/WAI/WCAG22/Understanding/orientation.html',
};

// WCAG 1.4.10 defines reflow against a 320 CSS px viewport (= 1280px at 400%).
const REFLOW = { width: 320, height: 256 };
// A portrait shape wide enough that a responsive layout has no excuse to hide
// content — if main content vanishes here, orientation is genuinely locked.
const PORTRAIT = { width: 512, height: 915 };

// WCAG 1.4.12's exact metrics, as the spec states them.
const SPACING_CSS = `
  *:not(html):not(body) {
    line-height: 1.5 !important;
    letter-spacing: 0.12em !important;
    word-spacing: 0.16em !important;
  }
  p, li, h1, h2, h3, h4, h5, h6, blockquote, dd, dt, figcaption {
    margin-bottom: 2em !important;
  }
`;

function result(id, help, impact, tags, nodes) {
  return { id, help, description: help, helpUrl: HELP_URLS[id] || '', impact, tags, nodes };
}
function node(impact, html, sel, failureSummary) {
  return { impact, html: String(html || '').slice(0, 400), target: [sel], failureSummary };
}

/**
 * Everything that runs in the browser, in one self-contained function so the
 * DOM helpers are written once. page.evaluate serialises the function, so it
 * cannot close over anything in this module — hence the mode switch.
 */
function probe(mode) {
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
  const shown = (el, cs) => cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity || '1') > 0.01;
  // Text belonging to THIS element, not to its descendants — so a violation is
  // blamed on the box that actually clips the words, not on a wrapper.
  const ownText = (el) => {
    let t = '';
    for (const n of el.childNodes) if (n.nodeType === 3) t += n.nodeValue;
    return t.trim().replace(/\s+/g, ' ');
  };

  // Content that legitimately needs two-dimensional layout is exempt from
  // 1.4.10 — the spec names data tables, maps, diagrams and video. Plain <img>
  // is deliberately NOT exempt: a photo overflowing 320px is a missing
  // max-width:100%, which is a real and trivially fixable defect.
  const EXEMPT = 'table,thead,tbody,tr,td,th,svg,canvas,iframe,video,pre,code,object,embed,[role="table"],[role="grid"],[role="treegrid"]';

  if (mode === 'overflow') {
    const vw = document.documentElement.clientWidth;
    // scrollWidth reports CONTENT width, not whether the user can reach it —
    // it exceeds clientWidth identically whether the page scrolls or clips. So
    // this only establishes that something overflows; who wins is decided by
    // the root overflow-x below.
    const contentOverflows = document.documentElement.scrollWidth > vw + 1;
    // A page that hides its own horizontal overflow does not scroll — it just
    // amputates whatever sticks out. Legacy apps do this routinely to silence a
    // scrollbar, and it fails 1.4.10 harder than scrolling does, because the
    // content becomes unreachable rather than merely awkward. So "no horizontal
    // scrollbar" is not on its own evidence of passing.
    const rootCS = getComputedStyle(document.documentElement);
    const bodyCS = document.body ? getComputedStyle(document.body) : rootCS;
    const clipX = (v) => v === 'hidden' || v === 'clip';
    const rootHidesX = clipX(rootCS.overflowX) || clipX(bodyCS.overflowX);

    const hits = [];
    const all = document.body ? document.body.querySelectorAll('*') : [];
    for (const el of all) {
      // Cheap discriminators first. getComputedStyle is by far the most
      // expensive call in this loop and almost every element passes the rect
      // test, so reading geometry first avoids the vast majority of them.
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.right <= vw + 1) continue;
      if (el.matches(EXEMPT) || el.closest(EXEMPT)) continue;
      if (!shown(el, getComputedStyle(el))) continue;
      // An ancestor BELOW the root that clips or scrolls its own overflow
      // contains this element, so it can neither widen the document nor lose
      // content. This is what rules out off-canvas menus parked at left:100%
      // inside a hidden wrapper — the biggest source of false positives here.
      // The root is deliberately excluded: clipping there is the defect above.
      let contained = false;
      for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
        if (getComputedStyle(p).overflowX !== 'visible') { contained = true; break; }
      }
      if (contained) continue;
      hits.push(el);
    }
    // Keep only the outermost element of each overflowing chain: that container
    // is where the fixed width / min-width actually lives, so it is the thing
    // to fix. Reporting its descendants too would just be noise.
    const outer = hits.filter((el) => !hits.some((o) => o !== el && o.contains(el)));
    return {
      docScrolls: contentOverflows && !rootHidesX,
      clipped: contentOverflows && rootHidesX && outer.length > 0,
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: vw,
      offenders: outer.map((el) => {
        const r = el.getBoundingClientRect();
        return {
          sel: selOf(el),
          html: el.outerHTML.slice(0, 300),
          overflowBy: Math.round(r.right - vw),
          width: Math.round(r.width),
        };
      }).sort((a, b) => b.overflowBy - a.overflowBy).slice(0, 15),
    };
  }

  if (mode === 'clipped') {
    const out = [];
    const all = document.body ? document.body.querySelectorAll('*') : [];
    for (const el of all) {
      // Order matters for speed: most elements own no text and do not overflow,
      // and both of those are cheap to test. getComputedStyle — the expensive
      // call — is then reached only by the handful of real candidates.
      const text = ownText(el);
      if (!text) continue;
      const oX = el.scrollWidth > el.clientWidth + 2;
      const oY = el.scrollHeight > el.clientHeight + 2;
      if (!oX && !oY) continue;
      const cs = getComputedStyle(el);
      if (!shown(el, cs)) continue;
      const clipsX = cs.overflowX === 'hidden' || cs.overflowX === 'clip';
      const clipsY = cs.overflowY === 'hidden' || cs.overflowY === 'clip';
      const overX = clipsX && oX;
      const overY = clipsY && oY;
      if (!overX && !overY) continue;
      out.push({
        sel: selOf(el),
        html: el.outerHTML.slice(0, 300),
        text: text.slice(0, 80),
        axis: overX ? 'horizontally' : 'vertically',
      });
    }
    return out;
  }

  if (mode === 'orientation') {
    const RE = /rotate\s+(your\s+)?(device|screen|phone)|please\s+rotate|landscape\s+mode|portrait\s+mode|best\s+viewed\s+in\s+(landscape|portrait)|not\s+supported\s+in\s+portrait/i;
    const all = document.body ? document.body.querySelectorAll('*') : [];
    for (const el of all) {
      const t = ownText(el);
      if (!t || !RE.test(t)) continue;      // cheap test first
      if (!shown(el, getComputedStyle(el))) continue;
      {
        const r = el.getBoundingClientRect();
        // Only a blocker if it is actually on screen and substantial.
        if (r.width > 80 && r.height > 20 && r.top < window.innerHeight) {
          return { blocked: true, sel: selOf(el), html: el.outerHTML.slice(0, 300), text: t.slice(0, 120) };
        }
      }
    }
    return { blocked: false };
  }

  return null;
}

const sig = (c) => c.sel + '|' + c.text;

async function settle(page, ms) {
  await page.waitForTimeout(ms);
  await page.waitForLoadState('domcontentloaded').catch(() => {});
}

/**
 * Runs the four viewport-dependent criteria and ALWAYS restores the original
 * viewport, so the caller's subsequent checks and screenshots are unaffected.
 */
async function viewportChecks(page, opts = {}) {
  const out = { violations: [], incomplete: [], passes: [] };
  const original = page.viewportSize();
  if (!original) return out; // context created with viewport:null — nothing to resize
  const pause = opts.settleMs || 220;
  let spacingTag = null;

  try {
    // Baseline: elements already clipping their own text at the normal size.
    // Only NEWLY clipped elements are attributable to zoom or spacing, so
    // pre-existing clipping (a deliberate ellipsis, say) never gets blamed here.
    const baseClipped = new Set((await page.evaluate(probe, 'clipped')).map(sig));

    // ── 1.4.10 Reflow — 320 CSS px wide (= 400% zoom at 1280px) ─────────────
    await page.setViewportSize(REFLOW);
    await settle(page, pause);
    const reflow = await page.evaluate(probe, 'overflow');
    if (reflow.docScrolls || reflow.clipped) {
      const nodes = reflow.offenders.length
        ? reflow.offenders.map((o) => node('serious', o.html, o.sel, reflow.clipped
          ? `This element extends ${o.overflowBy}px past the 320px viewport (it renders ${o.width}px wide), and the page hides horizontal overflow — so that content is cut off with no way to scroll to it. Remove the fixed width / min-width so it can wrap.`
          : `This element extends ${o.overflowBy}px past the 320px viewport (it renders ${o.width}px wide). Remove the fixed width / min-width, or let it wrap.`))
        : [node('serious', '<html>', 'html',
          `The page is ${reflow.scrollWidth}px wide in a ${reflow.clientWidth}px viewport, but no single element could be isolated as the cause — check for a fixed-width container or a wide background image.`)];
      out.violations.push(result('vp-reflow',
        reflow.clipped
          ? 'Content is cut off at 320px width — the page hides horizontal overflow instead of reflowing'
          : 'Content requires horizontal scrolling at 320px width (400% zoom)',
        reflow.clipped ? 'critical' : 'serious',
        ['cat.structure', 'wcag2aa', 'wcag1410'], nodes));
    } else {
      out.passes.push(result('vp-reflow', 'Content reflows to 320px without horizontal scrolling', null, ['wcag2aa', 'wcag1410'], []));
    }

    // ── 1.4.4 Resize Text — 200% zoom is exactly half the CSS viewport ──────
    await page.setViewportSize({ width: Math.max(320, Math.round(original.width / 2)), height: Math.max(256, Math.round(original.height / 2)) });
    await settle(page, pause);
    const zoomClipped = (await page.evaluate(probe, 'clipped')).filter((c) => !baseClipped.has(sig(c)));
    if (zoomClipped.length) {
      out.violations.push(result('vp-resize-text',
        'Text is cut off at 200% zoom', 'serious',
        ['cat.structure', 'wcag2aa', 'wcag144'],
        zoomClipped.slice(0, 15).map((c) => node('serious', c.html, c.sel,
          `At 200% zoom this element clips its text ${c.axis} ("${c.text}"). Replace the fixed height/width with a min- value so the box can grow.`))));
    } else {
      out.passes.push(result('vp-resize-text', 'No text clipped at 200% zoom', null, ['wcag2aa', 'wcag144'], []));
    }

    // ── 1.4.12 Text Spacing — at the ORIGINAL size, so this measures spacing
    // alone rather than compounding it with the zoom failures above ─────────
    await page.setViewportSize(original);
    await settle(page, pause);
    spacingTag = await page.addStyleTag({ content: SPACING_CSS }).catch(() => null);
    await settle(page, pause);
    const spacingClipped = (await page.evaluate(probe, 'clipped')).filter((c) => !baseClipped.has(sig(c)));
    if (spacingClipped.length) {
      out.violations.push(result('vp-text-spacing',
        'Content is cut off when WCAG text spacing is applied', 'serious',
        ['cat.structure', 'wcag21aa', 'wcag1412'],
        spacingClipped.slice(0, 15).map((c) => node('serious', c.html, c.sel,
          `With line-height 1.5, letter-spacing 0.12em and word-spacing 0.16em, this element clips its text ${c.axis} ("${c.text}"). Remove the fixed height so the text can reflow.`))));
    } else {
      out.passes.push(result('vp-text-spacing', 'Content survives WCAG text-spacing overrides', null, ['wcag21aa', 'wcag1412'], []));
    }
    if (spacingTag) { await spacingTag.evaluate((el) => el.remove()).catch(() => {}); spacingTag = null; }

    // ── 1.3.4 Orientation ───────────────────────────────────────────────────
    await page.setViewportSize(PORTRAIT);
    await settle(page, pause);
    const orient = await page.evaluate(probe, 'orientation');
    if (orient.blocked) {
      out.violations.push(result('vp-orientation',
        'Content is locked to one orientation', 'serious',
        ['cat.structure', 'wcag21aa', 'wcag134'],
        [node('serious', orient.html, orient.sel,
          `In a portrait viewport the page shows "${orient.text}" instead of its content. Content must work in both orientations unless a specific orientation is essential.`)]));
    } else {
      out.passes.push(result('vp-orientation', 'Content is usable in portrait orientation', null, ['wcag21aa', 'wcag134'], []));
    }
  } finally {
    // Restore unconditionally — a thrown check must not leave the page at 320px
    // with spacing overrides still applied for the screenshot pass or the next
    // state.
    if (spacingTag) await spacingTag.evaluate((el) => el.remove()).catch(() => {});
    await page.setViewportSize(original).catch(() => {});
    await page.waitForTimeout(80).catch(() => {});
  }

  return out;
}

module.exports = { viewportChecks, REFLOW, PORTRAIT, SPACING_CSS };
