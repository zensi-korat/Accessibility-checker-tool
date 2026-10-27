/**
 * Turns raw axe results (collected across every page and every revealed
 * UI state) into:
 *   - a status for each of the 56 WCAG 2.2 A+AA criteria
 *   - a deduplicated, code-mapped list of concrete issues
 *   - headline statistics for the dashboard
 *
 * Criterion status:
 *   fail    → axe found at least one violation for this criterion
 *   review  → axe was unsure (incomplete) — a human must check
 *   pass    → a rule or check actually examined matching elements and found
 *             nothing wrong (shown as "No automated failures" — automation
 *             covers part of a criterion, never all of it)
 *   manual  → automation can't test this criterion, or every rule for it
 *             was inapplicable (nothing to examine); a human must
 *   na      → obsolete (4.1.1), or media criteria on a site with no media
 *
 * Issues with no WCAG criterion (axe "best-practice" rules) are kept in the
 * list as category 'best-practice' but are excluded from confirmed counts,
 * health scores and the CI gate: they are advice, not conformance failures.
 */
const { categoryOf } = require('./categories');
const { CRITERIA, BY_TAG } = require('../wcag-criteria');
const { fixFor } = require('./fixes');
const { locateNode } = require('./codeMap');

const WCAG_TAG_RE = /^wcag\d{3,4}$/;

// Our own checks that re-detect what an axe rule already reports on the same
// element. The axe issue is kept (better docs, stable rule id) and the own
// check is folded into it as `alsoFlaggedBy`, so one defect is one issue.
const SAME_DEFECT = {
  'sr-unnamed-control': ['button-name', 'link-name', 'label', 'select-name', 'input-button-name', 'input-image-alt',
    'aria-command-name', 'aria-input-field-name', 'aria-toggle-field-name', 'aria-meter-name',
    'aria-progressbar-name', 'aria-tooltip-name', 'aria-treeitem-name', 'summary-name', 'frame-title'],
  'sr-broken-aria-ref': ['aria-valid-attr-value'],
  'hl-heading-empty': ['empty-heading'],
};

