/**
 * Builds three artifacts in the output folder:
 *   dashboard.html - the overview: results by WCAG criterion and by page  (start here)
 *   report.html    - every finding, grouped by problem, with how to fix it
 *   report.json    - raw aggregated data for CI/CD
 *
 * Everything is inlined (CSS, font, tiny JS). No CDN, works offline.
 * The shared look (tokens, light/dark, icons) lives in lib/ui/theme.js.
 */
const fs = require('fs');
const path = require('path');
const { PRINCIPLES } = require('../wcag-criteria');
const { CATEGORIES, categoryOf, labelOf } = require('./categories');
const THEME = require('./ui/theme');

const { icon } = THEME;
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const plural = (n, w, ws) => `${n} ${n === 1 ? w : (ws || w + 's')}`;

// Criterion status → label + icon (lib/ui/theme.js). Internal ids are kept:
// fail · review (partial) · pass (no automated failures) · manual · na.
const STATUS = THEME.STATUS_UI;
const IMPACTS = ['critical', 'serious', 'moderate', 'minor'];

function deltaBadge(cur, prev) {
  if (prev == null) return '<span class="muted">—</span>';
  const d = cur - prev;
  if (d === 0) return '<span class="muted">no change</span>';
  // More violations is worse.
  return `<span class="${d > 0 ? 'ac-sev sev-critical' : 'ac-st st-verified'}">${d > 0 ? '↑' : '↓'} ${Math.abs(d)}</span>`;
}

// Confirmed-violation count recorded for a past run (older manifests only
// stored the all-kinds `issues` total, which is not comparable).
const runConfirmed = (r) => (r && r.stats && r.stats.confirmed != null ? r.stats.confirmed : null);
// Two runs are only comparable when they scanned the same pages: a 2-page run
// after a 15-page run is not an improvement.
function samePages(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((p) => set.has(p));
}

// ── Shared chrome ─────────────────────────────────────────────────────────

/**
 * The masthead every view shares: what was scanned, the headline numbers and
 * the view tabs. Wrapped in markers so the single-file bundle can keep one copy.
 */
function masthead(data, { current, links, actions = '' }) {
  const { meta, stats } = data;
  const conf = stats.confirmed || { total: stats.totalIssues };
  const uq = stats.unique && stats.unique.confirmed != null && stats.unique.confirmed !== conf.total ? stats.unique.confirmed : null;
  const applicable = (stats.totalCriteria || 56) - (stats.na || 0);
  const verdict = stats.fail
    ? `<p class="ac-verdict v-fail">${icon('fail')}Fails ${plural(stats.fail, 'WCAG 2.2 criterion', 'WCAG 2.2 criteria')}</p>`
    : `<p class="ac-verdict v-clean">${icon('pass')}No automated failures. Manual checks still apply.</p>`;
  const sub = [
    meta.baseUrl ? `<a href="${esc(meta.baseUrl)}">${esc(meta.baseUrl.replace(/^https?:\/\//, ''))}</a>` : '',
    'WCAG 2.2 A + AA',
    esc(meta.generatedAt || ''),
    meta.repoIndexed ? `${meta.repoIndexed} source files indexed` : '',
  ].filter(Boolean).join(' · ');
  const tab = (id, label, href, count) => `<a href="${esc(href)}" data-view="${id}"${current === id ? ' aria-current="page"' : ''}>${label}${count != null ? ` <span class="count">${count}</span>` : ''}</a>`;
  return `<!--ac:mast--><a class="ac-skip" href="#${current === 'findings' ? 'fx-main' : 'main'}">Skip to the report</a>
<header class="ac-mast"><div class="ac-mast-in">
  <div class="ac-mast-top">
    <div><h1>Accessibility report</h1><p class="ac-sub">${sub}</p>${verdict}</div>
    <div class="ac-actions">${actions}</div>
  </div>
  <dl class="ac-facts">
    <div><dt>Criteria failed</dt><dd>${stats.fail || 0} <small>of ${applicable}</small></dd></div>
    <div><dt>Confirmed violations</dt><dd>${conf.total}${uq != null ? ` <small>${uq} unique</small>` : ''}</dd></div>
    <div><dt>Need review</dt><dd>${stats.needsReview || 0} <small>the engines could not decide</small></dd></div>
    <div><dt>Scanned</dt><dd>${plural(stats.pagesInScope != null ? stats.pagesInScope : meta.pageCount, 'page')} <small>${plural(meta.stateCount || 0, 'UI state')}</small></dd></div>
  </dl>
  <nav class="ac-views" aria-label="Report views">
    ${tab('summary', 'Overview', links.summary)}${tab('plan', 'Fix plan', links.plan)}${tab('findings', 'All findings', links.findings, (data.issues || []).length)}
  </nav>
</div></header><!--/ac:mast-->`;
}

function exportMenu(meta) {
  return `<details class="ac-menu"><summary class="ac-btn">${icon('download')}Export${icon('down')}</summary>
    <div class="ac-menu-pop">
      <button type="button" id="dlCsv">${icon('download')}<span>CSV<small>One row per finding, for a tracker</small></span></button>
      <button type="button" id="dlJson">${icon('download')}<span>JSON<small>Summary and every finding</small></span></button>
      <button type="button" id="dlHtml">${icon('download')}<span>HTML snapshot<small>This dashboard, offline and working</small></span></button>
      <button type="button" id="dlPrint">${icon('print')}<span>Print or save as PDF</span></button>
    </div></details>
  <button type="button" class="ac-btn" data-open-commands data-base-url="${esc(meta && meta.baseUrl || '')}">${icon('terminal')}Commands</button>`;
}

