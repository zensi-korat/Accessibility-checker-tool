/**
 * Keeps a browsable history of scans so runs don't overwrite each other.
 *
 * After each scan the three reports are copied into
 *   reports/<timestamp>_<name>/{dashboard.html,report.html,report.json}
 * and reports/index.html is regenerated — a single page listing every run
 * (newest first) with links and headline stats. Each run folder is
 * self-contained, so you can zip/download/share any of them.
 */
const fs = require('fs');
const path = require('path');

function slug(s) {
  return String(s || 'scan').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'scan';
}
function stamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function buildIndex(manifest) {
  const rows = manifest.map((r) => `
    <tr>
      <td><a href="${esc(r.folder)}/dashboard.html">${esc(r.name)}</a>
        <div class="u">${esc(r.url)}</div></td>
      <td>${esc(r.at)}</td>
      <td>${(r.pages || []).length}</td>
      <td><b style="color:#c0392b">${r.stats.fail}</b></td>
      <td style="color:#9a6700">${r.stats.review}</td>
      <td style="color:#1b7a4b">${r.stats.pass}</td>
      <td>${r.stats.issues} <span class="u">(${r.stats.critical}c / ${r.stats.serious}s)</span></td>
      <td class="links">
        <a href="${esc(r.folder)}/dashboard.html">Dashboard</a>
        <a href="${esc(r.folder)}/report.html">Issues</a>
        <a href="${esc(r.folder)}/report.json" download>JSON</a>
      </td>
    </tr>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Accessibility scans</title>
<style>
body{margin:0;background:#f4f6f9;color:#1f2733;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif}
.wrap{max-width:1080px;margin:0 auto;padding:32px 24px 80px}
h1{font-size:22px;margin:0 0 4px}.sub{color:#6b7280;font-size:13px;margin-bottom:22px}
table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e2e6ec;border-radius:12px;overflow:hidden}
th,td{text-align:left;padding:11px 14px;border-bottom:1px solid #edf0f4;font-size:13px;vertical-align:top}
th{background:#fbfcfd;color:#6b7280;font-size:11px;text-transform:uppercase;letter-spacing:.04em}
a{color:#1a6dd4;text-decoration:none}a:hover{text-decoration:underline}
.u{color:#9aa2ae;font-size:11px}.links a{margin-right:10px}
tr:last-child td{border-bottom:none}
.cta{display:inline-block;margin-bottom:18px;padding:9px 16px;border-radius:8px;background:#111827;color:#fff;font-size:13px}
.cta:hover{text-decoration:none;background:#1f2937}
</style></head><body><div class="wrap">
<h1>Accessibility scans</h1>
<div class="sub">${manifest.length} run${manifest.length === 1 ? '' : 's'} · newest first · every scan you've ever run is listed here and kept — nothing is deleted when you scan a new page.</div>
<a class="cta" href="all-pages-dashboard.html">→ Combined dashboard — every page ever scanned, in one view</a>
<table><thead><tr><th>Scan</th><th>When</th><th>Pages</th><th>Failed</th><th>Review</th><th>Passed</th><th>Issues</th><th></th></tr></thead>
<tbody>${rows || '<tr><td colspan="8">No scans yet.</td></tr>'}</tbody></table>
</div></body></html>`;
}

function archiveReports(outDir, data, rawScans) {
  const reportsDir = path.join(outDir, 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  const now = new Date();
  const name = data.meta.reportName || (data.matrix && data.matrix.pages && data.matrix.pages[0]) || 'scan';
  const folder = `${stamp(now)}_${slug(name)}`;
  const runDir = path.join(reportsDir, folder);
  fs.mkdirSync(runDir, { recursive: true });
  for (const f of ['dashboard.html', 'report.html', 'report.json']) {
    try { fs.copyFileSync(path.join(outDir, f), path.join(runDir, f)); } catch (e) { /* ignore */ }
  }
  // Persist the raw per-state scan data (not just the aggregated report) so
  // this run's pages can be recombined into the cumulative all-pages
  // dashboard later, even after a different report overwrites the live
  // dashboard.html.
  if (rawScans) {
    try { fs.writeFileSync(path.join(runDir, 'scan-data.json'), JSON.stringify(rawScans)); } catch (e) { /* ignore */ }
  }
  // Copy this run's screenshots too, so archived reports stay self-contained
  // even after a later scan overwrites the live shots/ folder.
  const shotsSrc = path.join(outDir, 'shots');
  if (fs.existsSync(shotsSrc)) {
    const shotsDest = path.join(runDir, 'shots');
    fs.mkdirSync(shotsDest, { recursive: true });
    for (const f of fs.readdirSync(shotsSrc)) {
      try { fs.copyFileSync(path.join(shotsSrc, f), path.join(shotsDest, f)); } catch (e) { /* ignore */ }
    }
  }

  const manifestFile = path.join(reportsDir, 'manifest.json');
  let manifest = [];
  try { manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); } catch (e) { manifest = []; }
  manifest.unshift({
    folder, name: String(name), url: data.meta.baseUrl, at: now.toLocaleString(), atISO: now.toISOString(),
    pages: (data.matrix && data.matrix.pages) || [],
    stats: {
      fail: data.stats.fail, review: data.stats.review, pass: data.stats.pass,
      issues: data.stats.totalIssues, critical: data.stats.byImpact.critical, serious: data.stats.byImpact.serious,
    },
    // Richer stats for trend/Δ across runs.
    byImpact: data.stats.byImpact,
    avgHealth: data.stats.avgHealth,
    byPageSeverity: data.stats.byPageSeverity || {},
  });
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(reportsDir, 'index.html'), buildIndex(manifest));
  return { folder, runDir, indexPath: path.join(reportsDir, 'index.html') };
}

