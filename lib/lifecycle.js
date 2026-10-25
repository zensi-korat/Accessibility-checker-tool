/**
 * Defect lifecycle across scans — age, regressions, and the remediation
 * burn-up. This is what turns a series of independent snapshots into a trend
 * the programme can be managed on.
 *
 * Everything here derives from the archived runs in reports/, so no new data
 * collection is required. A defect is identified by rule + page + selector,
 * which was verified stable across real runs of the same page.
 *
 * Produces:
 *   ageByIssue      signature -> { firstSeen, lastSeen, runsSeen, ageDays }
 *   openByAge       Blocker/Critical/Major/Minor bucketed by age band
 *   regressions     defects that appeared on a page that was previously clean
 *                   for that rule — the "regression escapes" KPI (target 0)
 *   burnUp          per-run cumulative found / resolved / open, for the chart
 *   resolved        defects present in an earlier run and absent since
 *
 * Caveat worth knowing: a defect "disappearing" means the scanner no longer
 * sees it. That usually means fixed, but can also mean the element stopped
 * rendering (missing test data, a state that did not open). Resolved counts
 * are therefore labelled "apparently resolved" in the UI, not "verified
 * fixed" — verification is a tracker/QA responsibility, not a scanner's.
 */
const fs = require('fs');
const path = require('path');
const { aggregate } = require('./aggregate');

// Stable identity for a defect across runs.
const signature = (i) => `${i.rule}|${i.page}|${i.target}`;

// Severity vocabulary used by the programme's KPI catalogue, mapped from the
// scanning engine's own impact levels.
const SEVERITY = { critical: 'Blocker', serious: 'Critical', moderate: 'Major', minor: 'Minor' };
const SEVERITY_ORDER = ['Blocker', 'Critical', 'Major', 'Minor'];

function readRuns(outDir, reportName) {
  const file = path.join(outDir, 'reports', 'manifest.json');
  let manifest = [];
  try { manifest = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return []; }
  const runs = [];
  for (const entry of manifest) {
    if (reportName && entry.name !== reportName) continue;
    let scans;
    try { scans = JSON.parse(fs.readFileSync(path.join(outDir, 'reports', entry.folder, 'scan-data.json'), 'utf8')); }
    catch (e) { continue; }
    if (!scans || !scans.length) continue;
    runs.push({ entry, scans, at: new Date(entry.atISO || entry.at) });
  }
  // oldest → newest
  return runs.sort((a, b) => a.at - b.at);
}

/**
 * @param {string} outDir tool root
 * @param {object} currentData { issues, stats } from the current aggregate
 * @param {object} opts { reportName, mapper }
 */