function shell(title, body, extraHead = '') {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${THEME.CSS}${SELECT_CSS}${COMMANDS.CSS}</style>${extraHead}</head><body>
${body}
${THEME.SCRIPT}
</body></html>`;
}

const section = (id, title, intro, inner) => `<section class="ac-sec" id="${id}" aria-labelledby="${id}-h">
  <div class="ac-sec-h"><h2 id="${id}-h">${title}</h2>${intro ? `<p>${intro}</p>` : ''}</div>
  ${inner}
</section>`;

// ── Overview panels ───────────────────────────────────────────────────────

// Fix verification: the answer to "did my fixes work?" after a re-scan.
function buildVerificationPanel(v) {
  if (!v) return '';
  const c = v.counts;
  const tile = (n, label, cls, sub) => `<div><dt>${label}</dt><dd><span class="${cls}">${n}</span> <small class="muted">${sub}</small></dd></div>`;
  const rows = (list, label, cls) => list.slice(0, 200).map((i) => `<tr>
      <td><span class="${cls}">${label}</span></td><td>${esc(i.page)}</td>
      <td><code>${esc(i.rule)}</code>${i.kind === 'incomplete' ? ' <span class="muted">(review)</span>' : ''}</td>
      <td>${i.location ? `<code>${esc(i.location)}</code>` : `<code class="muted">${esc((i.target || '').slice(0, 80))}</code>`}</td>
      <td class="muted">${esc(i.reason || '')}</td></tr>`).join('');
  const body = rows(v.still, 'Still failing', 'ac-sev sev-critical') + rows(v.new, 'New', 'ac-sev sev-serious')
    + rows(v.unverified, "Couldn't verify", 'ac-st st-manual') + rows(v.fixed, 'Fixed', 'ac-st st-verified');
  return `<div class="ac-panel" id="verification">
    <h3 style="margin:0 0 .25rem">Did the fixes work?</h3>
    <p class="ac-hint" style="margin:0 0 .75rem">Compared with the previous scan of each page${v.since ? ` (latest baseline ${esc(new Date(v.since).toLocaleString())})` : ''}. “Fixed” means the element was found again and no longer fails. If it could not be found, it is listed as <i>couldn’t verify</i>.</p>
    <dl class="ac-kv">
      ${tile(c.fixed, 'Fixed', 'ac-st st-verified', 'verified gone')}
      ${tile(c.still, 'Still failing', 'ac-sev sev-critical', `${c.stillConfirmed} confirmed`)}
      ${tile(c.new, 'New', 'ac-sev sev-serious', `${c.newConfirmed} confirmed`)}
      ${tile(c.unverified, "Couldn't verify", 'ac-st st-manual', 'check by hand')}
      ${c.notRechecked ? tile(c.notRechecked, 'Not re-scanned', 'ac-st st-manual', 'pages outside this run') : ''}
    </dl>
    ${body ? `<details class="ac-disc" style="margin-top:.75rem"${c.still || c.new ? ' open' : ''}><summary>Issue by issue${icon('chev', 'chev')}</summary>
      <div class="ac-disc-body"><div class="ac-tbl"><table><thead><tr><th>Result</th><th>Page</th><th>Rule</th><th>Where</th><th>Note</th></tr></thead><tbody>${body}</tbody></table></div></div></details>` : ''}
  </div>`;
}

// Pages a public-only scan could not open without logging in.
function buildSkippedPages(meta) {
  const list = (meta && meta.skippedPages) || [];
  if (!list.length) return '';
  return `<div class="ac-note warn">${icon('info')}<div><p><b>${plural(list.length, 'page')} not scanned: login required.</b> This run scanned public pages only. Run the scan again and log in to include them.</p>
    <p class="muted" style="margin-top:.35rem">${list.map((p) => `${esc(p.name)} <code>${esc(p.path)}</code>`).join(' · ')}</p></div></div>`;
}

/**
 * "Where the pages come from" — only worth saying when the report really
 * merges several scan runs. One line, with the detail behind a disclosure.
 */
function buildSourcesNote(meta) {
  const src = meta && meta.combinedSources;
  if (!src || !src.length) return '';
  const runs = new Map();
  for (const s of src) {
    const k = `${s.reportName}|${s.at}`;
    if (!runs.has(k)) runs.set(k, { name: s.reportName, at: s.at, pages: [] });
    runs.get(k).pages.push(s.page);
  }
  if (runs.size < 2) return '';
  const list = [...runs.values()].map((r) => `<li><b>${esc(r.name)}</b> <span class="muted">· ${esc(r.at)} · ${plural(r.pages.length, 'page')}</span><br><span class="muted">${esc(r.pages.join(', '))}</span></li>`).join('');
  return `<details class="ac-disc" style="margin-bottom:1rem"><summary>${icon('layers')}<span>Combined from ${runs.size} scans <span class="sum-sub">· each page shows its most recent result</span></span>${icon('chev', 'chev')}</summary>
    <div class="ac-disc-body"><ul style="margin:0;padding-left:1.1rem;display:grid;gap:.4rem;font-size:.88rem">${list}</ul></div></details>`;
}

/**
 * Dashboard teaser for the fix plan: the top of the "Fix first" list and the
 * tier counts, linking to fix-plan.html (or the plan tab in the single file).
 */
function buildFixPlanTeaser(issues, planHref) {
  const { prioritize } = require('./priority');
  const plan = prioritize(issues || []);
  if (!plan.groups.length) return '';
  const c = plan.counts;
  const top = plan.groups.filter((g) => g.tier === 'now' || g.tier === 'next').slice(0, 3);
  const tiers = [['now', 'Fix first', 'sev-critical'], ['next', 'Fix next', 'sev-serious'], ['plan', 'Schedule', 'sev-moderate'], ['review', 'Needs a decision', 'sev-minor'], ['later', 'Can wait', 'sev-minor']];
  const counts = tiers.filter(([id]) => c[id]).map(([id, label, cls]) => `<span class="ac-sev nocap ${cls}">${label} ${c[id]}</span>`).join(' ');
  const rows = top.map((g) => `<li><span class="rk">${g.rank}</span><span><b>${esc(g.title)}</b><br><span class="muted">${esc(g.reasons.slice(0, 3).join(' · '))}</span></span></li>`).join('');
  return `<div class="ac-panel ac-start" id="fixplan-teaser">
    <div class="ac-start-h"><div><h3>Where to start</h3>
      <p class="ac-hint" style="margin:.2rem 0 0">${c.total} unique ${c.total === 1 ? 'issue' : 'issues'}, ordered by who they block, how many pages they hit and how quick they are to fix.${c.quickWins ? ` ${plural(c.quickWins, 'quick win')}.` : ''}</p></div>
      <a class="ac-btn primary" href="${esc(planHref || 'fix-plan.html')}" data-view="plan">Open the fix plan</a></div>
    <div class="ac-chips" style="margin:.75rem 0 .25rem">${counts}</div>
    ${rows ? `<ol class="ac-start-list">${rows}</ol>` : ''}
  </div>`;
}

// ── Pages ─────────────────────────────────────────────────────────────────

const PAGE_ROWS = 15; // rows shown before "Show all"; search always covers every page

function buildPagesTable(stats, previous) {
  const rows = Object.entries(stats.byPageSeverity || {});
  if (!rows.length) return '<div class="ac-empty">No pages in this report.</div>';
  const prevBPS = (previous && previous.byPageSeverity) || {};
  const max = Math.max(1, ...rows.map(([, s]) => s.total || 0));
  const n = (v) => (v ? v : '<span class="ac-zero">0</span>');
  const body = rows.map(([page, s]) => {
    const prev = prevBPS[page];
    const scoreCls = s.score >= 80 ? 'st-pass' : s.score >= 50 ? 'st-review' : 'st-fail';
    return `<tr data-page="${esc(page.toLowerCase())}" data-c="${s.critical}" data-s="${s.serious}" data-m="${s.moderate}" data-mi="${s.minor}" data-t="${s.total}" data-r="${s.review || 0}" data-score="${s.score}">
      <th scope="row">${esc(page)}</th>
      <td class="num"><span class="ac-mini" style="width:${((s.total / max) * 4.5).toFixed(2)}rem"></span><b>${s.total}</b></td>
      <td class="num hide-sm">${n(s.critical)}</td><td class="num hide-sm">${n(s.serious)}</td><td class="num hide-sm">${n(s.moderate)}</td><td class="num hide-sm">${n(s.minor)}</td>
      <td class="num">${n(s.review || 0)}</td>
      <td class="num"><span class="ac-st ${scoreCls}">${s.score}</span></td>
      <td class="num hide-sm">${deltaBadge(s.total, prev ? prev.total : null)}</td>
    </tr>`;
  }).join('');
  const th = (k, label, cls = 'num') => `<th scope="col" class="${cls}"${k === 't' ? ' aria-sort="descending"' : ''}><button type="button" data-k="${k}">${label}</button></th>`;
  return `<div class="ac-controls">
      <label class="ac-field" style="min-width:16rem">Find a page<input id="imxFilter" type="search" placeholder="Page name" autocomplete="off"></label>
      <p class="ac-count" id="imxCount" role="status" aria-live="polite">${rows.length > PAGE_ROWS ? `The ${PAGE_ROWS} pages with the most violations, of ${rows.length}` : plural(rows.length, 'page')}</p>
    </div>
    <div class="ac-tbl"><table id="imx">
      <caption class="vh">Confirmed violations per page by severity. Column headers sort the table.</caption>
      <thead><tr>${th('page', 'Page', '')}${th('t', 'Confirmed')}${th('c', 'Critical', 'num hide-sm')}${th('s', 'Serious', 'num hide-sm')}${th('m', 'Moderate', 'num hide-sm')}${th('mi', 'Minor', 'num hide-sm')}${th('r', 'Review')}${th('score', 'Health')}<th scope="col" class="num hide-sm">vs last scan</th></tr></thead>
      <tbody>${body}</tbody>
    </table></div>
    ${rows.length > PAGE_ROWS ? `<button type="button" class="ac-btn" id="imxMore" aria-expanded="false" style="margin-top:.6rem">Show all ${rows.length} pages</button>` : ''}
    <p class="ac-hint"><b>Health</b> is 100 minus 10 per critical, 5 per serious, 2 per moderate and 1 per minor confirmed violation (never below 0). Review items and best-practice findings are not counted.</p>`;
}

// Page (rows) × all 56 WCAG criteria (columns).
function buildMatrix(criteria, matrix) {
  if (!matrix || !matrix.pages || !matrix.pages.length) return '';
  const headCells = criteria.map((c) => `<th scope="col" class="mxh" data-tip="${esc(c.id + ' ' + c.name + ' (' + c.level + ')')}"><span class="rot">${esc(c.id)}</span></th>`).join('');
  const rows = matrix.pages.map((pg) => {
    const cells = criteria.map((c) => {
      const st = (matrix.cells[pg] && matrix.cells[pg][c.id]) || 'na';
      return `<td class="cell t-${st}" data-tip="${esc(pg + ' · ' + c.id + ' ' + c.name + ' · ' + STATUS[st].label)}"><span class="vh">${esc(c.id)}: ${STATUS[st].label}</span></td>`;
    }).join('');
    return `<tr data-page="${esc(pg)}"><th scope="row" class="pg">${esc(pg)}</th>${cells}</tr>`;
  }).join('');
  return `<details class="ac-disc" id="matrix"><summary>Page × criterion matrix <span class="sum-sub">· every page against all 56 criteria</span>${icon('chev', 'chev')}</summary>
    <div class="ac-disc-body">
      <p class="ac-hint">Hover or focus a cell for the page, criterion and result. Scroll sideways for all 56 criteria, in order from Perceivable to Robust.</p>
      <div class="ac-mx" tabindex="0" role="region" aria-label="WCAG criteria by page (scrolls sideways)"><table class="ac-mxt">
        <thead><tr><th scope="col" class="corner">Page</th>${headCells}</tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </div></details>`;
}

// ── Coverage panels ───────────────────────────────────────────────────────

// Every UI state visited per page (base + revealed modals/dropdowns/tabs).
function buildModalCoverage(stats) {
  const cov = stats.stateCoverage || {};
  const pages = Object.keys(cov);
  if (!pages.length) return '';
  const revealedTotal = stats.totalStatesRevealed || 0;
  if (!revealedTotal) {
    return `<details class="ac-disc"><summary>${icon('layers')}<span>Dialogs, menus and tabs <span class="sum-sub">· only base pages were scanned</span></span>${icon('chev', 'chev')}</summary>
      <div class="ac-disc-body"><p>No modal, dropdown or tab was opened. Add <code>actions</code> (click or show, then snapshot) to a page in a11y.config.js, or turn on <code>AUTO_EXPLORE</code>, to test hidden UI.</p></div></details>`;
  }
  const link = (pg, s, label) => `<button type="button" class="ac-link" data-dlg-page="${esc(pg)}" data-dlg-state="${esc(s)}">${label}</button>`;
  const rows = pages.filter((pg) => cov[pg].states.length > 1).map((pg) => {
    const { states, counts } = cov[pg];
    return states.map((s, k) => {
      const n = counts[s] || 0;
      const label = /^initial$/i.test(s) ? 'Base page' : s;
      return `<tr>${k === 0 ? `<th scope="rowgroup" rowspan="${states.length}">${esc(pg)}</th>` : ''}<td>${esc(label)}</td><td class="num">${n ? link(pg, s, plural(n, 'issue')) : '<span class="ac-zero">0</span>'}</td></tr>`;
    }).join('');
  }).join('');
  const modalOnly = stats.modalOnlyIssues || 0;
  return `<details class="ac-disc" open><summary>${icon('layers')}<span>Dialogs, menus and tabs <span class="sum-sub">· ${plural(revealedTotal, 'hidden state')} opened</span></span>${icon('chev', 'chev')}</summary>
    <div class="ac-disc-body">
      <p>${modalOnly ? `<b>${plural(modalOnly, 'issue')}</b> exist only inside an opened state, so a scan of the base page alone would miss them.` : 'No issue was found only inside an opened state.'} Select a count to see those issues.</p>
      ${rows ? `<div class="ac-tbl"><table><thead><tr><th scope="col">Page</th><th scope="col">State</th><th scope="col" class="num">Issues</th></tr></thead><tbody>${rows}</tbody></table></div>` : ''}
    </div></details>`;
}

// Raw DOM census, independent of pass/fail.
function buildInventory(stats) {
  const inv = stats.inventory;
  if (!inv) return '';
  const row = (n, label, warn) => `<tr><th scope="row">${label}</th><td class="num">${warn && n > 0 ? `<span class="ac-sev sev-critical">${n}</span>` : n}</td></tr>`;
  return `<details class="ac-disc"><summary>${icon('layers')}<span>What the scan found on the pages <span class="sum-sub">· a raw count, not pass/fail</span></span>${icon('chev', 'chev')}</summary>
    <div class="ac-disc-body"><div class="ac-grid-2">
      <div class="ac-tbl"><table><caption>Detected</caption><tbody>
        ${row(inv.detected.headings, 'Headings')}${row(inv.detected.roleAttributes, 'Role attributes')}${row(inv.detected.ariaAttributes, 'ARIA attributes')}
        ${row(inv.detected.accessKeys, 'Access keys')}${row(inv.detected.fieldsWithoutLabel, 'Fields without a label', true)}${row(inv.detected.altlessImages, 'Images without alt', true)}
      </tbody></table></div>
      <div class="ac-tbl"><table><caption>Content crawled</caption><tbody>
        ${row(inv.crawled.links, 'Links')}${row(inv.crawled.images, 'Images')}${row(inv.crawled.iframes, 'Iframes')}
        ${row(inv.crawled.pdfs, 'PDFs')}${row(inv.crawled.video, 'Video')}${row(inv.crawled.audio, 'Audio')}
      </tbody></table></div>
    </div>
    <p class="ac-hint">Across ${plural(Object.keys(inv.byPage).length, 'page')}. Fields without a label and images without alt are worth checking even where no rule flagged them. Linked PDFs, video and audio need their own checks.</p></div></details>`;
}

function buildCodeMappingSummary(issues, meta) {
  if (!meta.repoIndexed) {
    return `<div class="ac-note">${icon('code')}<p>Code mapping is off. Set <code>REPO_PATH</code> in a11y.config.js to point each issue at its source file and line.</p></div>`;
  }
  const withLoc = issues.filter((i) => i.locations && i.locations.length);
  const files = new Set(withLoc.flatMap((i) => i.locations.map((l) => l.file)));
  const high = withLoc.filter((i) => ['exact', 'high'].includes(i.locations[0].confidence)).length;
  return `<div class="ac-note">${icon('code')}<p><b>${withLoc.length}</b> of ${issues.length} issues point at source code, in <b>${plural(files.size, 'file')}</b> (${high} high-confidence matches, ${meta.repoIndexed} files indexed).</p></div>`;
}

// Engine agreement, server-side fallback (the per-scope version is drawn client-side).
function buildEngineComparison(stats) {
  const ec = stats.engineComparison;
  if (!ec) return `<div class="ac-note">${icon('info')}<p>The second-engine comparison is off or had nothing to compare. Set <code>SECOND_ENGINE: true</code> in a11y.config.js to cross-check with IBM's open-source Equal Access engine.</p></div>`;
  return '<div id="engineWrap"></div>';
}

// ── History ───────────────────────────────────────────────────────────────

function buildTrend(stats, meta, history) {
  const past = (history || []).slice().reverse(); // oldest → newest
  // Only past runs of the same pages that recorded confirmed counts are comparable.
  const pages = (meta && meta.pages) || null;
  const conf = stats.confirmed || { total: stats.totalIssues, critical: stats.byImpact.critical };
  const current = { at: meta.generatedAt, pages, stats: { issues: conf.total, critical: conf.critical }, avgHealth: stats.avgHealth };
  const usable = past.filter((r) => runConfirmed(r) != null && (!pages || samePages(r.pages, pages)))
    .map((r) => ({ ...r, stats: { issues: runConfirmed(r), critical: r.stats.confirmedCritical != null ? r.stats.confirmedCritical : r.stats.critical } }));
  const skippedRuns = past.length - usable.length;
  const seq = usable.concat([current]);
  if (seq.length < 2) {
    return `<div class="ac-panel"><h3 style="margin:0 0 .3rem">Trend</h3><p class="ac-hint" style="margin:0">${skippedRuns ? `No earlier scan of exactly these pages to compare with (${skippedRuns} earlier scan(s) covered different pages or predate confirmed counts).` : 'This is the first recorded scan of this report.'} Scan again later to see confirmed violations over time.</p></div>`;
  }
  const W = 680, H = 170, PAD = 28;
  const maxIssues = Math.max(1, ...seq.map((r) => r.stats.issues));
  const stepX = (W - PAD * 2) / (seq.length - 1);
  const yFor = (v) => H - PAD - (v / maxIssues) * (H - PAD * 2);
  const pt = (i, v) => `${(PAD + i * stepX).toFixed(1)},${yFor(v).toFixed(1)}`;
  const dots = (cls, key) => seq.map((r, i) => {
    const [x, y] = pt(i, r.stats[key]).split(',');
    return `<circle cx="${x}" cy="${y}" r="4" class="${cls}"><title>${esc(r.at)}: ${r.stats[key]} ${key === 'issues' ? 'confirmed' : 'critical'}</title></circle>`;
  }).join('');
  const first = seq[0], last = seq[seq.length - 1];
  const svg = `<svg viewBox="0 0 ${W} ${H}" class="ac-chart" role="img" aria-label="Confirmed violations over ${seq.length} scans: ${first.stats.issues} to ${last.stats.issues}">
    <line x1="${PAD}" y1="${H - PAD}" x2="${W - PAD}" y2="${H - PAD}" class="axis"/>
    <polyline points="${seq.map((r, i) => pt(i, r.stats.issues)).join(' ')}" class="s1"/>
    <polyline points="${seq.map((r, i) => pt(i, r.stats.critical)).join(' ')}" class="s2"/>
    ${dots('d1', 'issues')}${dots('d2', 'critical')}
  </svg>`;
  const rows = seq.slice().reverse().slice(0, 8).map((r) => `<tr><td>${esc(r.at)}</td><td class="num">${r.stats.issues}</td><td class="num">${r.stats.critical}</td><td class="num">${r.avgHealth == null ? '<span class="muted">—</span>' : r.avgHealth}</td></tr>`).join('');
  return `<div class="ac-panel"><h3 style="margin:0 0 .3rem">Trend <span class="muted" style="font-weight:400">· ${seq.length} scans of the same pages${skippedRuns ? `, ${skippedRuns} of other pages left out` : ''}</span></h3>
    <ul class="ac-key" style="border:0;margin:.25rem 0 .5rem;padding:0"><li><i class="ac-line l1"></i>Confirmed violations</li><li><i class="ac-line l2"></i>Critical</li><li>Since the first scan: ${deltaBadge(last.stats.issues, first.stats.issues)}</li></ul>
    ${svg}
    <div class="ac-tbl" style="margin-top:.75rem"><table><thead><tr><th scope="col">When</th><th scope="col" class="num">Confirmed</th><th scope="col" class="num">Critical</th><th scope="col" class="num">Avg health</th></tr></thead><tbody>${rows}</tbody></table></div>
  </div>`;
}