// Comparable form of an element: the same node reported by two checks may
// carry `style=""` (added by a check that highlighted it), different
// whitespace, or a `tag#id` vs `#id` selector.
function normHtml(html) {
  return String(html || '').replace(/\s+style=""/g, '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 160);
}
function normTarget(t) {
  const last = String(t || '').trim().split(/\s*>\s*|\s+/).pop() || '';
  // "button#menu" → "#menu"; leave class/attr selectors alone.
  return last.replace(/^[a-z][a-z0-9-]*(?=#)/i, '').toLowerCase();
}
const impactRankOf = { critical: 4, serious: 3, moderate: 2, minor: 1 };

function tagsToCriteria(tags = []) {
  return tags.filter((t) => WCAG_TAG_RE.test(t)).map((t) => BY_TAG[t]).filter(Boolean);
}

/**
 * @param {Array} scans  [{ page, url, state, axe }]
 * @param {object} mapper  from createMapper(); may be null
 * @param {{stacks?:string[]}} opts  detected stack ids — picks stack-specific fix advice
 */
// Criteria this tool DOES have a check for, but where that check can finish
// without any verdict: it is opt-in, or it only judges something the site may
// not have. "No rule exists" would be wrong for these; say why there is no
// result and what to do about it instead.
const OPT_IN = (check) => `This tool's ${check} check covers this criterion, but it only runs with LIVE_REGION_CHECKS: true in a11y.config.js (off by default because it submits forms, with network writes blocked). It produced no result in this scan, so turn it on or check by hand. `;
const OWN_CHECK = /^(kbd|sr|uic|con|vp|hl|ff|cc|pc|lr)-|^contrast-sampled$/;
const NO_RESULT_WHY = {
  '4.1.3': OPT_IN('status-message'),
  '3.3.1': OPT_IN('form-error'),
  '3.3.3': OPT_IN('form-error'),
  '2.5.2': OPT_IN('pointer-cancellation'),
  '3.3.4': 'The form-flow check only judges pages listed in CONSEQUENTIAL_FLOWS (legal, financial or data-deleting forms). None are listed, so it had nothing to check. List those pages in a11y.config.js, or check by hand. ',
  '3.2.3': 'The consistency check compares navigation blocks that repeat across pages. It found none repeated on two or more scanned pages, so it gave no verdict. Check by hand. ',
  '3.2.6': 'The consistency check looks for a help mechanism (help or contact link, chat, phone number) to compare its position across pages. It found none. If the site really has no help mechanism this criterion does not apply; otherwise check by hand. ',
};

const INAPPLICABLE_WHY = 'The automated rules for this criterion ran but found nothing on the scanned pages they could examine (for example no <meta http-equiv="refresh"> for 2.2.1). That is not evidence the criterion is met, so it needs a human check. ';

function aggregate(scans, mapper, opts = {}) {
  const stacks = opts.stacks || [];
  // Per-criterion accumulator (global, across all pages).
  const acc = {};
  for (const c of CRITERIA) acc[c.id] = { hasViolation: false, hasIncomplete: false, hasPass: false, checked: false };

  // Per-PAGE × per-criterion accumulator (for the matrix table).
  const pageOrder = [];
  const perPage = {};
  const ensurePage = (name) => {
    if (!perPage[name]) {
      perPage[name] = {};
      pageOrder.push(name);
      for (const c of CRITERIA) perPage[name][c.id] = { v: false, inc: false, pass: false };
    }
    return perPage[name];
  };

  // Deduplicate issues across states/pages by rule + element + page.
  const issueMap = new Map();

  const impactRank = { critical: 4, serious: 3, moderate: 2, minor: 1, null: 0, undefined: 0 };

  // IBM second-engine results, merged across all states/pages, per criterion.
  const ibmAcc = {}; // num -> { fail, review, pass }
  const ibmAccByPage = {}; // page -> num -> { fail, review, pass }

  // Every UI state actually visited (base page + every revealed modal/dialog/
  // tab), in scan order, per page — even states with zero issues. Powers the
  // "Modal & Dialog Coverage" section (proof of deep-reveal, not just counts).
  const stateOrder = {};
  const seenState = new Set();
  // The source lint arrives as a pseudo-scan (page "Source code (lint)",
  // state "lint"). It is not a page of the app and not a revealed UI state.
  const lintPages = new Set();
  let lintMeta = null;
  // Our own checks (keyboard, zoom, consistency…) → pages they produced any
  // result on, pass or fail. Tells "ran clean" apart from "never ran".
  const checkPages = {};

  // DOM inventory (raw census, independent of pass/fail) — captured once per
  // page on its initial state.
  const inventoryByPage = {};

  for (const scan of scans) {
    if (scan.inventory && !inventoryByPage[scan.page]) inventoryByPage[scan.page] = scan.inventory;
    if (scan.ibm && scan.ibm.byCriterion) {
      const pageAcc2 = ibmAccByPage[scan.page] || (ibmAccByPage[scan.page] = {});
      for (const [num, v] of Object.entries(scan.ibm.byCriterion)) {
        const e = ibmAcc[num] || (ibmAcc[num] = { fail: 0, review: 0, pass: 0 });
        e.fail += v.fail; e.review += v.review; e.pass += v.pass;
        const pe = pageAcc2[num] || (pageAcc2[num] = { fail: 0, review: 0, pass: 0 });
        pe.fail += v.fail; pe.review += v.review; pe.pass += v.pass;
      }
    }
    // scan.js spreads axe fields onto the scan itself; also accept scan.axe.
    const axe = scan.axe || scan;
    const pageAcc = ensurePage(scan.page);
    const stateKey = `${scan.page}::${scan.state}`;
    if (scan.state === 'lint') { lintPages.add(scan.page); if (scan.lint) lintMeta = scan.lint; }
    else if (!seenState.has(stateKey)) {
      seenState.add(stateKey);
      (stateOrder[scan.page] = stateOrder[scan.page] || []).push(scan.state);
    }
    for (const k of ['violations', 'incomplete', 'passes']) {
      for (const r of axe[k] || []) {
        if (OWN_CHECK.test(r.id)) (checkPages[r.id] = checkPages[r.id] || new Set()).add(scan.page);
      }
    }
    const mark = (results, kind) => {
      for (const r of results || []) {
        const crits = tagsToCriteria(r.tags);
        for (const c of crits) {
          acc[c.id].checked = true;
          if (kind === 'violation') { acc[c.id].hasViolation = true; pageAcc[c.id].v = true; }
          else if (kind === 'incomplete') { acc[c.id].hasIncomplete = true; pageAcc[c.id].inc = true; }
          else if (kind === 'pass') { acc[c.id].hasPass = true; pageAcc[c.id].pass = true; }
        }
        if (kind !== 'violation' && kind !== 'incomplete') continue;

        for (const node of r.nodes || []) {
          const target = Array.isArray(node.target) ? node.target.join(' ') : String(node.target || '');
          const key = `${r.id}::${scan.page}::${target}`;
          if (issueMap.has(key)) {
            const prev = issueMap.get(key);
            prev.states.add(scan.state);
            // A node axe was unsure about in one state (e.g. contrast behind
            // an overlay) and sure about in another is a confirmed violation.
            // Keeping the first-seen kind would hide it from the gate.
            if (kind === 'violation' && prev.kind !== 'violation') {
              prev.kind = 'violation';
              prev.failureSummary = node.failureSummary || prev.failureSummary;
              if (node.screenshot) prev.screenshot = node.screenshot;
            }
            const imp = node.impact || r.impact;
            if ((impactRankOf[imp] || 0) > (impactRankOf[prev.impact] || 0)) prev.impact = imp;
            continue;
          }
          const custom = fixFor(r.fixRule || r.id, stacks);
          issueMap.set(key, {
            rule: r.id,
            topic: categoryOf(r.id, node.html), // issue type, for the report filters (lib/categories.js)
            kind, // violation | incomplete
            impact: node.impact || r.impact || 'minor',
            help: r.help,
            helpUrl: r.helpUrl,
            description: r.description,
            criteria: crits.map((c) => ({ id: c.id, name: c.name, level: c.level })),
            page: scan.page,
            url: scan.url,
            states: new Set([scan.state]),
            target,
            html: (node.html || '').slice(0, 500),
            failureSummary: node.failureSummary || '',
            customFix: custom,
            locations: locateNode(node, mapper),
            screenshot: node.screenshot || null,
            source: node.lintKey ? 'lint' : 'browser',
            category: crits.length ? 'wcag' : 'best-practice',
            ...(r.sampled || node.sampled ? { sampled: true } : {}),
            ...(node.lintKey ? { lintKey: node.lintKey } : {}),
          });
        }
      }
    };
    mark(axe.violations, 'violation');
    mark(axe.incomplete, 'incomplete');
    mark(axe.passes, 'pass');
    // inapplicable: the rule ran but found NO matching element (no <meta
    // refresh>, no lang attribute on a part…). That is not evidence the
    // criterion is met — 2.2.1 "passing" because there is no meta refresh says
    // nothing about session timeouts. Remembered only so the criterion can say
    // why it has no verdict.
    for (const r of axe.inapplicable || []) {
      for (const c of tagsToCriteria(r.tags)) { acc[c.id].checked = true; acc[c.id].onlyInapplicable = true; }
    }
  }

  // IBM's Equal Access engine runs on every page alongside axe. Its verdicts
  // were historically kept apart from criterion status because the two engines
  // disagree in shape (XPath vs CSS selectors, different severity words) — but
  // that meant criteria axe has NO rule for inherited no verdict at all, while
  // IBM had actually tested them. So IBM is now used to FILL GAPS: it decides
  // a criterion only where our own pipeline produced nothing. It never
  // overrides an axe or module verdict, so existing results are unchanged.
  const ibmVerdictFrom = (acc, num) => {
    const a = acc[num];
    if (!a) return 'na';
    if (a.fail > 0) return 'fail';
    if (a.review > 0) return 'review';
    if (a.pass > 0) return 'pass';
    return 'na';
  };
  // When IBM is the ONLY source, its failures never become "Failed": IBM's
  // results are not in the issue list (different selector shape), so a fail
  // would have no element, no screenshot and nothing anyone could act on.
  // They become "review", pointing the reader at the engine-agreement table.
  const ibmFill = (acc, num) => {
    const v = ibmVerdictFrom(acc, num);
    return v === 'fail' ? 'review' : v;
  };

  // Resolve the page × criterion matrix. Statuses: pass | fail | review | na.
  // na = "can't support" (automation-untestable manual criteria, obsolete, or
  // no signal for this criterion on this page).
  const matrix = { pages: pageOrder, cells: {} };
  for (const name of pageOrder) {
    matrix.cells[name] = {};
    for (const c of CRITERIA) {
      const a = perPage[name][c.id];
      let st;
      if (c.obsolete || !c.auto) st = 'na';
      else if (a.v) st = 'fail';
      else if (a.inc) st = 'review';
      else if (a.pass) st = 'pass';
      else st = ibmFill(ibmAccByPage[name] || {}, c.id); // 'na' if IBM has nothing either
      matrix.cells[name][c.id] = st;
    }
  }

  // Does this site have any audio/video at all? Inventory is a raw DOM census
  // taken once per page, so this is a direct count rather than an inference
  // from rule results. Only trustworthy if at least one page reported an
  // inventory — otherwise we must not claim anything about media.
  const inventories = Object.values(inventoryByPage).filter(Boolean);
  const mediaKnown = inventories.length > 0;
  const siteMedia = inventories.reduce(
    (n, inv) => n + ((inv.crawled && inv.crawled.audio) || 0) + ((inv.crawled && inv.crawled.video) || 0), 0);

  // Resolve each criterion to a final status.
  const criteria = CRITERIA.map((c) => {
    const a = acc[c.id];
    let status;
    let untested = false;
    let inapplicableOnly = false;
    let source = null;
    if (c.obsolete) status = 'na';
    else if (a.hasViolation) status = 'fail';
    else if (a.hasIncomplete) status = 'review';
    // Media criteria on a site with no media are Not Applicable, not passing.
    // Checked BEFORE hasPass because axe reports its media rules as
    // "inapplicable" when there is no media, and inapplicable is folded into
    // hasPass above — which would otherwise read as a clean bill of health for
    // captions and audio description on a site that has no video at all.
    else if (c.requires === 'media' && mediaKnown && siteMedia === 0) status = 'na';
    else if (a.hasPass) status = 'pass';
    // IBM only fills criteria this tool considers automatable. Its rule table
    // also maps rules to criteria that need human judgement (1.3.3 Sensory
    // Characteristics, 2.4.11 Focus Not Obscured, 2.5.7 Dragging), and one
    // IBM pass must not turn those into "Passed".
    else if (c.auto && ibmFill(ibmAcc, c.id) !== 'na') {
      // Our own engines produced nothing for this criterion, but IBM did.
      status = ibmFill(ibmAcc, c.id);
      source = 'ibm';
    } else if (c.auto && a.onlyInapplicable) {
      // Rules for it ran, but found nothing to examine on these pages.
      status = 'manual';
      untested = true;
      inapplicableOnly = true;
    } else if (c.auto) {
      // Nothing was ever produced for this criterion — no violation, no
      // incomplete, no pass, not even an "inapplicable" from a rule that ran
      // and found nothing. That means no rule for it exists in the engine at
      // all, so "no findings" is absence of evidence, not evidence of absence.
      // Reporting it as a pass is false assurance: it told us 1.4.11, 2.4.6
      // and 4.1.3 were clean while the vendor's own VPAT marks all three
      // "Partially Supports". Needs a human, and says so.
      status = 'manual';
      untested = true;
    } else status = 'manual';
    const why = untested
      ? (NO_RESULT_WHY[c.id] || (inapplicableOnly ? INAPPLICABLE_WHY : null))
      : null;
    return { ...c, status, untested, untestedWhy: why, source };
  });

  // Fold our own checks into the axe issue for the same element (see
  // SAME_DEFECT). Matched on page + element: normalised selector first, then
  // normalised markup, because the two report selectors in different shapes.
  const all = [...issueMap.values()];
  const dropped = new Set();
  for (const own of all) {
    const axeRules = SAME_DEFECT[own.rule];
    if (!axeRules) continue;
    const t = normTarget(own.target), h = normHtml(own.html);
    const match = all.find((x) => x !== own && !dropped.has(x) && x.page === own.page && axeRules.includes(x.rule)
      && ((t && normTarget(x.target) === t && /^#/.test(t)) || (h && normHtml(x.html) === h)));
    if (!match) continue;
    match.alsoFlaggedBy = [...new Set([...(match.alsoFlaggedBy || []), own.rule])];
    for (const st of own.states) match.states.add(st);
    if (own.kind === 'violation' && match.kind !== 'violation') match.kind = 'violation';
    if ((impactRankOf[own.impact] || 0) > (impactRankOf[match.impact] || 0)) match.impact = own.impact;
    dropped.add(own);
  }

  const issues = all.filter((i) => !dropped.has(i))
    .map((i) => ({ ...i, states: [...i.states] }))
    .sort((a, b) => (impactRank[b.impact] - impactRank[a.impact]) || a.rule.localeCompare(b.rule));

  // The same defect on many pages (a header button, a footer link) is one
  // fix. Group by rule + element across pages so the report can say
  // "34 issues (15 unique)". groupId is stable for a given rule + markup.
  const groups = new Map();
  for (const i of issues) {
    const el = i.source === 'lint' ? (i.lintKey || i.target) : (normHtml(i.html) || normTarget(i.target));
    const gk = `${i.rule}::${el}`;
    if (!groups.has(gk)) groups.set(gk, []);
    groups.get(gk).push(i);
  }
  let gid = 0;
  for (const members of groups.values()) {
    gid += 1;
    const pagesInGroup = [...new Set(members.map((m) => m.page))];
    for (const m of members) { m.groupId = gid; m.groupPages = pagesInGroup.length; }
  }
  const isConfirmed = (i) => i.kind === 'violation' && i.category !== 'best-practice';
  const isReview = (i) => i.kind === 'incomplete' && i.category !== 'best-practice';

  // A browser finding whose source location is next to a lint finding for the
  // same criterion is the same defect seen twice — say so on both, so whoever
  // fixes one knows it closes the other.
  const lintIssues = issues.filter((i) => i.source === 'lint' && i.locations && i.locations[0]);
  if (lintIssues.length) {
    for (const b of issues) {
      const loc = b.source === 'browser' && b.locations && b.locations[0];
      if (!loc) continue;
      const m = lintIssues.find((l) => l.locations[0].file === loc.file && Math.abs(l.locations[0].line - loc.line) <= 3
        && l.criteria.some((c) => b.criteria.some((d) => d.id === c.id)));
      if (!m) continue;
      b.alsoInLint = `${m.locations[0].file}:${m.locations[0].line}`;
      m.seenInBrowser = [...new Set([...(m.seenInBrowser || []), b.page])];
    }
  }

  // Statistics.
  const countBy = (pred) => criteria.filter(pred).length;
  const stats = {
    totalCriteria: criteria.length,
    fail: countBy((c) => c.status === 'fail'),
    review: countBy((c) => c.status === 'review'),
    pass: countBy((c) => c.status === 'pass'),
    manual: countBy((c) => c.status === 'manual'),
    na: countBy((c) => c.status === 'na'),
    totalIssues: issues.length,
    violations: issues.filter((i) => i.kind === 'violation').length,
    incompletes: issues.filter((i) => i.kind === 'incomplete').length,
    byImpact: {
      critical: issues.filter((i) => i.impact === 'critical').length,
      serious: issues.filter((i) => i.impact === 'serious').length,
      moderate: issues.filter((i) => i.impact === 'moderate').length,
      minor: issues.filter((i) => i.impact === 'minor').length,
    },
    // CONFIRMED-ONLY counts: kind === 'violation', i.e. the engine positively
    // determined the element fails. Everything with kind === 'incomplete' is
    // the engine saying "I could not decide" — e.g. color-contrast against an
    // overlapped background — and is a review queue, NOT a defect count.
    //
    // These two numbers are wildly different on this app and must not be
    // conflated: a real run produced 83 violations and 7,469 incompletes,
    // 7,396 of them color-contrast and 7,327 from a single data-dense page.
    // Gating a build on the combined number fails it for findings no human
    // has confirmed are real, which is the definition of a false positive in
    // a CI gate. lib/ci.js gates on `confirmed` for exactly this reason.
    //
    // Best-practice findings (no WCAG criterion) are excluded too: they are
    // advice, and a "serious" threshold must not fail a build over them.
    confirmed: (() => {
      const v = issues.filter(isConfirmed);
      return {
        total: v.length,
        critical: v.filter((i) => i.impact === 'critical').length,
        serious: v.filter((i) => i.impact === 'serious').length,
        moderate: v.filter((i) => i.impact === 'moderate').length,
        minor: v.filter((i) => i.impact === 'minor').length,
      };
    })(),
    needsReview: issues.filter(isReview).length, // review ITEMS (not criteria)
    bestPractice: issues.filter((i) => i.category === 'best-practice').length,
    unique: (() => {
      const ids = (pred) => new Set(issues.filter(pred).map((i) => i.groupId)).size;
      const v = issues.filter(isConfirmed);
      const u = (imp) => new Set(v.filter((i) => i.impact === imp).map((i) => i.groupId)).size;
      return {
        total: ids(() => true),
        confirmed: ids(isConfirmed),
        critical: u('critical'), serious: u('serious'), moderate: u('moderate'), minor: u('minor'),
      };
    })(),
    byRule: Object.entries(
      issues.reduce((m, i) => ((m[i.rule] = (m[i.rule] || 0) + 1), m), {})
    ).map(([rule, count]) => ({ rule, count })).sort((a, b) => b.count - a.count),
    byPage: Object.entries(
      issues.reduce((m, i) => {
        const e = m[i.page] || (m[i.page] = { count: 0, confirmed: 0 });
        e.count += 1;
        if (isConfirmed(i)) e.confirmed += 1;
        return m;
      }, {})
    ).map(([page, e]) => ({ page, ...e })).sort((a, b) => b.confirmed - a.confirmed || b.count - a.count),
  };

  // Issues grouped by WCAG SUCCESS CRITERION (not by axe rule) — several rules
  // roll up into one criterion, and auditors think in criteria. An issue tagged
  // with 2 criteria counts toward both, so the sum can exceed totalIssues.
  // `count` is every issue (confirmed + review); `confirmed` / `review` split
  // it, and the list is ordered by confirmed failures first.
  const critAcc = {};
  for (const i of issues) {
    for (const c of i.criteria || []) {
      const e = critAcc[c.id] || (critAcc[c.id] = { id: c.id, name: c.name, level: c.level, count: 0, confirmed: 0, review: 0 });
      e.count += 1;
      if (i.kind === 'violation') e.confirmed += 1; else e.review += 1;
    }
  }
  stats.byCriterion = Object.values(critAcc).sort((a, b) => b.confirmed - a.confirmed || b.count - a.count || a.id.localeCompare(b.id));
  stats.criterionTaggedIssues = stats.byCriterion.reduce((n, c) => n + c.count, 0);
  // Failing/at-risk criteria counted by conformance level.
  stats.byLevel = { A: 0, AA: 0 };
  for (const c of criteria) {
    if (c.status === 'fail' || c.status === 'review') {
      if (stats.byLevel[c.level] != null) stats.byLevel[c.level] += 1;
    }
  }
  // Same split, but weighted by number of CONFIRMED issues rather than
  // criteria count (review items are a queue, not defects).
  stats.issuesByLevel = { A: 0, AA: 0 };
  for (const c of stats.byCriterion) {
    if (stats.issuesByLevel[c.level] != null) stats.issuesByLevel[c.level] += c.confirmed;
  }

  // Per-page severity breakdown + a 0-100 health score (higher = healthier).
  // Confirmed WCAG violations only: a page with 30 unresolved contrast reviews
  // and no defect is not a page with health 0. Review items are counted
  // separately so the matrix can still show them.
  const healthOf = (sev) => Math.max(0, 100 - (sev.critical * 10 + sev.serious * 5 + sev.moderate * 2 + sev.minor * 1));
  const byPageSeverity = {};
  const blankSev = () => ({ critical: 0, serious: 0, moderate: 0, minor: 0, total: 0, review: 0, bestPractice: 0 });
  for (const name of matrix.pages) byPageSeverity[name] = blankSev();
  for (const i of issues) {
    const s = byPageSeverity[i.page] || (byPageSeverity[i.page] = blankSev());
    if (i.category === 'best-practice') { s.bestPractice += 1; continue; }
    if (i.kind !== 'violation') { s.review += 1; continue; }
    if (s[i.impact] != null) s[i.impact] += 1;
    s.total += 1;
  }
  for (const name of Object.keys(byPageSeverity)) byPageSeverity[name].score = healthOf(byPageSeverity[name]);
  const scoreVals = Object.entries(byPageSeverity).filter(([name]) => !lintPages.has(name)).map(([, s]) => s.score);
  stats.byPageSeverity = byPageSeverity;
  stats.pagesInScope = matrix.pages.filter((name) => !lintPages.has(name)).length;
  stats.avgHealth = scoreVals.length ? Math.round(scoreVals.reduce((a, b) => a + b, 0) / scoreVals.length) : 100;

  // Modal & dialog deep-reveal coverage: every state visited per page (base +
  // revealed modals/tabs), how many issues surfaced in each, and how many
  // issues exist ONLY inside a revealed state (invisible to a single-shot scan
  // of the base page).
  const isBaseState = (s) => /^initial$/i.test(s);
  const stateCoverage = {};
  for (const page of Object.keys(stateOrder)) {
    const counts = {};
    for (const s of stateOrder[page]) counts[s] = 0;
    stateCoverage[page] = { states: stateOrder[page], counts };
  }
  for (const i of issues) {
    const cov = stateCoverage[i.page];
    if (!cov) continue;
    for (const s of i.states) if (cov.counts[s] != null) cov.counts[s] += 1;
  }
  stats.stateCoverage = stateCoverage;
  stats.checkRuns = Object.fromEntries(Object.entries(checkPages).map(([id, set]) => [id, set.size]));
  stats.lint = lintMeta;
  stats.totalStatesRevealed = Object.values(stateOrder).reduce((n, arr) => n + arr.filter((s) => !isBaseState(s)).length, 0);
  stats.modalOnlyIssues = issues.filter((i) => i.source !== 'lint' && !i.states.some(isBaseState)).length;

  // Sum the per-page DOM inventory into cumulative totals.
  const invPages = Object.values(inventoryByPage);
  const sumField = (group, key) => invPages.reduce((n, inv) => n + ((inv[group] && inv[group][key]) || 0), 0);
  if (invPages.length) {
    stats.inventory = {
      byPage: inventoryByPage,
      detected: {
        roleAttributes: sumField('detected', 'roleAttributes'),
        ariaAttributes: sumField('detected', 'ariaAttributes'),
        accessKeys: sumField('detected', 'accessKeys'),
        headings: sumField('detected', 'headings'),
        fieldsWithoutLabel: sumField('detected', 'fieldsWithoutLabel'),
        altlessImages: sumField('detected', 'altlessImages'),
      },
      crawled: {
        iframes: sumField('crawled', 'iframes'),
        images: sumField('crawled', 'images'),
        pdfs: sumField('crawled', 'pdfs'),
        links: sumField('crawled', 'links'),
        audio: sumField('crawled', 'audio'),
        video: sumField('crawled', 'video'),
      },
    };
  }

  // Engine Agreement: axe-core's verdict vs IBM's independently-built engine,
  // side by side. Computed once for 'ALL' (cumulative) and once per page, so
  // the dashboard's page selector can switch between them like everything
  // else. Only criteria BOTH engines actually exercised are compared — a
  // criterion neither engine can auto-test isn't a disagreement, it's untested.
  const buildComparison = (acc, axeStatusOf) => {
    const rows = [];
    let agree = 0, axeOnly = 0, ibmOnly = 0, bothClean = 0;
    for (const c of CRITERIA) {
      if (c.obsolete || !c.auto) continue;
      const ibm = ibmVerdictFrom(acc, c.id);
      const axeStatus = axeStatusOf(c.id);
      if (ibm === 'na' || !axeStatus) continue;
      const axeBad = axeStatus === 'fail' || axeStatus === 'review';
      const ibmBad = ibm === 'fail' || ibm === 'review';
      let agreement;
      if (axeBad && ibmBad) { agreement = 'agree-bad'; agree += 1; }
      else if (!axeBad && !ibmBad) { agreement = 'agree-clean'; bothClean += 1; }
      else if (axeBad && !ibmBad) { agreement = 'axe-only'; axeOnly += 1; }
      else { agreement = 'ibm-only'; ibmOnly += 1; }
      rows.push({ id: c.id, name: c.name, level: c.level, axe: axeStatus, ibm, agreement });
    }
    return { rows, agree, axeOnly, ibmOnly, bothClean, compared: rows.length };
  };
  if (Object.keys(ibmAcc).length) {
    const statusById = Object.fromEntries(criteria.map((c) => [c.id, c.status]));
    const byScope = { ALL: buildComparison(ibmAcc, (id) => statusById[id]) };
    for (const page of pageOrder) {
      const pageAccIbm = ibmAccByPage[page];
      if (!pageAccIbm) continue;
      byScope[page] = buildComparison(pageAccIbm, (id) => matrix.cells[page] && matrix.cells[page][id]);
    }
    stats.engineComparisonByScope = byScope;
    stats.engineComparison = byScope.ALL; // back-compat for report.json consumers
  }

  matrix.lintPages = [...lintPages];
  return { criteria, issues, stats, matrix };
}

module.exports = { aggregate };
