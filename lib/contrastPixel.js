/**
 * Pixel-sampled CONTRAST resolution — turns axe's "incomplete" colour-contrast
 * results into real verdicts (1.4.3, and the same machinery serves 1.4.11).
 *
 * axe reports `incomplete` for colour-contrast whenever it cannot determine
 * what is actually behind the text: a background image, a gradient, an
 * overlapping element, or a partly transparent ancestor. It is not being
 * unhelpful — from the CSS cascade alone the answer genuinely is unknown.
 *
 * On this app that is not a rounding error. A real run produced:
 *     confirmed violations    83
 *     incomplete           7,469   (7,396 of them colour-contrast)
 * so ~99% of the contrast question was left to a human.
 *
 * The rendered page does know the answer, so we ask it: screenshot the page,
 * hand the PNG back to the browser as a data URL, draw it to a <canvas>, and
 * read the pixels. Canvas decodes PNG natively, so this needs no image
 * library and keeps the dependency list at four.
 *
 * ── Finding the background ─────────────────────────────────────────────────
 * The screenshot contains the text as well as its background, so we cannot
 * simply average the box. Instead we take the MODE (most frequent colour) of
 * the element's box: for a run of text, most pixels are background, and the
 * glyphs plus their anti-aliased edges are a minority spread across many
 * shades. The foreground is taken from computed style, which is reliable —
 * it is only ever the background that axe could not resolve.
 *
 * ── What it deliberately does NOT do ───────────────────────────────────────
 * If the sampled box is visually busy (no colour holds a clear plurality) the
 * element is left as "review" rather than guessed at. Text over a photograph
 * genuinely needs a human. Downgrading those to a fabricated pass would be the
 * same false-assurance bug this codebase has already been bitten by.
 */

const HELP_URL = 'https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html';

function result(id, help, impact, tags, nodes) {
  return { id, help, description: help, helpUrl: HELP_URL, impact, tags, nodes };
}
function node(impact, html, sel, failureSummary) {
  return { impact, html: String(html || '').slice(0, 400), target: [sel], failureSummary };
}

/** WCAG relative luminance + contrast ratio. */
const lum = ([r, g, b]) => {
  const f = (c) => {
    c /= 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const ratio = (a, b) => {
  const [hi, lo] = lum(a) >= lum(b) ? [lum(a), lum(b)] : [lum(b), lum(a)];
  return (hi + 0.05) / (lo + 0.05);
};

/**
 * Runs in the browser. Draws the screenshot to a canvas and, for each target,
 * returns the modal background colour of its box plus its text metrics.
 */
function sampleProbe({ dataUrl, targets }) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onerror = () => resolve({ error: 'image-blocked' });
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const g = canvas.getContext('2d', { willReadFrequently: true });
      g.drawImage(img, 0, 0);

      // The screenshot is in device pixels and covers the full document; the
      // rects below are CSS pixels relative to the viewport.
      const scale = img.width / document.documentElement.scrollWidth;
      const out = [];

      for (const sel of targets) {
        let el;
        try { el = document.querySelector(sel); } catch { el = null; }
        if (!el) { out.push({ sel, skip: 'gone' }); continue; }
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') { out.push({ sel, skip: 'hidden' }); continue; }
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) { out.push({ sel, skip: 'empty' }); continue; }

        const x0 = Math.round((r.left + window.scrollX) * scale);
        const y0 = Math.round((r.top + window.scrollY) * scale);
        const w = Math.round(r.width * scale);
        const h = Math.round(r.height * scale);
        if (x0 < 0 || y0 < 0 || x0 + w > canvas.width || y0 + h > canvas.height) {
          out.push({ sel, skip: 'offscreen' }); continue;
        }

        let data;
        try { data = g.getImageData(x0, y0, w, h).data; }
        catch { resolve({ error: 'canvas-tainted' }); return; }

        // Histogram, quantised to 8 levels per channel so anti-aliasing noise
        // collapses into its parent colour instead of fragmenting the count.
        const counts = new Map();
        let total = 0;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] < 128) continue;
          const key = ((data[i] >> 5) << 10) | ((data[i + 1] >> 5) << 5) | (data[i + 2] >> 5);
          let e = counts.get(key);
          if (!e) { e = { n: 0, r: 0, g: 0, b: 0 }; counts.set(key, e); }
          e.n += 1; e.r += data[i]; e.g += data[i + 1]; e.b += data[i + 2];
          total += 1;
        }
        if (!total) { out.push({ sel, skip: 'empty' }); continue; }

        let best = null;
        for (const e of counts.values()) if (!best || e.n > best.n) best = e;
        const share = best.n / total;
        const bg = [Math.round(best.r / best.n), Math.round(best.g / best.n), Math.round(best.b / best.n)];

        const fgm = (cs.color || '').match(/rgba?\(([^)]+)\)/);
        const fg = fgm ? fgm[1].split(',').slice(0, 3).map((v) => parseInt(v.trim(), 10)) : null;
        const size = parseFloat(cs.fontSize) || 16;
        const weight = parseInt(cs.fontWeight, 10) || 400;

        out.push({
          sel, bg, fg, share, size, weight,
          text: (el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 60),
          html: el.outerHTML.slice(0, 300),
        });
      }
      resolve({ samples: out });
    };
    img.src = dataUrl;
  });
}

