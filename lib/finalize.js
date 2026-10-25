/**
 * Everything after the browser closes: cross-page checks, aggregation,
 * reports, history archive, the cumulative dashboard, the single-file report,
 * JUnit and the quality gate. Shared by scan.js and the Playwright reporter.
 *
 * Sets process.exitCode = 1 when the gate fails; returns what it wrote.
 */
const fs = require('fs');
const path = require('path');
const { evaluateGate, writeJUnit } = require('./ci');
const { aggregate } = require('./aggregate');
const { writeReports } = require('./report');
const { writeSingleFile } = require('./bundle');
const { evaluateConsistency } = require('./consistency');
const { evaluateFlowAcrossPages } = require('./formFlow');
const { archiveReports, readPrevious, readHistory, syncCombinedShots } = require('./archive');
const { buildVerification, logVerification } = require('./verify');
const { buildLifecycle } = require('./lifecycle');
const { buildCombinedScans } = require('./combine');

/**
 * @param {{scans:object[], config:object, mapper:object, log?:Function, pageCount?:number, reportName?:string}} run
 */
function finalizeRun({ scans, config, mapper, log = () => {}, pageCount = null, reportName, skippedPages = [], verifyWith = null }) {
  const OUT_DIR = config.OUTPUT_DIR;
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const aggregateOpts = { stacks: config.STACKS || [], repoPath: config.REPO_PATH };
  log('\nAggregating results…');
  const meta = {
    baseUrl: config.BASE_URL,
    generatedAt: new Date().toLocaleString(),
    pageCount: pageCount != null ? pageCount : config.PAGES.length,
    stateCount: scans.length,
    repoIndexed: config.REPO_PATH ? mapper.indexedFiles : 0,
    reportName: reportName != null ? reportName : (config.REPORT_NAME || ''),
    skippedPages,
  };

  // ── Cross-page consistency (3.2.3, 3.2.4, 3.2.6, 2.4.5) ──────────────────
  // Every page has now been seen, so the per-page fingerprints can be compared.
  // Findings are attributed to the DEVIATING page, which is the one someone
  // has to open to fix it, so they merge into that page's results.
  try {
    const signatures = {};
    for (const s of scans) if (s.consistency && !signatures[s.page]) signatures[s.page] = s.consistency;
    const byPage = evaluateConsistency(signatures);
    let added = 0;
    for (const s of scans) {
      if (s.state !== 'initial') continue; // attach to the base state only
      const r = byPage[s.page];
      if (!r) continue;
      s.violations.push(...r.violations);
      s.passes.push(...r.passes);
      added += r.violations.length;
    }
    const pagesCompared = Object.keys(signatures).length;
    if (pagesCompared >= 3) {
      log(`\nCross-page consistency: compared ${pagesCompared} pages, ${added} deviation(s) found.`);
    } else {
      log(`\nCross-page consistency: only ${pagesCompared} page(s) with a signature — need 3+ to compare, skipped.`);
    }
  } catch (e) { log(`⚠ consistency evaluation skipped (${e.message.split('\n')[0]})`); }

  // ── 3.3.7 across the steps of one flow ───────────────────────────────────
  try {
    const flowSigs = {};
    for (const s of scans) if (s.flowSignature && !flowSigs[s.page]) flowSigs[s.page] = s.flowSignature;
    const byPage = evaluateFlowAcrossPages(flowSigs);
    let added = 0;
    for (const s of scans) {
      if (s.state !== 'initial') continue;
      const r = byPage[s.page];
      if (!r) continue;
      s.violations.push(...r.violations);
      added += r.violations.length;
    }
    if (added) log(`Redundant entry across flow steps: ${added} finding(s).`);
  } catch (e) { log(`⚠ redundant-entry evaluation skipped (${e.message.split('\n')[0]})`); }

  // Cache the raw axe results so reports can be re-rendered (styling/matrix
  // tweaks) with `npm run render` — no need to re-scan the live site.
  try {
    fs.writeFileSync(path.join(OUT_DIR, '.scan-cache.json'), JSON.stringify({ meta, scans }));
  } catch (e) { /* non-fatal */ }

  const { criteria, issues, stats, matrix } = aggregate(scans, config.REPO_PATH ? mapper : null, aggregateOpts);
  // Previous run of this report (for Δ vs last scan) + full history (for trend).
  const previous = readPrevious(OUT_DIR, meta.reportName);
  const history = readHistory(OUT_DIR, meta.reportName);
  const data = { criteria, issues, stats, matrix, meta, previous, history };
  // Fixed / still failing / new vs. the previous scan of each page (lib/verify.js).
  if (verifyWith) {
    try { data.verification = buildVerification(verifyWith.baseline, scans, issues, verifyWith.presence); } catch (e) { log(`   ⚠ fix verification skipped (${e.message.split('\n')[0]})`); }
  }
  try { data.lifecycle = buildLifecycle(OUT_DIR, data, { reportName: meta.reportName }); } catch (e) { log(`   ⚠ lifecycle skipped (${e.message.split("\n")[0]})`); }
  const own = writeReports(OUT_DIR, data);
  const archived = archiveReports(OUT_DIR, data, scans); // keep a browsable history + raw data for combining

  let singleFile = null;
  // CUMULATIVE_REPORT: false bundles ONLY the pages this run scanned.
  //
  // By default the shareable single file is the cumulative view — every page
  // ever scanned, so pages from an earlier run stay visible after you scan
  // another area. That is right for a real report and wrong for a demo: a
  // 2-page scan would open a dashboard whose page picker lists 15, and the
  // scope on screen would contradict what was just run.
  if (config.CUMULATIVE_REPORT === false) {
    try {
      singleFile = writeSingleFile(OUT_DIR, { dashboard: own.dashboard, report: own.report },
        { shotRoots: [OUT_DIR], log });
      log(`   • single-run report: ${pageCount != null ? pageCount : config.PAGES.length} page(s) only (CUMULATIVE_REPORT: false)`);
    } catch (e) { log(`   ⚠ single-file report skipped (${e.message.split('\n')[0]})`); }
  } else try {
    // Rebuild the CUMULATIVE all-pages dashboard: every page you've ever
    // scanned (across all reports), using each page's most recent run. This is
    // what keeps pages from an earlier run visible after you scan another area.
    const combined = buildCombinedScans(OUT_DIR);
    const c = aggregate(combined.scans, config.REPO_PATH ? mapper : null, aggregateOpts);
    const combinedMeta = {
      baseUrl: config.BASE_URL,
      generatedAt: new Date().toLocaleString(),
      pageCount: combined.sources.length,
      stateCount: combined.scans.length,
      repoIndexed: config.REPO_PATH ? mapper.indexedFiles : 0,
      reportName: 'All pages (combined)',
      combinedSources: combined.sources,
    };
    const built = writeReports(path.join(OUT_DIR, 'reports'), { ...c, meta: combinedMeta }, { prefix: 'all-pages-dashboard,all-pages-report' });
    // The combined report's <img> paths are relative ("shots/x.png"), so they
    // resolve to reports/shots/ — which only the per-run archives have. Build
    // the union there or every screenshot in this report is broken.
    const shots = syncCombinedShots(OUT_DIR);
    log(`   • combined screenshots: ${shots.copied} file(s) → reports/shots/`);

    // ONE self-contained file: dashboard + every finding + screenshots inlined.
    // This is the artifact to hand to anyone who just wants to read the report
    // — no folder, no sibling files, no hosting.
    singleFile = writeSingleFile(OUT_DIR, { dashboard: built.dashboard, report: built.report },
      { shotRoots: [path.join(OUT_DIR, 'reports'), OUT_DIR], log });
    fs.copyFileSync(singleFile.file, path.join(OUT_DIR, 'reports', 'accessibility-report.html'));
  } catch (e) { log(`   ⚠ combined dashboard skipped (${e.message.split('\n')[0]})`); }

  log('\n─────────────────────────────────────────────');
  log(`  Criteria:  ${stats.fail} failed · ${stats.review} review · ${stats.pass} passed · ${stats.manual} manual · ${stats.na} n/a`);
  log(`  Issues:    ${stats.totalIssues}  (${stats.byImpact.critical} critical, ${stats.byImpact.serious} serious, ${stats.byImpact.moderate} moderate, ${stats.byImpact.minor} minor)`);
  log('─────────────────────────────────────────────');
  logVerification(data.verification, log);
  log(`\n✔ Latest:   ${path.join(OUT_DIR, 'dashboard.html')}`);
  log(`  Archived: reports/${archived.folder}/`);
  log(`  History:  ${archived.indexPath}`);
  if (config.CUMULATIVE_REPORT !== false) {
    log(`  Combined: ${path.join(OUT_DIR, 'reports', 'all-pages-dashboard.html')}  (every page ever scanned)`);
  }
  if (singleFile) {
    const scope = config.CUMULATIVE_REPORT === false
      ? `this run's ${pageCount != null ? pageCount : config.PAGES.length} page(s) only`
      : 'self-contained';
    log(`  ONE FILE: ${singleFile.file}  (${(singleFile.bytes / 1e6).toFixed(1)} MB, ${scope} — this is the one to share)`);
  }
  // ── CI outputs: JUnit XML (Azure "Tests" tab) + build quality gate ─────────
  try {
    const junitPath = writeJUnit(OUT_DIR, data);
    log(`  JUnit:    ${junitPath}`);
  } catch (e) { log(`   ⚠ JUnit output skipped (${e.message.split('\n')[0]})`); }

  const gate = evaluateGate(stats, config, matrix, data.lifecycle);
  if (gate.failed) {
    log('\n✗ Accessibility quality gate FAILED:');
    gate.reasons.forEach((r) => log(`    · ${r}`));
    process.exitCode = 1;
  } else if (gate.limits.critical != null || gate.limits.serious != null || gate.limits.total != null) {
    log(`\n✔ Quality gate passed (critical ${gate.actual.critical}/${gate.limits.critical ?? '∞'}, serious ${gate.actual.serious}/${gate.limits.serious ?? '∞'}, total ${gate.actual.total}/${gate.limits.total ?? '∞'}).`);
  }

  return { data, singleFile, gate, outDir: OUT_DIR };
}

module.exports = { finalizeRun };