// Defect lifecycle: age bands with the Blocker SLA, regression escapes and the
// remediation burn-up. Derived from archived runs — see lib/lifecycle.js.
function buildLifecyclePanel(lc) {
  if (!lc) return '';
  if (lc.runCount < 2) {
    return `<div class="ac-panel"><h3 style="margin:0 0 .3rem">Defect lifecycle</h3><p class="ac-hint" style="margin:0">Only one scan is archived so far. Age, regressions and the burn-up chart appear once a second scan of the same pages has run.</p></div>`;
  }
  const SEV_CLS = { Blocker: 'sev-critical', Critical: 'sev-serious', Major: 'sev-moderate', Minor: 'sev-minor' };
  const ageRows = lc.severityOrder.map((sev) => {
    const b = lc.openByAge[sev];
    if (!b.total) return '';
    const seg = (n, cls) => (n ? `<span class="${cls}" style="width:${(n / b.total) * 100}%" title="${n}"></span>` : '');
    return `<tr><th scope="row"><span class="ac-sev ${SEV_CLS[sev]}">${sev}</span></th><td class="num"><b>${b.total}</b></td>
      <td style="min-width:10rem"><div class="ac-stack">${seg(b.band0_7, 'a0')}${seg(b.band8_30, 'a1')}${seg(b.band31plus, 'a2')}</div></td>
      <td class="num">${b.band0_7}</td><td class="num">${b.band8_30}</td><td class="num">${b.band31plus ? `<b>${b.band31plus}</b>` : 0}</td><td class="num">${b.oldestDays}d</td></tr>`;
  }).join('');
  const series = lc.burnUp;
  const W2 = 660, H2 = 190, PAD = 34;
  const maxY = Math.max(1, ...series.map((s) => s.cumulativeFound));
  const stepX = series.length > 1 ? (W2 - PAD * 2) / (series.length - 1) : 0;
  const yFor = (v) => H2 - PAD - (v / maxY) * (H2 - PAD * 2);
  const pts = (key) => series.map((s, i) => `${(PAD + i * stepX).toFixed(1)},${yFor(s[key]).toFixed(1)}`).join(' ');
  const last = series[series.length - 1];
  const pctResolved = last.cumulativeFound ? Math.round((last.resolved / last.cumulativeFound) * 100) : 0;
  const regList = lc.regressions.slice(0, 8).map((r) => `<li><span class="ac-sev ${SEV_CLS[r.severity]}">${r.severity}</span> <code>${esc(r.rule)}</code> <span class="muted">${esc(r.page)}${r.location ? ' · ' + esc(r.location) : ''}</span></li>`).join('');
  return `<div class="ac-panel"><h3 style="margin:0 0 .3rem">Defect lifecycle <span class="muted" style="font-weight:400">· across ${lc.runCount} scans</span></h3>
    <div class="ac-chips" style="margin:.5rem 0 1rem">
      <span class="${lc.overSla ? 'ac-sev sev-critical' : 'ac-st st-verified'}">${plural(lc.overSla, 'Blocker')} older than 7 days · target 0</span>
      <span class="${lc.regressions.length ? 'ac-sev sev-critical' : 'ac-st st-verified'}">${plural(lc.regressions.length, 'regression')} · target 0</span>
      <span class="ac-st st-pass">${lc.resolvedCount} apparently resolved</span>
    </div>
    <div class="ac-tbl"><table><caption class="vh">Open confirmed violations by severity and age</caption><thead><tr><th scope="col">Severity</th><th scope="col" class="num">Open</th><th scope="col">Age spread</th><th scope="col" class="num">0–7 days</th><th scope="col" class="num">8–30 days</th><th scope="col" class="num">31+ days</th><th scope="col" class="num">Oldest</th></tr></thead>
      <tbody>${ageRows || '<tr><td colspan="7" class="ac-empty">No open confirmed violations.</td></tr>'}</tbody></table></div>
    <div class="ac-grid-2" style="margin-top:1rem">
      <div><h4 style="font-size:.9rem;margin:0 0 .2rem">Remediation burn-up</h4><p class="ac-hint" style="margin:0 0 .4rem">${pctResolved}% of all violations ever found are no longer detected.</p>
        <svg viewBox="0 0 ${W2} ${H2}" class="ac-chart" role="img" aria-label="Remediation burn-up: ${last.cumulativeFound} found, ${last.open} open, ${last.resolved} resolved">
          <line x1="${PAD}" y1="${H2 - PAD}" x2="${W2 - PAD}" y2="${H2 - PAD}" class="axis"/>
          <polyline points="${pts('cumulativeFound')}" class="s3"/><polyline points="${pts('open')}" class="s2"/><polyline points="${pts('resolved')}" class="s4"/>
        </svg>
        <ul class="ac-key" style="border:0;margin:.25rem 0 0;padding:0"><li><i class="ac-line l3"></i>Total ever found</li><li><i class="ac-line l2"></i>Still open</li><li><i class="ac-line l4"></i>Resolved</li></ul></div>
      <div><h4 style="font-size:.9rem;margin:0 0 .2rem">Regressions</h4><p class="ac-hint" style="margin:0 0 .4rem">Defects on a page that was previously clean for that rule.</p>
        ${lc.regressions.length ? `<ul class="ac-reg">${regList}</ul>` : '<p class="muted">None. No previously clean page has regressed.</p>'}
        ${lc.newRuleFindings.length ? `<p class="ac-hint">Not counted: ${plural(lc.newRuleFindings.length, 'finding')} from checks added since the previous scan. These existed before and are newly detected.</p>` : ''}</div>
    </div>
    <p class="ac-hint">“Apparently resolved” means a re-scan of the page no longer detects the defect. That usually means fixed, but can also mean the element did not render.${lc.staleCount ? ` ${plural(lc.staleCount, 'defect')} on pages not re-scanned yet are left out.` : ''}</p>
  </div>`;
}

// ── Assets shared with other modules ──────────────────────────────────────

// Accessible custom select (lib/ui/select.*): replaces native <select data-a11y-select>.
const SELECT_CSS = fs.readFileSync(path.join(__dirname, 'ui', 'select.css'), 'utf8');
const SELECT_SCRIPT = `<script>${fs.readFileSync(path.join(__dirname, 'ui', 'select.js'), 'utf8')}</script>`;
const COMMANDS = require('./ui/commands'); // the Commands dialog

// Styles only the dashboard and findings views need (the shared ones are in theme.js).
const VIEW_CSS = `
.ac-kv{display:flex;flex-wrap:wrap;gap:.75rem 2rem;margin:0}
.ac-kv dt{font-size:.8rem;color:var(--muted)}
.ac-kv dd{margin:.15rem 0 0;font-size:.9rem}
.ac-link{font:inherit;color:var(--link);background:none;border:0;padding:0;cursor:pointer;text-decoration:underline;text-underline-offset:.18em}
.ac-start-h{display:flex;justify-content:space-between;align-items:flex-start;gap:1rem;flex-wrap:wrap}
.ac-start-h h3{margin:0;font-size:1.05rem}
.ac-start-list{list-style:none;margin:.5rem 0 0;padding:0}
.ac-start-list li{display:grid;grid-template-columns:1.75rem minmax(0,1fr);gap:.6rem;padding:.6rem 0;border-top:1px solid var(--line);font-size:.9rem}
.ac-start-list .rk{width:1.6rem;height:1.6rem;border-radius:6px;background:var(--sev-critical-bg);color:var(--sev-critical);font-weight:700;font-size:.8rem;display:grid;place-items:center}
.ac-mx{overflow-x:auto;border:1px solid var(--line);border-radius:8px;background:var(--surface)}
.ac-mxt{border-collapse:separate;border-spacing:0;font-size:.72rem}
.ac-mxt th,.ac-mxt td{border-right:1px solid var(--surface);border-bottom:1px solid var(--surface);padding:0;text-align:center}
.ac-mxt thead th{height:4.5rem;width:26px;min-width:24px;vertical-align:bottom;position:relative;background:var(--surface-2);font-weight:700;color:var(--ink-2)}
.ac-mxt .rot{position:absolute;bottom:.5rem;left:50%;transform:translateX(-50%) rotate(-90deg);white-space:nowrap}
.ac-mxt .corner,.ac-mxt .pg{position:sticky;left:0;z-index:2;background:var(--surface);text-align:left;padding:.3rem .7rem;font-size:.8rem;white-space:nowrap;min-width:10rem;border-right:1px solid var(--line)}
.ac-mxt thead .corner{vertical-align:middle;background:var(--surface-2)}
.ac-mxt td.cell{height:26px;min-width:24px;border-radius:0}
.ac-mxt td.cell.t-na{border:0;background:var(--surface-2)}
.ac-mxt tr:hover .pg{background:var(--accent-tint)}
.ac-chart{width:100%;height:auto;display:block}
.ac-chart .axis{stroke:var(--line-2);stroke-width:1}
.ac-chart polyline{fill:none;stroke-width:2;stroke-linejoin:round;stroke-linecap:round}
.ac-chart .s1{stroke:var(--bar)}.ac-chart .s2{stroke:var(--fail)}.ac-chart .s3{stroke:var(--muted)}.ac-chart .s4{stroke:var(--good)}
.ac-chart .d1{fill:var(--bar);stroke:var(--surface);stroke-width:2}.ac-chart .d2{fill:var(--fail);stroke:var(--surface);stroke-width:2}
.ac-line{display:inline-block;width:1rem;height:2px;border-radius:1px;vertical-align:middle}
.ac-line.l1{background:var(--bar)}.ac-line.l2{background:var(--fail)}.ac-line.l3{background:var(--muted)}.ac-line.l4{background:var(--good)}
.ac-stack{display:flex;height:12px;border-radius:999px;overflow:hidden;background:var(--surface-2);gap:2px}
.ac-stack span{display:block;height:100%}.ac-stack .a0{background:var(--good)}.ac-stack .a1{background:var(--warn)}.ac-stack .a2{background:var(--fail)}
.ac-reg{list-style:none;margin:0;padding:0;display:grid;gap:.35rem;font-size:.85rem}
.ac-crit-steps summary{cursor:pointer;color:var(--link);font-size:.85rem;margin-top:.35rem}
.ac-crit-steps ol{margin:.4rem 0 0;padding-left:1.2rem;font-size:.85rem;color:var(--ink-2)}
.ac-checks{display:grid;grid-template-columns:repeat(auto-fill,minmax(22rem,1fr));gap:1rem;align-items:start}
.ac-checks>.ac-panel,.ac-grid-2>.ac-panel{margin:0}
.ac-check-h{display:flex;align-items:center;gap:.5rem;font-weight:700}
.ac-check-h .ac-ic{color:var(--accent);width:1.1rem;height:1.1rem}
.ac-check-h .n{margin-left:auto;font-weight:400;color:var(--muted);font-size:.85rem}
.ac-check-how{font-size:.82rem;color:var(--muted);margin:.2rem 0 .5rem}
.ac-check-rows{list-style:none;margin:0;padding:0}
.ac-check-rows li{display:grid;grid-template-columns:2.4rem minmax(0,1fr) auto;gap:.6rem;align-items:center;padding:.45rem 0;border-top:1px solid var(--line);font-size:.86rem}
.ac-check-rows .cnt{font-size:1.05rem;font-weight:700;text-align:right;font-variant-numeric:tabular-nums;color:var(--muted)}
.ac-check-rows .cnt.hit{color:var(--fail-text)}
.ac-check-rows .lbl small{display:block;color:var(--muted);font-size:.76rem}
.ac-check-rows button.lbl{font:inherit;text-align:left;background:none;border:0;padding:0;color:var(--ink);cursor:pointer}
.ac-check-rows button.lbl:hover span{text-decoration:underline}
.ac-check-off{font-size:.84rem;color:var(--ink-2);background:var(--surface-2);border-radius:8px;padding:.6rem .75rem}
.ac-engine-diff td{background:var(--accent-tint)}
@media print{
  @page{size:A4 landscape;margin:10mm}
  details.ac-disc{display:block}
  .ac-mx{overflow:visible;border:0}
  .ac-mxt{font-size:7px}.ac-mxt thead th{width:13px;min-width:13px;height:48px}.ac-mxt td.cell{min-width:13px;height:13px}
  .ac-mxt .pg,.ac-mxt .corner{position:static;min-width:0;font-size:8px}
}
`;

// ── Automated checks catalogue ────────────────────────────────────────────

