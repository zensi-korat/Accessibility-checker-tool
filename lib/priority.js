/**
 * Fix priority: turns a flat issue list into an ordered fix plan.
 *
 * Severity alone is a poor fix order. A "serious" contrast problem on one
 * page matters less than a "serious" unlabelled header button that blocks
 * screen-reader users on every page and takes five minutes to fix. So each
 * unique defect (the same element on many pages is one defect, one fix) is
 * scored on:
 *
 *   impact     critical > serious > moderate > minor (axe / check impact)
 *   level      Level A is the minimum bar, so it outranks AA
 *   blocker    whether it makes something UNUSABLE for a group of people
 *              (no name, unreachable by keyboard, zoom disabled) rather
 *              than harder to use
 *   reach      pages it appears on, and occurrences
 *   effort     a rough per-rule estimate; quick fixes get a small boost so
 *              cheap, high-value work surfaces early ("quick wins")
 *   certainty  confirmed violation vs. needs-review vs. best practice
 *
 * …and placed in a tier, the thing a team actually plans with:
 *
 *   now     Fix first: critical, or a serious blocker / site-wide issue
 *   next    Fix next: the remaining serious violations
 *   plan    Schedule: moderate and minor violations
 *   review  Needs a decision: the scanner could not decide; a person must
 *   later   Can wait: best practice, not a WCAG failure
 *
 * Every placement carries plain-language reasons, so nobody has to trust a
 * number they cannot see the workings of.
 */
const { categoryOf } = require('./categories');
const crypto = require('crypto');

const IMPACT_W = { critical: 10, serious: 6, moderate: 3, minor: 1 };
const LEVEL_W = { A: 1.3, AA: 1 };

// Who an issue affects, by WCAG criterion.
const AFFECTS = [
  { id: 'screen-reader', label: 'Screen-reader users', sc: ['1.1.1', '1.3.1', '1.3.2', '2.4.2', '2.4.4', '2.4.6', '3.1.1', '3.1.2', '3.3.2', '4.1.2', '4.1.3'] },
  { id: 'keyboard', label: 'Keyboard users', sc: ['2.1.1', '2.1.2', '2.1.4', '2.4.1', '2.4.3', '2.4.7', '2.4.11'] },
  { id: 'low-vision', label: 'Low-vision users', sc: ['1.3.4', '1.4.1', '1.4.3', '1.4.4', '1.4.5', '1.4.10', '1.4.11', '1.4.12', '1.4.13'] },
  { id: 'motor', label: 'Touch & motor-impaired users', sc: ['2.5.1', '2.5.2', '2.5.3', '2.5.4', '2.5.7', '2.5.8'] },
  { id: 'cognitive', label: 'People with cognitive disabilities', sc: ['2.2.1', '2.2.2', '3.2.1', '3.2.2', '3.2.3', '3.2.4', '3.2.6', '3.3.1', '3.3.3', '3.3.4', '3.3.7', '3.3.8'] },
  { id: 'hearing', label: 'Deaf & hard-of-hearing users', sc: ['1.2.1', '1.2.2', '1.2.4', '1.4.2'] },
];

// Rules whose failure makes content unusable (not merely harder) for someone.
const BLOCKERS = new Set([
  'image-alt', 'input-image-alt', 'area-alt', 'role-img-alt', 'svg-img-alt', 'object-alt',
  'button-name', 'link-name', 'label', 'select-name', 'input-button-name', 'aria-input-field-name',
  'aria-command-name', 'aria-toggle-field-name', 'sr-unnamed-control', 'frame-focusable-content',
  'kbd-click-not-focusable', 'kbd-role-not-focusable', 'kbd-keyboard-trap', 'kbd-focus-visible',
  'aria-hidden-focus', 'aria-hidden-body', 'meta-viewport', 'scrollable-region-focusable',
  'nested-interactive', 'no-autoplay-audio',
]);
const LINT_BLOCKER = /(alt-text|img-alt|label|accessible-name|has-content|interactive-supports-focus|click-events-have-key-events|no-static-element-interactions|anchor-has-content|control-has-associated-label)/;

