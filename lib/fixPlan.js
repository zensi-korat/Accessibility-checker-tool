/**
 * The fix plan: what to fix, in what order, and what is already done.
 *
 *   fix-plan.html   the page (works from file://, inside the single-file
 *                   report, and served live by `a11y fix`)
 *   fix-plan.json   the same data, read by `a11y fix` after every re-check
 *
 * Open work is the project's CURRENT state — every page's most recent scan,
 * not just the last run — so re-checking two pages never makes the rest of the
 * plan disappear. "Done" comes from the fix verification each run records:
 * a defect is only shown as fixed when a re-scan proved it (lib/verify.js).
 *
 * Team decisions (in progress / snoozed / won't fix) live in a11y.triage.json
 * next to the config, so they can be committed and shared. A plain report
 * opened from disk keeps them in the browser instead.
 */
const fs = require('fs');
const path = require('path');
const { prioritize, defectKey } = require('./priority');

const ASSET_DIR = path.join(__dirname, 'fixplan');
const readAsset = (f) => fs.readFileSync(path.join(ASSET_DIR, f), 'utf8');
const readUi = (f) => fs.readFileSync(path.join(__dirname, 'ui', f), 'utf8'); // shared components (custom select)
const commands = require('./ui/commands'); // the Commands dialog
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Where team triage decisions are stored for this config. */
function triageFile(config) {
  const dir = config && config._meta && !config._meta.quick && config._meta.configDir
    ? config._meta.configDir
    : (config && config.OUTPUT_DIR) || process.cwd();
  return path.join(dir, 'a11y.triage.json');
}

function readTriage(file) {
  try {
    const t = JSON.parse(fs.readFileSync(file, 'utf8'));
    return t && typeof t === 'object' && t.decisions && typeof t.decisions === 'object' ? t.decisions : {};
  } catch { return {}; }
}

const TRIAGE_STATES = new Set(['inprogress', 'snoozed', 'wontfix']);
/** Apply one decision (state null clears it) and save. Returns the new map. */
function writeTriage(file, key, decision) {
  if (!/^[0-9a-f]{12}$/.test(String(key))) throw new Error('bad key');
  const all = readTriage(file);
  if (!decision || !decision.state) delete all[key];
  else {
    if (!TRIAGE_STATES.has(decision.state)) throw new Error('bad state');
    all[key] = {
      state: decision.state,
      ...(decision.reason ? { reason: String(decision.reason).slice(0, 500) } : {}),
      ...(decision.until ? { until: new Date(decision.until).toISOString() } : {}),
      ...(decision.title ? { title: String(decision.title).slice(0, 200) } : {}),
      at: new Date().toISOString(),
    };
  }
  const body = {
    $comment: 'Accessibility fix-plan decisions (in progress / snoozed / won\'t fix). Commit this file to share them with your team.',
    decisions: all,
  };
  fs.writeFileSync(file, JSON.stringify(body, null, 2) + '\n');
  return all;
}

/**
 * Defects proven fixed by earlier runs (newest first), from each archived
 * run's verification block. Skips anything that is open again now; those are
 * reported as regressions on the open card instead.
 */
function loadDone(outDir, openKeys, limit = 300) {
  let manifest = [];
  try { manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'reports', 'manifest.json'), 'utf8')); } catch { return { done: [], fixedBefore: new Map() }; }
  const runs = manifest.slice().sort((a, b) => new Date(b.atISO || b.at) - new Date(a.atISO || a.at));
  const done = new Map();
  const fixedBefore = new Map(); // open key → when it was last fixed (it came back)
  for (const run of runs) {
    let rep;
    try { rep = JSON.parse(fs.readFileSync(path.join(outDir, 'reports', run.folder, 'report.json'), 'utf8')); } catch { continue; }
    const fixed = (rep.verification && rep.verification.fixed) || [];
    const at = run.atISO || rep.meta && rep.meta.generatedAtISO || null;
    for (const f of fixed) {
      if (!f.html && !f.lintKey && !f.target) continue;
      const key = defectKey(f);
      if (openKeys.has(key)) { if (!fixedBefore.has(key)) fixedBefore.set(key, at); continue; }
      const d = done.get(key);
      if (d) { if (!d.pages.includes(f.page)) d.pages.push(f.page); continue; }
      if (done.size >= limit) continue;
      done.set(key, {
        key, rule: f.rule, title: f.title || f.help || f.rule, impact: f.impact, kind: f.kind,
        bestPractice: f.category === 'best-practice', pages: [f.page], location: f.location || null, fixedAt: at,
      });
    }
  }
  return { done: [...done.values()], fixedBefore };
}

