#!/usr/bin/env node
/**
 * Combine every archived scan run into ONE report, then apply the quality gate.
 *
 * Why this exists: apps with several roles (e.g. admin and staff) cannot be
 * scanned in one pass — each role needs its own browser session, its own
 * credentials, and therefore its own scan run. In CI those are usually
 * parallel jobs.
 *
 * This script is the join point: it reads every reports/<run>/scan-data.json
 * present on disk — however they got there, locally or downloaded from job
 * artifacts — merges them by page (most recent run of each page wins), and
 * produces the combined dashboard, the single-file report, JUnit XML, and a
 * single pass/fail gate covering every role.
 *
 * Exit codes match scan.js:  0 = gate passed   1 = gate breached / fatal
 *
 *   node combine-reports.js
 */
const path = require('path');
const fs = require('fs');

const { aggregate } = require('./lib/aggregate');
const { writeReports } = require('./lib/report');
const { writeSingleFile } = require('./lib/bundle');
const { buildCombinedScans } = require('./lib/combine');
const { syncCombinedShots } = require('./lib/archive');
const { buildLifecycle } = require('./lib/lifecycle');
const { createMapper } = require('./lib/codeMap');
const { evaluateGate, writeJUnit } = require('./lib/ci');

// Same config lookup as scan.js (--config / A11Y_CONFIG / ./a11y.config.js)
// so the combine step reads the folder the scans wrote.
// Without any config, fall back to the current directory + env vars.
let config = null;
try { config = require('./lib/config/load').loadConfig(); } catch { /* env-only mode */ }
const OUT_DIR = config ? config.OUTPUT_DIR : process.cwd();
const log = (m) => process.stdout.write(m + '\n');

function main() {
  const reportsDir = path.join(OUT_DIR, 'reports');
  if (!fs.existsSync(reportsDir)) {
    log('\n✗ No reports/ directory — nothing to combine. Did the scan jobs publish their artifacts?');
    process.exitCode = 1;
    return;
  }

  const combined = buildCombinedScans(OUT_DIR);
  if (!combined.scans.length) {
    log('\n✗ No scan data found in reports/. Each scan job must publish its');
    log('  reports/<timestamp>_*/scan-data.json for this step to combine them.');
    process.exitCode = 1;
    return;
  }

  const repoPath = config ? config.REPO_PATH : (process.env.A11Y_REPO_PATH || '');
  const exts = config ? config.CODE_EXTENSIONS : require('./lib/adapters').codeExtensionsFor(repoPath ? require('./lib/adapters').detectStacks(repoPath) : []);
  const mapper = repoPath ? createMapper(repoPath, exts, { stripServerIds: config ? config.STRIP_SERVER_IDS : exts.includes('.aspx') }) : null;
  if (mapper) log(`Indexed ${mapper.indexedFiles} source files for code mapping.`);

  const c = aggregate(combined.scans, mapper, { stacks: config ? config.STACKS : [] });
  const meta = {
    baseUrl: (config && config.BASE_URL) || process.env.A11Y_BASE_URL || '',
    generatedAt: new Date().toLocaleString(),
    pageCount: combined.sources.length,
    stateCount: combined.scans.length,
    repoIndexed: mapper ? mapper.indexedFiles : 0,
    reportName: 'All pages (combined)',
    combinedSources: combined.sources,
  };
  const data = { ...c, meta };
  try { data.lifecycle = buildLifecycle(OUT_DIR, data, {}); }
  catch (e) { log(`   ⚠ lifecycle skipped (${e.message.split('\n')[0]})`); }

  const built = writeReports(reportsDir, data, { prefix: 'all-pages-dashboard,all-pages-report' });
  const shots = syncCombinedShots(OUT_DIR);
  log(`   • combined screenshots: ${shots.copied} file(s) → reports/shots/`);

  const one = writeSingleFile(OUT_DIR, { dashboard: built.dashboard, report: built.report },
    { shotRoots: [reportsDir, OUT_DIR], log });
  fs.copyFileSync(one.file, path.join(reportsDir, 'accessibility-report.html'));

  try { writeJUnit(OUT_DIR, data); log('   • JUnit: a11y-results.xml'); }
  catch (e) { log(`   ⚠ JUnit skipped (${e.message.split('\n')[0]})`); }

  // Which scan runs (roles/portals) actually contributed — makes a silently
  // missing job obvious instead of quietly reporting "all pages" from one.
  const pages = c.matrix.pages;
  const perReport = {};
  // A page covered by a route scan AND an E2E run lists both names, joined by " + ".
  for (const src of combined.sources) {
    for (const n of (src.reportName || '(unnamed)').split(' + ')) perReport[n] = (perReport[n] || 0) + 1;
  }
  const breakdown = Object.entries(perReport).map(([n, k]) => `${k} from "${n}"`).join(' · ');

  log('\n─────────────────────────────────────────────');
  log(`  Pages:     ${pages.length}  (${breakdown})`);
  log(`  States:    ${combined.scans.length}`);
  log(`  Confirmed: ${c.stats.confirmed.total} violation(s)  — ${c.stats.confirmed.critical} critical, ${c.stats.confirmed.serious} serious, ${c.stats.confirmed.moderate} moderate, ${c.stats.confirmed.minor} minor`);
  log(`  Review:    ${c.stats.incompletes} finding(s) the engine could not decide — NOT gated on`);
  log('─────────────────────────────────────────────');
  log(`\n✔ ONE FILE: ${one.file}  (${(one.bytes / 1e6).toFixed(1)} MB, self-contained)`);

  // EXPECTED_REPORTS (config) / A11Y_EXPECTED_REPORTS (comma-separated): the
  // REPORT_NAMEs of every job that should have contributed, e.g. one per role.
  const expected = (process.env.A11Y_EXPECTED_REPORTS ? process.env.A11Y_EXPECTED_REPORTS.split(',') : (config && config.EXPECTED_REPORTS) || [])
    .map((x) => x.trim()).filter(Boolean);
  const absent = expected.filter((n) => !perReport[n]);
  if (absent.length) {
    log(`\n⚠ No pages from: ${absent.map((n) => `"${n}"`).join(', ')}. If that scan job was expected`);
    log('  to run, it either failed or published nothing — check that job.');
  }

  // Gate across every role at once. PAGES is unknown here (two configs), so
  // page-completeness is enforced per-job in each scan; this gate covers
  // issue thresholds and lifecycle only.
  const gate = evaluateGate(c.stats, { PAGES: [], FAIL_ON: {} }, c.matrix, data.lifecycle);
  if (gate.failed) {
    log('\n✗ Accessibility quality gate FAILED:');
    gate.reasons.forEach((r) => log(`    · ${r}`));
    process.exitCode = 1;
  } else {
    log(`\n✔ Quality gate passed (counting ${gate.basis}).`);
  }
}

try { main(); }
catch (e) { console.error('\nFatal:', e); process.exitCode = 1; }
