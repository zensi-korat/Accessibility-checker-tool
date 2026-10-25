/**
 * Fix verification: after someone fixes issues and scans again, say exactly
 * which of the previous issues are fixed, which are still failing, which are
 * new, and which could not be verified.
 *
 * The baseline is, per page, the most recent PRIOR run that scanned that page
 * (same rule lib/lifecycle.js uses) — so re-scanning a few pages never makes
 * the other pages' issues look fixed.
 *
 * "Fixed" is a positive claim and is only made with evidence:
 *   browser issue — its page and UI state were scanned again, the element is
 *                   still there and visible (its selector still matches), and
 *                   the rule no longer reports it. If the element is gone, or the modal /
 *                   tab it lived in was not opened this time, the issue is
 *                   "couldn't verify", not fixed — a missing dialog is not a fix.
 *   lint issue    — the lint ran again and the same rule no longer fires on
 *                   the same source line (matched by content, so code moving
 *                   up or down the file is not a fix).
 */
const { readRuns, signature } = require('./lifecycle');
const { aggregate } = require('./aggregate');

const LINT_PAGE = 'Source code (lint)';
const keyOf = (i) => i.lintKey || signature(i);

/**
 * @returns {null | {pages: Map<string, {at: Date, label: string, issues: object[]}>}}
 */
function loadBaseline(outDir, reportName) {
  const runs = readRuns(outDir, reportName); // oldest → newest
  if (!runs.length) return null;
  const pages = new Map();
  for (let i = runs.length - 1; i >= 0; i--) {
    const run = runs[i];
    const scanned = [...new Set(run.scans.map((s) => s.page))].filter((p) => !pages.has(p));
    if (!scanned.length) continue;
    const { issues } = aggregate(run.scans.filter((s) => scanned.includes(s.page)), null);
    for (const p of scanned) pages.set(p, { at: run.at, label: run.entry.at, issues: issues.filter((x) => x.page === p) });
  }
  return { pages };
}

/** Pages that had open issues last time (what `a11y verify` re-scans). */
function pagesWithIssues(baseline) {
  if (!baseline) return new Set();
  return new Set([...baseline.pages].filter(([, v]) => v.issues.length).map(([p]) => p));
}

/** Selectors of last run's browser issues seen on this page + state — checked for presence after the state is scanned. */
function targetsFor(baseline, pageName, state) {
  const b = baseline && baseline.pages.get(pageName);
  if (!b) return [];
  return [...new Set(b.issues.filter((i) => !i.lintKey && i.target && (i.states || []).includes(state)).map((i) => i.target))];
}

/**
 * @param {object} baseline   from loadBaseline (taken BEFORE this run was archived)
 * @param {object[]} scans    this run's raw scans
 * @param {object[]} issues   this run's aggregated issues
 * @param {Map<string, 'visible'|'hidden'|'absent'|null>} presence  `${page}::${state}::${target}` → how the element was found this time
 */
function buildVerification(baseline, scans, issues, presence = new Map()) {
  if (!baseline || !baseline.pages.size) return null;
  const visited = new Map(); // page → Set(state)
  for (const s of scans) (visited.get(s.page) || visited.set(s.page, new Set()).get(s.page)).add(s.state);
  const nowKeys = new Set(issues.map(keyOf));

  const out = { fixed: [], still: [], unverified: [], new: [], notRechecked: 0, since: null };
  const brief = (i, extra = {}) => ({
    rule: i.rule, kind: i.kind, impact: i.impact, page: i.page, help: i.help, target: i.target,
    states: i.states, location: i.locations && i.locations[0] ? `${i.locations[0].file}:${i.locations[0].line}` : null,
    criteria: (i.criteria || []).map((c) => c.id), ...extra,
  });

  for (const [page, b] of baseline.pages) {
    const states = visited.get(page);
    if (!states) { out.notRechecked += b.issues.length; continue; }
    if (!out.since || b.at > out.since) out.since = b.at;
    for (const i of b.issues) {
      if (nowKeys.has(keyOf(i))) { out.still.push(brief(i)); continue; }
      if (i.lintKey) { out.fixed.push(brief(i)); continue; }
      const seenStates = (i.states || []).filter((st) => states.has(st));
      if (!seenStates.length) {
        out.unverified.push(brief(i, { reason: `the "${(i.states || [])[0]}" state was not reached this time` }));
        continue;
      }
      const looks = seenStates.map((st) => presence.get(`${page}::${st}::${i.target}`));
      if (looks.includes('visible')) out.fixed.push(brief(i));
      else if (looks.includes('hidden')) out.unverified.push(brief(i, { reason: 'the element is hidden this time (did its dialog / tab open?)' }));
      else if (looks.length && looks.every((v) => v === 'absent')) out.unverified.push(brief(i, { reason: 'the element is no longer on the page' }));
      else out.unverified.push(brief(i, { reason: 'could not look the element up again' }));
    }
  }
  for (const i of issues) {
    const b = baseline.pages.get(i.page);
    if (!b) continue; // first scan of this page — nothing to compare with
    if (!b.issues.some((x) => keyOf(x) === keyOf(i))) out.new.push(brief(i));
  }
  const confirmed = (list) => list.filter((i) => i.kind === 'violation').length;
  out.counts = {
    fixed: out.fixed.length, still: out.still.length, unverified: out.unverified.length, new: out.new.length,
    notRechecked: out.notRechecked,
    stillConfirmed: confirmed(out.still), newConfirmed: confirmed(out.new),
  };
  out.since = out.since ? out.since.toISOString() : null;
  return out;
}

/** Terminal summary. */
function logVerification(v, log) {
  if (!v) return;
  const c = v.counts;
  if (!c.fixed && !c.still && !c.new && !c.unverified) return; // nothing open before or now
  log('\nFix verification (vs. the previous scan of each page):');
  log(`  ✔ ${c.fixed} fixed · ✗ ${c.still} still failing · ⚠ ${c.new} new · ? ${c.unverified} couldn't verify${c.notRechecked ? ` · ${c.notRechecked} on pages not re-scanned` : ''}`);
  const show = (mark, list, n = 8) => {
    for (const i of list.slice(0, n)) log(`    ${mark} ${i.page} · ${i.rule}${i.location ? `  ${i.location}` : ''}${i.reason ? `  — ${i.reason}` : ''}`);
    if (list.length > n) log(`      … +${list.length - n} more in the dashboard`);
  };
  show('✗', v.still);
  show('⚠', v.new);
  show('?', v.unverified, 5);
}

module.exports = { loadBaseline, pagesWithIssues, targetsFor, buildVerification, logVerification, LINT_PAGE };
