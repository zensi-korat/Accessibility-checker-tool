/**
 * Per-issue screenshots with a highlight box around the failing element
 * (mirrors EqualWeb's red-bounding-box screenshots). Requires a LIVE page —
 * these can only be captured during an actual `npm run scan`, not re-created
 * from `.scan-cache.json` via `npm run render`.
 *
 * Capped (config.SCREENSHOTS.maxPerRule / maxPerState) because a busy page
 * can have hundreds of instances of one rule (e.g. color-contrast) — we don't
 * want to screenshot every one of them and slow the scan to a crawl.
 */
const fs = require('fs');
const path = require('path');

const SHOTS_DIRNAME = 'shots';

function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'x';
}

/**
 * Screenshot ONE element with a red highlight box.
 * @param {import('playwright').Page} page
 * @param {string[]} target  axe node.target (only simple same-frame selectors supported)
 * @param {string} outDir    tool root — shots/ is created here
 * @param {string} filenameBase
 * @param {object} opts      { padding, maxWidth, maxHeight }
 * @returns {Promise<string|null>} relative path ("shots/xxx.png") or null
 */
async function captureElementShot(page, target, outDir, filenameBase, opts = {}) {
  if (!Array.isArray(target) || target.length !== 1) return null; // skip iframe/shadow-nested targets
  const selector = target[0];
  const padding = opts.padding ?? 24;
  const maxWidth = opts.maxWidth ?? 900;
  const maxHeight = opts.maxHeight ?? 650;
  // Small failing elements (icons, toggles, a single badge) produce a crop
  // just padding*2 wider than the element — e.g. a 34x26px element becomes an
  // 82x74px image. Technically correct, but too small to make out what's
  // wrong or even recognise the element on the page. Below this size the crop
  // is widened around the element's centre instead of just padded, so small
  // elements are shown with enough surrounding page for context.
  const minWidth = opts.minWidth ?? 320;
  const minHeight = opts.minHeight ?? 120;

  let handle = null;
  try {
    const locator = page.locator(selector).first();
    if ((await locator.count()) === 0) return null;
    await locator.scrollIntoViewIfNeeded({ timeout: 3000 });
    handle = await locator.elementHandle({ timeout: 3000 });
    if (!handle) return null;

    await handle.evaluate((el) => {
      el.setAttribute('data-a11y-shot', '1');
      el.style.setProperty('outline', '4px solid #ff0000', 'important');
      el.style.setProperty('outline-offset', '2px', 'important');
      el.style.setProperty('box-shadow', '0 0 0 4px rgba(255,0,0,0.25)', 'important');
    });

    const box = await handle.boundingBox();
    if (!box) return null;

    const vp = page.viewportSize() || { width: 1366, height: 900 };
    // Pad, then if that's still below the minimum, grow outward from the
    // element's centre (not just downward/rightward) so a small target stays
    // centred in its crop rather than pinned to one corner.
    const padW = Math.max(box.width + padding * 2, minWidth);
    const padH = Math.max(box.height + padding * 2, minHeight);
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    let x = Math.max(0, cx - padW / 2);
    let y = Math.max(0, cy - padH / 2);
    let w = Math.min(padW, maxWidth, vp.width - x);
    let h = Math.min(padH, maxHeight, vp.height - y);
    if (w < 10 || h < 10) return null;

    fs.mkdirSync(path.join(outDir, SHOTS_DIRNAME), { recursive: true });
    const file = `${slug(filenameBase)}.png`;
    const abs = path.join(outDir, SHOTS_DIRNAME, file);
    await page.screenshot({ path: abs, clip: { x, y, width: w, height: h } });
    return `${SHOTS_DIRNAME}/${file}`;
  } catch (e) {
    return null;
  } finally {
    if (handle) {
      await handle.evaluate((el) => {
        el.style.removeProperty('outline');
        el.style.removeProperty('outline-offset');
        el.style.removeProperty('box-shadow');
        el.removeAttribute('data-a11y-shot');
      }).catch(() => {});
    }
  }
}

/**
 * Walks axe results (violations + incomplete) and attaches a `screenshot`
 * (relative path) onto up to N nodes per rule, capped overall per state.
 * Mutates `results` in place.
 */
async function captureForResults(page, results, outDir, ctx, cfg = {}) {
  if (cfg.enabled === false) return;
  const maxPerRule = cfg.maxPerRule ?? 3;
  const maxPerState = cfg.maxPerState ?? 15;
  let taken = 0;
  for (const kind of ['violations', 'incomplete']) {
    for (const r of results[kind] || []) {
      let forThisRule = 0;
      for (const node of r.nodes || []) {
        if (taken >= maxPerState || forThisRule >= maxPerRule) break;
        const base = `${ctx.page}__${ctx.state}__${r.id}__${taken}`;
        const rel = await captureElementShot(page, node.target, outDir, base, cfg);
        if (rel) { node.screenshot = rel; taken += 1; forThisRule += 1; }
      }
      if (taken >= maxPerState) break;
    }
    if (taken >= maxPerState) break;
  }
}

module.exports = { captureElementShot, captureForResults, SHOTS_DIRNAME };
