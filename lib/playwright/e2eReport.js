/**
 * Turn the per-test scan files written by the fixture into the normal
 * reports (dashboard, single-file report, history, JUnit, gate).
 *
 * Called by the Playwright reporter at the end of a run, or by
 * `a11y e2e-report` after sharded CI jobs have pooled their
 * a11y-report/.e2e-scans/ folders.
 */
const fs = require('fs');
const path = require('path');
const { createMapper } = require('../codeMap');
const { finalizeRun } = require('../finalize');
const { scansDir } = require('./shared');

function readScans(config) {
  const dir = scansDir(config);
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return { scans: [], files: [] }; }
  // Retries write one file per attempt; keep only the last attempt per test.
  const latest = new Map();
  for (const f of files) {
    const m = f.match(/^(.*)-r(\d+)-w\d+\.json$/);
    const id = m ? m[1] : f;
    const retry = m ? Number(m[2]) : 0;
    if (!latest.has(id) || latest.get(id).retry < retry) latest.set(id, { f, retry });
  }
  const scans = [];
  for (const { f } of latest.values()) {
    try { scans.push(...JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))); } catch { /* partial write from a killed worker */ }
  }
  return { scans, files: files.map((f) => path.join(dir, f)) };
}

function finalizeE2e(config, { log = (m) => process.stdout.write(m + '\n'), clean = true } = {}) {
  const { scans, files } = readScans(config);
  if (!scans.length) {
    log('\na11y: no accessibility checks ran in this test run (no a11y.check() calls and auto mode found nothing to scan).');
    return null;
  }
  const mapper = config.REPO_PATH
    ? createMapper(config.REPO_PATH, config.CODE_EXTENSIONS, { stripServerIds: config.STRIP_SERVER_IDS })
    : { indexedFiles: 0, guessLocations: () => [], runtimeLocation: () => null };
  const pages = new Set(scans.map((s) => s.page));
  log(`\na11y: ${scans.length} state(s) on ${pages.size} page(s) from ${new Set(scans.map((s) => s.test)).size} test(s)`);
  const reportName = `${config.REPORT_NAME || path.basename(process.cwd())} (E2E)`;
  const result = finalizeRun({ scans, config, mapper, log, pageCount: pages.size, reportName });
  if (clean) for (const f of files) fs.rmSync(f, { force: true });
  return result;
}

module.exports = { finalizeE2e, readScans };