/**
 * @param {object[]} issues   current project-wide issues (latest scan per page)
 * @param {object}   opts     { outDir, meta, shotPrefix, triage }
 */
function buildPlanData(issues, opts = {}) {
  const plan = prioritize(issues, { triage: opts.triage || {} });
  const openKeys = new Set(plan.groups.map((g) => g.key));
  const { done, fixedBefore } = opts.outDir ? loadDone(opts.outDir, openKeys) : { done: [], fixedBefore: new Map() };
  const prefix = opts.shotPrefix || '';
  for (const g of plan.groups) {
    if (fixedBefore.has(g.key)) {
      g.regressedFrom = fixedBefore.get(g.key);
      g.reasons.unshift('Was fixed before and came back');
    }
    for (const e of g.elements) if (e.screenshot && !/^(data:|https?:|\/)/.test(e.screenshot)) e.screenshot = prefix + e.screenshot;
  }
  const meta = opts.meta || {};
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    project: meta.reportName || '',
    baseUrl: meta.baseUrl || '',
    pages: [...new Set(issues.map((i) => i.page))],
    tiers: plan.tiers,
    counts: plan.counts,
    groups: plan.groups,
    done,
  };
}

/**
 * The page. `mode`:
 *   'file'   — opened from disk; decisions are kept in the browser
 *   'live'   — served by `a11y fix`; re-check buttons, decisions saved to disk
 *   'bundle' — the fragment for the single-file report (body only)
 */
function renderFixPlan(data, { mode = 'file', live = null, title } = {}) {
  const payload = { ...data, mode, live };
  if (mode === 'bundle') {
    // The single file inlines no screenshots here (the findings view already
    // embeds them); dropping the paths avoids broken thumbnails.
    payload.groups = payload.groups.map((g) => ({ ...g, elements: g.elements.map((e) => ({ ...e, screenshot: '' })) }));
  }
  const json = JSON.stringify(payload).replace(/</g, '\\u003c').replace(/[\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16)}`);
  const body = `<div id="fp-root" class="fp" data-mode="${esc(mode)}">
  <noscript><p class="fp-noscript">The fix plan needs JavaScript. The same issues are listed in the detailed report.</p></noscript>
</div>
<script type="application/json" id="fp-data">${json}</script>
<script>${readUi('select.js')}</script>
${commands.script()}
<script>${readAsset('client.js')}</script>`;
  if (mode === 'bundle') return { body, css: readUi('select.css') + commands.CSS + readAsset('style.css') };
  const pageTitle = title || `Fix plan${data.project ? ` · ${data.project}` : ''}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(pageTitle)}</title>
<style>${readUi('select.css')}${commands.CSS}${readAsset('style.css')}</style></head>
<body class="fp-page">${body}</body></html>`;
}

/** Write fix-plan.html + fix-plan.json into outDir. */
function writeFixPlan(outDir, issues, opts = {}) {
  const triage = opts.triageFile ? readTriage(opts.triageFile) : {};
  const data = buildPlanData(issues, { outDir, meta: opts.meta, shotPrefix: opts.shotPrefix, triage });
  fs.writeFileSync(path.join(outDir, 'fix-plan.json'), JSON.stringify(data));
  fs.writeFileSync(path.join(outDir, 'fix-plan.html'), renderFixPlan(data, { mode: 'file' }));
  return data;
}

module.exports = { buildPlanData, renderFixPlan, writeFixPlan, readTriage, writeTriage, triageFile, loadDone };