// Rough effort per rule. Deliberately coarse: it orders work, it is not an estimate to bill.
const QUICK = new Set([
  'image-alt', 'input-image-alt', 'area-alt', 'role-img-alt', 'svg-img-alt', 'object-alt', 'label', 'select-name',
  'aria-input-field-name', 'document-title', 'html-has-lang', 'html-lang-valid', 'valid-lang', 'link-name',
  'button-name', 'input-button-name', 'frame-title', 'aria-valid-attr-value', 'aria-valid-attr', 'aria-allowed-attr',
  'aria-required-attr', 'aria-hidden-focus', 'meta-viewport', 'meta-refresh', 'kbd-positive-tabindex', 'tabindex',
  'autocomplete-valid', 'sr-unnamed-control', 'sr-broken-aria-ref', 'duplicate-id-aria', 'empty-heading', 'list',
  'listitem', 'dlitem', 'definition-list', 'label-title-only', 'aria-command-name', 'aria-toggle-field-name',
  'aria-tooltip-name', 'aria-meter-name', 'aria-progressbar-name', 'scope-attr-valid', 'td-headers-attr',
  'aria-dialog-name', 'empty-table-header', 'form-field-multiple-labels',
]);
const LARGE = /^(kbd-keyboard-trap|vp-|cc-|lr-|con-|ff-|pc-|no-autoplay-audio|video-|audio-)/;
const LINT_QUICK = /(alt|label|lang|title|has-content|aria-|role|autocomplete|tabindex|heading-has-content)/;
const EFFORT = {
  quick: { level: 'quick', label: '~5 min', boost: 1.25 },
  medium: { level: 'medium', label: '~30 min', boost: 1 },
  large: { level: 'large', label: 'Hours', boost: 0.85 },
};

const TIERS = [
  { id: 'now', label: 'Fix first', blurb: 'Blocks people from using the site, or is critical. Fix these before anything else.' },
  { id: 'next', label: 'Fix next', blurb: 'Serious barriers that make the site hard to use. Fix these once the first group is clear.' },
  { id: 'plan', label: 'Schedule', blurb: 'Moderate and minor failures. Real WCAG failures, but lower impact: plan them into upcoming work.' },
  { id: 'review', label: 'Needs a decision', blurb: 'The scanner could not decide. Someone has to check each one and either fix it or dismiss it.' },
  { id: 'later', label: 'Can wait', blurb: 'Best practice, not a WCAG failure. Worth doing, safe to defer.' },
];

