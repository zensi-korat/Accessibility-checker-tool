/**
 * CI / automation support: environment-variable overrides, a build quality
 * gate, and JUnit XML output so Azure Pipelines (or any CI) can display
 * per-page accessibility results as test cases.
 *
 * Everything here is opt-in — running locally is unchanged.
 */
const fs = require('fs');
const path = require('path');

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/**
 * A threshold value → integer, or null when unset or not a number. CI systems
 * pass unset variables in odd shapes (Azure: the literal "$(NAME)"); parseInt
 * would give NaN, every `actual > NaN` comparison is false, and the gate would
 * silently never fail.
 */
const num = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
};

/** True when running in a CI/non-interactive environment. */
function isCI() {
  return !!(process.env.CI || process.env.TF_BUILD || process.env.A11Y_CI);
}

/**
 * Apply environment-variable overrides onto a loaded config. Lets one config
 * file serve local + CI without edits, and keeps secrets out of the repo.
 *
 *   A11Y_BASE_URL       override BASE_URL (e.g. per-environment staging URL)
 *   A11Y_REPO_PATH      override REPO_PATH (CI checkout path differs from local)
 *   A11Y_STORAGE_STATE  path to a Playwright storageState JSON (the saved login)
 *   A11Y_STORAGE_STATE_B64  same, but base64 — for secret pipeline variables
 *   A11Y_MAX_PAGES      cap pages for a faster smoke run
 *   A11Y_HEADLESS       '0' forces a visible browser window for the WHOLE run
 *                       (not just an interactive login), '1' forces headless.
 *                       Unset keeps the default: headless unless a login is
 *                       needed. Ignored under isCI() — a build agent has no
 *                       display, so forcing a window there would just hang.
 *   A11Y_FAIL_ON_CRITICAL / _SERIOUS / _TOTAL   build-failure thresholds
 *   A11Y_GATE_UNIQUE    '1' counts each defect once even when it repeats on
 *                       many pages (a shared header button is one fix)
 */
function applyEnvOverrides(config, log = () => {}) {
  const out = { ...config };

  if (process.env.A11Y_BASE_URL) {
    out.BASE_URL = process.env.A11Y_BASE_URL;
    log(`CI: BASE_URL overridden → ${out.BASE_URL}`);
  }
  if (process.env.A11Y_REPO_PATH !== undefined) {
    out.REPO_PATH = process.env.A11Y_REPO_PATH;
    log(`CI: REPO_PATH overridden → ${out.REPO_PATH || '(code mapping off)'}`);
  }
  if (process.env.A11Y_MAX_PAGES) {
    out.MAX_PAGES = parseInt(process.env.A11Y_MAX_PAGES, 10) || out.MAX_PAGES;
    log(`CI: MAX_PAGES → ${out.MAX_PAGES}`);
  }
  if (process.env.A11Y_HEADLESS === '0' && !isCI()) {
    out.HEADLESS = false;
    log('CI: HEADLESS=false — the browser window will stay visible for the whole run');
  } else if (process.env.A11Y_HEADLESS === '1') {
    out.HEADLESS = true;
  }

  // Auth: materialise a storageState file from a secret if provided, then
  // force 'form'-less reuse so nothing ever waits for an interactive login.
  let statePath = process.env.A11Y_STORAGE_STATE || null;
  if (process.env.A11Y_STORAGE_STATE_B64) {
    statePath = path.join(process.cwd(), '.ci-auth-state.json');
    fs.writeFileSync(statePath, Buffer.from(process.env.A11Y_STORAGE_STATE_B64, 'base64').toString('utf8'));
    log('CI: storageState materialised from A11Y_STORAGE_STATE_B64');
  }
  if (statePath) {
    out.LOGIN = { ...(out.LOGIN || {}), mode: 'manual', reuse: true, stateFile: statePath };
    log(`CI: reusing storageState → ${path.basename(statePath)}`);
  }

  if (process.env.A11Y_OPEN_REPORT === '0') out.OPEN_REPORT = false; // e.g. re-checks run by `a11y fix`
  if (isCI()) {
    out.OPEN_REPORT = false; // never try to open a browser window on a build agent
  }
  return out;
}