// Every check this tool runs itself, beyond axe-core, grouped for the
// "Automated checks" panel. Each row: [rule ids, what it finds, criterion].
// passless: the group's checks report failures only, so a group that ran and
//   found nothing on a row is clean (otherwise a row with no result of its own
//   had nothing to judge, e.g. no navigation repeated across pages).
// optIn: the config switch the group needs; without it the group never runs.
const CHECK_GROUPS = [
  { icon: 'keyboard', name: 'Keyboard walk', how: 'A real Tab-through of each page: focus order, traps, focus visibility.', rows: [
    [['kbd-focus-visible'], 'Elements with no visible focus indicator', '2.4.7'],
    [['kbd-keyboard-trap'], 'Possible keyboard traps', '2.1.2'],
    [['kbd-positive-tabindex'], 'Positive tabindex (breaks focus order)', '2.4.3'],
    [['kbd-click-not-focusable', 'kbd-click-not-focusable-review'], 'Clickable elements you cannot reach with Tab', '2.1.1'],
    [['kbd-role-not-focusable'], 'Widgets (role="button" etc.) that are not focusable', '2.1.1'],
  ] },
  { icon: 'ear', name: 'Screen reader', passless: true, how: 'Accessibility-tree analysis: accessible names and ARIA references.', rows: [
    [['sr-broken-aria-ref'], 'Broken ARIA name/description references', '4.1.2'],
    [['sr-broken-aria-relationship'], 'ARIA relationship pointing at an element not in the page', '4.1.2'],
    [['sr-unnamed-control'], 'Controls a screen reader announces blank', '4.1.2'],
    [['sr-duplicate-name'], 'Controls sharing an identical name', '4.1.2'],
  ] },
  { icon: 'zoom', name: 'Zoom & reflow', how: 'Each page re-rendered at 320px wide, 200% text, wider text spacing and both orientations.', rows: [
    [['vp-reflow'], 'Horizontal scrolling at 320px wide (reflow)', '1.4.10'],
    [['vp-resize-text'], 'Text clipped or overlapping at 200% text size', '1.4.4'],
    [['vp-text-spacing'], 'Content breaks with wider text spacing', '1.4.12'],
    [['vp-orientation'], 'Locked to one screen orientation', '1.3.4'],
  ] },
  { icon: 'contrast', name: 'Contrast beyond axe', how: 'Control boundaries against their surroundings, and text contrast axe could not decide, measured from rendered pixels.', rows: [
    [['uic-component-boundary'], 'Control boundaries under 3:1 contrast', '1.4.11'],
    [['contrast-sampled'], 'Low text contrast found by pixel sampling', '1.4.3'],
  ] },
  { icon: 'heading', name: 'Headings & labels', passless: true, how: 'Heading structure, and whether headings and labels describe what they are for.', rows: [
    [['hl-h1-count'], 'Pages without exactly one h1', '2.4.6'],
    [['hl-heading-empty'], 'Empty headings', '2.4.6'],
    [['hl-heading-duplicate'], 'Repeated heading text', '2.4.6'],
    [['hl-heading-placeholder'], 'Placeholder headings', '2.4.6'],
    [['hl-label-duplicate'], 'Different fields with the same label', '2.4.6'],
    [['hl-label-generic'], 'Generic labels ("Click here", "More")', '2.4.6'],
  ] },
  { icon: 'repeat', name: 'Consistency across pages', how: 'Navigation, link labels and help links compared between the scanned pages.', rows: [
    [['con-multiple-ways'], 'No second way to find pages (search, sitemap…)', '2.4.5'],
    [['con-nav-order'], 'Navigation order differs between pages', '3.2.3'],
    [['con-identification'], 'Same link labelled differently on different pages', '3.2.4'],
    [['con-help-missing'], 'Help link missing or moved on some pages', '3.2.6'],
  ] },
  { icon: 'form', name: 'Forms', how: 'Questions asked twice in one flow, and confirm/review/undo on forms listed in CONSEQUENTIAL_FLOWS.', rows: [
    [['ff-redundant-entry'], 'Same information asked twice', '3.3.7'],
    [['ff-no-error-prevention'], 'Consequential form without confirm, review or undo', '3.3.4'],
  ] },
  { icon: 'pointer', name: 'Interaction', optIn: 'LIVE_REGION_CHECKS: true', how: 'Forms submitted and controls pressed, with network writes blocked, to see what happens.', rows: [
    [['lr-status-not-announced'], 'Status messages a screen reader does not announce', '4.1.3'],
    [['lr-error-not-associated'], 'Error messages not tied to their field', '3.3.1'],
    [['lr-error-no-suggestion'], 'Errors that do not say how to fix the input', '3.3.3'],
    [['cc-focus-context-change'], 'Focusing a control changes context', '3.2.1'],
    [['cc-input-context-change'], 'Changing a value changes context', '3.2.2'],
    [['cc-hover-not-dismissable', 'cc-hover-not-persistent'], 'Hover/focus pop-ups that cannot be dismissed or vanish', '1.4.13'],
    [['pc-down-event-action'], 'Actions that fire on pointer down', '2.5.2'],
  ] },
];

// ── Export (CSV / JSON / HTML snapshot / print) ───────────────────────────

/**
 * Client-side export controls.
 *
 * Deliberately Blob-based rather than a link to a file on disk: the dashboard
 * is read from a build artifact, a blob URL or a local folder, and in the
 * artifact case a sibling <a download> can resolve to something that isn't
 * there. A Blob is built from data already embedded in this page, so the
 * buttons work from file://, from blob hosting, and from an unzipped artifact
 * alike — with no server and no network.
 *
 * CSV columns are chosen to paste straight into a tracker: one row per
 * finding, with the state it appeared in and the probable source location.
 */
function buildExportPayload(data) {
  const { issues } = data;
  return (issues || []).map((i) => {
    const loc = (i.locations && i.locations[0]) || null;
    return {
      page: i.page || '',
      state: (i.states || []).join(' | '),
      severity: SEVERITY_LABEL[i.impact] || i.impact || '',
      rule: i.rule || '',
      criteria: (i.criteria || []).map((c) => `${c.id} ${c.name}`).join('; '),
      description: i.help || i.description || '',
      selector: Array.isArray(i.target) ? i.target.join(' ') : String(i.target || ''),
      html: String(i.html || '').replace(/\s+/g, ' ').slice(0, 300),
      remediation: String((i.customFix && i.customFix.fix) || i.failureSummary || '').replace(/\s+/g, ' ').slice(0, 500),
      sourceFile: loc ? `${loc.file}:${loc.line}` : '',
      sourceConfidence: loc && loc.confidence != null ? String(loc.confidence) : '',
      url: i.url || '',
    };
  });
}

// Impact -> the programme KPI catalogue's severity vocabulary (matches
// lib/lifecycle.js, so exports and the lifecycle panel speak the same language).
const SEVERITY_LABEL = { critical: 'Blocker', serious: 'Critical', moderate: 'Major', minor: 'Minor' };

function buildExportScript(data) {
  const rows = buildExportPayload(data);
  const scanName = (data.meta && data.meta.reportName) || 'accessibility-scan';
  const slug = String(scanName).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'scan';
  // </script> inside embedded data would close the tag early.
  const json = JSON.stringify(rows).replace(/</g, '\\u003c');
  const summary = JSON.stringify({
    scan: scanName,
    generatedAt: (data.meta && data.meta.generatedAt) || '',
    baseUrl: (data.meta && data.meta.baseUrl) || '',
    pages: (data.matrix && data.matrix.pages) || [],
    stats: data.stats || {},
  }).replace(/</g, '\\u003c');

  return `<script>
(function(){
  var ROWS = ${json};
  var SUMMARY = ${summary};
  var SLUG = ${JSON.stringify(slug)};
  // Shared with the issue dialog, so the page carries the detail only once.
  window.__A11Y_ROWS__ = ROWS;
  var COLS = ['page','state','severity','rule','criteria','description','selector','html','remediation','sourceFile','sourceConfidence','url'];

  function csvCell(v){
    v = v == null ? '' : String(v);
    // Quote when the value contains a delimiter, quote or newline; double any
    // embedded quotes. Leading =,+,-,@ are prefixed with a quote so a
    // spreadsheet treats them as text rather than a formula.
    if (/^[=+\\-@]/.test(v)) v = "'" + v;
    return /[",\\r\\n]/.test(v) ? '"' + v.replace(/"/g,'""') + '"' : v;
  }
  function toCSV(){
    var out = [COLS.join(',')];
    ROWS.forEach(function(r){ out.push(COLS.map(function(c){ return csvCell(r[c]); }).join(',')); });
    // BOM so Excel reads UTF-8 correctly.
    return '\\ufeff' + out.join('\\r\\n');
  }
  function save(text, mime, name){
    var blob = new Blob([text], { type: mime });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function(){ URL.revokeObjectURL(url); }, 1000);
  }
  function stamp(){ return new Date().toISOString().slice(0,10); }
  function closeMenu(b){ var d = b && b.closest('details'); if (d) d.open = false; }

  var csvBtn = document.getElementById('dlCsv');
  if (csvBtn) csvBtn.addEventListener('click', function(){
    closeMenu(csvBtn);
    save(toCSV(), 'text/csv;charset=utf-8', 'a11y-' + SLUG + '-' + stamp() + '.csv');
  });
  var jsonBtn = document.getElementById('dlJson');
  if (jsonBtn) jsonBtn.addEventListener('click', function(){
    closeMenu(jsonBtn);
    save(JSON.stringify({ summary: SUMMARY, findings: ROWS }, null, 2), 'application/json', 'a11y-' + SLUG + '-' + stamp() + '.json');
  });
  // Self-contained HTML snapshot of the dashboard exactly as it looks now.
  // The page has no external assets and all its data is inline, so a DOM
  // snapshot reopens fully working: filters, tooltips and the CSV/JSON
  // buttons keep functioning offline.
  var htmlBtn = document.getElementById('dlHtml');
  if (htmlBtn) htmlBtn.addEventListener('click', function(){
    closeMenu(htmlBtn);
    var clone = document.documentElement.cloneNode(true);
    // Sibling files (fix plan, findings) won't travel with the snapshot, so
    // links to them would land on a 404. Drop the view tabs.
    [].forEach.call(clone.querySelectorAll('.ac-views, .ac-tip, #view-plan, #view-findings'), function(el){ el.remove(); });
    var sub = clone.querySelector('.ac-mast .ac-sub');
    if (sub) sub.innerHTML += ' · <b>offline snapshot</b> taken ' + new Date().toLocaleString();
    save('<!doctype html>\\n' + clone.outerHTML, 'text/html;charset=utf-8', 'a11y-' + SLUG + '-' + stamp() + '.html');
  });

  var printBtn = document.getElementById('dlPrint');
  if (printBtn) printBtn.addEventListener('click', function(){ closeMenu(printBtn); window.print(); });

  var n = ROWS.length;
  [csvBtn, jsonBtn].forEach(function(b){
    if (!b) return;
    if (!n) { b.disabled = true; b.title = 'No findings to export'; }
  });
})();
</script>`;
}

// ── Dashboard ─────────────────────────────────────────────────────────────

