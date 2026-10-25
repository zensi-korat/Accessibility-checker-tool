#!/usr/bin/env node
/**
 * Re-render dashboard.html / report.html / report.json from the cached scan
 * results (.scan-cache.json) WITHOUT re-scanning the live site.
 *
 * Use this after tweaking report styling, the matrix, wcag-criteria.js, or
 * fixes.js — it re-aggregates the last scan and rebuilds the reports in ~1s.
 *
 *   npm run render
 */
const fs = require('fs');
const path = require('path');
const config = require('./lib/config/load').loadConfig();
const { createMapper } = require('./lib/codeMap');
const { aggregate } = require('./lib/aggregate');
const { writeReports } = require('./lib/report');
const { readPrevious, readHistory, syncCombinedShots } = require('./lib/archive');
const { buildCombinedScans } = require('./lib/combine');
const { writeSingleFile } = require('./lib/bundle');
const { buildLifecycle } = require('./lib/lifecycle');

const OUT_DIR = config.OUTPUT_DIR;
const cacheFile = path.join(OUT_DIR, '.scan-cache.json');

if (!fs.existsSync(cacheFile)) {
  console.error('✗ No .scan-cache.json found. Run `npm run scan` at least once first.');
  process.exit(1);
}

const { meta, scans } = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
const mapper = config.REPO_PATH ? createMapper(config.REPO_PATH, config.CODE_EXTENSIONS, { stripServerIds: config.STRIP_SERVER_IDS }) : null;

const { criteria, issues, stats, matrix } = aggregate(scans, mapper, { stacks: config.STACKS });
const previous = readPrevious(OUT_DIR, meta.reportName);
const history = readHistory(OUT_DIR, meta.reportName);
const runData = { criteria, issues, stats, matrix, previous, history, meta: { ...meta, generatedAt: new Date().toLocaleString() } };
try { runData.lifecycle = buildLifecycle(OUT_DIR, runData, { reportName: meta.reportName }); } catch (e) { /* non-fatal */ }
writeReports(OUT_DIR, runData);

console.log(`✔ Re-rendered from cache (${scans.length} states, ${issues.length} issues).`);
console.log(`  dashboard.html · report.html · report.json`);

// Also refresh the cumulative all-pages dashboard (reads reports/*/scan-data.json
// directly from disk, so it reflects every page ever scanned, not just this cache).
try {
  const combined = buildCombinedScans(OUT_DIR);
  if (combined.scans.length) {
    const c = aggregate(combined.scans, mapper, { stacks: config.STACKS });
    const combinedMeta = {
      baseUrl: meta.baseUrl, generatedAt: new Date().toLocaleString(),
      pageCount: combined.sources.length, stateCount: combined.scans.length,
      repoIndexed: config.REPO_PATH ? mapper.indexedFiles : 0,
      reportName: 'All pages (combined)', combinedSources: combined.sources,
    };
    const combinedData = { ...c, meta: combinedMeta };
    try { combinedData.lifecycle = buildLifecycle(OUT_DIR, combinedData, {}); } catch (e) { /* non-fatal */ }
    const built = writeReports(path.join(OUT_DIR, 'reports'), combinedData, { prefix: 'all-pages-dashboard,all-pages-report' });
    // Combined report's <img> paths are relative, so they resolve to
    // reports/shots/ — assemble the union from every run's archived shots.
    const shots = syncCombinedShots(OUT_DIR);
    console.log(`  reports/all-pages-dashboard.html (${combined.sources.length} page(s) combined, ${shots.copied} screenshot(s))`);
    // ONE self-contained file — dashboard + findings + inlined screenshots.
    const one = writeSingleFile(OUT_DIR, { dashboard: built.dashboard, report: built.report },
      { shotRoots: [path.join(OUT_DIR, 'reports'), OUT_DIR], log: (m) => console.log(m) });
    fs.copyFileSync(one.file, path.join(OUT_DIR, 'reports', 'accessibility-report.html'));
    console.log(`  accessibility-report.html (${(one.bytes / 1e6).toFixed(1)} MB, self-contained)`);
  }
} catch (e) { console.log('  ⚠ combined dashboard skipped:', e.message.split('\n')[0]); }

if (config.OPEN_REPORT !== false) {
  const { exec } = require('child_process');
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start ""' : 'xdg-open';
  exec(`${cmd} "${path.join(OUT_DIR, 'dashboard.html')}"`, () => {});
}
