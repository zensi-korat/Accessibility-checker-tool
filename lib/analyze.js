/**
 * Analyse one interface state: axe-core, then the dynamic and structural
 * checks axe cannot do (keyboard walk, screen-reader tree, reflow, contrast
 * sampling, status messages, …), then runtime source locations.
 *
 * Shared by scan.js (route-by-route scans) and the Playwright fixture
 * (scans inside a project's own E2E tests), so both produce identical data.
 *
 *   const analyze = createAnalyzer(config, { log, timed, outDir });
 *   const state = await analyze(page, 'initial', dynamic, 'Users', runViewport);
 */
const { AxeBuilder } = require('@axe-core/playwright');
const { captureForResults } = require('./screenshot');
const { keyboardChecks } = require('./keyboard');
const { screenReaderChecks } = require('./screenReader');
const { clickableChecks } = require('./clickable');
const { viewportChecks } = require('./viewport');
const { installGuard } = require('./interact');
const { liveRegionChecks } = require('./liveRegion');
const { contextChangeChecks } = require('./contextChange');
const { contrastPixelChecks } = require('./contrastPixel');
const { headingChecks } = require('./headings');
const { uiContrastChecks } = require('./uiContrast');
const { formFlowChecks } = require('./formFlow');
const { pointerCancelChecks } = require('./pointerCancel');
const { runSecondEngine } = require('./secondEngine');
const { attachRuntimeSources } = require('./runtimeSource');

