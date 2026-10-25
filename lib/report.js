/**
 * Builds three artifacts in the output folder:
 *   dashboard.html - statistics + status of all 56 criteria  (start here)
 *   report.html    - every issue, how to fix it, where it likely is in code
 *   report.json    - raw aggregated data for CI/CD
 *
 * Everything is inlined (CSS + tiny JS). No CDN, works offline.
 */
const fs = require('fs');
const path = require('path');
const { PRINCIPLES } = require('../wcag-criteria');

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Light-mode palette. `solid` fills the matrix cells; `bg` tints pills.
const STATUS = {
  fail:   { label: 'Failed',       color: '#c0392b', bg: '#fdecea', solid: '#e5484d' },
  review: { label: 'Partial',      color: '#9a6700', bg: '#fff6e5', solid: '#f2b01e' },
  // Automation covers part of a criterion, never all of it, so a clean result
  // is "no automated failures", not a conformance claim.
  pass:   { label: 'No automated failures', color: '#1b7a4b', bg: '#e7f6ee', solid: '#37b26e' },
  manual: { label: "Can't support", color: '#5b6472', bg: '#eef0f3', solid: '#c2c7cf' },
  na:     { label: 'Not applicable', color: '#6b7280', bg: '#eef0f3', solid: '#d3d7dd' },
};
const IMPACT = { critical: '#c0392b', serious: '#d35400', moderate: '#b7791f', minor: '#6b7280' };
const SEV_BORDER = { critical: '#e5484d', serious: '#f76808', moderate: '#f5a524', minor: '#5eb0ef' };