/**
 * Populate reports/shots/ for the CUMULATIVE all-pages report.
 *
 * The combined report is written into reports/ but its <img> paths are the
 * per-run relative ones ("shots/x.png"), which resolve to reports/shots/.
 * Its findings are drawn from every archived run, and each run's screenshots
 * live in reports/<folder>/shots/ — the root shots/ folder only ever holds
 * the latest run. So the union has to be assembled here, or every screenshot
 * in the combined report (the view stakeholders actually open, and the one
 * the pipeline publishes) is a broken image.
 *
 * Oldest run first so a newer capture of the same page/state/rule wins.
 * Call AFTER archiveReports(), so the current run is already in the manifest.
 */
function syncCombinedShots(outDir) {
  const reportsDir = path.join(outDir, 'reports');
  let manifest = [];
  try { manifest = JSON.parse(fs.readFileSync(path.join(reportsDir, 'manifest.json'), 'utf8')); } catch (e) { manifest = []; }

  // manifest is newest-first; walk it backwards, then let the live shots/
  // folder (the run that just finished) overwrite last.
  const sources = manifest.slice().reverse().map((r) => path.join(reportsDir, r.folder, 'shots'));
  sources.push(path.join(outDir, 'shots'));

  const dest = path.join(reportsDir, 'shots');
  let copied = 0;
  for (const src of sources) {
    if (!fs.existsSync(src)) continue;
    fs.mkdirSync(dest, { recursive: true });
    for (const f of fs.readdirSync(src)) {
      try { fs.copyFileSync(path.join(src, f), path.join(dest, f)); copied += 1; } catch (e) { /* ignore */ }
    }
  }
  return { dest, copied };
}

// The most recent PRIOR run for the same report name (for Δ / trend). Call
// before archiveReports() adds the current run. Returns null if none.
function readPrevious(outDir, reportName) {
  const manifestFile = path.join(outDir, 'reports', 'manifest.json');
  let manifest = [];
  try { manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); } catch (e) { return null; }
  const match = manifest.find((r) => !reportName || r.name === String(reportName));
  return match || manifest[0] || null;
}

// Full run history (newest first) for the same report name — for trend charts.
function readHistory(outDir, reportName) {
  const manifestFile = path.join(outDir, 'reports', 'manifest.json');
  let manifest = [];
  try { manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); } catch (e) { return []; }
  return manifest.filter((r) => !reportName || r.name === String(reportName));
}

// Rebuild reports/index.html from the current manifest.json without adding a
// new run — useful after manually editing/pruning the manifest.
function regenerateIndex(outDir) {
  const reportsDir = path.join(outDir, 'reports');
  let manifest = [];
  try { manifest = JSON.parse(fs.readFileSync(path.join(reportsDir, 'manifest.json'), 'utf8')); } catch (e) { manifest = []; }
  fs.writeFileSync(path.join(reportsDir, 'index.html'), buildIndex(manifest));
}

module.exports = { archiveReports, readPrevious, readHistory, regenerateIndex, syncCombinedShots };