/**
 * @param {import('playwright').Page} page
 * @param {string[]} targets  CSS selectors from axe's incomplete colour-contrast nodes
 * @param {{minShare?: number, log?: Function}} [opts]
 */
async function contrastPixelChecks(page, targets, opts = {}) {
  const out = { violations: [], incomplete: [], passes: [], resolved: 0, unresolved: 0 };
  const log = opts.log || (() => {});
  // Below this plurality the box is too busy to call — text over a photo.
  const minShare = opts.minShare ?? 0.45;
  if (!targets || !targets.length) return out;

  let shot;
  try {
    shot = await page.screenshot({ type: 'png', fullPage: true, animations: 'disabled' });
  } catch (e) {
    log(`      ⚠ contrast sampling skipped (screenshot failed: ${e.message.split('\n')[0]})`);
    return out;
  }
  const dataUrl = 'data:image/png;base64,' + shot.toString('base64');

  // sampleProbe's returned promise only settles via the in-page <img>'s
  // onload/onerror. If the page navigates or reloads mid-decode (Dashboard is
  // known to do this), that frame is destroyed before either fires, so the
  // promise never settles — Playwright does not reliably reject evaluate() in
  // that case. Confirmed in practice: a scan hung indefinitely on Dashboard at
  // near-zero CPU, one call away from finishing this exact await forever. A
  // hard timeout is the only thing that can end an in-page promise that will
  // never resolve on its own.
  let res;
  try {
    res = await Promise.race([
      page.evaluate(sampleProbe, { dataUrl, targets: targets.slice(0, 400) }),
      new Promise((_, reject) => setTimeout(
        () => reject(new Error('contrast sampling timed out after 20s (page likely navigated mid-decode)')), 20000)),
    ]);
  } catch (e) {
    log(`      ⚠ contrast sampling skipped (${e.message.split('\n')[0]})`);
    return out;
  }
  if (!res || res.error) {
    // A page whose CSP forbids data: images, or a tainted canvas. Not a
    // failure of the page under test — just leave the items for a human.
    log(`      ⚠ contrast sampling unavailable (${res ? res.error : 'no result'})`);
    return out;
  }

  const fails = [];
  for (const s of res.samples || []) {
    if (s.skip || !s.fg || !s.bg) { out.unresolved += 1; continue; }
    if (s.share < minShare) { out.unresolved += 1; continue; } // too busy to judge
    const r = ratio(s.fg, s.bg);
    // WCAG large text: >=24px, or >=18.66px when bold.
    const large = s.size >= 24 || (s.size >= 18.66 && s.weight >= 700);
    const need = large ? 3 : 4.5;
    out.resolved += 1;
    if (r < need) {
      fails.push({ ...s, r, need, large });
    }
  }

  const hex = (c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
  if (fails.length) {
    out.violations.push(result('contrast-sampled',
      'Text contrast is below the minimum, measured from rendered pixels', 'serious',
      ['cat.color', 'wcag2aa', 'wcag143'],
      fails.slice(0, 25).map((f) => node('serious', f.html, f.sel,
        `Measured ${f.r.toFixed(2)}:1 against the rendered background (text ${hex(f.fg)} on ${hex(f.bg)}), below the required ${f.need}:1 for ${f.large ? 'large' : 'normal'} text${f.text ? ` — "${f.text}"` : ''}. axe could not determine this background from CSS alone; it was sampled from the screenshot.`))));
  } else if (out.resolved > 0) {
    out.passes.push(result('contrast-sampled',
      `Sampled contrast meets the minimum on ${out.resolved} element(s) axe could not resolve`,
      null, ['wcag2aa', 'wcag143'], []));
  }

  log(`      · contrast sampling: ${out.resolved} resolved, ${out.unresolved} still need a human`);
  return out;
}

module.exports = { contrastPixelChecks, ratio, lum };
