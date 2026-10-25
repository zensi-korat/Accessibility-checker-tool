/**
 * Reuse a project's own Playwright tests as accessibility journeys.
 *
 * E2E tests already log in, seed data, open the dialogs and walk the flows a
 * route-by-route scan can't reach. This fixture runs the same analysis as
 * `a11y scan` (lib/analyze.js) at the points the test chooses, and the
 * reporter (./reporter.js) turns everything into the usual dashboard.
 *
 *   // tests/fixtures.ts
 *   import { test as base } from '@playwright/test';
 *   import { withA11y } from '<tool>/playwright';
 *   export const test = withA11y(base);
 *
 *   // in a test
 *   await page.getByRole('button', { name: 'Add user' }).click();
 *   const r = await a11y.check('Add user dialog');
 *   expect(r.violations).toEqual([]);          // optional: fail the test on violations
 *
 *   // playwright.config.ts
 *   reporter: [['list'], ['<tool>/playwright/reporter.js']],
 *
 * Options (test.use({ a11yOptions: {...} })):
 *   auto    true   scan the final page of every passing test that made no check() call
 *   deep    false  also run the keyboard walk, screen-reader, reflow/zoom, heading and
 *                  contrast checks — they resize the viewport and press Tab, so they are
 *                  off by default to keep mid-test state untouched
 *   config  —      path to a11y.config.js (default: ./a11y.config.js if present)
 */
const fs = require('fs');
const path = require('path');
const { createAnalyzer } = require('../analyze');
const { instrumentListeners } = require('../clickable');
const { loadE2eConfig, pageNameFor, scansDir } = require('./shared');

function withA11y(base, defaults = {}) {
  return base.extend({
    a11yOptions: [{ auto: true, deep: false, config: undefined, ...defaults }, { option: true }],

    a11y: async ({ page, a11yOptions }, use, testInfo) => {
      const config = loadE2eConfig(a11yOptions.config);
      const analyze = createAnalyzer(config, { log: () => {} });
      if (a11yOptions.deep && config.DYNAMIC_CHECKS !== false) await instrumentListeners(page).catch(() => {});
      const testTitle = testInfo.titlePath.slice(1).join(' › ');
      const scans = [];

      const api = {
        /**
         * Analyse the page as it is right now.
         * @returns {{violations: {id:string, impact:string, help:string, nodes:number}[], review:number, page:string}}
         */
        async check(label, opts = {}) {
          const deep = opts.deep !== undefined ? opts.deep : a11yOptions.deep;
          await page.waitForLoadState('domcontentloaded').catch(() => {});
          if (config.SETTLE_MS) await page.waitForTimeout(Math.min(config.SETTLE_MS, 1000));
          const url = page.url();
          const name = pageNameFor(url, config);
          const state = `${testTitle} › ${label || `check ${scans.length + 1}`}`;
          const out = await analyze(page, state, deep, name, deep);
          scans.push({ page: name, url, ...out, test: testTitle, file: path.relative(process.cwd(), testInfo.file) });
          return {
            page: name,
            violations: out.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: (v.nodes || []).length })),
            review: out.incomplete.length,
          };
        },
      };

      await use(api);

      const passed = testInfo.status === testInfo.expectedStatus;
      if (a11yOptions.auto && !scans.length && passed && !page.isClosed() && /^https?:/.test(page.url())) {
        await api.check('end of test').catch(() => {});
      }
      if (scans.length) {
        const dir = scansDir(config);
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `${testInfo.testId}-r${testInfo.retry}-w${testInfo.workerIndex}.json`);
        fs.writeFileSync(file, JSON.stringify(scans));
        // Never let a scan without findings be mistaken for an unscanned test.
        testInfo.annotations.push({ type: 'a11y', description: `${scans.length} state(s), ${scans.reduce((n, s) => n + s.violations.length, 0)} violation rule(s)` });
      }
    },
  });
}

module.exports = { withA11y };