/**
 * Guards against a scan that silently only covered a fraction of the
 * intended site — e.g. a browser crash mid-run that skips every remaining
 * page but still exits 0. Discovered the hard way: a 40-page crawl crashed
 * after page 2 and reported a clean gate pass having scanned 5% of the site.
 *
 * In precise mode (explicit PAGES list) "expected" is exact. In crawl mode
 * page counts vary run to run, so we only enforce an absolute floor
 * (config.MIN_PAGES / A11Y_MIN_PAGES) rather than a ratio against MAX_PAGES.
 */
function evaluatePageCompleteness(matrix, config) {
  // The source-lint pseudo-page is not a scanned page of the app.
  const lint = new Set((matrix && matrix.lintPages) || []);
  const actualPages = (matrix && matrix.pages) ? matrix.pages.filter((p) => !lint.has(p)).length : 0;

  if (!config.AUTO_EXPLORE) {
    const expected = (config.PAGES || []).length;
    if (expected === 0) return { failed: false, reasons: [] };
    const minRatio = num(process.env.A11Y_MIN_PAGE_COMPLETION) != null
      ? num(process.env.A11Y_MIN_PAGE_COMPLETION) / 100
      : (config.MIN_PAGE_COMPLETION ?? 0.7);
    const ratio = actualPages / expected;
    if (ratio < minRatio) {
      return {
        failed: true,
        reasons: [`Only ${actualPages} of ${expected} configured pages produced data (${Math.round(ratio * 100)}%, need ${Math.round(minRatio * 100)}%) — likely a partial scan failure (browser crash/hang), not a clean pass. Check the scan log for load/timeout errors.`],
      };
    }
    return { failed: false, reasons: [] };
  }

  // Crawl mode: enforce an absolute minimum instead of a ratio.
  const minPages = num(process.env.A11Y_MIN_PAGES) ?? num(config.MIN_PAGES) ?? 1;
  if (actualPages < minPages) {
    return {
      failed: true,
      reasons: [`Crawl only produced data for ${actualPages} page(s), below the minimum of ${minPages}. Check the scan log — this usually means the crawl crashed or hung early.`],
    };
  }
  return { failed: false, reasons: [] };
}

/**
 * Build quality gate. Returns { failed, reasons } — the caller decides the
 * exit code. Thresholds come from env (CI) or config.FAIL_ON (local).
 * Unset/absent threshold = not enforced. Also enforces page-completeness
 * (see evaluatePageCompleteness) so a crashed/partial scan can't pass silently.
 */