function buildDashboard(data, opts = {}) {
  const { criteria, meta, matrix, issues, stats, previous, history } = data;
  const reportFile = opts.reportFile || 'report.html';
  const planHref = opts.planHref || 'fix-plan.html';
  const pages = (matrix && matrix.pages) || [];

  // Per-scope data embedded for client-side filtering (All + each page).
  const statusByScope = { ALL: {} };
  for (const c of criteria) statusByScope.ALL[c.id] = c.status;
  for (const pg of pages) {
    statusByScope[pg] = {};
    for (const c of criteria) statusByScope[pg][c.id] = (matrix.cells[pg] && matrix.cells[pg][c.id]) || 'na';
  }
  const embed = {
    pages,
    principles: Object.values(PRINCIPLES),
    status: STATUS,
    icons: THEME.ICONS,
    // `untested` distinguishes "manual by design" from "we have no rule for
    // this" — both need a human, but only the second is a gap in the tool.
    criteria: criteria.map((c) => ({
      id: c.id, name: c.name, level: c.level, principle: c.principle,
      untested: !!c.untested,
      // Where a criterion needs a person, say exactly what that person should
      // do. A status of "manual" with no procedure attached is how criteria
      // sit untouched for months.
      steps: c.manualSteps || null,
      source: c.source || null, // 'ibm' when the second engine decided it
      hint: (c.untested ? c.untestedWhy || 'No rule for this criterion exists in the scan engine, so it was never actually tested. This is a tooling gap, not a clean result. ' : '') + (c.manualHint || ''),
    })),
    statusByScope,
    // `ix` indexes the export rows (window.__A11Y_ROWS__), which hold the bulky
    // detail (markup, fix, source file) the issue dialog shows.
    issues: issues.map((i, ix) => ({
      ix, rule: i.rule, page: i.page, impact: i.impact, kind: i.kind, cat: i.category || 'wcag', gid: i.groupId || ix,
      crits: (i.criteria || []).map((c) => ({ id: c.id, name: c.name, level: c.level })),
      states: i.states || [],
      title: i.customFix ? i.customFix.what : '',
      helpUrl: i.helpUrl || '',
      shot: i.screenshot || '',
    })),
    engineByScope: stats.engineComparisonByScope || (stats.engineComparison ? { ALL: stats.engineComparison } : null),
    checks: CHECK_GROUPS,
    checkRuns: stats.checkRuns || {},
    lint: stats.lint || null,
    previousConfirmed: previous && samePages(previous.pages, pages) ? runConfirmed(previous) : null,
    previousOtherPages: !!(previous && !samePages(previous.pages, pages)),
  };
  const json = JSON.stringify(embed).replace(/</g, '\\u003c');

  // "(cumulative)" is only true when this report merges several runs.
  const isCumulative = !!(meta && meta.combinedSources);
  const allLabel = `All pages (${isCumulative ? pages.length : (stats.pagesInScope != null ? stats.pagesInScope : pages.length)})`;
  const options = [`<option value="ALL">${esc(allLabel)}</option>`].concat(pages.map((p) => `<option value="${esc(p)}">${esc(p)}</option>`)).join('');

  const toc = `<nav class="ac-toc" aria-label="Dashboard sections">
    <label class="ac-field"><span class="lbl-t">Show results for</span><select id="scopeSel" aria-label="Show results for" data-a11y-select>${options}</select></label>
    <p class="ac-toc-h">On this page</p>
    <ol>
      <li><a href="#overview"><span class="n">1</span>Overview</a></li>
      <li><a href="#pages"><span class="n">2</span>Pages</a></li>
      <li><a href="#fixonce"><span class="n">3</span>Fix once</a></li>
      <li><a href="#criteria"><span class="n">4</span>WCAG criteria</a></li>
      <li><a href="#checks"><span class="n">5</span>Automated checks</a></li>
      <li><a href="#coverage"><span class="n">6</span>Coverage</a></li>
      <li><a href="#history"><span class="n">7</span>History</a></li>
    </ol>
  </nav>`;

  const overview = section('overview', 'Overview', '', `
    ${buildSourcesNote(meta)}
    ${buildSkippedPages(meta)}
    ${buildVerificationPanel(data.verification)}
    <div class="ac-panel"${data.verification ? ' style="margin-top:1rem"' : ''}>
      <div class="ac-start-h" style="margin-bottom:.9rem"><h3 id="mapTitle" style="margin:0;font-size:1.05rem">WCAG 2.2 A and AA, by result</h3><span class="ac-hint" style="margin:0">Select a criterion for its details</span></div>
      <div id="map" class="ac-map"></div><ul class="ac-key" id="mapKey"></ul>
    </div>
    <div class="ac-grid-2" style="margin-top:1rem">
      ${buildFixPlanTeaser(issues, planHref) || '<div class="ac-panel"><h3 style="margin:0">Where to start</h3><p class="muted">Nothing to fix.</p></div>'}
      <div class="ac-panel" id="sevPanel"></div>
    </div>`);

  const pagesSec = section('pages', 'Pages', 'Confirmed WCAG violations on each page. Use this to find the pages that need the most work.',
    buildPagesTable(stats, previous) + `<div style="margin-top:1rem">${buildMatrix(criteria, matrix)}</div>`);
  const fixOnce = section('fixonce', 'Fix once', 'The same component often fails on many pages. These are the distinct problems behind the issue count, ranked by how much each fix clears.', '<div id="fixonce-body"></div>');
  const criteriaSec = section('criteria', 'WCAG criteria', 'Every WCAG 2.2 A and AA success criterion, with what the scan found and what a person still has to check.', `
    <div class="ac-controls">
      <div class="ac-chips" role="group" aria-label="Filter criteria by result">
        <button type="button" class="ac-chip fbtn" data-f="all" aria-pressed="true">All</button>
        <button type="button" class="ac-chip fbtn" data-f="fail" aria-pressed="false">${icon('fail')}Failed</button>
        <button type="button" class="ac-chip fbtn" data-f="review" aria-pressed="false">${icon('review')}Partial</button>
        <button type="button" class="ac-chip fbtn" data-f="pass" aria-pressed="false">${icon('auto')}No automated failures</button>
        <button type="button" class="ac-chip fbtn" data-f="manual" aria-pressed="false">${icon('manual')}Needs a person</button>
      </div>
      <p class="ac-count" id="critCount" role="status" aria-live="polite"></p>
    </div>
    <div id="criteria-body"></div>
    <div class="ac-panel" style="margin-top:1rem" id="topCrit"></div>`);
  const checks = section('checks', 'Automated checks', 'What this tool tests itself, beyond axe-core, and what it found. A count opens the issues behind it.', '<div id="dynamic" class="ac-checks"></div>');
  const coverage = section('coverage', 'Coverage', 'How much of the site the scan saw, and how far to trust it.', `
    ${buildCodeMappingSummary(issues, meta)}
    ${buildModalCoverage(stats)}
    <details class="ac-disc" id="engineDisc"><summary>${icon('repeat')}<span>Second engine cross-check <span class="sum-sub" id="engineSum">· axe-core vs IBM Equal Access</span></span>${icon('chev', 'chev')}</summary><div class="ac-disc-body">${buildEngineComparison(stats)}</div></details>
    ${buildInventory(stats)}`);
  const historySec = section('history', 'History', 'How the confirmed count has moved across scans of the same pages.',
    buildTrend(stats, { ...meta, pages: matrix.pages }, history) + (data.lifecycle ? `<div style="margin-top:1rem">${buildLifecyclePanel(data.lifecycle)}</div>` : ''));

  const dialog = `<dialog id="issueDlg" class="ac-dlg" aria-labelledby="idlgTitle" aria-describedby="idlgSub">
      <div class="ac-dlg-head"><div><h2 id="idlgTitle"></h2><div class="muted" id="idlgSub" style="font-size:.85rem"></div></div>
        <button type="button" class="ac-dlg-x" aria-label="Close">${icon('fail')}</button></div>
      <div class="ac-dlg-body" id="idlgBody"></div>
    </dialog>`;

  const js = `<script>
  window.__A11Y__=${json};
  (function(){
    var D=window.__A11Y__,S=D.status;
    var scope='ALL',filter='all';
    function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
    function ic(n){return '<svg class="ac-ic" viewBox="0 0 16 16" aria-hidden="true" focusable="false">'+(D.icons[n]||'')+'</svg>';}
    function plural(n,w,ws){return n+' '+(n===1?w:(ws||w+'s'));}
    function sIssues(){return D.issues.filter(function(i){return scope==='ALL'||i.page===scope;});}
    // Confirmed WCAG violation: not a review item, not a best-practice finding.
    function isConf(i){return i.kind==='violation'&&i.cat!=='best-practice';}
    function st(id){return D.statusByScope[scope][id]||'na';}
    function bars(items){var max=1;items.forEach(function(i){max=Math.max(max,i[1]);});
      return '<ul class="ac-bars">'+items.map(function(i){return '<li><span class="lab" title="'+esc(i[0])+'">'+esc(i[0])+'</span><span class="trk"><span class="bar" style="width:'+(i[1]/max*100)+'%"></span><span class="val">'+i[1]+'</span></span></li>';}).join('')+'</ul>';}

    // ── Compliance map: 56 tiles by principle ──
    function renderMap(){
      var cnt={fail:0,review:0,pass:0,manual:0,na:0};
      var html=D.principles.map(function(pr){
        return '<div><h3>'+esc(pr)+'</h3><ul>'+D.criteria.filter(function(c){return c.principle===pr;}).map(function(c){
          var s=st(c.id);cnt[s]=(cnt[s]||0)+1;
          return '<li><a class="ac-tile t-'+s+'" href="#crit-'+c.id.replace(/\\./g,'-')+'" data-crit="'+c.id+'" aria-label="'+esc(c.id+' '+c.name+', level '+c.level+': '+S[s].label)+'" data-tip="'+esc(c.id+' '+c.name+' ('+c.level+') · '+S[s].label)+'">'+ic(S[s].icon)+'<span>'+c.id+'</span></a></li>';
        }).join('')+'</ul></div>';
      }).join('');
      document.getElementById('map').innerHTML=html;
      document.getElementById('mapKey').innerHTML=['fail','review','pass','manual','na'].map(function(k){return '<li><span class="ac-tile t-'+k+'">'+ic(S[k].icon)+'</span>'+S[k].label+' <b>'+cnt[k]+'</b></li>';}).join('');
      document.getElementById('mapTitle').textContent='WCAG 2.2 A and AA, by result'+(scope==='ALL'?'':' · '+scope);
    }
    // ── Severity panel ──
    function renderSeverity(){
      var all=sIssues(),conf=all.filter(isConf),imp={critical:0,serious:0,moderate:0,minor:0},uq={};
      conf.forEach(function(i){if(imp[i.impact]!=null)imp[i.impact]++;uq[i.gid]=1;});
      var rv=all.filter(function(i){return i.kind!=='violation'&&i.cat!=='best-practice';}).length,bp=all.filter(function(i){return i.cat==='best-practice';}).length;
      var nu=Object.keys(uq).length,delta='';
      if(scope==='ALL'){
        if(D.previousOtherPages)delta='<p class="ac-hint">The previous scan covered different pages, so the totals are not compared.</p>';
        else if(D.previousConfirmed!=null){var d=conf.length-D.previousConfirmed;
          delta='<p class="ac-hint">'+(d===0?'Same as the last scan.':d>0?'<b>'+d+' more</b> than the last scan.':'<b>'+(-d)+' fewer</b> than the last scan.')+'</p>';}
      }
      document.getElementById('sevPanel').innerHTML='<h3 style="margin:0;font-size:1.05rem">Confirmed violations by severity</h3>'
        +'<p class="ac-hint" style="margin:.2rem 0 .8rem">'+plural(conf.length,'violation')+(nu!==conf.length?' from '+plural(nu,'distinct problem'):'')+(scope==='ALL'?'':' on '+esc(scope))+'.</p>'
        +bars([['Critical',imp.critical],['Serious',imp.serious],['Moderate',imp.moderate],['Minor',imp.minor]])
        +'<p class="ac-hint">Also '+plural(rv,'item')+' that need review and '+plural(bp,'best-practice finding')+'. Neither counts as a WCAG failure.</p>'+delta;
    }
    // ── WCAG criteria list ──
    function renderCriteria(){
      var shown=0,html='';
      D.principles.forEach(function(pr){
        var rows='';
        D.criteria.filter(function(c){return c.principle===pr;}).forEach(function(c){
          var s=st(c.id),m=S[s];if(filter!=='all'&&filter!==s)return;shown++;
          rows+='<tr id="crit-'+c.id.replace(/\\./g,'-')+'"><th scope="row" class="num" style="text-align:left">'+c.id+'</th><td><b>'+esc(c.name)+'</b> <span class="muted">'+c.level+'</span>'
            +(c.hint?'<div class="muted" style="font-size:.84rem;margin-top:.2rem">'+esc(c.hint)+'</div>':'')
            +(c.source==='ibm'?'<div class="ac-hint" style="margin-top:.2rem">Result from the second engine (IBM Equal Access).</div>':'')
            +(c.steps&&c.steps.length?'<details class="ac-crit-steps"><summary>How to check it by hand ('+plural(c.steps.length,'step')+')</summary><ol>'+c.steps.map(function(t){return '<li>'+esc(t)+'</li>';}).join('')+'</ol></details>':'')
            +'</td><td><span class="ac-st st-'+s+'">'+ic(m.icon)+esc(m.label)+'</span></td></tr>';
        });
        if(rows)html+='<tbody><tr class="grp"><th colspan="3" scope="colgroup">'+esc(pr)+'</th></tr>'+rows+'</tbody>';
      });
      document.getElementById('criteria-body').innerHTML=html?'<div class="ac-tbl"><table><caption class="vh">WCAG criteria and their result'+(scope==='ALL'?'':' on '+esc(scope))+'</caption><thead><tr><th scope="col">SC</th><th scope="col">Criterion</th><th scope="col">Result</th></tr></thead>'+html+'</table></div>':'<div class="ac-empty">No criterion has this result.</div>';
      document.getElementById('critCount').textContent=filter==='all'?plural(D.criteria.length,'criterion','criteria'):'Showing '+shown+' of '+D.criteria.length;
    }
    function renderTopCriteria(){
      var byCrit={};sIssues().filter(isConf).forEach(function(i){(i.crits||[]).forEach(function(c){var e=byCrit[c.id]||(byCrit[c.id]={id:c.id,name:c.name,n:0});e.n++;});});
      var list=Object.keys(byCrit).map(function(k){return byCrit[k];}).sort(function(a,b){return b.n-a.n||(a.id<b.id?-1:1);}).slice(0,10);
      document.getElementById('topCrit').innerHTML='<h3 style="margin:0;font-size:1.05rem">Criteria with the most confirmed violations</h3><p class="ac-hint" style="margin:.2rem 0 .8rem">A violation tagged with two criteria counts toward both.</p>'
        +(list.length?bars(list.map(function(c){return [c.id+' '+c.name,c.n];})):'<div class="ac-empty">No confirmed violations.</div>');
    }
    // ── Automated checks ──
    function renderDynamic(){
      var iss=sIssues(),runs=D.checkRuns||{};
      function row(ids,label,crit,state,hits,sub){
        var n=hits.length,cnt='<span class="cnt'+(n&&state!=='review'?' hit':'')+'">'+(n||(state==='clean'?0:'–'))+'</span>';
        var pill={found:['st-fail','Found'],review:['st-review','Review'],clean:['st-pass','Clean'],none:['st-manual','No verdict'],off:['st-manual','Off'],notrun:['st-manual','Not run']}[state];
        var lbl=n?'<button type="button" class="lbl" data-dlg-rule="'+esc(ids.join(' '))+'" data-dlg-label="'+esc(label)+'"><span>'+esc(label)+'</span><small>'+sub+'</small></button>':'<span class="lbl">'+esc(label)+'<small>'+sub+'</small></span>';
        return '<li>'+cnt+lbl+'<span class="ac-st '+pill[0]+'">'+(crit?crit+' ':'')+pill[1]+'</span></li>';
      }
      function hitsFor(ids){return iss.filter(function(i){return ids.indexOf(i.rule)!==-1;});}
      function pagesOf(h){var pg={};h.forEach(function(i){pg[i.page]=1;});return Object.keys(pg).length;}
      function found(h){return h.every(function(i){return i.kind==='incomplete';})?'review':'found';}
      function group(iconName,name,how,body,total){return '<div class="ac-panel"><div class="ac-check-h">'+ic(iconName)+esc(name)+'<span class="n">'+plural(total,'finding')+'</span></div><p class="ac-check-how">'+how+'</p>'+body+'</div>';}
      var html='';
      D.checks.forEach(function(g){
        var groupRan=g.rows.some(function(r){return r[0].some(function(id){return runs[id];});});
        if(g.optIn&&!groupRan&&!g.rows.some(function(r){return hitsFor(r[0]).length;})){
          html+=group(g.icon,g.name,g.how,'<p class="ac-check-off">Off by default. Set <code>'+esc(g.optIn)+'</code> in a11y.config.js to test: '+g.rows.map(function(r){return esc(r[1].charAt(0).toLowerCase()+r[1].slice(1))+' ('+r[2]+')';}).join('; ')+'.</p>',0);
          return;
        }
        var total=0,body=g.rows.map(function(r){
          var h=hitsFor(r[0]),n=h.length,ran=Math.max.apply(null,r[0].map(function(id){return runs[id]||0;}));total+=n;
          if(n)return row(r[0],r[1],r[2],found(h),h,plural(pagesOf(h),'page')+' affected');
          if(ran)return row(r[0],r[1],r[2],'clean',h,'checked on '+plural(ran,'page')+', none found');
          if(groupRan&&g.passless)return row(r[0],r[1],r[2],'clean',h,'none found');
          if(groupRan)return row(r[0],r[1],r[2],'none',h,'nothing on these pages for this check to judge');
          if(g.optIn)return row(r[0],r[1],r[2],'off',h,'off by default: set <code>'+esc(g.optIn)+'</code>');
          return row(r[0],r[1],r[2],'notrun',h,'did not run in this scan');
        }).join('');
        html+=group(g.icon,g.name,g.how,'<ul class="ac-check-rows">'+body+'</ul>',total);
      });
      // Source lint: one row per ESLint rule that fired.
      var lint=iss.filter(function(i){return i.states.indexOf('lint')!==-1;}),byRule={},order=[];
      lint.forEach(function(i){if(!byRule[i.rule]){byRule[i.rule]=[];order.push(i.rule);}byRule[i.rule].push(i);});
      order.sort(function(a,b){return byRule[b].length-byRule[a].length;});
      var lintHow=D.lint?D.lint.files+' source files checked with the ESLint accessibility plugins (jsx-a11y, Vue, Angular, HTML)'+(D.lint.unparsed?' · '+D.lint.unparsed+' file(s) could not be parsed':'')+'.':'Did not run: needs REPO_PATH in a11y.config.js (and STATIC_LINT not disabled).';
      var lintBody=order.map(function(rule){
        var h=byRule[rule],c=h[0].crits&&h[0].crits[0],name=rule.replace(/^lint:/,'').split('/').pop().replace(/-/g,' ');
        return row([rule],name.charAt(0).toUpperCase()+name.slice(1),c?c.id:'',found(h),h,'<code>'+esc(rule.replace(/^lint:/,''))+'</code>');
      }).join('')||(D.lint?row([],'No lint findings','','clean',[],'all checked files are clean'):'');
      var lintPage=(D.issues.filter(function(i){return i.states.indexOf('lint')!==-1;})[0]||{}).page;
      if(scope==='ALL'||scope===lintPage)html+=group('code','Source code lint',lintHow,lintBody?'<ul class="ac-check-rows">'+lintBody+'</ul>':'',lint.length);
      document.getElementById('dynamic').innerHTML=html;
    }
    // ── Fix once: issues that share one fix ──
    // Group by rule + source line (or, without a usable source location, rule
    // + element) and rank by how much each fix clears.
    var fixGroups=[];
    function isBuildOutput(f){var p='/'+f;return ['/_next/static/','/.next/','/node_modules/','/dist/','/build/'].some(function(d){return p.indexOf(d)!==-1;});}
    function renderFixOnce(){
      var rows=window.__A11Y_ROWS__||[],iss=sIssues(),map={};fixGroups=[];
      iss.forEach(function(i){
        var r=rows[i.ix]||{},src=r.sourceFile&&!isBuildOutput(r.sourceFile)?r.sourceFile:'';
        var key=i.rule+'|'+(src||(r.selector||'')+'|'+String(r.html||'').slice(0,120));
        var g=map[key];
        if(!g){g=map[key]={rule:i.rule,src:src,sel:r.selector||'',title:i.title||r.description||i.rule,crit:(i.crits[0]||{}).id||'',impact:i.impact,list:[],pages:{}};fixGroups.push(g);}
        g.list.push(i);g.pages[i.page]=1;
      });
      // Severity weights × issues cleared, so 18 critical issues outrank 126 minor ones.
      var W={critical:10,serious:5,moderate:2,minor:1};
      fixGroups.forEach(function(g){g.weight=g.list.reduce(function(n,i){return n+(W[i.impact]||1);},0);});
      fixGroups.sort(function(a,b){return b.weight-a.weight||b.list.length-a.list.length;});
      var el=document.getElementById('fixonce-body');
      if(!iss.length){el.innerHTML='<div class="ac-empty">No issues.</div>';return;}
      var TOP=10,top=fixGroups.slice(0,TOP),cleared=top.reduce(function(n,g){return n+g.list.length;},0);
      function line(g,k){
        var np=Object.keys(g.pages).length;
        return '<tr><td class="num muted">'+(k+1)+'</td><td><button type="button" class="ac-link" data-dlg-fix="'+k+'" style="text-align:left;font-weight:700">'+esc(g.title)+'</button>'
          +'<div class="ac-issue-m" style="margin-top:.25rem"><span class="ac-sev sev-'+esc(g.impact)+'">'+esc(g.impact||'')+'</span>'+(g.crit?'<span class="ac-tag">'+g.crit+'</span>':'')+'<code>'+esc(g.rule)+'</code></div></td>'
          +'<td class="hide-sm" style="max-width:20rem;overflow-wrap:anywhere"><code>'+esc(g.src||g.sel.slice(0,90))+'</code></td>'
          +'<td class="num"><b>'+g.list.length+'</b><div class="muted" style="font-size:.78rem">'+plural(np,'page')+'</div></td></tr>';
      }
      var head='<thead><tr><th scope="col" class="num">#</th><th scope="col">Problem</th><th scope="col" class="hide-sm">Where to fix</th><th scope="col" class="num">Issues</th></tr></thead>';
      el.innerHTML='<p class="ac-hint" style="margin:0 0 .75rem"><b>'+iss.length+'</b> issues come from <b>'+fixGroups.length+'</b> distinct problems. Fixing the top '+top.length+' clears <b>'+cleared+'</b> ('+Math.round(cleared/iss.length*100)+'%). “Where to fix” is the source line when known, otherwise the element.</p>'
        +'<div class="ac-tbl"><table>'+head+'<tbody>'+top.map(line).join('')+'</tbody></table></div>'
        +(fixGroups.length>TOP?'<details class="ac-disc" style="margin-top:.75rem"><summary>All '+fixGroups.length+' problems'+ic('chev').replace('ac-ic','ac-ic chev')+'</summary><div class="ac-disc-body"><div class="ac-tbl"><table>'+head+'<tbody>'+fixGroups.slice(TOP).map(function(g,k){return line(g,k+TOP);}).join('')+'</tbody></table></div></div></details>':'');
    }
    function renderMatrix(){[].forEach.call(document.querySelectorAll('.ac-mxt tbody tr'),function(tr){tr.style.display=(scope==='ALL'||tr.getAttribute('data-page')===scope)?'':'none';});}
    function renderEngine(){
      var wrap=document.getElementById('engineWrap');if(!wrap)return;
      var ec=D.engineByScope&&D.engineByScope[scope];
      if(!ec||!ec.compared){wrap.innerHTML='<p class="muted">No comparable criteria for this view.</p>';return;}
      var AG={'agree-bad':'Both flag an issue','agree-clean':'Both pass','axe-only':'Only axe-core flags it','ibm-only':'Only the IBM engine flags it'};
      var lab=function(s){return '<span class="ac-st st-'+s+'">'+ic(S[s].icon)+esc(S[s].label)+'</span>';};
      var rows=ec.rows.map(function(r){var diff=r.agreement==='axe-only'||r.agreement==='ibm-only';
        return '<tr'+(diff?' class="ac-engine-diff"':'')+'><th scope="row">'+r.id+' <span style="font-weight:400">'+esc(r.name)+'</span> <span class="muted">'+r.level+'</span></th><td>'+lab(r.axe in S?r.axe:'na')+'</td><td>'+lab(r.ibm in S?r.ibm:'na')+'</td><td>'+(diff?'<b>'+AG[r.agreement]+'</b>':AG[r.agreement])+'</td></tr>';}).join('');
      var pct=Math.round((ec.agree+ec.bothClean)/ec.compared*100);
      document.getElementById('engineSum').textContent='· '+pct+'% agreement on '+ec.compared+' criteria';
      wrap.innerHTML='<p>Two independently built rule engines checked the same '+ec.compared+' criteria and agreed on <b>'+pct+'%</b>. Where only one flags a problem is worth a manual look; those rows are highlighted.</p>'
        +'<div class="ac-tbl"><table><thead><tr><th scope="col">Criterion</th><th scope="col">axe-core</th><th scope="col">IBM engine</th><th scope="col">Agreement</th></tr></thead><tbody>'+rows+'</tbody></table></div>';
    }
    function renderAll(){renderMap();renderSeverity();renderFixOnce();renderCriteria();renderTopCriteria();renderDynamic();renderMatrix();renderEngine();}

    // ── Issue dialog: a count opens the issues behind it ──
    var dlg=document.getElementById('issueDlg'),dlgReturn=null;
    function issueCard(m){
      var r=(window.__A11Y_ROWS__||[])[m.ix]||{};
      // In the single-file bundle the findings view holds the screenshot as a
      // data: URI; use it, since the relative path won't resolve.
      var img=document.querySelector('#view-findings [data-ix~="'+m.ix+'"] img');
      var shot=img?img.getAttribute('src'):m.shot;
      var kind=m.cat==='best-practice'?'<span class="ac-st st-manual">Best practice</span>':m.kind==='incomplete'?'<span class="ac-st st-review">Needs review</span>':'<span class="ac-st st-fail">Violation</span>';
      return '<div class="ac-inst-card" style="border:1px solid var(--line);border-radius:10px;padding:.75rem .9rem;margin-bottom:.6rem"><b>'+esc(m.title||r.description||m.rule)+'</b>'
        +'<div class="ac-issue-m" style="margin:.35rem 0">'+kind+'<span class="ac-sev sev-'+esc(m.impact)+'">'+esc(m.impact||'')+'</span><code>'+esc(m.rule)+'</code>'
        +(m.crits||[]).map(function(c){return '<span class="ac-tag">'+c.id+' '+c.level+'</span>';}).join('')
        +'<span>'+esc(m.page)+(m.states.length?' · '+esc(m.states.join(', ')):'')+'</span>'
        +(m.helpUrl?'<a href="'+esc(m.helpUrl)+'" target="_blank" rel="noopener">Rule docs</a>':'')+'</div>'
        +(shot?'<img class="ac-shot" src="'+esc(shot)+'" alt="Screenshot of the page with the failing element outlined" loading="lazy" onerror="this.remove()">':'')
        +(r.html?'<pre tabindex="0" aria-label="Element HTML">'+esc(r.html)+'</pre>':'')
        +(r.selector?'<div class="ac-inst-sel">Selector: <code>'+esc(r.selector)+'</code></div>':'')
        +(r.remediation?'<div class="ac-fix" style="margin-top:.5rem"><b>How to fix:</b> '+esc(r.remediation)+'</div>':'')
        +(r.sourceFile?'<div class="ac-loc">Likely in code: <b><code>'+esc(r.sourceFile)+'</code></b>'+(r.sourceConfidence?' <span class="muted">· '+esc(r.sourceConfidence)+' confidence</span>':'')+'</div>':'')
        +'</div>';
    }
    function openIssues(title,sub,list){
      var MAX=300,groups={},order=[],body='',shown=0;
      list.forEach(function(m){if(!groups[m.page]){groups[m.page]=[];order.push(m.page);}groups[m.page].push(m);});
      order.forEach(function(p){
        if(shown>=MAX)return;
        var g=groups[p].slice(0,MAX-shown);shown+=g.length;
        body+=(order.length>1?'<h3 style="font-size:.95rem;margin:.75rem 0 .5rem">'+esc(p)+' <span class="muted">('+groups[p].length+')</span></h3>':'')+g.map(issueCard).join('');
      });
      if(list.length>MAX)body+='<p class="muted">Showing the first '+MAX+' of '+list.length+'. All findings lists them all.</p>';
      document.getElementById('idlgTitle').textContent=title;
      document.getElementById('idlgSub').textContent=sub;
      document.getElementById('idlgBody').innerHTML=body||'<div class="ac-empty">No issues.</div>';
      dlgReturn=document.activeElement;
      if(dlg.showModal)dlg.showModal();else dlg.setAttribute('open','');
      dlg.scrollTop=0;
    }
    function closeDlg(){if(dlg.close)dlg.close();else{dlg.removeAttribute('open');dlg.dispatchEvent(new Event('close'));}}
    if(dlg){
      dlg.querySelector('.ac-dlg-x').addEventListener('click',closeDlg);
      dlg.addEventListener('click',function(e){if(e.target===dlg)closeDlg();}); // backdrop
      dlg.addEventListener('close',function(){if(dlgReturn&&dlgReturn.focus)dlgReturn.focus();});
      document.addEventListener('click',function(e){
        var b=e.target.closest&&e.target.closest('[data-dlg-rule],[data-dlg-page],[data-dlg-fix]');
        if(!b)return;
        var list,title,sub;
        if(b.hasAttribute('data-dlg-fix')){
          var g=fixGroups[+b.getAttribute('data-dlg-fix')];if(!g)return;
          list=g.list;title=g.title;
          sub=plural(list.length,'issue')+' on '+plural(Object.keys(g.pages).length,'page')+(g.src?' · fix in '+g.src:'');
        }else if(b.hasAttribute('data-dlg-rule')){
          var rules=b.getAttribute('data-dlg-rule').split(' ');
          list=sIssues().filter(function(i){return rules.indexOf(i.rule)!==-1;});
          title=b.getAttribute('data-dlg-label');
          sub=plural(list.length,'finding')+(scope==='ALL'?' across all pages':' on '+scope);
        }else{
          var pg=b.getAttribute('data-dlg-page'),stt=b.getAttribute('data-dlg-state');
          list=D.issues.filter(function(i){return i.page===pg&&i.states.indexOf(stt)!==-1;});
          title=pg+' · '+(/^initial$/i.test(stt)?'Base page':stt);
          sub=plural(list.length,'issue');
        }
        openIssues(title,sub,list);
      });
    }
    // Map tile → criteria row (clear a filter that would hide it).
    document.addEventListener('click',function(e){
      var t=e.target.closest&&e.target.closest('a[data-crit]');if(!t)return;
      if(filter!=='all'){filter='all';[].forEach.call(document.querySelectorAll('.fbtn'),function(x){x.setAttribute('aria-pressed',String(x.getAttribute('data-f')==='all'));});renderCriteria();}
    });

    // ── Pages table: filter + sort ──
    var tbl=document.getElementById('imx');
    if(tbl){
      var f=document.getElementById('imxFilter'),cnt=document.getElementById('imxCount'),more=document.getElementById('imxMore'),tb=tbl.querySelector('tbody'),trs=[].slice.call(tb.querySelectorAll('tr')),LIMIT=${PAGE_ROWS},all=!more;
      // Rows past LIMIT stay hidden until "Show all", or while a search is active.
      function paint(){var q=f.value.toLowerCase(),n=0,k=0;trs.forEach(function(tr){var hit=tr.getAttribute('data-page').indexOf(q)>=0,ok=hit&&(q||all||k<LIMIT);if(hit)k++;tr.hidden=!ok;if(ok)n++;});
        cnt.textContent=q?'Showing '+n+' of '+trs.length+' pages':(all?plural(trs.length,'page'):'The '+n+' pages with the most violations, of '+trs.length);if(more)more.hidden=!!q;}
      f.addEventListener('input',paint);
      if(more)more.addEventListener('click',function(){all=!all;more.setAttribute('aria-expanded',String(all));more.textContent=all?'Show fewer pages':'Show all '+trs.length+' pages';paint();});
      var ths=[].slice.call(tbl.querySelectorAll('thead th'));
      [].forEach.call(tbl.querySelectorAll('thead button[data-k]'),function(b){b.addEventListener('click',function(){
        var th=b.closest('th'),k=b.getAttribute('data-k'),cur=th.getAttribute('aria-sort');
        var dir=cur==='descending'?'ascending':cur==='ascending'?'descending':(k==='page'?'ascending':'descending');
        ths.forEach(function(h){h.removeAttribute('aria-sort');});th.setAttribute('aria-sort',dir);
        trs.sort(function(a,c){var x=k==='page'?a.getAttribute('data-page'):+a.getAttribute('data-'+k),y=k==='page'?c.getAttribute('data-page'):+c.getAttribute('data-'+k);return (x<y?-1:x>y?1:0)*(dir==='ascending'?1:-1);}).forEach(function(tr){tb.appendChild(tr);});
        paint();
      });});
      trs.sort(function(a,c){return +c.getAttribute('data-t')-+a.getAttribute('data-t');}).forEach(function(tr){tb.appendChild(tr);});
      paint();
    }

    var sel=document.getElementById('scopeSel');
    if(sel)sel.addEventListener('change',function(e){scope=e.target.value;renderAll();});
    [].forEach.call(document.querySelectorAll('.fbtn'),function(b){b.addEventListener('click',function(){
      [].forEach.call(document.querySelectorAll('.fbtn'),function(x){x.setAttribute('aria-pressed',String(x===b));});filter=b.getAttribute('data-f');renderCriteria();});});
    renderAll();
  })();
  </script>`;

  const mast = masthead(data, { current: 'summary', links: { summary: '#', plan: planHref, findings: reportFile }, actions: exportMenu(meta) });
  const body = `${mast}
<div class="ac-shell">${toc}
<main class="ac-main" id="main" tabindex="-1">
${overview}${pagesSec}${fixOnce}${criteriaSec}${checks}${coverage}${historySec}
</main></div>
${dialog}
${buildExportScript(data)}${SELECT_SCRIPT}${COMMANDS.script(require('./cliName')())}${js}`;
  return shell('Accessibility report · Overview', body, `<style>${VIEW_CSS}</style>`);
}