function createAnalyzer(config, { log = () => {}, timed = (n, fn) => fn(), outDir } = {}) {
  const OUT_DIR = outDir || config.OUTPUT_DIR;
  return async function analyze(page, stateLabel, dynamic, pageLabel = 'page', runViewport = false) {
    // Heavy pages (long lists, chat widgets, polling) can navigate/mutate the DOM
    // while axe injects — which aborts analysis. Retry once after letting it
    // settle; if it still fails, return empty results so one page can't kill the
    // whole run.
    let results = null;
    for (let attempt = 0; attempt < 2 && !results; attempt++) {
      try {
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        results = await timed('axe', () => new AxeBuilder({ page }).withTags(config.AXE_TAGS).analyze());
      } catch (e) {
        const msg = e.message.split('\n')[0];
        if (attempt === 0 && /context was destroyed|navigation|detached/i.test(msg)) {
          log(`      … page moved during analysis, retrying "${stateLabel}"`);
          await page.waitForTimeout(2500);
          await page.waitForLoadState('load').catch(() => {});
        } else {
          log(`      ⚠ axe could not analyze "${stateLabel}": ${msg}`);
          results = { violations: [], incomplete: [], passes: [], inapplicable: [] };
        }
      }
    }
    // Per-issue screenshots with a red highlight box (capped — see config).
    if (config.SCREENSHOTS && config.SCREENSHOTS.enabled !== false) {
      try { await timed('screenshots', () => captureForResults(page, results, OUT_DIR, { page: pageLabel, state: stateLabel }, config.SCREENSHOTS)); }
      catch (e) { log(`      ⚠ screenshot capture skipped (${e.message.split('\n')[0]})`); }
    }

    const out = {
      state: stateLabel,
      violations: results.violations.slice(),
      incomplete: results.incomplete.slice(),
      passes: results.passes.slice(),
      inapplicable: results.inapplicable,
      srPreview: null,
    };
    // Dynamic checks axe can't do: real keyboard walk + accessibility-tree (SR).
    if (dynamic && config.DYNAMIC_CHECKS !== false) {
      try {
        const kb = await timed('keyboard', () => keyboardChecks(page, { maxTabs: config.KEYBOARD_MAX_TABS || 40 }));
        out.violations.push(...kb.violations);
        out.incomplete.push(...kb.incomplete);
        out.passes.push(...kb.passes);
      } catch (e) { log(`      ⚠ keyboard check skipped (${e.message.split('\n')[0]})`); }
      try {
        const sr = await timed('screenReader', () => screenReaderChecks(page));
        out.violations.push(...sr.violations);
        out.incomplete.push(...sr.incomplete);
        out.passes.push(...sr.passes);
        out.srPreview = sr.preview;
      } catch (e) { log(`      ⚠ screen-reader check skipped (${e.message.split('\n')[0]})`); }
      // Keyboard REACHABILITY: click handlers on non-focusable elements. Neither
      // axe nor IBM detect this (verified) — it's the addendum's §4.3 defect.
      try {
        const ck = await timed('clickable', () => clickableChecks(page));
        out.violations.push(...ck.violations);
        out.passes.push(...ck.passes);
      } catch (e) { log(`      ⚠ clickable check skipped (${e.message.split('\n')[0]})`); }
    }
    // 2.4.6 Headings and Labels and 1.4.11 Non-text Contrast. Neither engine
    // covers these, so without them both criteria report "not tested" — while
    // the VPAT calls both Partially Supports. These decide the STRUCTURAL half
    // (empty/duplicate/placeholder headings, shared labels; component boundary
    // contrast), leaving a human only the semantic judgement.
    if (runViewport) {
      try {
        const hl = await timed('headings', () => headingChecks(page));
        out.violations.push(...hl.violations);
        out.passes.push(...hl.passes);
      } catch (e) { log(`      ⚠ heading check skipped (${e.message.split('\n')[0]})`); }
      try {
        const uc = await timed('uiContrast', () => uiContrastChecks(page));
        out.violations.push(...uc.violations);
        out.incomplete.push(...uc.incomplete);
        out.passes.push(...uc.passes);
      } catch (e) { log(`      ⚠ non-text contrast check skipped (${e.message.split('\n')[0]})`); }
      // 3.3.7 Redundant Entry and 3.3.4 Error Prevention. 3.3.4 only speaks for
      // pages the team has DECLARED consequential in config.CONSEQUENTIAL_FLOWS —
      // the tool cannot know that "Submit" means payroll, so it stays silent
      // rather than guessing.
      try {
        const ff = await timed('formFlow', () => formFlowChecks(page, { flows: config.CONSEQUENTIAL_FLOWS || [] }));
        out.violations.push(...ff.violations);
        out.passes.push(...ff.passes);
        out.flowSignature = ff.signature;
      } catch (e) { log(`      ⚠ form-flow check skipped (${e.message.split('\n')[0]})`); }
    }
    // VIEWPORT-dependent criteria (reflow, 200% zoom, text spacing, orientation).
    // Once per page, on the base state only: these resize the window, which is
    // wasted work on every revealed state and would only re-report the same
    // layout defects. The module restores the original viewport before returning.
    if (runViewport && config.VIEWPORT_CHECKS !== false) {
      try {
        const vp = await timed('viewport', () => viewportChecks(page, { settleMs: config.VIEWPORT_SETTLE_MS }));
        out.violations.push(...vp.violations);
        out.incomplete.push(...vp.incomplete);
        out.passes.push(...vp.passes);
      } catch (e) { log(`      ⚠ viewport check skipped (${e.message.split('\n')[0]})`); }
    }
    // STATUS MESSAGES (4.1.3) + ERROR IDENTIFICATION (3.3.1). These are the only
    // checks that must ACT before they can observe — a status message does not
    // exist until something produces it. lib/interact.js answers every non-GET
    // with 204 for the duration, so the submit fires client-side validation and
    // dies at the network boundary; nothing can be written. Off by default for
    // any config that has not opted in.
    if (runViewport && config.LIVE_REGION_CHECKS === true) {
      let guard = null;
      try {
        guard = await installGuard(page, { log });
        const lr = await timed('liveRegion', () => liveRegionChecks(page, { guard, maxForms: config.LIVE_REGION_MAX_FORMS || 3, log }));
        out.violations.push(...lr.violations);
        out.incomplete.push(...lr.incomplete);
        out.passes.push(...lr.passes);
        // 3.2.1 / 3.2.2 / 1.4.13 — also needs to act, so it shares the guard.
        const cc = await timed('contextChange', () => contextChangeChecks(page, { guard, maxTabs: config.KEYBOARD_MAX_TABS || 25 }));
        out.violations.push(...cc.violations);
        out.incomplete.push(...cc.incomplete);
        out.passes.push(...cc.passes);
        // 2.5.2 — presses each down-event control and drags away before
        // releasing. Shares the guard: any write the press triggers is stopped.
        const pc = await timed('pointerCancel', () => pointerCancelChecks(page, { guard, max: config.POINTER_CANCEL_MAX || 8, log }));
        out.violations.push(...pc.violations);
        out.passes.push(...pc.passes);
        if (guard.blocked.length) log(`      · guard blocked ${guard.blocked.length} request(s) during interaction`);
      } catch (e) { log(`      ⚠ status-message check skipped (${e.message.split('\n')[0]})`); }
      finally { if (guard) await guard.uninstall().catch(() => {}); }
    }
    // 1.4.3 — resolve the contrast results axe could not decide, by sampling the
    // rendered pixels. Only the incomplete ones: anything axe already decided
    // needs no second opinion.
    if (config.CONTRAST_SAMPLING !== false) {
      const targets = [];
      for (const r of results.incomplete || []) {
        if (r.id !== 'color-contrast' && r.id !== 'color-contrast-enhanced') continue;
        for (const n of r.nodes || []) {
          const t = Array.isArray(n.target) ? n.target[0] : n.target;
          if (typeof t === 'string') targets.push(t);
        }
      }
      if (targets.length) {
        try {
          const cp = await timed('contrastPixel', () => contrastPixelChecks(page, targets, { log }));
          out.violations.push(...cp.violations);
          out.passes.push(...cp.passes);
          out.contrastResolved = { resolved: cp.resolved, unresolved: cp.unresolved };
        } catch (e) { log(`      ⚠ contrast sampling skipped (${e.message.split('\n')[0]})`); }
      }
    }
    // Second opinion: IBM's independently-built open-source engine, for a real
    // cross-engine accuracy comparison (not merged into the axe issue list).
    if (config.SECOND_ENGINE !== false) {
      try { out.ibm = await timed('ibmEngine', () => runSecondEngine(page)); }
      catch (e) { log(`      ⚠ second-engine check skipped (${e.message.split('\n')[0]})`); }
    }
    // Last, so findings from the custom checks get a location too: where each
    // failing element lives in source, read from the dev build
    // (React/Vue/Angular/Svelte). No-op on production builds.
    if (config.RUNTIME_SOURCE !== false) {
      try { await timed('runtimeSource', () => attachRuntimeSources(page, out)); }
      catch (e) { log(`      ⚠ runtime source lookup skipped (${e.message.split('\n')[0]})`); }
    }
    return out;
  }

}

module.exports = { createAnalyzer };