function evaluateGate(stats, config, matrix, lifecycle) {
  const fo = config.FAIL_ON || {};
  const limits = {
    critical: num(process.env.A11Y_FAIL_ON_CRITICAL) ?? num(fo.critical),
    serious: num(process.env.A11Y_FAIL_ON_SERIOUS) ?? num(fo.serious),
    total: num(process.env.A11Y_FAIL_ON_TOTAL) ?? num(fo.total),
  };

  // ── What the gate counts ──────────────────────────────────────────────────
  // CONFIRMED violations only, by default. An "incomplete" result is the rule
  // engine reporting that it could NOT determine whether the element passes
  // (most commonly color-contrast where the background is overlapped or
  // image-based). Those need a human, but failing a build on them means
  // failing on findings nobody has confirmed are defects.
  //
  // The difference is not marginal here — a real run of this app:
  //   confirmed violations  83
  //   incomplete           7469   (7396 of them color-contrast)
  // so a gate counting both is ~90x louder than the actual defect count, and
  // would be permanently red for reasons unrelated to accessibility quality.
  //
  // Set A11Y_GATE_INCLUDE_UNCONFIRMED=1 to count review items too (for a
  // deliberately stricter posture) — off by default.
  const includeUnconfirmed = process.env.A11Y_GATE_INCLUDE_UNCONFIRMED === '1';
  // A11Y_GATE_UNIQUE=1 counts a defect repeated across pages once (stats.unique
  // groups by rule + element). Confirmed violations only.
  const unique = process.env.A11Y_GATE_UNIQUE === '1' && stats.unique && !includeUnconfirmed;
  const c = stats.confirmed || { total: stats.totalIssues, critical: stats.byImpact.critical, serious: stats.byImpact.serious };
  const actual = includeUnconfirmed
    ? { critical: stats.byImpact.critical, serious: stats.byImpact.serious, total: stats.totalIssues }
    : unique
      ? { critical: stats.unique.critical, serious: stats.unique.serious, total: stats.unique.confirmed }
      : { critical: c.critical, serious: c.serious, total: c.total };
  const basis = includeUnconfirmed ? 'confirmed + needs-review'
    : unique ? 'unique confirmed WCAG violations' : 'confirmed WCAG violations only';
  const reasons = [];
  for (const key of ['critical', 'serious', 'total']) {
    if (limits[key] !== null && limits[key] !== undefined && actual[key] > limits[key]) {
      reasons.push(`${actual[key]} ${key} ${key === 'total' ? 'issue(s)' : 'violation(s)'} exceeds threshold of ${limits[key]} (counting ${basis})`);
    }
  }
  const completeness = evaluatePageCompleteness(matrix, config);
  reasons.push(...completeness.reasons);

  // Lifecycle gates from the programme KPI catalogue. Both default to "not
  // enforced" so existing pipelines are unaffected until they are switched on:
  //   A11Y_FAIL_ON_REGRESSIONS   regression escapes (catalogue target: 0)
  //   A11Y_FAIL_ON_BLOCKER_AGE   Blockers older than 7 days (target: 0)
  if (lifecycle) {
    const lc = lifecycle;
    const maxReg = num(process.env.A11Y_FAIL_ON_REGRESSIONS) ?? num(fo.regressions);
    if (maxReg !== null && maxReg !== undefined && lc.regressions.length > maxReg) {
      reasons.push(`${lc.regressions.length} regression escape(s) exceeds threshold of ${maxReg} — a previously clean page now fails. See the Defect Lifecycle panel.`);
    }
    const maxAged = num(process.env.A11Y_FAIL_ON_BLOCKER_AGE) ?? num(fo.blockersOverSla);
    if (maxAged !== null && maxAged !== undefined && lc.overSla > maxAged) {
      reasons.push(`${lc.overSla} Blocker-severity defect(s) older than 7 days exceeds threshold of ${maxAged}.`);
    }
  }

  const enforced = ['critical', 'serious', 'total'].some((k) => limits[k] !== null && limits[k] !== undefined);
  const warnings = [];
  if (!enforced && isCI()) {
    warnings.push('No failure threshold is set, so this build cannot fail on accessibility issues. Set A11Y_FAIL_ON_CRITICAL (e.g. 0) and/or A11Y_FAIL_ON_SERIOUS, or FAIL_ON in a11y.config.js.');
  }
  return { failed: reasons.length > 0, reasons, warnings, enforced, limits, actual, basis };
}

/**
 * JUnit XML — one <testsuite> per scanned page, one <testcase> per WCAG
 * criterion that page exercised. Azure Pipelines' PublishTestResults task
 * renders this as a pass/fail tree, so a11y regressions show up in the normal
 * build "Tests" tab instead of only inside an HTML artifact.
 */