// ── All findings ──────────────────────────────────────────────────────────

/** Measured contrast pairs, from the axe / pixel-sampling summaries. */
function contrastPairs(list) {
  const seen = new Map();
  for (const i of list) {
    if (!/contrast/.test(i.rule)) continue;
    const s = i.failureSummary || '';
    const m = s.match(/contrast of ([\d.]+)[\s\S]*?foreground color: (#[0-9a-f]{6})[\s\S]*?background color: (#[0-9a-f]{6})/i)
      || s.match(/Measured ([\d.]+):1[\s\S]*?\(text (#[0-9a-f]{6}) on (#[0-9a-f]{6})\)/i);
    if (!m) continue;
    const key = `${m[2]}|${m[3]}`.toLowerCase();
    if (seen.has(key)) continue;
    const need = (s.match(/Expected contrast ratio of ([\d.]+):1/i) || s.match(/required ([\d.]+):1/i) || [])[1];
    const text = String(i.html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 24) || 'Aa';
    seen.set(key, { ratio: m[1], fg: m[2].toLowerCase(), bg: m[3].toLowerCase(), need, text });
  }
  return [...seen.values()].slice(0, 6);
}
const swatch = (p) => `<span class="ac-sw"><span class="ac-sw-s" aria-hidden="true" style="color:${p.fg};background:${p.bg}" data-s="${esc(p.text)}"></span><span class="ac-sw-m"><b>${esc(p.ratio)}:1</b>${icon('fail')}<span class="hex">${p.fg.toUpperCase()} on ${p.bg.toUpperCase()}${p.need ? ` · needs ${esc(p.need)}:1` : ''}</span></span></span>`;

function buildReport(data, opts = {}) {
  const { issues, meta, stats } = data;
  const dashFile = opts.dashFile || 'dashboard.html';
  const planHref = opts.planHref || 'fix-plan.html';
  const topicOf = (i) => i.topic || categoryOf(i.rule, i.html); // archived runs predate the field
  const kindOf = (i) => (i.category === 'best-practice' ? 'best-practice' : i.kind);

  // One card per kind of problem (rule), and inside it one entry per distinct
  // element (groupId: same rule + same markup) with every page it was found on.
  // "The same button on 67 pages" is one line, not 67 cards.
  const cardsByRule = new Map();
  issues.forEach((i, idx) => {
    const key = `${i.rule}|${kindOf(i)}`;
    if (!cardsByRule.has(key)) cardsByRule.set(key, { first: i, els: new Map(), n: 0, pages: new Set() });
    const card = cardsByRule.get(key);
    const ek = i.groupId != null ? `g${i.groupId}` : `i${idx}`;
    if (!card.els.has(ek)) card.els.set(ek, { first: i, idx: [], pages: [], states: new Set(), shot: '' });
    const el = card.els.get(ek);
    el.idx.push(idx);
    if (!el.pages.includes(i.page)) el.pages.push(i.page);
    (i.states || []).forEach((st) => el.states.add(st));
    if (!el.shot && i.screenshot) el.shot = i.screenshot;
    card.n++; card.pages.add(i.page);
  });
  const rankKind = { violation: 0, incomplete: 1, 'best-practice': 2 };
  const rankImp = { critical: 0, serious: 1, moderate: 2, minor: 3 };
  const list = [...cardsByRule.values()].sort((a, b) => (rankKind[kindOf(a.first)] - rankKind[kindOf(b.first)])
    || ((rankImp[a.first.impact] ?? 4) - (rankImp[b.first.impact] ?? 4)) || (b.n - a.n));

  const SHOW = 5;
  const pagesText = (pg) => (pg.length <= 6 ? pg.join(', ') : `${pg.slice(0, 5).join(', ')} and ${pg.length - 5} more`);
  const cards = list.map((g, n) => {
    const i = g.first;
    const isLint = i.source === 'lint';
    const pages = [...g.pages];
    const els = [...g.els.values()].sort((a, b) => b.pages.length - a.pages.length);
    const kind = kindOf(i);
    const kindTag = kind === 'best-practice' ? '<span class="ac-st st-manual">Best practice</span>'
      : kind === 'incomplete' ? '<span class="ac-st st-review">Needs review</span>' : '<span class="ac-st st-fail">Violation</span>';
    const all = els.flatMap((e) => e.idx.map((k) => issues[k]));
    // Some fixes quote the element's own values ("border #c3ccd3 … 1.63:1"):
    // when they differ, each element carries its own.
    const fixOf = (x) => String((x.customFix ? x.customFix.fix : x.failureSummary) || '').trim();
    const perElementFix = new Set(els.map((e) => fixOf(e.first))).size > 1;
    const fix = perElementFix ? '' : fixOf(i);
    const withLoc = all.find((x) => x.locations && x.locations.length);
    const locs = withLoc ? withLoc.locations.slice(0, 3).map((l) => `<div class="ac-loc"><b><code>${esc(l.file)}:${l.line}</code></b> <span class="muted">· ${esc(l.confidence)} confidence · matched ${esc(l.clue)}</span><pre tabindex="0" aria-label="Source snippet">${esc(l.snippet)}</pre></div>`).join('') : '';
    const pairs = contrastPairs(all);
    const el = (e) => {
      const f = e.first;
      const states = [...e.states].filter((st) => !/^initial$|^lint$/i.test(st));
      return `<li data-ix="${e.idx.join(' ')}" data-pages="${esc(JSON.stringify(e.pages))}" data-states="${esc(JSON.stringify([...e.states]))}">
        <div class="ac-inst-h"><b>${e.pages.length === 1 ? esc(e.pages[0]) : `${e.pages.length} pages`}</b>${states.map((st) => `<span class="ac-tag">${esc(st)}</span>`).join('')}${f.sampled ? '<span class="ac-tag">measured from pixels</span>' : ''}</div>
        ${e.pages.length > 1 ? `<div class="ac-inst-sel">${esc(pagesText(e.pages))}</div>` : ''}
        ${f.target ? `<div class="ac-inst-sel">${isLint ? 'At' : 'Selector'}: <code>${esc(f.target)}</code></div>` : ''}
        ${f.html ? `<pre tabindex="0" aria-label="Element HTML">${esc(f.html)}</pre>` : ''}
        ${perElementFix && fixOf(f) ? `<div class="ac-inst-fix"><b>Fix:</b> ${esc(fixOf(f))}</div>` : ''}
        ${e.shot ? `<img class="ac-shot" src="${esc(e.shot)}" alt="Screenshot of the page with the failing element outlined" loading="lazy">` : ''}
      </li>`;
    };
    const extra = els.length - SHOW;
    const notes = [
      i.alsoInLint ? `Also reported by the source lint at <code>${esc(i.alsoInLint)}</code>; one fix closes both.` : '',
      i.alsoFlaggedBy && i.alsoFlaggedBy.length ? `Also detected by this tool’s <code>${esc(i.alsoFlaggedBy.join(', '))}</code> check on the same element; counted once.` : '',
    ].filter(Boolean).map((t) => `<p class="ac-hint" style="margin:0">${t}</p>`).join('');
    const text = [i.customFix ? i.customFix.what : i.help, i.rule, ...pages, ...(i.criteria || []).map((c) => c.id)].join(' ').toLowerCase();
    return `<details class="ac-issue" id="fx-${n}" data-impact="${esc(i.impact)}" data-kind="${esc(kind)}" data-source="${isLint ? 'lint' : 'browser'}" data-topic="${esc(topicOf(i))}" data-pages="${esc(JSON.stringify(pages))}" data-text="${esc(text)}">
  <summary>
    <span class="ac-issue-t">${esc(i.customFix ? i.customFix.what : i.help)}</span>
    <span class="ac-issue-m">${kindTag}<span class="ac-sev sev-${esc(i.impact)}">${esc(i.impact)}</span>${(i.criteria || []).map((c) => `<span class="ac-tag">${esc(c.id)} ${esc(c.level)}</span>`).join('')}<code>${esc(i.rule)}</code><span>${esc(labelOf(topicOf(i)))}</span>${isLint ? '<span>Source lint</span>' : ''}</span>
    <span class="ac-issue-r"><span><b data-n="els">${els.length}</b> ${els.length === 1 ? 'element' : 'elements'} · <b data-n="pages">${pages.length}</b> ${pages.length === 1 ? 'page' : 'pages'}</span>${icon('chev')}</span>
  </summary>
  <div class="ac-issue-b">
    ${fix ? `<div class="ac-fix"><p class="ac-lbl">How to fix</p>${esc(fix)}</div>` : ''}
    ${i.description ? `<p style="margin:0;color:var(--ink-2)">${esc(i.description)}${i.helpUrl ? ` <a href="${esc(i.helpUrl)}" target="_blank" rel="noopener">${isLint ? 'Rule docs' : 'axe rule docs'}</a>` : ''}</p>` : ''}
    ${notes}
    ${pairs.length ? `<div><p class="ac-lbl">Measured colours</p><div class="ac-chips">${pairs.map(swatch).join('')}</div></div>` : ''}
    ${locs ? `<div><p class="ac-lbl">${isLint ? 'In code' : 'Likely in code'}</p>${locs}</div>` : (meta.repoIndexed ? '<p class="ac-hint" style="margin:0">No confident source match. Search for the element’s id or text.</p>' : '')}
    <div><p class="ac-lbl">Where it was found <span style="font-weight:400">· ${plural(els.length, 'distinct element')}, ${plural(g.n, 'finding')} in all</span></p>
      <ul class="ac-inst">${els.slice(0, SHOW).map(el).join('')}</ul>
      ${extra > 0 ? `<details class="ac-more"><summary class="ac-btn">Show ${plural(extra, 'more element')}</summary><ul class="ac-inst" style="margin-top:.5rem">${els.slice(SHOW).map(el).join('')}</ul></details>` : ''}
    </div>
  </div>
</details>`;
  }).join('');

  // Filters (rail). Counts are per distinct problem.
  const count = (pred) => list.filter((g) => pred(g.first)).length;
  const chip = (attr, val, label, n, icn) => `<button type="button" class="ac-chip" data-${attr}="${esc(val)}" aria-pressed="false">${icn ? icon(icn) : ''}${esc(label)} <b>${n}</b></button>`;
  const kinds = [['violation', 'Violations', 'fail'], ['incomplete', 'Needs review', 'review'], ['best-practice', 'Best practice', 'manual']]
    .map(([k, l, ic]) => [k, l, ic, count((i) => kindOf(i) === k)]).filter((k) => k[3]).map(([k, l, ic, n]) => chip('kind', k, l, n, ic)).join('');
  const sevs = IMPACTS.map((k) => [k, count((i) => i.impact === k)]).filter((k) => k[1]).map(([k, n]) => chip('impact', k, k[0].toUpperCase() + k.slice(1), n)).join('');
  const topics = CATEGORIES.map((c) => [c, count((i) => topicOf(i) === c.id)]).filter((x) => x[1]).map(([c, n]) => chip('topic', c.id, c.label, n)).join('');
  const hasLint = issues.some((i) => i.source === 'lint');
  const sources = hasLint ? chip('source', 'browser', 'Browser', count((i) => i.source !== 'lint')) + chip('source', 'lint', 'Source lint', count((i) => i.source === 'lint')) : '';
  const pageOpts = (data.matrix && data.matrix.pages || []).map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
  const only = (meta.only || []).length
    ? `<div class="ac-note warn">${icon('info')}<p><b>Scoped scan:</b> only ${esc(meta.only.map(labelOf).join(', '))} were checked. Other issue types are not in this report.</p></div>` : '';

  const rail = `<nav class="ac-toc ac-filters" aria-label="Filter findings"><details id="fx-fd" open><summary class="ac-btn fx-fsum">Filters</summary>
    <label class="ac-field"><span>Search</span><input id="fx-q" type="search" placeholder="Problem, rule, page or criterion" autocomplete="off"></label>
    <label class="ac-field"><span>Page</span><select id="fx-page" data-a11y-select><option value="">All pages</option>${pageOpts}</select></label>
    <div class="ac-fgroup"><p class="ac-toc-h">Kind</p><div class="ac-chips" role="group" aria-label="Kind">${kinds}</div></div>
    ${sevs ? `<div class="ac-fgroup"><p class="ac-toc-h">Severity</p><div class="ac-chips" role="group" aria-label="Severity">${sevs}</div></div>` : ''}
    ${topics ? `<div class="ac-fgroup"><p class="ac-toc-h">Type</p><div class="ac-chips" role="group" aria-label="Issue type">${topics}</div></div>` : ''}
    ${sources ? `<div class="ac-fgroup"><p class="ac-toc-h">Source</p><div class="ac-chips" role="group" aria-label="Source">${sources}</div></div>` : ''}
    <button type="button" class="ac-btn" id="fx-clear" hidden>Clear filters</button>
  </details></nav>`;

  const FX_CSS = `
.ac-filters .ac-fgroup{margin-bottom:1rem}
.fx-fsum{display:none}
.fx-fsum::-webkit-details-marker{display:none}
.ac-filters .ac-field{margin-bottom:1rem}
.ac-fx-bar{display:flex;align-items:center;gap:1rem;flex-wrap:wrap;margin:0 0 1rem}
.ac-fx-bar p{margin:0;color:var(--ink-2)}
.ac-inst-fix{font-size:.86rem;background:var(--good-tint);border-radius:8px;padding:.45rem .65rem;margin-top:.45rem}
.ac-more>summary{list-style:none;margin-top:.5rem}
.ac-more>summary::-webkit-details-marker{display:none}
.ac-more[open]>summary{display:none}
@media (max-width:1000px){.ac-filters{display:block;position:static;background:none;backdrop-filter:none;border:0;margin:0;padding:1.25rem 0 0}.ac-filters .ac-field{width:auto;margin-bottom:1rem}.ac-filters p.ac-toc-h{display:block}.fx-fsum{display:inline-flex;list-style:none;margin-bottom:1rem}}
`;

  // Findings filters. Self-contained (ids prefixed fx-) so the bundle can keep it.
  const js = `<script>(function(){
  var root=document.getElementById('fx-main');if(!root)return;
  var fd=document.getElementById('fx-fd');if(fd&&window.matchMedia&&matchMedia('(max-width:1000px)').matches)fd.open=false;
  var cards=[].slice.call(root.querySelectorAll('.ac-issue')),q=document.getElementById('fx-q'),pg=document.getElementById('fx-page'),cnt=document.getElementById('fx-count'),clr=document.getElementById('fx-clear'),empty=document.getElementById('fx-empty'),exp=document.getElementById('fx-expand');
  var chips=[].slice.call(document.querySelectorAll('.ac-filters .ac-chip'));
  var state={state:''};
  function picked(a){return chips.filter(function(c){return c.hasAttribute('data-'+a)&&c.getAttribute('aria-pressed')==='true';}).map(function(c){return c.getAttribute('data-'+a);});}
  function apply(){
    var text=(q.value||'').trim().toLowerCase(),page=pg.value,k=picked('kind'),im=picked('impact'),tp=picked('topic'),sr=picked('source'),n=0,els=0;
    cards.forEach(function(c){
      var pages=JSON.parse(c.getAttribute('data-pages')||'[]');
      var ok=(!text||c.getAttribute('data-text').indexOf(text)!==-1)&&(!page||pages.indexOf(page)!==-1)
        &&(!k.length||k.indexOf(c.getAttribute('data-kind'))!==-1)&&(!im.length||im.indexOf(c.getAttribute('data-impact'))!==-1)
        &&(!tp.length||tp.indexOf(c.getAttribute('data-topic'))!==-1)&&(!sr.length||sr.indexOf(c.getAttribute('data-source'))!==-1);
      var shown=0;
      [].forEach.call(c.querySelectorAll('[data-ix]'),function(li){var m=(!page||JSON.parse(li.getAttribute('data-pages')||'[]').indexOf(page)!==-1)&&(!state.state||JSON.parse(li.getAttribute('data-states')||'[]').indexOf(state.state)!==-1);li.hidden=!m;if(m)shown++;});
      if(state.state&&!shown)ok=false;
      c.hidden=!ok;if(ok){n++;els+=shown;}
    });
    var any=text||page||k.length||im.length||tp.length||sr.length||state.state;
    cnt.textContent=(any?'Showing ':'')+n+' '+(n===1?'kind of problem':'kinds of problem')+' · '+els+' distinct '+(els===1?'element':'elements')+(page?' on '+page:'')+(state.state?' in state “'+state.state+'”':'');
    clr.hidden=!any;empty.hidden=n>0;
  }
  chips.forEach(function(c){c.addEventListener('click',function(){c.setAttribute('aria-pressed',String(c.getAttribute('aria-pressed')!=='true'));apply();});});
  q.addEventListener('input',apply);pg.addEventListener('change',apply);
  clr.addEventListener('click',function(){q.value='';pg.value='';pg.dispatchEvent(new Event('a11y-sel-sync'));state.state='';chips.forEach(function(c){c.setAttribute('aria-pressed','false');});apply();});
  exp.addEventListener('click',function(){var open=exp.getAttribute('aria-pressed')!=='true';cards.forEach(function(c){if(!c.hidden)c.open=open;});exp.setAttribute('aria-pressed',String(open));exp.textContent=open?'Collapse all':'Expand all';});
  // Deep links: ?page=X&state=Y&type=a,b (also called by the single-file report).
  window.__acFindingsScope=function(page,st,types){
    if(page!=null){pg.value=page;pg.dispatchEvent(new Event('a11y-sel-sync'));}
    state.state=st||'';
    if(types)chips.forEach(function(c){if(c.hasAttribute('data-topic'))c.setAttribute('aria-pressed',String(types.indexOf(c.getAttribute('data-topic'))!==-1));});
    apply();
  };
  var p=new URLSearchParams(location.search);
  if(p.get('page')||p.get('state')||p.get('type'))window.__acFindingsScope(p.get('page')||'',p.get('state')||'',p.get('type')?p.get('type').split(','):null);else apply();
  addEventListener('beforeprint',function(){cards.forEach(function(c){if(!c.hidden)c.open=true;});});
})();</script>`;

  const mast = masthead(data, { current: 'findings', links: { summary: dashFile, plan: planHref, findings: '#' }, actions: '' });
  const body = `${mast}
<div class="ac-shell">${rail}
<main class="ac-main" id="fx-main" tabindex="-1">
  ${only}
  <div class="ac-fx-bar"><h2 class="vh">Findings</h2><p id="fx-count" role="status" aria-live="polite"></p><button type="button" class="ac-btn" id="fx-expand" aria-pressed="false" style="margin-left:auto">Expand all</button></div>
  ${issues.length ? cards : '<div class="ac-panel ac-empty">No violations or review items were found on the scanned pages.</div>'}
  <p class="ac-panel ac-empty" id="fx-empty" hidden>No problem matches these filters.</p>
</main></div>
${SELECT_SCRIPT}${js}`;
  return shell('Accessibility report · All findings', body, `<style>${VIEW_CSS}${FX_CSS}</style>`);
}

/** Writes the three outputs and returns the HTML, so callers (lib/bundle.js)
 *  can build the single-file bundle without re-rendering everything. */
function writeReports(outDir, data, opts = {}) {
  const prefix = opts.prefix || 'dashboard,report'; // "dashboard,report" -> dashboard.html/report.html
  const [dashName, reportName] = prefix.split(',');
  const dashboard = buildDashboard(data, { reportFile: `${reportName}.html`, planHref: opts.planHref });
  const report = buildReport(data, { dashFile: `${dashName}.html`, planHref: opts.planHref });
  fs.writeFileSync(path.join(outDir, `${dashName}.html`), dashboard);
  fs.writeFileSync(path.join(outDir, `${reportName}.html`), report);
  fs.writeFileSync(path.join(outDir, `${reportName}.json`), JSON.stringify({
    meta: data.meta, stats: data.stats, criteria: data.criteria, matrix: data.matrix, issues: data.issues,
    ...(data.verification ? { verification: data.verification } : {}),
  }, null, 2));
  return { dashboard, report, dashName, reportName };
}

module.exports = { writeReports };
