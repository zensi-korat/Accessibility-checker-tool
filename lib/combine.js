/**
 * Builds the CUMULATIVE all-pages dashboard: merges the most recent scan of
 * EVERY distinct page you've ever run, across all archived reports, into one
 * combined view. This is what fixes "why did scanning one area make another
 * area's pages disappear?" — each scan only re-scans the page(s) in
 * that run's config.PAGES, so the LIVE dashboard.html only ever reflects the
 * latest run. This module reconstructs the union from each archived run's
 * scan-data.json (the raw per-state axe results persisted by archiveReports()).
 *
 * If the SAME page name is scanned again later, its newer run wins — so the
 * combined view always reflects the freshest data per page, not a pile of
 * duplicates.
 */
const fs = require('fs');
const path = require('path');

function readManifest(outDir) {
  try { return JSON.parse(fs.readFileSync(path.join(outDir, 'reports', 'manifest.json'), 'utf8')); }
  catch (e) { return []; }
}

/**
 * @param {string} outDir tool root
 * @returns {{ scans: Array, sources: Array<{page:string, reportName:string, folder:string, at:string}> }}
 */
function buildCombinedScans(outDir) {
  const manifest = readManifest(outDir); // newest first
  const byPage = new Map(); // page name -> { atISO, entry, scans }

  for (const entry of manifest) {
    const dataFile = path.join(outDir, 'reports', entry.folder, 'scan-data.json');
    let scans;
    try { scans = JSON.parse(fs.readFileSync(dataFile, 'utf8')); } catch (e) { continue; }
    const byPageInRun = new Map();
    for (const s of scans) {
      if (!byPageInRun.has(s.page)) byPageInRun.set(s.page, []);
      byPageInRun.get(s.page).push(s);
    }
    // E2E runs (REPORT_NAME "… (E2E)") cover different states of the same
    // pages, so they sit ALONGSIDE the latest route scan of a page instead of
    // replacing it. Between runs of the same kind, the newest still wins.
    const kind = /\(E2E\)$/.test(entry.name || '') ? '#e2e' : '';
    for (const [page, pageScans] of byPageInRun) {
      const key = page + kind;
      // manifest is newest-first, so the FIRST time we see a page is already
      // its most recent run — skip if we've already captured it.
      if (byPage.has(key)) continue;
      byPage.set(key, { page, entry, scans: pageScans });
    }
  }

  const scans = [];
  const byName = new Map();
  // Sort pages by most-recent-first for a stable, meaningful order.
  const entries = [...byPage.values()].sort((a, b) => new Date(b.entry.atISO || 0) - new Date(a.entry.atISO || 0));
  for (const { page, entry, scans: pageScans } of entries) {
    scans.push(...pageScans);
    const prev = byName.get(page);
    if (prev) prev.reportName += ` + ${entry.name}`;
    else byName.set(page, { page, reportName: entry.name, folder: entry.folder, at: entry.at });
  }
  const sources = [...byName.values()];
  return { scans, sources };
}

module.exports = { buildCombinedScans };