function suite(name, cases) {
  const failures = cases.filter((c) => c.includes('<failure')).length;
  const skipped = cases.filter((c) => c.includes('<skipped')).length;
  return {
    tests: cases.length, failures, skipped,
    xml: `  <testsuite name="${esc(name)}" tests="${cases.length}" failures="${failures}" skipped="${skipped}">\n`
      + cases.join('\n') + '\n  </testsuite>',
  };
}

function writeJUnit(outDir, data, file = 'a11y-results.xml') {
  const { matrix, criteria, issues } = data;
  const lint = new Set((matrix && matrix.lintPages) || []);
  const pages = ((matrix && matrix.pages) || []).filter((p) => !lint.has(p));
  const byPageCriterion = (page, id) => (matrix.cells[page] && matrix.cells[page][id]) || 'na';

  const suites = pages.map((page) => {
    const pageIssues = issues.filter((i) => i.page === page);
    const cases = criteria
      .filter((c) => c.auto && !c.obsolete)
      .map((c) => {
        const status = byPageCriterion(page, c.id);
        const name = esc(`${c.id} ${c.name} (${c.level})`);
        const cls = esc(page);
        const rel = status === 'fail'
          ? pageIssues.filter((i) => i.kind === 'violation' && (i.criteria || []).some((x) => x.id === c.id))
          : [];
        if (status === 'fail' && rel.length) {
          const detail = rel.slice(0, 10).map((i) => {
            const loc = i.locations && i.locations[0] ? ` @ ${i.locations[0].file}:${i.locations[0].line}` : '';
            return `[${i.impact}] ${i.rule}${loc}\n  ${String(i.html || '').replace(/\s+/g, ' ').slice(0, 180)}`;
          }).join('\n\n');
          return `    <testcase classname="${cls}" name="${name}">\n`
            + `      <failure message="${esc(rel.length + ' issue(s) for this criterion')}">${esc(detail)}</failure>\n`
            + '    </testcase>';
        }
        if (status === 'review' || status === 'fail') {
          // 'fail' with no confirmed issue on this page (evidence lives
          // elsewhere) is reported as needing review, never an empty failure.
          return `    <testcase classname="${cls}" name="${name}">\n`
            + '      <skipped message="Needs manual review — automated check was inconclusive"/>\n'
            + '    </testcase>';
        }
        if (status === 'pass') return `    <testcase classname="${cls}" name="${name}"/>`;
        return `    <testcase classname="${cls}" name="${name}">\n`
          + '      <skipped message="Not applicable / not exercised on this page"/>\n'
          + '    </testcase>';
      });
    return suite(page, cases);
  });

  // Source lint: one test case per finding, in its own suite.
  const lintIssues = issues.filter((i) => i.source === 'lint' && i.kind === 'violation');
  if (lint.size && lintIssues.length) {
    suites.push(suite('Source code (lint)', lintIssues.map((i) => {
      const loc = i.locations && i.locations[0] ? `${i.locations[0].file}:${i.locations[0].line}` : i.target;
      return `    <testcase classname="lint" name="${esc(`${i.rule} @ ${loc}`)}">\n`
        + `      <failure message="${esc(i.help || i.rule)}">${esc(String(i.html || '').replace(/\s+/g, ' ').slice(0, 180))}</failure>\n`
        + '    </testcase>';
    })));
  }

  const totals = suites.reduce((t, s) => ({ tests: t.tests + s.tests, failures: t.failures + s.failures, skipped: t.skipped + s.skipped }),
    { tests: 0, failures: 0, skipped: 0 });
  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n'
    + `<testsuites name="Accessibility (WCAG 2.2 A+AA)" tests="${totals.tests}" failures="${totals.failures}" skipped="${totals.skipped}">\n`
    + suites.map((s) => s.xml).join('\n') + '\n</testsuites>\n';
  fs.writeFileSync(path.join(outDir, file), xml);
  return path.join(outDir, file);
}

module.exports = { isCI, applyEnvOverrides, evaluateGate, evaluatePageCompleteness, writeJUnit, num };