function healthColor(v) { return v >= 80 ? '#1b7a4b' : v >= 50 ? '#b7791f' : '#c0392b'; }
// Heatmap bucket (light → intense) from a 0..1 ratio.
function heat(t) {
  const scale = [
    { bg: '#fef3c7', fg: '#92400e' }, { bg: '#fde68a', fg: '#92400e' },
    { bg: '#fdba74', fg: '#7c2d12' }, { bg: '#f87171', fg: '#fff' }, { bg: '#dc2626', fg: '#fff' },
  ];
  return scale[Math.min(scale.length - 1, Math.max(0, Math.ceil(t * scale.length) - 1))];
}
function deltaBadge(cur, prev, invert) {
  if (prev == null) return '<span class="muted">—</span>';
  const d = cur - prev;
  if (d === 0) return '<span class="muted">—</span>';
  // For violations, up (more) is bad → red; down is good → green.
  const bad = invert ? d < 0 : d > 0;
  const color = bad ? '#c0392b' : '#1b7a4b';
  return `<span style="color:${color};font-weight:600">${d > 0 ? '↑' : '↓'} ${Math.abs(d)}</span>`;
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

// Severity + health summary cards (aligned to the shared artifact).
// Counts are CONFIRMED WCAG violations; review items and best-practice
// findings are shown beside them, never folded in.
function buildSeverityCards(stats, previous, pages) {
  const conf = stats.confirmed || { total: stats.totalIssues, ...stats.byImpact };
  const imp = conf;
  const total = conf.total;
  const pct = (n) => (total ? Math.round((n / total) * 100) : 0);
  const comparable = previous && samePages(previous.pages, pages);
  const prevIssues = comparable ? runConfirmed(previous) : null;
  const dTotal = previous && !comparable
    ? '<span class="muted" title="The previous scan covered different pages, so the totals are not comparable">different pages</span>'
    : deltaBadge(total, prevIssues, false);
  const uq = stats.unique && stats.unique.confirmed !== total ? stats.unique.confirmed : null;
  const extras = [
    stats.needsReview ? `${stats.needsReview} need review` : '',
    stats.bestPractice ? `${stats.bestPractice} best-practice` : '',
  ].filter(Boolean).join(' · ');
  const hc = healthColor(stats.avgHealth);
  const sevCard = (label, n, color) => `<div class="card" style="border-top:3px solid ${color}">
    <div class="l" style="margin:0 0 8px">${label}</div>
    <div class="n" style="font-size:32px">${n}</div>
    <div class="muted" style="font-size:11px;margin-top:4px">${pct(n)}% of total</div></div>`;
  return `<div class="cards" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr))">
    <div class="card"><div class="l" style="margin:0 0 8px">Average health score</div>
      <div class="n" style="font-size:32px;color:${hc}">${stats.avgHealth}</div>
      <div style="height:4px;background:#eef1f5;border-radius:2px;margin-top:10px"><div style="height:4px;width:${stats.avgHealth}%;background:${hc};border-radius:2px"></div></div></div>
    <div class="card"><div class="l" style="margin:0 0 8px">Confirmed violations</div>
      <div class="n" style="font-size:32px">${total}</div>
      ${uq != null ? `<div class="muted" style="font-size:11px">${uq} unique — the rest repeat on other pages</div>` : ''}
      <div style="font-size:12px;margin-top:4px">${dTotal} <span class="muted">vs last scan</span></div>
      <div class="muted" style="font-size:11px">${stats.pagesInScope} page(s) in scope${extras ? ` · also ${extras}` : ''}</div></div>
    ${sevCard('Critical', imp.critical, SEV_BORDER.critical)}
    ${sevCard('Serious', imp.serious, SEV_BORDER.serious)}
    ${sevCard('Moderate', imp.moderate, SEV_BORDER.moderate)}
    ${sevCard('Minor', imp.minor, SEV_BORDER.minor)}
  </div>`;
}

// Issues Matrix: Page × severity heatmap + Total + Score + Δ, sortable/filterable.
function buildIssuesMatrix(stats, previous) {
  const rows = Object.entries(stats.byPageSeverity || {});
  if (!rows.length) return '';
  const prevBPS = (previous && previous.byPageSeverity) || {};
  const cols = ['critical', 'serious', 'moderate', 'minor'];
  const max = { critical: 1, serious: 1, moderate: 1, minor: 1, total: 1 };
  rows.forEach(([, s]) => cols.concat('total').forEach((k) => { max[k] = Math.max(max[k], s[k] || 0); }));
  const cell = (k, v) => {
    if (!v) return `<td style="text-align:center;color:#c2c7cf">·</td>`;
    const h = heat((v || 0) / max[k]);
    return `<td style="text-align:center"><span style="display:inline-block;min-width:28px;padding:2px 8px;border-radius:6px;background:${h.bg};color:${h.fg};font-weight:700;font-size:12px">${v}</span></td>`;
  };
  const body = rows.map(([page, s]) => {
    const prev = prevBPS[page];
    const score = s.score;
    return `<tr data-page="${esc(page.toLowerCase())}" data-c="${s.critical}" data-s="${s.serious}" data-m="${s.moderate}" data-mi="${s.minor}" data-t="${s.total}" data-score="${score}">
      <td><b>${esc(page)}</b></td>
      ${cell('critical', s.critical)}${cell('serious', s.serious)}${cell('moderate', s.moderate)}${cell('minor', s.minor)}
      <td style="text-align:center;font-weight:700">${s.total}</td>
      <td style="text-align:center"><span class="pill" style="background:${healthColor(score)}22;color:${healthColor(score)}">${score}</span></td>
      <td style="text-align:center">${deltaBadge(s.total, prev ? prev.total : null, false)}</td>
    </tr>`;
  }).join('');
  const js = `<script>(function(){
    var tbl=document.getElementById('imx');if(!tbl)return;
    var f=document.getElementById('imxFilter');
    if(f)f.addEventListener('input',function(){var q=this.value.toLowerCase();tbl.querySelectorAll('tbody tr').forEach(function(tr){tr.style.display=tr.getAttribute('data-page').indexOf(q)>=0?'':'none';});});
    tbl.querySelectorAll('th[data-k]').forEach(function(th){th.style.cursor='pointer';th.addEventListener('click',function(){
      var k=th.getAttribute('data-k'),tb=tbl.querySelector('tbody'),rows=[].slice.call(tb.querySelectorAll('tr'));
      var asc=th.getAttribute('data-asc')==='1';th.setAttribute('data-asc',asc?'0':'1');
      rows.sort(function(a,b){var x=k==='page'?a.getAttribute('data-page'):+a.getAttribute('data-'+k);var y=k==='page'?b.getAttribute('data-page'):+b.getAttribute('data-'+k);return (x<y?-1:x>y?1:0)*(asc?1:-1);});
      rows.forEach(function(r){tb.appendChild(r);});});});
  })();</script>`;
  return `<div class="section"><div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;margin-bottom:12px">
      <h2 style="margin:0">Issues Matrix <span class="muted" style="font-weight:400">— by page &amp; severity</span></h2>
      <input id="imxFilter" placeholder="Filter pages…" style="padding:6px 10px;border:1px solid #d3d9e2;border-radius:8px;font:inherit;min-width:160px">
    </div>
    <div style="overflow-x:auto"><table id="imx">
      <thead><tr>
        <th data-k="page">Page ↕</th><th data-k="c" style="text-align:center">Critical ↕</th><th data-k="s" style="text-align:center">Serious ↕</th>
        <th data-k="m" style="text-align:center">Moderate ↕</th><th data-k="mi" style="text-align:center">Minor ↕</th>
        <th data-k="t" style="text-align:center">Total ↕</th><th data-k="score" style="text-align:center">Score ↕</th><th style="text-align:center">Δ</th>
      </tr></thead><tbody>${body}</tbody>
    </table></div>
    <div class="muted" style="font-size:11px;margin-top:8px">Counts are confirmed WCAG violations; review items and best-practice findings are not included. Health score 0–100 (higher = healthier). Cell shade = relative count. Click a header to sort. Δ compares to your previous scan of this report.</div>
  </div>${js}`;
}

// Modal & Dialog Coverage: proves the deep-reveal actually happened — every
// UI state visited per page (base + revealed modals/dropdowns/tabs), issues
// found in each, and how many issues are invisible unless you open them.
function buildModalCoverage(stats) {
  const cov = stats.stateCoverage || {};
  const pages = Object.keys(cov);
  if (!pages.length) return '';
  const revealedTotal = stats.totalStatesRevealed || 0;
  if (!revealedTotal) {
    return `<div class="section"><h2>Modal &amp; Dialog Coverage</h2>
      <div class="empty">Only the base page was scanned — no modals, dropdowns, or tabs were revealed. Add <code>actions</code> (click/show + snapshot) or turn on <code>AUTO_EXPLORE</code> in a11y.config.js to test hidden UI.</div>
    </div>`;
  }
  // Opens the issue dialog (see buildIssueDialog) listing this page/state's issues.
  const link = (pg, s, label) => `<button type="button" class="cnt-btn" data-dlg-page="${esc(pg)}" data-dlg-state="${esc(s)}">${label}</button>`;
  const rows = pages.map((pg) => {
    const { states, counts } = cov[pg];
    const items = states.map((s) => {
      const isBase = /^initial$/i.test(s);
      const n = counts[s] || 0;
      const color = n === 0 ? STATUS.pass.color : STATUS.fail.color;
      const countLabel = `<span style="color:${color};font-weight:700">${n} issue${n === 1 ? '' : 's'}</span>`;
      return `<div style="display:flex;justify-content:space-between;gap:10px;padding:5px 0;border-bottom:1px solid #edf0f4;font-size:12px">
        <span>${isBase ? '<b>Base page</b>' : '🔓 ' + esc(s)}</span>
        ${n > 0 ? link(pg, s, countLabel) : countLabel}
      </div>`;
    }).join('');
    const revealedCount = states.filter((s) => !/^initial$/i.test(s)).length;
    return `<div class="crit" style="border-left:4px solid #5eb0ef">
      <div style="font-weight:600;margin-bottom:6px">${esc(pg)} <span class="muted" style="font-weight:400">— ${revealedCount} state${revealedCount === 1 ? '' : 's'} revealed</span></div>
      ${items}
    </div>`;
  }).join('');
  const modalOnly = stats.modalOnlyIssues || 0;
  return `<div class="section"><h2>Modal &amp; Dialog Coverage <span class="muted" style="font-weight:400">— deep-reveal testing</span></h2>
    <p class="mx-hint">${revealedTotal} hidden UI state${revealedTotal === 1 ? '' : 's'} revealed (modals, dropdowns, tabs) across ${pages.length} page${pages.length === 1 ? '' : 's'}.
      ${modalOnly ? `<b style="color:${STATUS.fail.color}">${modalOnly} issue${modalOnly === 1 ? '' : 's'}</b> exist ONLY inside a revealed state — invisible to a single-shot scan of the base page.` : 'No issues were found exclusively inside a revealed state.'} Click a count to see those issues.</p>
    <div class="crit-grid">${rows}</div>
  </div>`;
}

// Historical trend: total issues (and critical count) across every scan of
// THIS report over time, so regressions/progress are visible run over run.
// Built server-side as inline SVG — no chart library, works offline.
// Defect lifecycle: age bands with the Blocker SLA, regression escapes, and
// the remediation burn-up. Derived from archived runs — see lib/lifecycle.js.
// Fix verification: the answer to "did my fixes work?" after a re-scan.
function buildVerificationPanel(v) {
  if (!v) return '';
  const c = v.counts;
  const tile = (n, label, color, sub) => `<div style="flex:1;min-width:130px;border:1px solid #e3e8ef;border-radius:10px;padding:12px 14px">
      <div style="font-size:26px;font-weight:700;color:${color}">${n}</div><div style="font-weight:600">${label}</div>
      <div class="muted" style="font-size:11px">${sub}</div></div>`;
  const rows = (list, mark, color) => list.slice(0, 200).map((i) => `<tr>
      <td style="color:${color};font-weight:700">${mark}</td><td>${esc(i.page)}</td>
      <td><code>${esc(i.rule)}</code>${i.kind === 'incomplete' ? ' <span class="muted">(review)</span>' : ''}</td>
      <td>${i.location ? `<code>${esc(i.location)}</code>` : `<code class="muted">${esc((i.target || '').slice(0, 80))}</code>`}</td>
      <td class="muted">${esc(i.reason || '')}</td></tr>`).join('');
  const body = rows(v.still, '✗', '#c0392b') + rows(v.new, '⚠', '#d35400') + rows(v.unverified, '?', '#6b7280') + rows(v.fixed, '✔', '#1b7a4b');
  return `<div class="section" id="verification"><h2>Fix verification</h2>
    <div class="muted" style="font-size:12px;margin-bottom:10px">Compared with the previous scan of each page${v.since ? ` (latest baseline ${esc(new Date(v.since).toLocaleString())})` : ''}. "Fixed" means the element was found again and no longer fails; if it could not be found (a dialog that did not open, a removed element) the issue is listed as <i>couldn't verify</i> instead.</div>
    <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:14px">
      ${tile(c.fixed, 'Fixed', '#1b7a4b', 'verified gone')}
      ${tile(c.still, 'Still failing', '#c0392b', `${c.stillConfirmed} confirmed violations`)}
      ${tile(c.new, 'New', '#d35400', `${c.newConfirmed} confirmed violations`)}
      ${tile(c.unverified, "Couldn't verify", '#6b7280', 'check by hand')}
      ${c.notRechecked ? tile(c.notRechecked, 'Not re-scanned', '#6b7280', 'pages outside this run') : ''}
    </div>
    ${body ? `<details${c.still || c.new ? ' open' : ''}><summary style="cursor:pointer;font-weight:600">Issue by issue</summary>
      <table style="margin-top:8px"><thead><tr><th></th><th>Page</th><th>Rule</th><th>Where</th><th>Note</th></tr></thead><tbody>${body}</tbody></table></details>` : ''}
  </div>`;
}

// Pages a public-only scan could not open without logging in.
function buildSkippedPages(meta) {
  const list = (meta && meta.skippedPages) || [];
  if (!list.length) return '';
  return `<div class="section"><h2>Not scanned — login required (${list.length})</h2>
    <div class="muted" style="font-size:12px;margin-bottom:8px">This run scanned public pages only. Run <code>a11y scan</code> and log in to include these.</div>
    <ul style="margin:0;padding-left:18px">${list.map((p) => `<li>${esc(p.name)} <code class="muted">${esc(p.path)}</code></li>`).join('')}</ul></div>`;
}

function buildLifecyclePanel(lc) {
  if (!lc) return '';
  if (lc.runCount < 2) {
    return `<div class="section"><h2>Defect Lifecycle</h2>
      <div class="empty">Only one scan is archived so far. Age, regressions and the burn-up chart appear once a second scan of the same pages has run.</div></div>`;
  }

  const SEV_COLOR = { Blocker: '#c0392b', Critical: '#d35400', Major: '#b7791f', Minor: '#6b7280' };

  // ── Open defects by severity and age ──
  const ageRows = lc.severityOrder.map((sev) => {
    const b = lc.openByAge[sev];
    if (!b.total) return '';
    const seg = (n, color) => (n ? `<span style="width:${(n / b.total) * 100}%;background:${color}" title="${n}"></span>` : '');
    return `<tr>
      <td><b style="color:${SEV_COLOR[sev]}">${sev}</b></td>
      <td style="text-align:center"><b>${b.total}</b></td>
      <td style="min-width:180px"><div class="bar" style="height:14px">
        ${seg(b.band0_7, '#37b26e')}${seg(b.band8_30, '#f2b01e')}${seg(b.band31plus, '#e5484d')}
      </div></td>
      <td style="text-align:center">${b.band0_7}</td>
      <td style="text-align:center">${b.band8_30}</td>
      <td style="text-align:center;${b.band31plus ? 'color:' + STATUS.fail.color + ';font-weight:700' : ''}">${b.band31plus}</td>
      <td style="text-align:center">${b.oldestDays}d</td>
    </tr>`;
  }).join('');

  const slaOk = lc.overSla === 0;
  const slaBadge = `<span class="pill" style="background:${slaOk ? STATUS.pass.bg : STATUS.fail.bg};color:${slaOk ? STATUS.pass.color : STATUS.fail.color}">
    ${lc.overSla} Blocker${lc.overSla === 1 ? '' : 's'} older than 7 days · target 0</span>`;

  // ── Regression escapes ──
  const regOk = lc.regressions.length === 0;
  const regList = lc.regressions.slice(0, 8).map((r) => `<div style="display:flex;gap:10px;padding:5px 0;border-bottom:1px solid #edf0f4;font-size:12px">
      <span class="pill" style="background:${SEV_COLOR[r.severity]}22;color:${SEV_COLOR[r.severity]};flex:none">${r.severity}</span>
      <span class="mono" style="flex:none">${esc(r.rule)}</span>
      <span class="muted" style="flex:1">${esc(r.page)}${r.location ? ' · ' + esc(r.location) : ''}</span>
    </div>`).join('');
  const newRuleNote = lc.newRuleFindings.length
    ? `<div class="muted" style="font-size:11px;margin-top:8px">Excluded: ${lc.newRuleFindings.length} finding(s) reported by checks added since the previous scan. These are pre-existing defects newly detected, not regressions.</div>`
    : '';

  // ── Burn-up chart ──
  const series = lc.burnUp;
  const W2 = 660, H2 = 190, PAD = 34;
  const maxY = Math.max(1, ...series.map((s) => s.cumulativeFound));
  const stepX = series.length > 1 ? (W2 - PAD * 2) / (series.length - 1) : 0;
  const yFor = (v) => H2 - PAD - (v / maxY) * (H2 - PAD * 2);
  const pts = (key) => series.map((s, i) => `${(PAD + i * stepX).toFixed(1)},${yFor(s[key]).toFixed(1)}`).join(' ');
  const dots = (key, color) => series.map((s, i) => {
    const x = (PAD + i * stepX).toFixed(1), y = yFor(s[key]).toFixed(1);
    return `<circle cx="${x}" cy="${y}" r="3" fill="${color}"><title>${esc(s.at)} — ${key}: ${s[key]} (${s.pages} page(s) covered)</title></circle>`;
  }).join('');
  const last = series[series.length - 1];
  const pctResolved = last.cumulativeFound ? Math.round((last.resolved / last.cumulativeFound) * 100) : 0;

  const svg = `<svg viewBox="0 0 ${W2} ${H2}" style="width:100%;height:${H2}px" role="img" aria-label="Remediation burn-up">
    <line x1="${PAD}" y1="${H2 - PAD}" x2="${W2 - PAD}" y2="${H2 - PAD}" stroke="#e2e6ec"/>
    <line x1="${PAD}" y1="${PAD - 10}" x2="${PAD}" y2="${H2 - PAD}" stroke="#e2e6ec"/>
    <polyline points="${pts('cumulativeFound')}" fill="none" stroke="#5b6472" stroke-width="2"/>
    <polyline points="${pts('open')}" fill="none" stroke="#e5484d" stroke-width="2"/>
    <polyline points="${pts('resolved')}" fill="none" stroke="#1b7a4b" stroke-width="2"/>
    ${dots('cumulativeFound', '#5b6472')}${dots('open', '#e5484d')}${dots('resolved', '#1b7a4b')}
    <text x="${PAD}" y="${PAD - 16}" font-size="10" fill="#6b7280">defects</text>
  </svg>`;

  return `<div class="section"><h2>Defect Lifecycle <span class="muted" style="font-weight:400">— age, regressions and remediation progress across ${lc.runCount} scans</span></h2>

    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px">${slaBadge}
      <span class="pill" style="background:${regOk ? STATUS.pass.bg : STATUS.fail.bg};color:${regOk ? STATUS.pass.color : STATUS.fail.color}">${lc.regressions.length} regression escape${lc.regressions.length === 1 ? '' : 's'} · target 0</span>
      <span class="pill" style="background:${STATUS.pass.bg};color:${STATUS.pass.color}">${lc.resolvedCount} apparently resolved</span>
    </div>

    <h2 style="font-size:14px;margin:0 0 10px">Open confirmed violations by severity and age</h2>
    <table><thead><tr>
      <th>Severity</th><th style="text-align:center">Open</th><th>Age spread</th>
      <th style="text-align:center">0–7d</th><th style="text-align:center">8–30d</th><th style="text-align:center">31d+</th><th style="text-align:center">Oldest</th>
    </tr></thead><tbody>${ageRows || '<tr><td colspan="7" class="empty">No open confirmed violations.</td></tr>'}</tbody></table>
    <div class="legend" style="margin-top:8px"><span><i style="background:#37b26e"></i>0–7 days</span><span><i style="background:#f2b01e"></i>8–30 days</span><span><i style="background:#e5484d"></i>31 days or older</span></div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-top:22px" class="lcgrid">
      <div>
        <h2 style="font-size:14px;margin:0 0 4px">Remediation burn-up</h2>
        <div class="muted" style="font-size:11px;margin-bottom:6px">${pctResolved}% of all violations ever found are no longer detected. Counts are coverage-aware: each page contributes its most recent scan.</div>
        ${svg}
        <div class="legend"><span><i style="background:#5b6472"></i>Total ever found</span><span><i style="background:#e5484d"></i>Still open</span><span><i style="background:#1b7a4b"></i>Resolved</span></div>
      </div>
      <div>
        <h2 style="font-size:14px;margin:0 0 4px">Regression escapes</h2>
        <div class="muted" style="font-size:11px;margin-bottom:6px">Defects that appeared on a page which was previously clean for that rule.</div>
        ${lc.regressions.length ? regList : '<div class="empty" style="padding:18px">None — no previously-clean page has regressed. 🎉</div>'}
        ${newRuleNote}
      </div>
    </div>

    <div class="muted" style="font-size:11px;margin-top:14px">“Apparently resolved” means the scanner no longer detects the defect on a re-scan of its page. That usually means fixed, but can also mean the element did not render. Independent verification remains a QA responsibility.${lc.staleCount ? ` ${lc.staleCount} defect(s) are on pages not yet re-scanned and are excluded from resolved counts.` : ''}</div>
  </div>`;
}

function buildTrend(stats, meta, history) {
  const past = (history || []).slice().reverse(); // oldest → newest
  // Trend of CONFIRMED violations. Runs recorded before that count existed
  // (or with a different page set) would draw a false slope, so the chart
  // only uses past runs of the same pages that recorded it.
  const pages = (meta && meta.pages) || null;
  const conf = stats.confirmed || { total: stats.totalIssues, critical: stats.byImpact.critical };
  const current = {
    at: meta.generatedAt,
    pages,
    stats: { issues: conf.total, critical: conf.critical },
    avgHealth: stats.avgHealth,
  };
  const usable = past.filter((r) => runConfirmed(r) != null && (!pages || samePages(r.pages, pages)))
    .map((r) => ({ ...r, stats: { issues: runConfirmed(r), critical: r.stats.confirmedCritical != null ? r.stats.confirmedCritical : r.stats.critical } }));
  const skippedRuns = past.length - usable.length;
  const seq = usable.concat([current]);
  if (seq.length < 2) {
    return `<div class="section"><h2>Trend</h2>
      <div class="empty">${skippedRuns ? `No earlier scan of exactly these pages to compare with (${skippedRuns} earlier scan(s) covered different pages or predate confirmed counts).` : 'This is the first recorded scan of this report.'} Scan again later to see confirmed violations trend over time.</div>
    </div>`;
  }
  const W = 680, H = 170, PAD = 28;
  const maxIssues = Math.max(1, ...seq.map((r) => r.stats.issues));
  const stepX = (W - PAD * 2) / (seq.length - 1);
  const yFor = (v) => H - PAD - (v / maxIssues) * (H - PAD * 2);
  const pt = (i, v) => `${(PAD + i * stepX).toFixed(1)},${yFor(v).toFixed(1)}`;
  const totalPts = seq.map((r, i) => pt(i, r.stats.issues)).join(' ');
  const critPts = seq.map((r, i) => pt(i, r.stats.critical)).join(' ');
  const dots = (color, key) => seq.map((r, i) => {
    const [x, y] = pt(i, r.stats[key]).split(',');
    return `<circle cx="${x}" cy="${y}" r="3.5" fill="${color}"><title>${esc(r.at)} — ${key}: ${r.stats[key]}</title></circle>`;
  }).join('');
  const first = seq[0], last = seq[seq.length - 1];
  const trendDelta = deltaBadge(last.stats.issues, first.stats.issues, false);
  const svg = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:${H}px" role="img" aria-label="Issue trend over time">
    <line x1="${PAD}" y1="${H - PAD}" x2="${W - PAD}" y2="${H - PAD}" stroke="#e2e6ec"/>
    <polyline points="${totalPts}" fill="none" stroke="#5eb0ef" stroke-width="2"/>
    <polyline points="${critPts}" fill="none" stroke="#c0392b" stroke-width="2" stroke-dasharray="4,3"/>
    ${dots('#5eb0ef', 'issues')}${dots('#c0392b', 'critical')}
  </svg>`;
  const rows = seq.slice().reverse().slice(0, 8).map((r) => `<tr>
    <td>${esc(r.at)}</td><td style="text-align:center">${r.stats.issues}</td>
    <td style="text-align:center;color:${STATUS.fail.color}">${r.stats.critical}</td>
    <td style="text-align:center">${r.avgHealth == null ? '<span class="muted">—</span>' : `<span class="pill" style="background:${healthColor(r.avgHealth)}22;color:${healthColor(r.avgHealth)}">${r.avgHealth}</span>`}</td>
  </tr>`).join('');
  return `<div class="section"><h2>Trend <span class="muted" style="font-weight:400">— ${seq.length} scans of the same pages${skippedRuns ? ` (${skippedRuns} scan(s) of other pages left out)` : ''}</span></h2>
    <div class="legend" style="margin-bottom:6px"><span><i style="background:#5eb0ef"></i>Confirmed violations</span><span><i style="background:#c0392b"></i>Critical</span>
      <span>Since first scan: ${trendDelta}</span></div>
    ${svg}
    <table style="margin-top:10px"><thead><tr><th>When</th><th style="text-align:center">Total</th><th style="text-align:center">Critical</th><th style="text-align:center">Health</th></tr></thead>
    <tbody>${rows}</tbody></table>
  </div>`;
}

// Code-to-source mapping summary: makes the file:line mapping visible on the
// dashboard itself (previously only shown per-issue in report.html).
function buildCodeMappingSummary(issues, meta) {
  if (!meta.repoIndexed) {
    return `<div class="section" style="padding:16px 22px"><span class="muted">Code mapping is off — set <code>REPO_PATH</code> in a11y.config.js to map issues to source file:line.</span></div>`;
  }
  const withLoc = issues.filter((i) => i.locations && i.locations.length);
  const files = new Set(withLoc.flatMap((i) => i.locations.map((l) => l.file)));
  const high = withLoc.filter((i) => ['exact', 'high'].includes(i.locations[0].confidence)).length;
  return `<div class="section" style="display:flex;gap:28px;align-items:center;flex-wrap:wrap;padding:16px 22px">
    <div><b>${meta.repoIndexed}</b> <span class="muted">source files indexed</span></div>
    <div><b>${withLoc.length}</b><span class="muted">/${issues.length} issues mapped to source</span></div>
    <div><b>${files.size}</b> <span class="muted">unique file(s) touched</span></div>
    <div><b style="color:${STATUS.pass.color}">${high}</b> <span class="muted">high-confidence match(es)</span></div>
  </div>`;
}

// "Detected on page" + "Content elements crawled" — a raw DOM census,
// independent of pass/fail (mirrors EqualWeb's inventory panels).
function buildInventory(stats) {
  const inv = stats.inventory;
  if (!inv) return '';
  const tile = (n, label, warn) => `<div class="card" style="padding:14px 16px">
    <div class="n" style="font-size:24px${warn && n > 0 ? `;color:${STATUS.fail.color}` : ''}">${n}</div>
    <div class="l" style="margin-top:2px">${label}</div>
  </div>`;
  const detected = [
    tile(inv.detected.roleAttributes, 'Role attributes'),
    tile(inv.detected.ariaAttributes, 'ARIA attributes'),
    tile(inv.detected.accessKeys, 'Access keys'),
    tile(inv.detected.headings, 'Headings'),
    tile(inv.detected.fieldsWithoutLabel, 'Fields w/o label', true),
    tile(inv.detected.altlessImages, 'Altless images', true),
  ].join('');
  const crawled = [
    tile(inv.crawled.iframes, 'Iframes'),
    tile(inv.crawled.images, 'Images'),
    tile(inv.crawled.pdfs, 'PDFs'),
    tile(inv.crawled.links, 'Links'),
    tile(inv.crawled.audio, 'Audio'),
    tile(inv.crawled.video, 'Video'),
  ].join('');
  return `<div class="section"><h2>Detected on page <span class="muted" style="font-weight:400">— raw inventory, not pass/fail</span></h2>
    <div class="cards" style="grid-template-columns:repeat(6,1fr);margin-bottom:18px">${detected}</div>
    <h2 style="font-size:14px;margin:0 0 12px">Content elements crawled</h2>
    <div class="cards" style="grid-template-columns:repeat(6,1fr)">${crawled}</div>
    <div class="muted" style="font-size:11px;margin-top:10px">Cumulative across ${Object.keys(inv.byPage).length} page(s) scanned. Red counts (fields without a label, images without alt) are worth checking even if axe didn't flag every instance as a violation.</div>
  </div>`;
}

// Engine Agreement: axe-core (this tool's engine) vs IBM's independently-built
// open-source "Equal Access" engine — a real accuracy cross-check, not just
// re-validating our own axe wiring. Agreement = high confidence; disagreement
// is exactly where a manual look is worth it.
function buildEngineComparison(stats) {
  const ec = stats.engineComparison;
  if (!ec) return `<div class="section" style="padding:16px 22px"><span class="muted">Second-engine comparison is off or found nothing to compare — set <code>SECOND_ENGINE: true</code> in a11y.config.js (uses IBM's open-source accessibility-checker-engine).</span></div>`;
  const AG = {
    'agree-bad': { label: 'Both flag an issue', color: STATUS.fail.color, bg: STATUS.fail.bg },
    'agree-clean': { label: 'Both pass', color: STATUS.pass.color, bg: STATUS.pass.bg },
    'axe-only': { label: 'Only axe-core flags it', color: '#7c3aed', bg: '#f3e8ff' },
    'ibm-only': { label: 'Only IBM engine flags it', color: '#0f7a9c', bg: '#e6f6fb' },
  };
  const rows = ec.rows.map((r) => {
    const ag = AG[r.agreement];
    const st = (v) => STATUS[v] || STATUS.na;
    return `<tr style="background:${r.agreement === 'axe-only' || r.agreement === 'ibm-only' ? ag.bg : 'transparent'}">
      <td><b>${r.id}</b> ${esc(r.name)} <span class="lvl">${r.level}</span></td>
      <td style="text-align:center"><span class="pill" style="background:${st(r.axe).bg};color:${st(r.axe).color}">${st(r.axe).label}</span></td>
      <td style="text-align:center"><span class="pill" style="background:${st(r.ibm).bg};color:${st(r.ibm).color}">${st(r.ibm).label}</span></td>
      <td style="text-align:center"><span class="pill" style="background:${ag.bg};color:${ag.color}">${ag.label}</span></td>
    </tr>`;
  }).join('');
  const pct = ec.compared ? Math.round(((ec.agree + ec.bothClean) / ec.compared) * 100) : 0;
  return `<div class="section">
    <h2>Engine Agreement <span class="muted" style="font-weight:400">— axe-core vs IBM Equal Access (open-source)</span></h2>
    <p class="mx-hint">Two independently-built rule engines checked the same ${ec.compared} criteria. <b>${pct}% agreement</b> (${ec.agree} both-flag + ${ec.bothClean} both-clean). Disagreements are where one engine caught something the other missed — worth a manual look.</p>
    <div class="legend" style="margin-bottom:14px">
      <span><i style="background:${AG['agree-bad'].color}"></i>Both flag — ${ec.agree}</span>
      <span><i style="background:${AG['agree-clean'].color}"></i>Both pass — ${ec.bothClean}</span>
      <span><i style="background:${AG['axe-only'].color}"></i>axe-core only — ${ec.axeOnly}</span>
      <span><i style="background:${AG['ibm-only'].color}"></i>IBM only — ${ec.ibmOnly}</span>
    </div>
    <div style="overflow-x:auto"><table>
      <thead><tr><th>Criterion</th><th style="text-align:center">axe-core</th><th style="text-align:center">IBM engine</th><th style="text-align:center">Agreement</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </div>`;
}

const BASE_CSS = `
:root{color-scheme:light}
*{box-sizing:border-box}
body{margin:0;background:#f4f6f9;color:#1f2733;font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
a{color:#1a6dd4;text-decoration:none}a:hover{text-decoration:underline}
.wrap{max-width:1180px;margin:0 auto;padding:32px 24px 80px}
header.top{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap;border-bottom:1px solid #e2e6ec;padding-bottom:20px;margin-bottom:28px}
h1{font-size:24px;margin:0 0 4px;color:#111827}
.sub{color:#6b7280;font-size:13px}
.nav a,.nav button{display:inline-block;margin-left:16px;font-size:13px;padding:6px 12px;border:1px solid #d3d9e2;border-radius:8px;color:#374151;background:#fff;font-family:inherit;cursor:pointer}
.nav button:hover{background:#f4f6f9}
.nav button.primary{background:#111827;border-color:#111827;color:#fff}
.nav button.primary:hover{background:#1f2937}
/* ── Print / PDF ───────────────────────────────────────────────────────────
   Three things break the matrix in print if left alone:
   1. Browsers DROP background colours when printing. The matrix encodes every
      status as a cell background, so without print-color-adjust each cell
      prints white and the whole grid becomes meaningless — as do the legend
      swatches, which render as empty outlines.
   2. .matrix-wrap is an overflow-x scroll container. Print clips it to the
      on-screen portion, so only the first ~18 of 56 criteria appear.
   3. Sticky page-name cells mispaint once the scroll container is unwrapped.
   Shrinking the cells to 14px fits 56 columns + the page label inside A4
   landscape (~1047px printable at 96dpi). */
@media print{
  @page{size:A4 landscape;margin:10mm}
  *{-webkit-print-color-adjust:exact !important;print-color-adjust:exact !important}
  .nav,.mx-tip,.screen-only{display:none !important}
  body{background:#fff}
  .card,table,.section{box-shadow:none !important}
  .section{border:1px solid #dde2e9;break-inside:avoid}
  /* Unpin the sticky filter bar — it would reprint on every page. */
  .section[style*="sticky"]{position:static !important}
  .matrix-wrap{overflow:visible !important;border:none}
  table.matrix{font-size:8px;table-layout:fixed}
  table.matrix td.pg,table.matrix th.corner{position:static !important}
  /* The HEADER cells carry width:26px and drive the column width, so shrinking
     only the body cells leaves the table 1484px wide and still clipped. Both
     have to come down: 56 x 14px + 110px label = ~894px, inside A4 landscape. */
  table.matrix thead th{height:56px}
  table.matrix thead th.mxh{width:14px !important;min-width:14px !important}
  table.matrix thead th .rot{font-size:8px;bottom:6px}
  table.matrix td.cell{width:14px !important;min-width:14px !important;height:14px}
  table.matrix td.cell span{height:14px}
  table.matrix td.pg,table.matrix th.corner{min-width:0;width:110px;font-size:9px;padding:3px 6px}
  thead{display:table-header-group}   /* repeat the criteria header per page */
  tr{break-inside:avoid}
}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:14px;margin-bottom:28px}
.card{background:#fff;border:1px solid #e2e6ec;border-radius:12px;padding:18px;box-shadow:0 1px 2px rgba(16,24,40,.04)}
.card .n{font-size:30px;font-weight:700;line-height:1}
.card .l{font-size:12px;color:#6b7280;margin-top:6px;text-transform:uppercase;letter-spacing:.04em}
.section{background:#fff;border:1px solid #e2e6ec;border-radius:12px;padding:22px;margin-bottom:22px;box-shadow:0 1px 2px rgba(16,24,40,.04)}
.section h2{font-size:16px;margin:0 0 16px;color:#111827}
.bar{height:26px;border-radius:6px;display:flex;overflow:hidden;background:#eef1f5;border:1px solid #e2e6ec}
.bar > span{display:block;height:100%}
.legend{display:flex;gap:18px;flex-wrap:wrap;margin-top:12px;font-size:12px;color:#4b5563}
.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px;vertical-align:middle;border:1px solid rgba(0,0,0,.08)}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:9px 10px;border-bottom:1px solid #edf0f4;vertical-align:top}
th{color:#6b7280;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.04em}
.pill{display:inline-block;padding:2px 9px;border-radius:999px;font-size:11px;font-weight:600}
.lvl{font-size:11px;color:#6b7280;border:1px solid #d3d9e2;border-radius:4px;padding:1px 6px}
.hbar{display:flex;align-items:center;gap:10px;margin:6px 0}
.hbar .track{flex:1;height:16px;background:#eef1f5;border-radius:4px;border:1px solid #e2e6ec;overflow:hidden}
.hbar .fill{height:100%}
.hbar .lab{width:220px;font-size:12px;color:#374151;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hbar .val{width:34px;text-align:right;color:#6b7280;font-size:12px}
code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}
.crit-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:10px}
.crit{border:1px solid #e2e6ec;border-radius:9px;padding:11px 13px;background:#fbfcfd}
.crit .id{font-weight:700;margin-right:6px}
.crit .hint{color:#6b7280;font-size:12px;margin-top:6px}
.crit .src{color:#8a6d3b;background:#fcf8e3;border-radius:3px;display:inline-block;padding:1px 6px;font-size:11px;margin-top:6px}
.crit .fixsteps{margin-top:8px;font-size:12px}
.crit .fixsteps summary{cursor:pointer;color:#1a5490;font-weight:600;user-select:none}
.crit .fixsteps ol{margin:8px 0 0 18px;padding:0;color:#374151;line-height:1.55}
.crit .fixsteps li{margin-bottom:5px}
.filters{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px}
.filters button{background:#fff;border:1px solid #d3d9e2;color:#374151;border-radius:8px;padding:6px 12px;font-size:12px;cursor:pointer}
.filters button.active{background:#1a6dd4;border-color:#1a6dd4;color:#fff}
.issue{border:1px solid #e2e6ec;border-left-width:4px;border-radius:9px;padding:16px;margin-bottom:14px;background:#fff}
.issue h3{margin:0 0 6px;font-size:15px;color:#111827}
.issue .meta{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px;font-size:12px;color:#6b7280}
.issue pre{background:#f7f9fb;border:1px solid #e5e9ef;border-radius:6px;padding:10px;overflow:auto;margin:8px 0;font-size:12px;color:#334155}
.fix{background:#eaf7f0;border:1px solid #bfe6d0;border-radius:6px;padding:10px 12px;margin-top:8px;color:#15603c}
.fix b{color:#0f7a44}
.loc{background:#eef4fb;border:1px solid #cddffb;border-radius:6px;padding:8px 10px;margin-top:8px;font-size:12px}
.loc .conf{font-size:10px;text-transform:uppercase;letter-spacing:.05em;padding:1px 6px;border-radius:4px;margin-left:6px}
.muted{color:#6b7280}
.empty{color:#6b7280;text-align:center;padding:30px}
footer{color:#9aa2ae;font-size:12px;text-align:center;margin-top:40px}
/* Page × criteria matrix */
.matrix-wrap{overflow-x:auto;border:1px solid #e2e6ec;border-radius:8px}
table.matrix{border-collapse:separate;border-spacing:0;font-size:11px}
table.matrix th,table.matrix td{border-right:1px solid #eef1f5;border-bottom:1px solid #eef1f5;padding:0;text-align:center}
table.matrix thead th{height:78px;width:26px;vertical-align:bottom;position:relative;background:#fbfcfd}
table.matrix thead th .rot{position:absolute;bottom:8px;left:50%;transform:translateX(-50%) rotate(-90deg);transform-origin:center;white-space:nowrap;font-size:10px;font-weight:600;color:#4b5563;letter-spacing:0}
table.matrix thead th.corner{width:150px}
table.matrix td.pg,table.matrix th.corner{position:sticky;left:0;z-index:2;background:#fff;text-align:left;padding:6px 12px;font-size:12px;font-weight:600;color:#111827;white-space:nowrap;min-width:140px;border-right:1px solid #e2e6ec}
table.matrix thead th.corner{background:#fbfcfd;vertical-align:middle;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#6b7280}
table.matrix td.cell{width:26px;min-width:24px;height:28px;cursor:pointer}
table.matrix td.cell span{display:block;width:100%;height:28px}
table.matrix thead th.mxh{min-width:24px;cursor:pointer}
table.matrix td.cell:hover{outline:2px solid #111827;outline-offset:-2px;position:relative;z-index:1}
table.matrix thead th.mxh:hover,table.matrix tr.mx-hl td.pg{background:#eaf0fb}
/* custom matrix tooltip */
.mx-tip{position:fixed;z-index:50;pointer-events:none;display:none;background:#111827;color:#fff;font-size:12px;line-height:1.45;padding:8px 11px;border-radius:8px;box-shadow:0 6px 20px rgba(16,24,40,.22);max-width:280px}
.mx-tip .p{color:#cbd5e1;font-size:11px;margin-bottom:2px}
.mx-tip .c{font-weight:600}
.mx-tip .s{font-weight:700;margin-top:3px}
.mx-hint{font-size:12px;color:#6b7280;margin:0 0 10px}
/* Clickable counts and the issue dialog they open */
.cnt-btn{font:inherit;color:inherit;background:none;border:0;padding:2px 6px;margin:-2px -6px;border-radius:6px;cursor:pointer}
.cnt-btn:hover{background:#eef3fb}
.cnt-btn:focus-visible,.idlg-x:focus-visible{outline:2px solid #1a6dd4;outline-offset:2px}
.dyn-btn{flex:1;display:flex;align-items:center;gap:10px;margin:0;padding:2px 6px}
button.dyn-btn:hover span[style*="flex:1"]{text-decoration:underline}
.dyngrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(400px,1fr));gap:22px 26px}
@media (max-width:520px){.dyngrid{grid-template-columns:1fr}}
.idlg{width:min(920px,calc(100vw - 32px));max-height:calc(100vh - 48px);padding:0;border:1px solid #e2e6ec;border-radius:12px;box-shadow:0 20px 50px rgba(16,24,40,.25);overflow:auto;color:#1f2733}
.idlg::backdrop{background:rgba(17,24,39,.45)}
.idlg-head{position:sticky;top:0;z-index:1;background:#fff;display:flex;justify-content:space-between;align-items:flex-start;gap:12px;padding:16px 20px;border-bottom:1px solid #e2e6ec}
.idlg-head h2{margin:0 0 2px;font-size:16px;color:#111827}
.idlg-x{flex:none;width:32px;height:32px;border:1px solid #d3d9e2;border-radius:8px;background:#fff;font-size:20px;line-height:1;cursor:pointer;color:#374151}
.idlg-x:hover{background:#f4f6f9}
.idlg-body{padding:16px 20px 6px}
.idlg-pg{font-size:13px;margin:6px 0 10px;color:#111827}
@media print{.idlg{display:none !important}}
.prin-band td{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#6b7280;background:#f4f6f9;text-align:left;padding:4px 8px}
`;

function statBar(stats) {
  const order = ['fail', 'review', 'pass', 'manual', 'na'];
  const total = stats.totalCriteria || 1;
  const segs = order.map((k) => {
    const v = stats[k] || 0;
    const pct = (v / total) * 100;
    return v ? `<span style="width:${pct}%;background:${STATUS[k].color}" title="${STATUS[k].label}: ${v}"></span>` : '';
  }).join('');
  const legend = order.map((k) =>
    `<span><i style="background:${STATUS[k].color}"></i>${STATUS[k].label} — <b>${stats[k] || 0}</b></span>`
  ).join('');
  return `<div class="bar">${segs}</div><div class="legend">${legend}</div>`;
}

function hBars(items, labelKey, valKey, color) {
  const max = Math.max(1, ...items.map((i) => i[valKey]));
  return items.map((i) => `
    <div class="hbar">
      <div class="lab" title="${esc(i[labelKey])}">${esc(i[labelKey])}</div>
      <div class="track"><div class="fill" style="width:${(i[valKey] / max) * 100}%;background:${color}"></div></div>
      <div class="val">${i[valKey]}</div>
    </div>`).join('');
}

// Page (rows) × all 56 WCAG criteria (columns) colored matrix.
function buildMatrix(criteria, matrix) {
  if (!matrix || !matrix.pages || !matrix.pages.length) return '';
  const cols = criteria;
  const headCells = cols.map((c) =>
    `<th class="mxh" data-c="${esc(c.id)}" data-n="${esc(c.name + ' (' + c.level + ')')}"><span class="rot">${esc(c.id)}</span></th>`
  ).join('');
  const rows = matrix.pages.map((pg) => {
    const cells = cols.map((c) => {
      const st = (matrix.cells[pg] && matrix.cells[pg][c.id]) || 'na';
      const s = STATUS[st];
      return `<td class="cell" data-p="${esc(pg)}" data-c="${esc(c.id)}" data-n="${esc(c.name + ' (' + c.level + ')')}" data-s="${esc(s.label)}" data-color="${s.solid}"><span style="background:${s.solid}"></span></td>`;
    }).join('');
    return `<tr data-page="${esc(pg)}"><td class="pg">${esc(pg)}</td>${cells}</tr>`;
  }).join('');
  const legend = [
    ['pass', 'No automated failures'], ['fail', 'Failed'], ['review', 'Partial'], ['na', "Can't support / N/A"],
  ].map(([k, lbl]) => `<span><i style="background:${STATUS[k].solid}"></i>${lbl}</span>`).join('');
  const js = `<script>(function(){
    var tbl=document.querySelector('table.matrix');if(!tbl)return;
    var tip=document.createElement('div');tip.className='mx-tip';document.body.appendChild(tip);
    var lastRow=null;
    function place(x,y){var w=tip.offsetWidth,h=tip.offsetHeight,nx=x+16,ny=y+16;
      if(nx+w>window.innerWidth-8)nx=x-w-16;if(ny+h>window.innerHeight-8)ny=y-h-16;
      tip.style.left=nx+'px';tip.style.top=ny+'px';}
    function hlRow(tr){if(lastRow&&lastRow!==tr)lastRow.classList.remove('mx-hl');if(tr)tr.classList.add('mx-hl');lastRow=tr;}
    tbl.addEventListener('mousemove',function(e){
      var td=e.target.closest('td.cell');
      if(td){hlRow(td.parentNode);
        tip.innerHTML='<div class="p">'+td.dataset.p+'</div><div class="c">'+td.dataset.c+' '+td.dataset.n+'</div><div class="s" style="color:'+td.dataset.color+'">'+td.dataset.s+'</div>';
        tip.style.display='block';place(e.clientX,e.clientY);return;}
      var th=e.target.closest('thead th.mxh');
      if(th){hlRow(null);tip.innerHTML='<div class="c">'+th.dataset.c+' '+th.dataset.n+'</div>';tip.style.display='block';place(e.clientX,e.clientY);return;}
      tip.style.display='none';hlRow(null);
    });
    tbl.addEventListener('mouseleave',function(){tip.style.display='none';hlRow(null);});
  })();</script>`;
  return `<div class="section"><h2>Page × WCAG criteria matrix</h2>
    <div class="legend" style="margin:0 0 10px">${legend}</div>
    <p class="mx-hint screen-only">Hover any cell to see the page, criterion and status; hover a column header for the criterion name. Scroll right for all 56 criteria.</p>
    <div class="matrix-wrap"><table class="matrix">
      <thead><tr><th class="corner">Page</th>${headCells}</tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <div class="muted" style="font-size:11px;margin-top:8px">All 56 WCAG 2.2 A+AA criteria, in order (Perceivable → Operable → Understandable → Robust).</div>
  </div>${js}`;
}

// Statistics for the dynamic (non-axe) checks: keyboard walk + screen-reader.
// Every check this tool runs itself, beyond axe-core, grouped for the
// "Automated checks" panel. Each row: [rule ids, what it finds, criterion].
// passless: the group's checks report failures only, so a group that ran and
//   found nothing on a row is clean (otherwise a row with no result of its own
//   had nothing to judge, e.g. no navigation repeated across pages).
// optIn: the config switch the group needs; without it the group never runs.
const CHECK_GROUPS = [
  { icon: '⌨️', name: 'Keyboard walk', how: 'Real Tab-through of each page: focus order, traps, focus visibility.', rows: [
    [['kbd-focus-visible'], 'Elements with no visible focus indicator', '2.4.7'],
    [['kbd-keyboard-trap'], 'Possible keyboard traps', '2.1.2'],
    [['kbd-positive-tabindex'], 'Positive tabindex (breaks focus order)', '2.4.3'],
    [['kbd-click-not-focusable', 'kbd-click-not-focusable-review'], 'Clickable elements you cannot reach with Tab', '2.1.1'],
    [['kbd-role-not-focusable'], 'Widgets (role="button" etc.) that are not focusable', '2.1.1'],
  ] },
  { icon: '🔊', name: 'Screen reader', passless: true, how: 'Accessibility-tree analysis: accessible names and ARIA references.', rows: [
    [['sr-broken-aria-ref'], 'Broken ARIA name/description references', '4.1.2'],
    [['sr-broken-aria-relationship'], 'ARIA relationship pointing at an element not in the page', '4.1.2'],
    [['sr-unnamed-control'], 'Controls a screen reader announces blank', '4.1.2'],
    [['sr-duplicate-name'], 'Controls sharing an identical name', '4.1.2'],
  ] },
  { icon: '🔍', name: 'Zoom & reflow', how: 'Re-renders each page at 320px wide, 200% text, wider text spacing and both orientations.', rows: [
    [['vp-reflow'], 'Horizontal scrolling at 320px wide (reflow)', '1.4.10'],
    [['vp-resize-text'], 'Text clipped or overlapping at 200% text size', '1.4.4'],
    [['vp-text-spacing'], 'Content breaks with wider text spacing', '1.4.12'],
    [['vp-orientation'], 'Locked to one screen orientation', '1.3.4'],
  ] },
  { icon: '🎨', name: 'Contrast beyond axe', how: 'Control boundaries against their surroundings, and text contrast axe could not decide, measured from the rendered pixels.', rows: [
    [['uic-component-boundary'], 'Control boundaries under 3:1 contrast', '1.4.11'],
    [['contrast-sampled'], 'Low text contrast found by pixel sampling', '1.4.3'],
  ] },
  { icon: '🏷️', name: 'Headings & labels', passless: true, how: 'Heading structure, and whether headings and labels describe what they are for.', rows: [
    [['hl-h1-count'], 'Pages without exactly one h1', '2.4.6'],
    [['hl-heading-empty'], 'Empty headings', '2.4.6'],
    [['hl-heading-duplicate'], 'Repeated heading text', '2.4.6'],
    [['hl-heading-placeholder'], 'Placeholder headings', '2.4.6'],
    [['hl-label-duplicate'], 'Different fields with the same label', '2.4.6'],
    [['hl-label-generic'], 'Generic labels ("Click here", "More")', '2.4.6'],
  ] },
  { icon: '🔁', name: 'Consistency across pages', how: 'Compares navigation, link labels and help links between the scanned pages.', rows: [
    [['con-multiple-ways'], 'No second way to find pages (search, sitemap…)', '2.4.5'],
    [['con-nav-order'], 'Navigation order differs between pages', '3.2.3'],
    [['con-identification'], 'Same link labelled differently on different pages', '3.2.4'],
    [['con-help-missing'], 'Help link missing or moved on some pages', '3.2.6'],
  ] },
  { icon: '📝', name: 'Forms', how: 'Questions asked twice in one flow, and confirm/review/undo on forms listed in CONSEQUENTIAL_FLOWS.', rows: [
    [['ff-redundant-entry'], 'Same information asked twice', '3.3.7'],
    [['ff-no-error-prevention'], 'Consequential form without confirm, review or undo', '3.3.4'],
  ] },
  { icon: '🖱️', name: 'Interaction', optIn: 'LIVE_REGION_CHECKS: true', how: 'Submits forms and presses controls, with network writes blocked, to see what happens.', rows: [
    [['lr-status-not-announced'], 'Status messages a screen reader does not announce', '4.1.3'],
    [['lr-error-not-associated'], 'Error messages not tied to their field', '3.3.1'],
    [['lr-error-no-suggestion'], 'Errors that do not say how to fix the input', '3.3.3'],
    [['cc-focus-context-change'], 'Focusing a control changes context', '3.2.1'],
    [['cc-input-context-change'], 'Changing a value changes context', '3.2.2'],
    [['cc-hover-not-dismissable', 'cc-hover-not-persistent'], 'Hover/focus pop-ups that cannot be dismissed or vanish', '1.4.13'],
    [['pc-down-event-action'], 'Actions that fire on pointer down', '2.5.2'],
  ] },
];

function shell(title, nav, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${BASE_CSS}</style></head><body><div class="wrap">
<header class="top"><div><h1>${esc(title)}</h1><div class="sub" id="sub"></div></div><div class="nav">${nav}</div></header>
${body}
<footer>Generated by Accessibility Automation Tool · axe-core + Playwright · WCAG 2.2 A+AA (56 criteria)</footer>
</div></body></html>`;
}

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
  const { issues, meta, stats } = data;
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

  var csvBtn = document.getElementById('dlCsv');
  if (csvBtn) csvBtn.addEventListener('click', function(){
    save(toCSV(), 'text/csv;charset=utf-8', 'a11y-' + SLUG + '-' + stamp() + '.csv');
  });
  var jsonBtn = document.getElementById('dlJson');
  if (jsonBtn) jsonBtn.addEventListener('click', function(){
    save(JSON.stringify({ summary: SUMMARY, findings: ROWS }, null, 2), 'application/json', 'a11y-' + SLUG + '-' + stamp() + '.json');
  });
  // Self-contained HTML snapshot of the dashboard exactly as it looks now.
  // Preferred over PDF for this content: the matrix is 56 columns wide and
  // depends on background colour, which paginates and prints poorly no matter
  // how much print CSS you throw at it. The page has no external assets and
  // all its data is inline, so a DOM snapshot reopens fully working — the
  // scope/status filters, the matrix tooltips and the CSV/JSON buttons all
  // keep functioning offline.
  var htmlBtn = document.getElementById('dlHtml');
  if (htmlBtn) htmlBtn.addEventListener('click', function(){
    var clone = document.documentElement.cloneNode(true);
    // The sibling "Detailed report" file won't travel with the snapshot, so a
    // relative link to it would land on a 404. Drop it; keep the export
    // buttons, which are Blob-based and still work for the recipient.
    var link = clone.querySelector('header.top .nav a');
    if (link) link.remove();
    var tip = clone.querySelector('.mx-tip');
    if (tip) tip.remove();
    var sub = clone.querySelector('header.top .sub');
    if (sub) sub.innerHTML += ' · <b>offline snapshot</b> taken ' + new Date().toLocaleString();
    save('<!doctype html>\\n' + clone.outerHTML, 'text/html;charset=utf-8',
         'a11y-' + SLUG + '-' + stamp() + '.html');
  });

  var printBtn = document.getElementById('dlPrint');
  if (printBtn) printBtn.addEventListener('click', function(){ window.print(); });

  var n = ROWS.length;
  [csvBtn, jsonBtn].forEach(function(b){
    if (!b) return;
    if (!n) { b.disabled = true; b.style.opacity = .5; b.title = 'No findings to export'; }
    else b.title = n + ' finding' + (n === 1 ? '' : 's');
  });
})();
</script>`;
}

function buildDashboard(data, opts = {}) {
  const { criteria, meta, matrix, issues, stats, previous, history } = data;
  const reportFile = opts.reportFile || 'report.html';
  const nav = `<a href="${esc(reportFile)}">Detailed report →</a>`
    + '<button type="button" id="dlHtml" class="primary">↓ HTML</button>'
    + '<button type="button" id="dlCsv">↓ CSV</button>'
    + '<button type="button" id="dlJson">↓ JSON</button>'
    + '<button type="button" id="dlPrint">🖨 Print</button>';
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
      hint: (c.untested ? c.untestedWhy || 'No rule for this criterion exists in the scan engine, so it was never actually tested — this is a tooling gap, not a clean result. ' : '') + (c.manualHint || ''),
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
    engineByScope: stats.engineComparisonByScope || null,
    checks: CHECK_GROUPS,
    checkRuns: stats.checkRuns || {},
    lint: stats.lint || null,
  };
  const json = JSON.stringify(embed).replace(/</g, '\\u003c');

  // Controls: page selector + status filters. Pinned to the top (sticky) so
  // it's the first thing visible and stays reachable while scrolling through
  // a long report.
  // "(cumulative)" is only true when this report merges several runs. On a
  // single-run report it reads as "everything ever scanned" and contradicts a
  // picker listing 2 pages, so label it with the actual count instead.
  const isCumulative = !!(data.meta && data.meta.combinedSources);
  const allLabel = isCumulative
    ? 'All pages (cumulative)'
    : `All pages in this scan (${stats.pagesInScope != null ? stats.pagesInScope : pages.length})`;
  const options = [`<option value="ALL">${esc(allLabel)}</option>`]
    .concat(pages.map((p) => `<option value="${esc(p)}">${esc(p)}</option>`)).join('');
  const controls = `<div class="section" style="position:sticky;top:12px;z-index:20;display:flex;gap:20px;align-items:center;flex-wrap:wrap;padding:14px 22px;box-shadow:0 4px 14px rgba(16,24,40,.08)">
    <label style="font-size:13px;color:#374151">View:
      <select id="scopeSel" style="margin-left:8px;padding:6px 10px;border:1px solid #d3d9e2;border-radius:8px;font:inherit;background:#fff">${options}</select>
    </label>
    <div class="filters" style="margin:0">
      <button class="fbtn active" data-f="all">All statuses</button>
      <button class="fbtn" data-f="pass">No automated failures</button>
      <button class="fbtn" data-f="failed">Failed</button>
      <button class="fbtn" data-f="partial">Partial</button>
      <button class="fbtn" data-f="cantsupport">Can't support</button>
    </div>
    <span class="muted" style="font-size:11px;margin-left:auto">Filters the criteria, automated checks, matrix &amp; charts below</span>
  </div>`;

  const skeleton = `${controls}
    ${buildVerificationPanel(data.verification)}
    ${buildSkippedPages(meta)}
    ${buildSeverityCards(stats, previous, matrix.pages)}
    ${buildIssuesMatrix(stats, previous)}
    <div class="section" id="fixonce"></div>
    ${buildCodeMappingSummary(issues, meta)}
    ${buildInventory(stats)}
    ${stats.engineComparisonByScope ? '<div class="section" id="engineWrap"></div>' : buildEngineComparison(stats)}
    ${buildModalCoverage(stats)}
    ${buildLifecyclePanel(data.lifecycle)}
    ${buildTrend(stats, { ...meta, pages: matrix.pages }, history)}
    <div class="cards" id="cards"></div>
    <div class="section"><h2 id="ovh">WCAG 2.2 A + AA — 56 success criteria</h2><div id="overview"></div></div>
    ${buildMatrix(criteria, matrix)}
    <div class="section" id="dynamic"></div>
    <div id="charts"></div>
    <div id="criteria"></div>
    <dialog id="issueDlg" class="idlg" aria-labelledby="idlgTitle" aria-describedby="idlgSub">
      <div class="idlg-head"><div><h2 id="idlgTitle"></h2><div class="muted" id="idlgSub" style="font-size:12px"></div></div>
        <button type="button" class="idlg-x" aria-label="Close">×</button></div>
      <div class="idlg-body" id="idlgBody"></div>
    </dialog>`;

  const js = `<script>
  window.__A11Y__=${json};
  (function(){
    var D=window.__A11Y__;
    var BK={pass:{l:'No automated failures',c:'#1b7a4b',b:'#e7f6ee',s:'#37b26e'},failed:{l:'Failed',c:'#c0392b',b:'#fdecea',s:'#e5484d'},partial:{l:'Partial',c:'#9a6700',b:'#fff6e5',s:'#f2b01e'},cantsupport:{l:"Can't support",c:'#5b6472',b:'#eef0f3',s:'#c2c7cf'}};
    var IMP={critical:'#c0392b',serious:'#d35400',moderate:'#b7791f',minor:'#6b7280'};
    var scope='ALL',filter='all';
    function bk(s){return s==='fail'?'failed':s==='review'?'partial':s==='pass'?'pass':'cantsupport';}
    function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
    function sIssues(){return D.issues.filter(function(i){return scope==='ALL'||i.page===scope;});}
    // Confirmed WCAG violation: not a review item, not a best-practice finding.
    function isConf(i){return i.kind==='violation'&&i.cat!=='best-practice';}
    function bars(items,color){var max=Math.max(1);items.forEach(function(i){max=Math.max(max,i[1]);});return items.map(function(i){return '<div class="hbar"><div class="lab">'+esc(i[0])+'</div><div class="track"><div class="fill" style="width:'+(i[1]/max*100)+'%;background:'+color+'"></div></div><div class="val">'+i[1]+'</div></div>';}).join('');}
    function card(n,l,color){return '<div class="card"><div class="n" style="color:'+color+'">'+n+'</div><div class="l">'+l+'</div></div>';}

    function renderSummary(){
      var st=D.statusByScope[scope],cnt={pass:0,failed:0,partial:0,cantsupport:0};
      D.criteria.forEach(function(c){cnt[bk(st[c.id])]++;});
      var all=sIssues(),iss=all.filter(isConf).length,uq={};all.filter(isConf).forEach(function(i){uq[i.gid]=1;});
      var nu=Object.keys(uq).length,rv=all.filter(function(i){return i.kind!=='violation'&&i.cat!=='best-practice';}).length;
      document.getElementById('cards').innerHTML=card(cnt.failed,'Criteria failed',BK.failed.c)+card(cnt.partial,'Partial / review',BK.partial.c)+card(cnt.pass,'No automated failures',BK.pass.c)+card(cnt.cantsupport,"Can't support",BK.cantsupport.c)+card(iss,'Confirmed violations'+(nu!==iss?' ('+nu+' unique)':''),'#111827')+card(rv,'Need review','#9a6700');
      var order=['failed','partial','pass','cantsupport'],tot=D.criteria.length,seg='',leg='';
      order.forEach(function(k){var v=cnt[k];if(v)seg+='<span style="width:'+(v/tot*100)+'%;background:'+BK[k].s+'"></span>';leg+='<span><i style="background:'+BK[k].s+'"></i>'+BK[k].l+' — <b>'+v+'</b></span>';});
      document.getElementById('overview').innerHTML='<div class="bar">'+seg+'</div><div class="legend">'+leg+'</div>';
      document.getElementById('ovh').textContent='WCAG 2.2 A + AA — 56 success criteria'+(scope==='ALL'?'':' · '+scope);
    }
    function renderCriteria(){
      var st=D.statusByScope[scope],html='';
      D.principles.forEach(function(pr){
        var items=D.criteria.filter(function(c){return c.principle===pr;}),cells='',shown=0;
        items.forEach(function(c){var b=bk(st[c.id]),m=BK[b],hide=(filter!=='all'&&filter!==b);if(!hide)shown++;
          cells+='<div class="crit" data-bk="'+b+'" style="border-left:4px solid '+m.s+';'+(hide?'display:none':'')+'"><div><span class="id">'+c.id+'</span>'+esc(c.name)+' <span class="lvl">'+c.level+'</span><span class="pill" style="float:right;background:'+m.b+';color:'+m.c+'">'+m.l+'</span></div><div class="hint">'+esc(c.hint)+'</div>'+(c.source==='ibm'?'<div class="src">verdict from the second engine (IBM Equal Access)</div>':'')+(c.steps&&c.steps.length?'<details class="fixsteps"><summary>How to check / fix this manually ('+c.steps.length+' steps)</summary><ol>'+c.steps.map(function(t){return '<li>'+esc(t)+'</li>';}).join('')+'</ol></details>':'')+'</div>';});
        html+='<div class="section"><h2>'+pr+' <span class="muted" style="font-weight:400">('+(filter==='all'?items.length:shown+' of '+items.length)+')</span></h2><div class="crit-grid">'+cells+'</div></div>';
      });
      document.getElementById('criteria').innerHTML=html;
    }
    function renderDynamic(){
      var iss=sIssues(),runs=D.checkRuns||{};
      var GREY='#9aa2ae',ST={found:[BK.failed.b,BK.failed.c,'Found'],review:[BK.partial.b,BK.partial.c,'Review'],clean:[BK.pass.b,BK.pass.c,'Clean'],none:['#eef0f3','#5b6472','No verdict'],off:['#eef0f3','#5b6472','Off'],notrun:['#eef0f3','#5b6472','Not run']};
      // One row = one check. The pill is this ROW's own result, not the
      // criterion's overall status (other rules can fail the same criterion).
      function row(ids,label,crit,state,hits,sub){
        var n=hits.length,s=ST[state],color=state==='found'?BK.failed.s:state==='review'?BK.partial.s:state==='clean'?BK.pass.s:GREY;
        var inner='<span style="font-size:22px;font-weight:700;color:'+color+';min-width:34px;text-align:right">'+(n||(state==='clean'?0:'–'))+'</span><span style="flex:1;text-align:left">'+esc(label)+'<span class="muted" style="display:block;font-size:11px">'+sub+'</span></span>';
        var main=n?'<button type="button" class="cnt-btn dyn-btn" data-dlg-rule="'+esc(ids.join(' '))+'" data-dlg-label="'+esc(label)+'">'+inner+'</button>':'<span class="dyn-btn">'+inner+'</span>';
        return '<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid #edf0f4">'+main+'<span class="pill" style="background:'+s[0]+';color:'+s[1]+';white-space:nowrap">'+(crit?crit+' ':'')+s[2]+'</span></div>';
      }
      function hitsFor(ids){return iss.filter(function(i){return ids.indexOf(i.rule)!==-1;});}
      function pagesOf(h){var pg={};h.forEach(function(i){pg[i.page]=1;});return Object.keys(pg).length;}
      function found(h){return h.every(function(i){return i.kind==='incomplete';})?'review':'found';}
      function group(icon,name,how,body,total){return '<div><div style="font-weight:600;margin-bottom:2px">'+icon+' '+esc(name)+' <span class="muted" style="font-weight:400">— '+total+' finding'+(total===1?'':'s')+'</span></div><div class="muted" style="font-size:12px;margin-bottom:6px">'+how+'</div>'+body+'</div>';}
      var html='';
      D.checks.forEach(function(g){
        var groupRan=g.rows.some(function(r){return r[0].some(function(id){return runs[id];});});
        if(g.optIn&&!groupRan&&!g.rows.some(function(r){return hitsFor(r[0]).length;})){
          // Switched off: one note instead of a row of dashes per check.
          html+=group(g.icon,g.name,g.how,'<div class="muted" style="font-size:12px;padding:10px 12px;background:#f7f9fb;border:1px solid #e5e9ef;border-radius:8px">Off by default. Set <code>'+esc(g.optIn)+'</code> in a11y.config.js to test: '+g.rows.map(function(r){return esc(r[1].charAt(0).toLowerCase()+r[1].slice(1))+' ('+r[2]+')';}).join('; ')+'.</div>',0);
          return;
        }
        var total=0,body=g.rows.map(function(r){
          var h=hitsFor(r[0]),n=h.length,ran=Math.max.apply(null,r[0].map(function(id){return runs[id]||0;}));total+=n;
          if(n)return row(r[0],r[1],r[2],found(h),h,pagesOf(h)+' page(s) affected · view all');
          if(ran)return row(r[0],r[1],r[2],'clean',h,'checked on '+ran+' page(s), none found');
          if(groupRan&&g.passless)return row(r[0],r[1],r[2],'clean',h,'none found');
          if(groupRan)return row(r[0],r[1],r[2],'none',h,'nothing on the scanned pages for this check to judge');
          if(g.optIn)return row(r[0],r[1],r[2],'off',h,'off by default: set <code>'+esc(g.optIn)+'</code> in a11y.config.js');
          return row(r[0],r[1],r[2],'notrun',h,'did not run in this scan');
        }).join('');
        html+=group(g.icon,g.name,g.how,body,total);
      });
      // Source lint: one row per ESLint rule that fired. Lint findings belong
      // to the "Source code (lint)" pseudo-page, so they show in the All view
      // and in that page's view only.
      var lint=iss.filter(function(i){return i.states.indexOf('lint')!==-1;}),byRule={},order=[];
      lint.forEach(function(i){if(!byRule[i.rule]){byRule[i.rule]=[];order.push(i.rule);}byRule[i.rule].push(i);});
      order.sort(function(a,b){return byRule[b].length-byRule[a].length;});
      var lintHow=D.lint?D.lint.files+' source files checked with the ESLint accessibility plugins (jsx-a11y, Vue, Angular, HTML)'+(D.lint.unparsed?' · '+D.lint.unparsed+' file(s) could not be parsed':'')+'.':'Did not run: needs REPO_PATH in a11y.config.js (and STATIC_LINT not disabled).';
      var lintBody=order.map(function(rule){
        var h=byRule[rule],c=h[0].crits&&h[0].crits[0],name=rule.replace(/^lint:/,'').split('/').pop().replace(/-/g,' ');
        return row([rule],name.charAt(0).toUpperCase()+name.slice(1),c?c.id:'',found(h),h,'<span class="mono">'+esc(rule.replace(/^lint:/,''))+'</span>');
      }).join('')||(D.lint?row([],'No lint findings','', 'clean',[],'all checked files are clean'):'');
      var lintPage=(D.issues.filter(function(i){return i.states.indexOf('lint')!==-1;})[0]||{}).page;
      if(scope==='ALL'||scope===lintPage)html+=group('🧹','Source code lint',lintHow,lintBody,lint.length);
      document.getElementById('dynamic').innerHTML='<h2>Automated checks <span class="muted" style="font-weight:400">— everything this tool tests beyond axe-core, and what it found</span></h2><div class="dyngrid">'+html+'</div>';
    }
    // ── Fix once: issues that share one fix ──────────────────────────────
    // The same component renders on many pages, so one defect is reported
    // once per page. Group by rule + source line (or, without a usable source
    // location, rule + element) and rank by how many issues each fix clears.
    var fixGroups=[];
    // Compiled output is not where a fix goes (no regex: this sits in a template string).
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
      // Rank by impact: the health score's severity weights × issues cleared,
      // so 18 critical issues outrank 126 minor "check by hand" ones.
      var W={critical:10,serious:5,moderate:2,minor:1};
      fixGroups.forEach(function(g){g.weight=g.list.reduce(function(n,i){return n+(W[i.impact]||1);},0);});
      fixGroups.sort(function(a,b){return b.weight-a.weight||b.list.length-a.list.length;});
      var el=document.getElementById('fixonce');if(!el)return;
      if(!iss.length){el.innerHTML='<h2>Fix once</h2><div class="empty">No issues 🎉</div>';return;}
      var TOP=10,top=fixGroups.slice(0,TOP),cleared=top.reduce(function(n,g){return n+g.list.length;},0);
      function line(g,k){
        var np=Object.keys(g.pages).length,col=IMP[g.impact]||'#8b93a1';
        return '<tr><td style="color:#6b7280;width:28px">'+(k+1)+'</td>'
          +'<td><button type="button" class="cnt-btn" data-dlg-fix="'+k+'" style="text-align:left"><b>'+esc(g.title)+'</b></button>'
          +'<div class="muted" style="font-size:11px;margin-top:2px"><span class="mono">'+esc(g.rule)+'</span>'+(g.crit?' · WCAG '+g.crit:'')+' · <span style="color:'+col+'">'+esc(g.impact||'')+'</span></div></td>'
          +'<td style="font-size:12px;max-width:340px;word-break:break-all">'+(g.src?'<span class="mono">'+esc(g.src)+'</span>':'<span class="mono muted">'+esc(g.sel.slice(0,90))+'</span>')+'</td>'
          +'<td style="text-align:right;white-space:nowrap"><button type="button" class="cnt-btn" data-dlg-fix="'+k+'"><b style="font-size:16px">'+g.list.length+'</b></button><div class="muted" style="font-size:11px">'+np+' page'+(np===1?'':'s')+'</div></td></tr>';
      }
      var head='<thead><tr><th></th><th>Problem</th><th>Where to fix</th><th style="text-align:right">Issues</th></tr></thead>';
      el.innerHTML='<h2>Fix once <span class="muted" style="font-weight:400">— the same problem, counted on every page it appears</span></h2>'
        +'<p class="mx-hint"><b>'+iss.length+'</b> issue'+(iss.length===1?'':'s')+' come from <b>'+fixGroups.length+'</b> distinct problem'+(fixGroups.length===1?'':'s')+'. '
        +'Ranked by impact (severity × issues cleared); fixing the top '+top.length+' clears <b>'+cleared+'</b> ('+Math.round(cleared/iss.length*100)+'%). "Where to fix" is the source line when it is known, otherwise the element.</p>'
        +'<div style="overflow-x:auto"><table>'+head+'<tbody>'+top.map(line).join('')+'</tbody></table></div>'
        +(fixGroups.length>TOP?'<details style="margin-top:10px"><summary style="cursor:pointer;font-weight:600;color:#1a5490">All '+fixGroups.length+' problems</summary><div style="overflow-x:auto"><table style="margin-top:8px">'+head+'<tbody>'+fixGroups.slice(TOP).map(function(g,k){return line(g,k+TOP);}).join('')+'</tbody></table></div></details>':'');
    }
    function renderCharts(){
      // Charts count CONFIRMED WCAG violations. Review items and best-practice
      // findings are in the issue list, but are not defects to chart.
      var allIss=sIssues(),iss=allIss.filter(isConf),imp={critical:0,serious:0,moderate:0,minor:0},byRule={};
      iss.forEach(function(i){if(imp[i.impact]!=null)imp[i.impact]++;byRule[i.rule]=(byRule[i.rule]||0)+1;});
      var impItems=Object.keys(imp).map(function(k){return [k.charAt(0).toUpperCase()+k.slice(1),imp[k],IMP[k]];});
      var impMax=Math.max(1);impItems.forEach(function(i){impMax=Math.max(impMax,i[1]);});
      var impHtml=impItems.map(function(i){return '<div class="hbar"><div class="lab">'+i[0]+'</div><div class="track"><div class="fill" style="width:'+(i[1]/impMax*100)+'%;background:'+i[2]+'"></div></div><div class="val">'+i[1]+'</div></div>';}).join('');
      var rules=Object.keys(byRule).map(function(k){return [k,byRule[k]];}).sort(function(a,b){return b[1]-a[1];}).slice(0,12);
      var byPage='';
      if(scope==='ALL'){var bp={};D.issues.filter(isConf).forEach(function(i){bp[i.page]=(bp[i.page]||0)+1;});var items=Object.keys(bp).map(function(k){return [k,bp[k]];}).sort(function(a,b){return b[1]-a[1];});byPage='<div class="section"><h2>Issues by page</h2>'+(items.length?bars(items,'#5eb0ef'):'<div class="empty">No issues 🎉</div>')+'</div>';}

      // ── Errors by WCAG CRITERION (not by axe rule) ──────────────────────
      var byCrit={};
      iss.forEach(function(i){(i.crits||[]).forEach(function(c){
        var e=byCrit[c.id]||(byCrit[c.id]={id:c.id,name:c.name,level:c.level,n:0});e.n++;});});
      var critList=Object.keys(byCrit).map(function(k){return byCrit[k];}).sort(function(a,b){return b.n-a.n||(a.id<b.id?-1:1);});
      var critTotal=critList.reduce(function(n,c){return n+c.n;},0);
      var PAL=['#2f5fd0','#4a7de0','#7aa3ec','#e5484d','#f5a524','#37b26e','#9b6bd6','#0fb5ba'];
      // Donut via stroke-dasharray on a single circle, one segment per criterion.
      var R=54,C=2*Math.PI*R,off=0,segs='';
      critList.slice(0,8).forEach(function(c,idx){
        var frac=critTotal?c.n/critTotal:0,len=frac*C;
        segs+='<circle cx="70" cy="70" r="'+R+'" fill="none" stroke="'+PAL[idx%PAL.length]+'" stroke-width="22" stroke-dasharray="'+len.toFixed(2)+' '+(C-len).toFixed(2)+'" stroke-dashoffset="'+(-off).toFixed(2)+'" transform="rotate(-90 70 70)"><title>'+c.id+' '+c.name+': '+c.n+'</title></circle>';
        off+=len;});
      var donut=critTotal?('<div style="display:flex;gap:20px;align-items:center;flex-wrap:wrap">'
        +'<svg viewBox="0 0 140 140" style="width:140px;height:140px;flex:none">'+segs
        +'<text x="70" y="68" text-anchor="middle" font-size="26" font-weight="700" fill="#111827">'+critTotal+'</text>'
        +'<text x="70" y="86" text-anchor="middle" font-size="9" fill="#6b7280" letter-spacing="1">ERRORS</text></svg>'
        +'<div style="flex:1;min-width:200px">'+critList.slice(0,8).map(function(c,idx){
          return '<div style="display:flex;align-items:center;gap:8px;padding:3px 0;font-size:12px"><i style="display:inline-block;width:9px;height:9px;border-radius:2px;background:'+PAL[idx%PAL.length]+'"></i><span style="flex:1">'+c.id+' '+esc(c.name)+'</span><b>'+c.n+'</b></div>';}).join('')
        +'</div></div>'):'<div class="empty">No issues 🎉</div>';

      // Top failing criteria (bars) + failures split by WCAG level.
      var topCrit=critList.slice(0,8).map(function(c){return [c.id+' '+c.name,c.n];});
      var lvl={A:0,AA:0};critList.forEach(function(c){if(lvl[c.level]!=null)lvl[c.level]+=c.n;});
      var lvlTot=lvl.A+lvl.AA;
      var lvlBar=lvlTot?('<div class="bar" style="height:18px">'
        +(lvl.A?'<span style="width:'+(lvl.A/lvlTot*100)+'%;background:#1b7a4b"></span>':'')
        +(lvl.AA?'<span style="width:'+(lvl.AA/lvlTot*100)+'%;background:#37b26e"></span>':'')
        +'</div><div class="legend" style="margin-top:8px"><span><i style="background:#1b7a4b"></i>Level A · <b>'+lvl.A+'</b></span><span><i style="background:#37b26e"></i>Level AA · <b>'+lvl.AA+'</b></span></div>'):'';

      document.getElementById('charts').innerHTML=
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:22px" class="chartgrid">'
        +'<div class="section"><h2>Errors by criterion</h2>'+donut
        +'<div class="muted" style="font-size:11px;margin-top:10px">Confirmed WCAG violations only. An issue tagged with 2 criteria counts toward both.'
        +(function(){var bp=allIss.filter(function(i){return i.cat==='best-practice';}).length,rv=allIss.filter(function(i){return i.kind!=='violation'&&i.cat!=='best-practice';}).length;
          return (rv?' '+rv+' item(s) need review':'')+(bp?(rv?' and ':' ')+bp+' best-practice finding(s) (advice, not WCAG failures)':'')+(rv||bp?' are listed in the report but not counted here.':'');})()
        +'</div></div>'
        +'<div class="section"><h2>Top failing criteria</h2>'+(topCrit.length?bars(topCrit,'#1b7a4b'):'<div class="empty">No issues 🎉</div>')
        +(lvlBar?'<div style="margin-top:14px"><div class="l" style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px">Failures by WCAG level</div>'+lvlBar+'</div>':'')+'</div>'
        +'</div>'
        +'<div style="display:grid;grid-template-columns:'+(scope==='ALL'?'1fr 1fr':'1fr')+';gap:22px"><div class="section"><h2>Issues by impact</h2>'+impHtml+'</div>'+byPage+'</div>'
        +'<div class="section"><h2>Top failing rules <span class="muted" style="font-weight:400">— by axe rule id</span></h2>'+(rules.length?bars(rules,'#f5a524'):'<div class="empty">No issues 🎉</div>')+'</div>';
    }
    function renderMatrix(){var trs=document.querySelectorAll('table.matrix tbody tr');for(var i=0;i<trs.length;i++){trs[i].style.display=(scope==='ALL'||trs[i].getAttribute('data-page')===scope)?'':'none';}}
    function renderEngine(){
      var wrap=document.getElementById('engineWrap');
      if(!wrap)return;
      var ec=D.engineByScope&&D.engineByScope[scope];
      if(!ec||!ec.compared){wrap.innerHTML='<h2>Engine Agreement <span class="muted" style="font-weight:400">— axe-core vs IBM Equal Access (open-source)</span></h2><div class="empty">No comparable criteria for this view.</div>';return;}
      var AG={'agree-bad':{l:'Both flag an issue',c:'#c0392b',b:'#fdecea'},'agree-clean':{l:'Both pass',c:'#1b7a4b',b:'#e7f6ee'},'axe-only':{l:'Only axe-core flags it',c:'#7c3aed',b:'#f3e8ff'},'ibm-only':{l:'Only IBM engine flags it',c:'#0f7a9c',b:'#e6f6fb'}};
      var rows=ec.rows.map(function(r){
        var ag=AG[r.agreement],stA=BK[bk(r.axe)],stI=BK[bk(r.ibm)];
        return '<tr style="background:'+((r.agreement==='axe-only'||r.agreement==='ibm-only')?ag.b:'transparent')+'"><td><b>'+r.id+'</b> '+esc(r.name)+' <span class="lvl">'+r.level+'</span></td>'
          +'<td style="text-align:center"><span class="pill" style="background:'+stA.b+';color:'+stA.c+'">'+stA.l+'</span></td>'
          +'<td style="text-align:center"><span class="pill" style="background:'+stI.b+';color:'+stI.c+'">'+stI.l+'</span></td>'
          +'<td style="text-align:center"><span class="pill" style="background:'+ag.b+';color:'+ag.c+'">'+ag.l+'</span></td></tr>';
      }).join('');
      var pct=Math.round((ec.agree+ec.bothClean)/ec.compared*100);
      wrap.innerHTML='<h2>Engine Agreement <span class="muted" style="font-weight:400">— axe-core vs IBM Equal Access (open-source)'+(scope==='ALL'?'':' · '+esc(scope))+'</span></h2>'
        +'<p class="mx-hint">Two independently-built rule engines checked the same '+ec.compared+' criteria. <b>'+pct+'% agreement</b> ('+ec.agree+' both-flag + '+ec.bothClean+' both-clean). Disagreements are where one engine caught something the other missed — worth a manual look.</p>'
        +'<div class="legend" style="margin-bottom:14px"><span><i style="background:'+AG['agree-bad'].c+'"></i>Both flag — '+ec.agree+'</span><span><i style="background:'+AG['agree-clean'].c+'"></i>Both pass — '+ec.bothClean+'</span><span><i style="background:'+AG['axe-only'].c+'"></i>axe-core only — '+ec.axeOnly+'</span><span><i style="background:'+AG['ibm-only'].c+'"></i>IBM only — '+ec.ibmOnly+'</span></div>'
        +'<div style="overflow-x:auto"><table><thead><tr><th>Criterion</th><th style="text-align:center">axe-core</th><th style="text-align:center">IBM engine</th><th style="text-align:center">Agreement</th></tr></thead><tbody>'+rows+'</tbody></table></div>';
    }
    function renderAll(){renderSummary();renderFixOnce();renderCriteria();renderDynamic();renderCharts();renderMatrix();renderEngine();}

    // ── Issue dialog: clicking a count lists the issues behind it ──────────
    var dlg=document.getElementById('issueDlg'),dlgReturn=null;
    function pill(bg,c,t){return '<span class="pill" style="background:'+bg+';color:'+c+'">'+esc(t)+'</span>';}
    function issueCard(m){
      var r=(window.__A11Y_ROWS__||[])[m.ix]||{},col=IMP[m.impact]||'#8b93a1';
      // In the single-file bundle the findings view holds the screenshot
      // inlined as a data: URI; use it, since the relative path won't resolve.
      var img=document.querySelector('#view-findings .issue[data-i="'+m.ix+'"] img');
      var shot=img?img.getAttribute('src'):m.shot;
      return '<div class="issue" style="border-left-color:'+col+'"><h3>'+esc(m.title||r.description||m.rule)+'</h3>'
        +'<div class="meta">'+(m.cat==='best-practice'?pill('#eef0f3','#5b6472','Best practice'):m.kind==='incomplete'?pill(BK.partial.b,BK.partial.c,'Needs review'):pill(BK.failed.b,BK.failed.c,'Violation'))
        +pill(col+'22',col,m.impact||'')+'<span class="mono">'+esc(m.rule)+'</span>'
        +(m.crits||[]).map(function(c){return '<span class="lvl">WCAG '+c.id+' ('+c.level+')</span>';}).join(' ')
        +'<span>· '+esc(m.page)+(m.states.length?' · '+esc(m.states.join(', ')):'')+'</span>'
        +(m.helpUrl?'<a href="'+esc(m.helpUrl)+'" target="_blank" rel="noopener">docs ↗</a>':'')+'</div>'
        +(shot?'<img src="'+esc(shot)+'" alt="Screenshot of the page with the failing element highlighted in red" loading="lazy" onerror="this.remove()" style="max-width:100%;border:1px solid #e2e6ec;border-radius:6px;margin:8px 0;display:block">':'')
        +(r.html?'<pre>'+esc(r.html)+'</pre>':'')
        +(r.selector?'<div class="mono muted" style="font-size:11px;margin-top:-4px">Selector: '+esc(r.selector)+'</div>':'')
        +(r.remediation?'<div class="fix"><b>How to fix:</b> '+esc(r.remediation)+'</div>':'')
        +(r.sourceFile?'<div class="loc"><span class="muted">Likely in code:</span> <b class="mono">'+esc(r.sourceFile)+'</b>'+(r.sourceConfidence?' <span class="muted">· '+esc(r.sourceConfidence)+' confidence</span>':'')+'</div>':'')
        +'</div>';
    }
    function openIssues(title,sub,list){
      var MAX=300,groups={},order=[],body='',shown=0;
      list.forEach(function(m){if(!groups[m.page]){groups[m.page]=[];order.push(m.page);}groups[m.page].push(m);});
      order.forEach(function(p){
        if(shown>=MAX)return;
        var g=groups[p].slice(0,MAX-shown);shown+=g.length;
        body+=(order.length>1?'<h3 class="idlg-pg">'+esc(p)+' <span class="muted">('+groups[p].length+')</span></h3>':'')+g.map(issueCard).join('');
      });
      if(list.length>MAX)body+='<p class="muted">Showing the first '+MAX+' of '+list.length+'. The detailed report lists them all.</p>';
      document.getElementById('idlgTitle').textContent=title;
      document.getElementById('idlgSub').textContent=sub;
      document.getElementById('idlgBody').innerHTML=body||'<div class="empty">No issues.</div>';
      dlgReturn=document.activeElement;
      if(dlg.showModal)dlg.showModal();else dlg.setAttribute('open','');
      dlg.scrollTop=0;
    }
    function closeDlg(){if(dlg.close)dlg.close();else{dlg.removeAttribute('open');dlg.dispatchEvent(new Event('close'));}}
    if(dlg){
      dlg.querySelector('.idlg-x').addEventListener('click',closeDlg);
      dlg.addEventListener('click',function(e){if(e.target===dlg)closeDlg();}); // backdrop
      dlg.addEventListener('close',function(){if(dlgReturn&&dlgReturn.focus)dlgReturn.focus();});
      document.addEventListener('click',function(e){
        var b=e.target.closest&&e.target.closest('[data-dlg-rule],[data-dlg-page],[data-dlg-fix]');
        if(!b)return;
        var list,title,sub,plural=function(n,w){return n+' '+w+(n===1?'':'s');};
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
          var pg=b.getAttribute('data-dlg-page'),st=b.getAttribute('data-dlg-state');
          list=D.issues.filter(function(i){return i.page===pg&&i.states.indexOf(st)!==-1;});
          title=pg+' · '+(/^initial$/i.test(st)?'Base page':st);
          sub=plural(list.length,'issue');
        }
        openIssues(title,sub,list);
      });
    }

    var sel=document.getElementById('scopeSel');
    if(sel)sel.addEventListener('change',function(e){scope=e.target.value;renderAll();});
    var fb=document.querySelectorAll('.fbtn');
    for(var j=0;j<fb.length;j++)fb[j].addEventListener('click',function(e){for(var k=0;k<fb.length;k++)fb[k].classList.remove('active');e.target.classList.add('active');filter=e.target.getAttribute('data-f');renderCriteria();});
    renderAll();
  })();
  </script>`;

  const sourcesBanner = meta.combinedSources ? `<div class="section" style="padding:14px 22px">
    <div style="font-weight:600;margin-bottom:8px">📦 Combined from ${meta.combinedSources.length} scan${meta.combinedSources.length === 1 ? '' : 's'} — each page shows its most recent run</div>
    ${meta.combinedSources.map((s) => `<div style="font-size:12px;color:#4b5563;padding:3px 0"><b>${esc(s.page)}</b> <span class="muted">— ${esc(s.reportName)} · ${esc(s.at)}</span></div>`).join('')}
  </div>` : '';

  const html = shell('Accessibility Dashboard', nav, sourcesBanner + skeleton + buildExportScript(data) + js).replace(
    '<div class="sub" id="sub"></div>',
    `<div class="sub">${esc(meta.baseUrl)} · ${meta.pageCount} page(s) · ${meta.stateCount} UI states · ${esc(meta.generatedAt)}</div>`
  );
  return html;
}

function buildReport(data, opts = {}) {
  const { issues, meta } = data;
  const dashFile = opts.dashFile || 'dashboard.html';
  const nav = `<a href="${esc(dashFile)}">← Dashboard</a>`;

  const issueHtml = issues.map((i, idx) => {
    const impactColor = IMPACT[i.impact] || '#8b93a1';
    const crits = i.criteria.map((c) => `<span class="lvl">WCAG ${c.id} (${c.level})</span>`).join(' ');
    const locs = (i.locations || []).map((l) => {
      const confColor = l.confidence === 'exact' || l.confidence === 'high' ? '#30a46c' : l.confidence === 'medium' ? '#f5a524' : '#8b93a1';
      return `<div class="loc"><b class="mono">${esc(l.file)}:${l.line}</b>
        <span class="conf" style="background:${confColor}22;color:${confColor}">${l.confidence}</span>
        <span class="muted"> · matched ${esc(l.clue)}</span>
        <pre style="margin:6px 0 0">${esc(l.snippet)}</pre></div>`;
    }).join('');
    const fix = i.customFix
      ? `<div class="fix"><b>How to fix:</b> ${esc(i.customFix.fix)}</div>`
      : (i.failureSummary ? `<div class="fix"><b>How to fix:</b> ${esc(i.failureSummary)}</div>` : '');
    const kindPill = i.category === 'best-practice'
      ? `<span class="pill" style="background:#eef0f3;color:#5b6472" title="No WCAG criterion — advice, not counted as a violation or in the CI gate">Best practice</span>`
      : i.kind === 'incomplete'
        ? `<span class="pill" style="background:${STATUS.review.bg};color:${STATUS.review.color}">Needs review</span>`
        : `<span class="pill" style="background:${STATUS.fail.bg};color:${STATUS.fail.color}">Violation</span>${i.sampled ? ' <span class="pill" style="background:#fff6e5;color:#9a6700" title="Measured from rendered pixels because axe could not resolve the background">Sampled</span>' : ''}`;
    const statesAttr = esc(JSON.stringify(i.states || []));
    const isLint = i.source === 'lint';
    const sourcePill = isLint
      ? '<span class="pill" style="background:#eef2ff;color:#4338ca">Source lint</span>'
      : '<span class="pill" style="background:#ecfdf5;color:#047857">Browser</span>';
    const crossRef = i.alsoInLint
      ? `<div class="muted" style="font-size:12px;margin-top:4px">Also reported by the source lint at <code>${esc(i.alsoInLint)}</code> — one fix closes both.</div>`
      : (i.seenInBrowser && i.seenInBrowser.length ? `<div class="muted" style="font-size:12px;margin-top:4px">Also seen in the running app on: ${esc(i.seenInBrowser.join(', '))}.</div>` : '');
    const alsoBy = i.alsoFlaggedBy && i.alsoFlaggedBy.length
      ? `<div class="muted" style="font-size:12px;margin-top:4px">Also detected by this tool's <code>${esc(i.alsoFlaggedBy.join(', '))}</code> check on the same element — counted once.</div>` : '';
    const repeats = i.groupPages > 1
      ? `<div class="muted" style="font-size:12px;margin-top:4px">The same problem appears on ${i.groupPages} pages — likely one shared component, one fix.</div>` : '';
    return `<div class="issue" data-i="${idx}" data-impact="${i.impact}" data-kind="${i.category === 'best-practice' ? 'best-practice' : i.kind}" data-source="${isLint ? 'lint' : 'browser'}" data-page="${esc(i.page)}" data-states="${statesAttr}" style="border-left-color:${impactColor}">
      <h3>${esc(i.customFix ? i.customFix.what : i.help)}</h3>
      <div class="meta">
        ${kindPill}
        ${sourcePill}
        <span class="pill" style="background:${impactColor}22;color:${impactColor}">${i.impact}</span>
        <span class="mono">${esc(i.rule)}</span>
        ${crits}
        <span>· ${esc(i.page)}${i.states.length ? ' · ' + esc(i.states.join(', ')) : ''}</span>
        ${i.helpUrl ? `<a href="${esc(i.helpUrl)}" target="_blank" rel="noopener">${isLint ? 'rule docs' : 'axe docs'} ↗</a>` : ''}
      </div>
      ${crossRef}${alsoBy}${repeats}
      <div class="muted" style="font-size:12px">${esc(i.description || '')}</div>
      ${i.screenshot ? `<img src="${esc(i.screenshot)}" alt="Screenshot of the page with the failing element highlighted in red" style="max-width:100%;border:1px solid #e2e6ec;border-radius:6px;margin:8px 0;display:block">` : ''}
      <pre>${esc(i.html)}</pre>
      ${i.target ? `<div class="mono muted" style="font-size:11px;margin-top:-4px">${isLint ? 'At' : 'Selector'}: ${esc(i.target)}</div>` : ''}
      ${fix}
      ${locs ? `<div style="margin-top:6px"><div class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:.04em;margin-bottom:4px">${isLint ? 'In code' : 'Likely in code'}</div>${locs}</div>` : (meta.repoIndexed ? '<div class="muted" style="font-size:12px;margin-top:6px">No confident source match — search the element id/text manually.</div>' : '')}
    </div>`;
  }).join('');

  const filters = `<div class="filters">
    <button class="active" data-f="all">All (${issues.length})</button>
    <button data-f="critical">Critical (${data.stats.byImpact.critical})</button>
    <button data-f="serious">Serious (${data.stats.byImpact.serious})</button>
    <button data-f="moderate">Moderate (${data.stats.byImpact.moderate})</button>
    <button data-f="minor">Minor (${data.stats.byImpact.minor})</button>
    <button data-f="violation">Violations (${data.stats.confirmed ? data.stats.confirmed.total : data.stats.violations})</button>
    <button data-f="incomplete">Needs review (${data.stats.needsReview != null ? data.stats.needsReview : data.stats.incompletes})</button>
    ${data.stats.bestPractice ? `<button data-f="best-practice">Best practice (${data.stats.bestPractice})</button>` : ''}
    ${issues.some((i) => i.source === 'lint') ? `<button data-f="browser">Browser (${issues.filter((i) => i.source !== 'lint').length})</button>
    <button data-f="lint">Source lint (${issues.filter((i) => i.source === 'lint').length})</button>` : ''}
  </div>`;

  const js = `<script>
   const params=new URLSearchParams(location.search);
   const fPage=params.get('page'),fState=params.get('state');
   const allIssues=[...document.querySelectorAll('.issue')];
   let scoped=allIssues;
   if(fPage||fState){
     scoped=allIssues.filter(el=>{
       if(fPage&&el.dataset.page!==fPage)return false;
       if(fState){try{const st=JSON.parse(el.dataset.states||'[]');if(st.indexOf(fState)===-1)return false;}catch(e){return false;}}
       return true;
     });
     allIssues.forEach(el=>{if(scoped.indexOf(el)===-1)el.style.display='none';});
     const banner=document.createElement('div');
     banner.className='section';
     banner.style.cssText='padding:12px 18px;background:#eef4fb;border-color:#cddffb';
     banner.innerHTML='<b>Filtered</b> to '+(fPage?'page &ldquo;'+fPage.replace(/</g,"&lt;")+'&rdquo;':'')+(fPage&&fState?' · ':'')+(fState?'state &ldquo;'+fState.replace(/</g,"&lt;")+'&rdquo;':'')+' — '+scoped.length+' issue(s). <a href="'+location.pathname+'">Clear filter</a>';
     document.querySelector('.filters').before(banner);
   }
   const btns=[...document.querySelectorAll('.filters button')];
   btns.forEach(b=>b.onclick=()=>{btns.forEach(x=>x.classList.remove('active'));b.classList.add('active');
     const f=b.dataset.f;scoped.forEach(el=>{
       const show=f==='all'||el.dataset.impact===f||el.dataset.kind===f||el.dataset.source===f;el.style.display=show?'':'none';});});
  </script>`;

  const body = filters + (issues.length ? issueHtml : '<div class="section empty">No violations or review items found across the scanned pages. 🎉</div>') + js;
  return shell('Accessibility Issues & Fixes', nav, body).replace(
    '<div class="sub" id="sub"></div>',
    `<div class="sub">${issues.length} issues · ${esc(meta.baseUrl)} · ${esc(meta.generatedAt)}${meta.repoIndexed ? ` · ${meta.repoIndexed} source files indexed` : ' · code mapping off'}</div>`
  );
}

/** Writes the three outputs and returns the HTML, so callers (lib/bundle.js)
 *  can build the single-file bundle without re-rendering everything. */
function writeReports(outDir, data, opts = {}) {
  const prefix = opts.prefix || 'dashboard,report'; // "dashboard,report" -> dashboard.html/report.html
  const [dashName, reportName] = prefix.split(',');
  const dashboard = buildDashboard(data, { reportFile: `${reportName}.html` });
  const report = buildReport(data, { dashFile: `${dashName}.html` });
  fs.writeFileSync(path.join(outDir, `${dashName}.html`), dashboard);
  fs.writeFileSync(path.join(outDir, `${reportName}.html`), report);
  fs.writeFileSync(path.join(outDir, `${reportName}.json`), JSON.stringify({
    meta: data.meta, stats: data.stats, criteria: data.criteria, matrix: data.matrix, issues: data.issues,
    ...(data.verification ? { verification: data.verification } : {}),
  }, null, 2));
  return { dashboard, report, dashName, reportName };
}

module.exports = { writeReports };