function buildLifecycle(outDir, currentData, opts = {}) {
  const runs = readRuns(outDir, opts.reportName);
  if (runs.length === 0) return null;

  // Per-run issue signatures, aggregated the same way the reports are.
  const snapshots = runs.map((r) => {
    const agg = aggregate(r.scans, null);
    const bySig = new Map();
    agg.issues.forEach((i) => bySig.set(signature(i), i));
    return { at: r.at, label: r.entry.at, bySig, pages: new Set(agg.matrix.pages) };
  });

  // ── First/last seen per defect ────────────────────────────────────────────
  const ages = new Map();
  snapshots.forEach((snap, idx) => {
    snap.bySig.forEach((issue, sig) => {
      const rec = ages.get(sig);
      if (rec) { rec.lastSeen = snap.at; rec.lastIdx = idx; rec.runsSeen += 1; }
      else ages.set(sig, { firstSeen: snap.at, lastSeen: snap.at, lastIdx: idx, runsSeen: 1, issue });
    });
  });

  const now = snapshots[snapshots.length - 1].at;
  const DAY = 86400000;
  ages.forEach((rec) => { rec.ageDays = Math.max(0, Math.round((now - rec.firstSeen) / DAY)); });

  // Runs cover DIFFERENT page sets — a single-page run does not mean every
  // other page's defects were fixed. So every judgement below is made against
  // the most recent run that actually scanned the defect's own page, never
  // against the latest run globally. Without this, scanning one page would
  // report every other page's defects as resolved.
  const lastRunIdxForPage = new Map();
  snapshots.forEach((snap, idx) => snap.pages.forEach((pg) => lastRunIdxForPage.set(pg, idx)));

  // Status per defect: open (present in the newest scan of its page),
  // resolved (that scan ran and it was gone), or stale (page not re-tested).
  const statusOf = (sig, rec) => {
    const lastIdx = lastRunIdxForPage.get(rec.issue.page);
    if (lastIdx === undefined) return 'stale';
    if (lastIdx <= rec.lastIdx) return 'open';              // never re-tested since last seen
    return snapshots[lastIdx].bySig.has(sig) ? 'open' : 'resolved';
  };

  // ── Currently-open defects, bucketed by severity and age ──────────────────
  const current = new Map();
  (currentData.issues || []).forEach((i) => current.set(signature(i), i));

  const openByAge = {};
  SEVERITY_ORDER.forEach((s) => { openByAge[s] = { total: 0, band0_7: 0, band8_30: 0, band31plus: 0, oldestDays: 0 }; });
  let overSla = 0; // Blockers older than 7 days — the catalogue's stated target
  current.forEach((issue, sig) => {
    if (issue.kind !== 'violation') return;       // confirmed violations only
    const sev = SEVERITY[issue.impact] || 'Minor';
    const rec = ages.get(sig);
    const age = rec ? rec.ageDays : 0;
    const b = openByAge[sev];
    b.total += 1;
    if (age <= 7) b.band0_7 += 1; else if (age <= 30) b.band8_30 += 1; else b.band31plus += 1;
    if (age > b.oldestDays) b.oldestDays = age;
    if (sev === 'Blocker' && age > 7) overSla += 1;
  });

  // Rules that fired at all in each run. Used to tell an application
  // regression apart from a newly-added check: when a rule is introduced, it
  // legitimately reports pre-existing defects, and counting those as
  // regressions would make the "0 regression escapes" target unusable.
  const rulesPerRun = snapshots.map((snap) => {
    const s = new Set();
    snap.bySig.forEach((issue) => s.add(issue.rule));
    return s;
  });

  // ── Regression escapes ────────────────────────────────────────────────────
  // A regression is a defect present in the newest scan of its page that was
  // absent from the PREVIOUS scan of that same page — excluding defects found
  // by a rule that did not exist at that earlier point.
  const regressions = [];
  const newRuleFindings = [];
  current.forEach((issue, sig) => {
    if (issue.kind !== 'violation') return;
    const rec = ages.get(sig);
    if (!rec) return;
    const lastIdx = lastRunIdxForPage.get(issue.page);
    if (lastIdx === undefined) return;
    // find the previous run that also scanned this page
    let prevIdx = -1;
    for (let i = lastIdx - 1; i >= 0; i--) { if (snapshots[i].pages.has(issue.page)) { prevIdx = i; break; } }
    if (prevIdx === -1) return;                     // page only ever scanned once
    if (snapshots[prevIdx].bySig.has(sig)) return;  // existed before — not a regression
    const entry = {
      rule: issue.rule, page: issue.page, impact: issue.impact,
      severity: SEVERITY[issue.impact] || 'Minor',
      html: (issue.html || '').slice(0, 160),
      location: issue.locations && issue.locations[0] ? `${issue.locations[0].file}:${issue.locations[0].line}` : null,
    };
    // Did this rule report anything anywhere before? If not, treat it as a
    // newly-added check surfacing existing debt, not an app regression.
    const ruleExistedBefore = rulesPerRun.slice(0, prevIdx + 1).some((s) => s.has(issue.rule));
    if (ruleExistedBefore) regressions.push(entry); else newRuleFindings.push(entry);
  });

  // ── Apparently-resolved and not-re-tested defects ─────────────────────────
  const resolved = [];
  let staleCount = 0;
  ages.forEach((rec, sig) => {
    if (rec.issue.kind !== 'violation') return;
    const st = statusOf(sig, rec);
    if (st === 'resolved') resolved.push({ rule: rec.issue.rule, page: rec.issue.page, severity: SEVERITY[rec.issue.impact] || 'Minor' });
    else if (st === 'stale') staleCount += 1;
  });

  // ── Burn-up series ────────────────────────────────────────────────────────
  // At each run, count only pages that had been scanned at least once by that
  // point, and take each page's latest result as of then. This keeps the line
  // meaningful when runs cover different page subsets.
  const seen = new Set();
  const burnUp = snapshots.map((snap, idx) => {
    snap.bySig.forEach((issue, sig) => { if (issue.kind === 'violation') seen.add(sig); });
    // newest scan of each page, up to and including this run
    const latestForPage = new Map();
    for (let i = 0; i <= idx; i++) snapshots[i].pages.forEach((pg) => latestForPage.set(pg, i));
    let open = 0;
    latestForPage.forEach((runIdx, pg) => {
      snapshots[runIdx].bySig.forEach((issue) => { if (issue.kind === 'violation' && issue.page === pg) open += 1; });
    });
    return {
      at: snap.label,
      atISO: snap.at.toISOString(),
      cumulativeFound: seen.size,
      open,
      resolved: Math.max(0, seen.size - open),
      pages: latestForPage.size,
      pagesThisRun: snap.pages.size,
    };
  });

  return {
    runCount: snapshots.length,
    firstRun: snapshots[0].label,
    latestRun: snapshots[snapshots.length - 1].label,
    openByAge,
    overSla,
    severityOrder: SEVERITY_ORDER,
    regressions,
    newRuleFindings,
    resolvedCount: resolved.length,
    resolved: resolved.slice(0, 20),
    staleCount,
    burnUp,
  };
}

module.exports = { buildLifecycle, readRuns, signature, SEVERITY, SEVERITY_ORDER };
