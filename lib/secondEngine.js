/**
 * Second opinion: IBM's open-source "Equal Access" accessibility-checker-engine
 * (Apache-2.0, github.com/IBMa/equal-access) — a rule engine written
 * independently of axe-core. Injected into the page just like axe, so it sees
 * the SAME revealed state (modals, tabs) our axe scan just analyzed.
 *
 * We don't merge its findings into the main axe-based issue list (different
 * shape: XPath not CSS selector, different severity vocabulary) — instead we
 * compare VERDICTS PER WCAG CRITERION, engine vs engine, so you can see where
 * axe-core and an independently-built engine agree or disagree. That's the
 * actual accuracy signal: agreement = high confidence; disagreement = worth a
 * manual look.
 */
const path = require('path');

const ACE_JS = path.join(__dirname, '..', 'node_modules', 'accessibility-checker-engine', 'ace.js');

// Runs in the browser once ace.js is injected. Self-contained.
async function runInPage() {
  const checker = new window.ace.Checker();
  const report = await checker.check(document, ['WCAG_2_2']);
  const gl = checker.guidelines.find((g) => g.id === 'WCAG_2_2');
  const ruleToWcag = {};
  if (gl) {
    for (const cp of gl.checkpoints) {
      for (const r of cp.rules || []) {
        (ruleToWcag[r.id] = ruleToWcag[r.id] || new Set()).add(cp.num);
      }
    }
  }
  // Per-criterion verdict for THIS state: fail (any FAIL) > review (any
  // POTENTIAL/MANUAL) > pass (rule ran, clean).
  const byCriterion = {};
  for (const r of report.results || []) {
    const nums = ruleToWcag[r.ruleId];
    if (!nums) continue;
    // value[0] is the rule's level: VIOLATION | RECOMMENDATION | INFORMATION.
    // Only VIOLATION rules are WCAG requirements; recommendations are IBM's
    // best practice (aria_content_in_landmark is axe's `region`) and must not
    // fail or flag a criterion.
    if (!r.value || r.value[0] !== 'VIOLATION') continue;
    const verdict = r.value[1]; // PASS | FAIL | POTENTIAL | MANUAL
    for (const num of nums) {
      const e = byCriterion[num] || (byCriterion[num] = { fail: 0, review: 0, pass: 0 });
      if (verdict === 'FAIL') e.fail += 1;
      else if (verdict === 'POTENTIAL' || verdict === 'MANUAL') e.review += 1;
      else if (verdict === 'PASS') e.pass += 1;
    }
  }
  return { byCriterion, totalResults: (report.results || []).length };
}

/**
 * checker.check() is IBM's own async DOM walk, scheduled internally (likely
 * via setTimeout/requestIdleCallback chains we do not control). If the page
 * it is running against navigates or reloads mid-check, that internal chain
 * is abandoned in a frame that no longer exists and NEVER settles — the same
 * failure mode as lib/contrastPixel.js's image decode, but with far more
 * exposure: this runs on every state of every page, not just where contrast
 * needs resolving. A hard timeout is the only thing that can end an in-page
 * promise that will never resolve on its own.
 *
 * @param {import('playwright').Page} page
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<{byCriterion: object, totalResults: number}|null>}
 */
async function runSecondEngine(page, opts = {}) {
  const timeoutMs = opts.timeoutMs || 25000;
  try {
    await page.addScriptTag({ path: ACE_JS });
    return await Promise.race([
      page.evaluate(runInPage),
      new Promise((_, reject) => setTimeout(
        () => reject(new Error(`IBM engine timed out after ${timeoutMs / 1000}s (page likely navigated mid-check)`)), timeoutMs)),
    ]);
  } catch (e) {
    return null;
  }
}

module.exports = { runSecondEngine };