function normHtml(html) {
  return String(html || '').replace(/\s+style="[^"]*"/g, '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 160);
}
function normTarget(t) {
  const last = String(t || '').trim().split(/\s*>\s*|\s+/).pop() || '';
  return last.replace(/^[a-z][a-z0-9-]*(?=#)/i, '').toLowerCase();
}

/** Stable id for one defect: the same rule on the same element, whichever page it is on. */
function defectKey(i) {
  const el = i.source === 'lint' ? (i.lintKey || i.target) : (normHtml(i.html) || normTarget(i.target));
  return crypto.createHash('sha1').update(`${i.rule}::${el}`).digest('hex').slice(0, 12);
}

const isBestPractice = (i) => i.category === 'best-practice' || !(i.criteria && i.criteria.length);

function effortOf(rule, source) {
  if (source === 'lint') return LINT_QUICK.test(rule) ? EFFORT.quick : EFFORT.medium;
  if (QUICK.has(rule)) return EFFORT.quick;
  if (LARGE.test(rule)) return EFFORT.large;
  return EFFORT.medium;
}

function affectsOf(criteria) {
  const ids = new Set((criteria || []).map((c) => c.id));
  return AFFECTS.filter((a) => a.sc.some((sc) => ids.has(sc))).map((a) => ({ id: a.id, label: a.label }));
}

function tierOf(g) {
  if (g.bestPractice) return 'later';
  if (!g.confirmed) return 'review';
  if (g.impact === 'critical') return 'now';
  if (g.impact === 'serious' && (g.blocker || g.pages.length >= 3)) return 'now';
  if (g.impact === 'serious') return 'next';
  if (g.blocker) return 'next'; // unusable for someone, whatever the axe impact says
  return 'plan';
}

function scoreOf(g) {
  const certainty = g.bestPractice ? 0.3 : g.confirmed ? 1 : 0.45;
  return +(
    (IMPACT_W[g.impact] || 1)
    * (LEVEL_W[g.level] || 0.5)
    * certainty
    * (1 + 0.6 * Math.log2(Math.max(1, g.pages.length)))
    * (1 + 0.1 * Math.log2(Math.max(1, g.occurrences)))
    * (g.blocker ? 1.5 : 1)
    * g.effort.boost
  ).toFixed(2);
}

function reasonsOf(g) {
  const r = [];
  if (g.bestPractice) r.push('Best practice, not a WCAG failure');
  else if (!g.confirmed) r.push('The scanner could not decide; a person needs to check');
  if (g.blocker && !g.bestPractice) {
    const who = g.affects[0] ? g.affects[0].label.toLowerCase() : 'some users';
    r.push(`Blocks ${who}`);
  }
  if (g.impact === 'critical' || g.impact === 'serious') r.push(`${g.impact[0].toUpperCase()}${g.impact.slice(1)} impact`);
  if (g.level === 'A' && !g.bestPractice) r.push('WCAG Level A, the minimum bar');
  if (g.pages.length >= 2) r.push(`One fix clears ${g.pages.length} pages`);
  else if (g.occurrences >= 3) r.push(`${g.occurrences} occurrences`);
  if (g.effort.level === 'quick' && g.confirmed && !g.bestPractice) r.push('Quick fix');
  return r;
}

/**
 * @param {object[]} issues  aggregated issues (any number of pages / runs)
 * @param {object} [opts]
 * @param {object} [opts.triage]  { [defectKey]: {state, reason, until, at} }
 * @param {Date}   [opts.now]
 * @returns {{tiers: object[], groups: object[], counts: object}}
 */
function prioritize(issues, opts = {}) {
  const triage = opts.triage || {};
  const now = opts.now || new Date();
  const byKey = new Map();
  for (const i of issues || []) {
    const key = defectKey(i);
    let g = byKey.get(key);
    if (!g) {
      g = {
        key, rule: i.rule, topic: i.topic || categoryOf(i.rule, i.html), source: i.source === 'lint' ? 'lint' : 'browser',
        title: (i.customFix && i.customFix.what) || i.help || i.rule,
        help: i.help || '', description: i.description || '', helpUrl: i.helpUrl || '',
        impact: i.impact || 'minor', confirmed: false, bestPractice: isBestPractice(i),
        criteria: i.criteria || [], fix: i.customFix || null, failureSummary: i.failureSummary || '',
        alsoFlaggedBy: i.alsoFlaggedBy || null, pageMap: new Map(), elements: [], locations: new Map(), occurrences: 0,
      };
      byKey.set(key, g);
    }
    if (i.kind === 'violation') g.confirmed = true;
    if ((IMPACT_W[i.impact] || 0) > (IMPACT_W[g.impact] || 0)) g.impact = i.impact;
    g.occurrences += 1;
    const pg = g.pageMap.get(i.page) || { name: i.page, url: i.url || '', count: 0 };
    pg.count += 1;
    g.pageMap.set(i.page, pg);
    if (g.elements.length < 25) {
      g.elements.push({
        page: i.page, url: i.url || '', target: i.target || '', html: String(i.html || '').slice(0, 400),
        states: i.states || [], screenshot: i.screenshot || '',
        location: i.locations && i.locations[0] ? i.locations[0] : null,
      });
    }
    for (const l of i.locations || []) {
      const k = `${l.file}:${l.line || ''}`;
      if (!g.locations.has(k)) g.locations.set(k, { file: l.file, line: l.line || null, confidence: l.confidence || l.conf || null });
    }
  }

  const groups = [...byKey.values()].map((g) => {
    const pages = [...g.pageMap.values()];
    const levels = g.criteria.map((c) => c.level);
    const out = {
      ...g, pageMap: undefined, pages, locations: [...g.locations.values()].slice(0, 8),
      level: levels.includes('A') ? 'A' : levels.includes('AA') ? 'AA' : null,
      affects: affectsOf(g.criteria),
      effort: effortOf(g.rule, g.source),
    };
    delete out.pageMap;
    out.blocker = !out.bestPractice && (BLOCKERS.has(out.rule) || (out.source === 'lint' && LINT_BLOCKER.test(out.rule)));
    out.tier = tierOf(out);
    out.score = scoreOf(out);
    out.reasons = reasonsOf(out);
    out.quickWin = out.confirmed && !out.bestPractice && out.effort.level === 'quick' && (out.tier === 'now' || out.tier === 'next');
    const t = triage[out.key];
    if (t && t.state === 'snoozed' && t.until && new Date(t.until) < now) out.triage = null; // snooze expired
    else out.triage = t || null;
    return out;
  });

  const tierRank = Object.fromEntries(TIERS.map((t, ix) => [t.id, ix]));
  groups.sort((a, b) => (tierRank[a.tier] - tierRank[b.tier]) || (b.score - a.score) || a.title.localeCompare(b.title));
  let rank = 0;
  for (const g of groups) g.rank = ++rank;

  const counts = Object.fromEntries(TIERS.map((t) => [t.id, groups.filter((g) => g.tier === t.id).length]));
  counts.total = groups.length;
  counts.quickWins = groups.filter((g) => g.quickWin).length;
  return { tiers: TIERS, groups, counts };
}

module.exports = { prioritize, defectKey, TIERS, AFFECTS };
