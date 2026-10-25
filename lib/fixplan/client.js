/* Fix plan — client. Plain ES2017, no dependencies.
 * Modes: 'file' (opened from disk), 'bundle' (inside the single-file report),
 * 'live' (served by `a11y fix`: re-checks + server-side decisions + SSE). */
(function () {
  'use strict';
  var root = document.getElementById('fp-root');
  var dataEl = document.getElementById('fp-data');
  if (!root || !dataEl) return;
  var D = JSON.parse(dataEl.textContent);
  var MODE = D.mode || 'file';
  var LIVE = MODE === 'live' && D.live ? D.live : null;
  var STORE = 'a11y-fixplan:' + (D.project || D.baseUrl || 'default');
  var WORK = ['now', 'next', 'plan'];

  var ui = { q: '', page: '', quick: false, groupBy: 'tier', collapsed: { done: true, later: true, aside: true }, open: {}, showAllEls: {}, current: null };
  var live = { checking: {}, still: {}, fresh: {}, connected: false, run: null, log: [], lastPages: null };
  try {
    var savedUi = JSON.parse(localStorage.getItem(STORE + ':ui') || 'null');
    if (savedUi) {
      ui.groupBy = savedUi.groupBy || 'tier';
      ui.quick = !!savedUi.quick;
      for (var k in savedUi.collapsed || {}) ui.collapsed[k] = savedUi.collapsed[k];
    }
  } catch (e) { /* storage unavailable */ }
  function saveUi() {
    try { localStorage.setItem(STORE + ':ui', JSON.stringify({ groupBy: ui.groupBy, quick: ui.quick, collapsed: ui.collapsed })); } catch (e) { /* ignore */ }
  }

  // ── Decisions (in progress / snoozed / won't fix) ─────────────────────────
  var localTriage = {};
  if (!LIVE) { try { localTriage = JSON.parse(localStorage.getItem(STORE + ':triage') || '{}') || {}; } catch (e) { localTriage = {}; } }
  function triageOf(g) {
    var t = LIVE ? g.triage : (localTriage[g.key] || g.triage);
    if (t && t.state === 'snoozed' && t.until && new Date(t.until) < new Date()) return null;
    return t || null;
  }
  function isAside(g) { var t = triageOf(g); return !!t && (t.state === 'snoozed' || t.state === 'wontfix'); }
  function setTriage(g, decision) {
    if (LIVE) {
      return api('/api/triage', { key: g.key, decision: decision ? Object.assign({ title: g.title }, decision) : null })
        .then(function (res) { g.triage = res.decision || null; render(); })
        .catch(function (e) { toast('err', 'Could not save the decision', e.message); });
    }
    if (decision) localTriage[g.key] = Object.assign({ at: new Date().toISOString() }, decision);
    else delete localTriage[g.key];
    try { localStorage.setItem(STORE + ':triage', JSON.stringify(localTriage)); } catch (e) { /* ignore */ }
    render();
    return Promise.resolve();
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
  function ago(iso) {
    if (!iso) return '';
    var s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
    if (isNaN(s)) return '';
    if (s < 45) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    if (s < 86400 * 14) return Math.round(s / 86400) + ' days ago';
    return new Date(iso).toLocaleDateString();
  }
  function fmtDate(iso) { try { return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }); } catch (e) { return ''; } }
  function tierById(id) { for (var i = 0; i < D.tiers.length; i++) if (D.tiers[i].id === id) return D.tiers[i]; return { id: id, label: id, blurb: '' }; }
  function groupByKey(key) { for (var i = 0; i < D.groups.length; i++) if (D.groups[i].key === key) return D.groups[i]; return null; }
  function baseName(f) { return String(f || '').split(/[\\/]/).pop(); }
  function icon(name) {
    var p = {
      search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
      caret: '<path d="m6 9 6 6 6-6"/>',
      refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>',
      more: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
      copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
      terminal: '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
      ext: '<path d="M14 4h6v6"/><path d="M20 4 10 14"/><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/>',
    }[name] || '';
    return '<svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + p + '</svg>';
  }

  // ── Filtering ─────────────────────────────────────────────────────────────
  function haystack(g) {
    return [g.title, g.rule, g.help, (g.criteria || []).map(function (c) { return c.id + ' ' + c.name; }).join(' '),
      g.pages.map(function (p) { return p.name; }).join(' '),
      g.locations.map(function (l) { return l.file; }).join(' '),
      (g.affects || []).map(function (a) { return a.label; }).join(' ')].join(' ').toLowerCase();
  }
  function visible(g) {
    if (ui.quick && !g.quickWin) return false;
    if (ui.page && !g.pages.some(function (p) { return p.name === ui.page; })) return false;
    if (ui.q) {
      var h = haystack(g);
      var words = ui.q.toLowerCase().split(/\s+/).filter(Boolean);
      for (var i = 0; i < words.length; i++) if (h.indexOf(words[i]) === -1) return false;
    }
    return true;
  }

  // ── Progress numbers ──────────────────────────────────────────────────────
  function progress() {
    var open = { now: 0, next: 0, plan: 0, review: 0, later: 0 }, aside = 0;
    D.groups.forEach(function (g) {
      var t = triageOf(g);
      if (t && t.state === 'wontfix') { aside++; return; }
      if (t && t.state === 'snoozed') aside++;
      open[g.tier] = (open[g.tier] || 0) + 1;
    });
    var done = D.done.filter(function (d) { return !d.bestPractice && d.kind !== 'incomplete'; }).length;
    var work = open.now + open.next + open.plan;
    var total = done + work;
    return { open: open, aside: aside, done: done, work: work, total: total, pct: total ? Math.round(done / total * 100) : 100 };
  }

  // ── Shell (rendered once) ─────────────────────────────────────────────────
  function shell() {
    var pages = D.pages.slice().sort();
    root.innerHTML =
      '<header class="fp-head"><div><h1>Fix plan</h1><div class="fp-sub" id="fp-sub"></div></div>'
      + '<div class="fp-head-actions" id="fp-head-actions"></div></header>'
      + '<div id="fp-banner"></div>'
      + '<div class="fp-activity" id="fp-activity" hidden></div>'
      + '<section class="fp-hero" aria-label="Progress" id="fp-hero"></section>'
      + '<div class="fp-toolbar" role="search">'
      + '  <div class="fp-search">' + icon('search') + '<label class="sr" for="fp-q">Filter issues</label>'
      + '    <input id="fp-q" type="search" placeholder="Filter by issue, page, file or WCAG criterion  ( / )" autocomplete="off"></div>'
      + '  <label class="sr" for="fp-page">Page</label><select id="fp-page"><option value="">All pages</option>'
      + pages.map(function (p) { return '<option>' + esc(p) + '</option>'; }).join('') + '</select>'
      + '  <label class="sr" for="fp-group">Group by</label><select id="fp-group">'
      + '    <option value="tier">Group: by priority</option><option value="page">Group: by page</option><option value="file">Group: by source file</option></select>'
      + '  <label class="fp-toggle-label"><input type="checkbox" id="fp-quick"> Quick wins only</label>'
      + '  <span class="fp-count" id="fp-count" aria-live="polite"></span>'
      + '</div>'
      + '<div id="fp-lanes"></div>'
      + '<div class="fp-toasts" id="fp-toasts"></div>'
      + '<div class="sr" aria-live="polite" id="fp-announce"></div>'
      + '<dialog class="fp-dialog" id="fp-wontfix"><form method="dialog"><h2>Won\'t fix this issue?</h2>'
      + '<p class="fp-sub" id="fp-wontfix-title"></p><label for="fp-wontfix-reason">Why (shown to the team)</label>'
      + '<textarea id="fp-wontfix-reason" placeholder="e.g. Third-party widget, tracked with the vendor in TICKET-123" required></textarea>'
      + '<div class="fp-dactions"><button class="fp-btn" value="cancel" formnovalidate>Cancel</button><button class="fp-btn primary" value="ok">Set aside</button></div></form></dialog>'
      + '<dialog class="fp-dialog shot" id="fp-shot"><div class="fp-dbody"><h2 id="fp-shot-title">Screenshot</h2><img id="fp-shot-img" alt="">'
      + '<div class="fp-dactions"><button class="fp-btn" data-act="close-dialog">Close</button></div></div></dialog>'
      + '<dialog class="fp-dialog" id="fp-keys"><div class="fp-dbody"><h2>Keyboard shortcuts</h2><div class="fp-keys">'
      + '<kbd>/</kbd><span>Filter issues</span><kbd>j</kbd><span>Next issue</span><kbd>k</kbd><span>Previous issue</span>'
      + '<kbd>Enter</kbd><span>Open or close the issue</span>' + (LIVE ? '<kbd>r</kbd><span>Re-check the issue</span>' : '')
      + '<kbd>p</kbd><span>Mark in progress</span><kbd>c</kbd><span>Commands (re-scan, verify, lint…)</span><kbd>?</kbd><span>This help</span></div>'
      + '<div class="fp-dactions"><button class="fp-btn" data-act="close-dialog">Close</button></div></div></dialog>';
    var q = document.getElementById('fp-q');
    q.addEventListener('input', function () { ui.q = q.value.trim(); renderLanes(); });
    var pg = document.getElementById('fp-page');
    pg.addEventListener('change', function () { ui.page = pg.value; renderLanes(); });
    var grp = document.getElementById('fp-group');
    grp.value = ui.groupBy;
    grp.addEventListener('change', function () { ui.groupBy = grp.value; saveUi(); renderLanes(); });
    // Custom, accessible dropdowns (lib/ui/select.js); the native selects stay the source of truth.
    if (window.A11ySelect) { window.A11ySelect.enhance(pg); window.A11ySelect.enhance(grp); }
    var quick = document.getElementById('fp-quick');
    quick.checked = ui.quick;
    quick.addEventListener('change', function () { ui.quick = quick.checked; saveUi(); renderLanes(); });
  }

  function renderHeader() {
    var sub = [];
    if (D.project) sub.push(esc(D.project));
    if (D.baseUrl) sub.push(esc(D.baseUrl));
    sub.push('Last checked <span data-ago="' + esc(D.generatedAt) + '">' + esc(ago(D.generatedAt)) + '</span>');
    sub.push(plural(D.pages.length, 'page'));
    document.getElementById('fp-sub').innerHTML = sub.join(' · ');
    var acts = '';
    if (LIVE) {
      acts += live.connected
        ? '<span class="fp-live on"><span class="fp-dot"></span>Live' + (LIVE.watch ? ': re-checks when you save' : '') + '</span>'
        : '<span class="fp-live off"><span class="fp-dot"></span>Disconnected</span>';
      var busy = !!live.run;
      acts += '<button class="fp-btn primary" data-act="recheck-all"' + (busy ? ' disabled' : '') + '>'
        + (busy ? '<span class="fp-spin" aria-hidden="true"></span>Re-checking…' : icon('refresh') + 'Re-check all open') + '</button>';
    }
    acts += '<button class="fp-btn" data-open-commands data-base-url="' + esc(D.baseUrl) + '" id="fp-cmds-btn">' + icon('terminal') + 'Commands</button>';
    acts += '<button class="fp-btn ghost" data-act="keys" title="Keyboard shortcuts">Shortcuts <kbd>?</kbd></button>';
    document.getElementById('fp-head-actions').innerHTML = acts;

    var banner = '';
    if (!LIVE) {
      banner = '<div class="fp-static"><span>This is a snapshot. To see fixes tick off <b>as you make them</b>, run</span>'
        + '<code id="fp-cmd">npx accessibility-check fix</code>'
        + '<button class="fp-btn small" data-act="copy-cmd">' + icon('copy') + 'Copy</button>'
        + '<span>in your project.</span>'
        + '<button class="fp-btn small ghost" data-open-commands data-base-url="' + esc(D.baseUrl) + '">All commands</button>'
        + '<span class="fp-sub" style="flex-basis:100%">Decisions you make on this page are saved in this browser only.</span></div>';
    } else if (LIVE.watch) {
      banner = '';
    }
    document.getElementById('fp-banner').innerHTML = banner;
  }

  function renderHero() {
    var p = progress();
    var seg = function (cls, n) { return n ? '<span class="' + cls + '" style="width:' + (n / Math.max(1, p.total) * 100) + '%"></span>' : ''; };
    var chip = function (id, label, n) {
      return '<button class="fp-chip t-' + id + '" data-act="jump" data-tier="' + id + '" aria-label="' + esc(label + ': ' + n + '. Jump to section') + '"><i></i>' + esc(label) + ' <b>' + n + '</b></button>';
    };
    var headline = p.total === 0
      ? '<div class="fp-big">Nothing to fix</div>'
      : '<div class="fp-big">' + p.done + ' <small>of ' + plural(p.total, 'issue') + ' fixed</small></div>';
    var left = '<div class="fp-panel"><div class="fp-progress-top">' + headline
      + '<span class="fp-pct">' + p.pct + '% done</span></div>'
      + '<div class="fp-bar" role="img" aria-label="' + esc(p.done + ' fixed, ' + p.open.now + ' fix first, ' + p.open.next + ' fix next, ' + p.open.plan + ' scheduled') + '">'
      + seg('s-done', p.done) + seg('s-now', p.open.now) + seg('s-next', p.open.next) + seg('s-plan', p.open.plan) + '</div>'
      + '<div class="fp-legend">'
      + chip('now', 'Fix first', p.open.now) + chip('next', 'Fix next', p.open.next) + chip('plan', 'Schedule', p.open.plan)
      + chip('done', 'Done', D.done.length) + chip('review', 'Needs a decision', p.open.review) + chip('later', 'Can wait', p.open.later)
      + (p.aside ? chip('aside', 'Set aside', p.aside) : '')
      + '</div>'
      + '<div class="fp-note">Progress counts confirmed WCAG failures. Items needing a decision and best-practice items are listed but not counted.'
      + (D.counts.quickWins ? ' <b>' + plural(D.counts.quickWins, 'quick win') + '</b> (about 5 minutes each) are in the top two groups.' : '') + '</div></div>';

    var nxt = null;
    for (var i = 0; i < D.groups.length && !nxt; i++) {
      var g = D.groups[i];
      if (WORK.indexOf(g.tier) !== -1 && !isAside(g)) nxt = g;
    }
    var right;
    if (!nxt) {
      right = '<div class="fp-panel fp-next empty"><h2>Up next</h2><h3>All confirmed issues are fixed or set aside</h3>'
        + '<p class="fp-sub">' + (p.open.review ? plural(p.open.review, 'item') + ' still need a decision from a person. ' : '')
        + 'Automated checks cover about a third of WCAG; the detailed report lists what a person still needs to test.</p></div>';
    } else {
      right = '<div class="fp-panel fp-next"><h2>Up next</h2><h3>' + esc(nxt.title) + '</h3>' + reasonsHtml(nxt, 4)
        + '<div class="fp-next-actions"><button class="fp-btn primary" data-act="goto" data-key="' + nxt.key + '">Show me how to fix it</button>'
        + (LIVE ? '<button class="fp-btn" data-act="recheck" data-key="' + nxt.key + '">' + icon('refresh') + 'Re-check</button>' : '')
        + '</div></div>';
    }
    document.getElementById('fp-hero').innerHTML = left + right;
  }

  function reasonsHtml(g, max) {
    var list = g.reasons.slice(0, max || 99);
    return '<ul class="fp-reasons" aria-label="Why it is ranked here">' + list.map(function (r) {
      var cls = /^Blocks/.test(r) ? ' block' : /^Quick fix/.test(r) ? ' quick' : /One fix clears|occurrences/.test(r) ? ' reach' : /came back/i.test(r) ? ' back' : '';
      return '<li class="fp-reason' + cls + '">' + esc(r) + '</li>';
    }).join('') + '</ul>';
  }

  function statusHtml(g) {
    var t = triageOf(g);
    if (live.checking[g.key]) return '<span class="fp-status checking"><span class="fp-spin" aria-hidden="true"></span>Checking…</span>';
    if (live.fresh[g.key]) return '<span class="fp-status new">New</span>';
    if (live.still[g.key]) return '<span class="fp-status still">Still failing · ' + esc(new Date(live.still[g.key]).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })) + '</span>';
    if (t && t.state === 'inprogress') return '<span class="fp-status inprogress">In progress</span>';
    if (t && t.state === 'snoozed') return '<span class="fp-status snoozed">Snoozed to ' + esc(fmtDate(t.until)) + '</span>';
    if (t && t.state === 'wontfix') return '<span class="fp-status wontfix">Won\'t fix</span>';
    if (g.regressedFrom) return '<span class="fp-status still">Came back</span>';
    return '';
  }

  function metaHtml(g) {
    var m = [];
    m.push('<span class="fp-impact ' + esc(g.impact) + '">' + esc(g.impact) + '</span>');
    if (g.criteria && g.criteria.length) m.push('<span>WCAG ' + g.criteria.map(function (c) { return esc(c.id) + ' (' + esc(c.level) + ')'; }).join(', ') + '</span>');
    else m.push('<span>Best practice</span>');
    m.push('<span>' + (g.pages.length === 1 ? esc(g.pages[0].name) : plural(g.pages.length, 'page')) + (g.occurrences > g.pages.length ? ' · ' + plural(g.occurrences, 'element') : '') + '</span>');
    m.push('<span>Effort ' + esc(g.effort.label) + '</span>');
    var loc = bestLoc(g);
    if (loc) m.push('<span><code>' + esc(baseName(loc.file)) + (loc.line ? ':' + loc.line : '') + '</code></span>');
    if (g.source === 'lint') m.push('<span>Source lint</span>');
    return '<span class="fp-meta">' + m.join('') + '</span>';
  }

  // A low-confidence code match is a guess; don't put a guess on the card face.
  function bestLoc(g) {
    for (var i = 0; i < g.locations.length; i++) if (g.locations[i].confidence !== 'low') return g.locations[i];
    return null;
  }
  // Fix advice uses `code` spans; show them as code.
  function rich(text) { return esc(text).replace(/`([^`]+)`/g, '<code>$1</code>'); }

  function cardHtml(g) {
    var open = !!ui.open[g.key];
    var cls = 'fp-card t-' + g.tier + (ui.current === g.key ? ' is-current' : '') + (live.checking[g.key] ? ' is-checking' : '') + (live.fresh[g.key] ? ' is-new' : '');
    var side = statusHtml(g)
      + (LIVE ? '<button class="fp-btn small" data-act="recheck" data-key="' + g.key + '" data-focus="rc:' + g.key + '"' + (live.checking[g.key] ? ' disabled' : '') + ' aria-label="Re-check: ' + esc(g.title) + '">' + icon('refresh') + '<span>Re-check</span></button>' : '')
      + '<div class="fp-menu"><button class="fp-btn small ghost" data-act="menu" data-key="' + g.key + '" data-focus="mn:' + g.key + '" aria-haspopup="true" aria-expanded="false" aria-label="More actions: ' + esc(g.title) + '">' + icon('more') + '</button>'
      + '<div class="fp-menu-pop" hidden>' + menuItems(g) + '</div></div>';
    return '<li class="' + cls + '" data-key="' + g.key + '">'
      + '<div class="fp-row"><span class="fp-rank" title="Priority ' + g.rank + '"><span class="sr">Priority </span>' + g.rank + '</span>'
      + '<button class="fp-open" data-act="toggle" data-key="' + g.key + '" data-focus="op:' + g.key + '" aria-expanded="' + open + '" aria-controls="fp-d-' + g.key + '">'
      + '<span class="fp-title">' + esc(g.title) + '</span>' + metaHtml(g) + '</button>'
      + '<div class="fp-side">' + side + '</div></div>'
      + '<div class="fp-detail" id="fp-d-' + g.key + '"' + (open ? '' : ' hidden') + '>' + (open ? detailHtml(g) : '') + '</div>'
      + '</li>';
  }

  function menuItems(g) {
    var t = triageOf(g);
    var b = function (act, label, hint) { return '<button data-act="' + act + '" data-key="' + g.key + '">' + esc(label) + (hint ? '<small>' + esc(hint) + '</small>' : '') + '</button>'; };
    return (t && t.state === 'inprogress' ? b('t-clear', 'Not in progress') : b('t-progress', 'Mark in progress', 'p'))
      + '<hr>' + b('t-snooze-1', 'Snooze for a day') + b('t-snooze-7', 'Snooze for a week') + b('t-snooze-30', 'Snooze for a month')
      + b('t-wontfix', 'Won\'t fix…')
      + (t && t.state !== 'inprogress' ? b('t-clear', 'Clear decision') : '')
      + '<hr>' + b('copy', 'Copy as ticket (Markdown)');
  }

  function detailHtml(g) {
    var t = triageOf(g);
    var parts = [];
    var why = '<div><h4>Why it is ranked #' + g.rank + '</h4><ul class="fp-why">' + g.reasons.map(function (r) { return '<li>' + esc(r) + '</li>'; }).join('') + '</ul>'
      + (g.affects && g.affects.length ? '<p class="fp-sub" style="margin-top:8px">Affects: ' + g.affects.map(function (a) { return esc(a.label); }).join(', ') + '</p>' : '')
      + '</div>';
    var fixText = (g.fix && g.fix.fix) || g.failureSummary || g.help || g.description;
    var how = '<div><h4>How to fix</h4><div class="fp-fix">' + rich(fixText) + '</div>'
      + (g.helpUrl ? '<p style="margin-top:8px"><a href="' + esc(g.helpUrl) + '" target="_blank" rel="noopener">Rule documentation ' + icon('ext') + '<span class="sr"> (opens in a new tab)</span></a></p>' : '')
      + (g.alsoFlaggedBy ? '<p class="fp-sub">Also reported by: ' + esc([].concat(g.alsoFlaggedBy).join(', ')) + '</p>' : '')
      + '</div>';
    parts.push(why, how);
    var ordered = g.locations.slice().sort(function (a, b) { return (a.confidence === 'low') - (b.confidence === 'low'); });
    var locs = g.locations.length
      ? '<ul class="fp-locs">' + ordered.map(function (l) {
        return '<li><code>' + esc(l.file) + (l.line ? ':' + l.line : '') + '</code>' + (l.confidence ? '<span class="fp-conf ' + esc(l.confidence) + '">' + (l.confidence === 'low' ? 'possible match' : esc(l.confidence) + ' match') + '</span>' : '') + '</li>';
      }).join('') + '</ul>'
      : '<p class="fp-sub">No source location found. Use the element below to find it, or set <code>REPO_PATH</code> in the config so the scanner can map issues to files.</p>';
    parts.push('<div class="full"><h4>Where in your code</h4>' + locs + '</div>');
    var all = !!ui.showAllEls[g.key];
    var els = all ? g.elements : g.elements.slice(0, 4);
    parts.push('<div class="full"><h4>Affected elements (' + g.occurrences + ')</h4><ul class="fp-els">' + els.map(function (e, ix) {
      var shot = e.screenshot ? '<button class="fp-shot" data-act="shot" data-key="' + g.key + '" data-ix="' + ix + '" aria-label="View screenshot of this element on ' + esc(e.page) + '"><img src="' + esc(e.screenshot) + '" alt="" loading="lazy"></button>' : '';
      var states = (e.states || []).filter(function (s) { return s !== 'initial'; });
      return '<li class="fp-el">' + shot + '<div style="min-width:0;flex:1"><div class="fp-el-page">'
        + (e.url ? '<a href="' + esc(e.url) + '" target="_blank" rel="noopener">' + esc(e.page) + '<span class="sr"> (opens in a new tab)</span></a>' : esc(e.page))
        + (states.length ? ' <span class="fp-sub">· ' + esc(states.join(', ')) + '</span>' : '') + '</div>'
        + (e.target ? '<div class="fp-el-sel"><code>' + esc(e.target) + '</code></div>' : '')
        + (e.html ? '<pre>' + esc(e.html) + '</pre>' : '') + '</div></li>';
    }).join('') + '</ul>'
      + (g.elements.length > 4 && !all ? '<button class="fp-btn small" style="margin-top:8px" data-act="all-els" data-key="' + g.key + '">Show all ' + g.elements.length + '</button>' : '')
      + (g.occurrences > g.elements.length ? '<p class="fp-sub">Showing the first ' + g.elements.length + ' of ' + g.occurrences + '. The detailed report lists every one.</p>' : '')
      + '</div>');
    var note = '';
    if (t && t.state === 'wontfix') note = '<div class="fp-triage-note"><b>Won\'t fix</b>' + (t.reason ? ': ' + esc(t.reason) : '') + (t.at ? ' · ' + esc(fmtDate(t.at)) : '') + '</div>';
    if (t && t.state === 'snoozed') note = '<div class="fp-triage-note"><b>Snoozed</b> until ' + esc(fmtDate(t.until)) + '. It comes back into the plan after that.</div>';
    parts.push('<div class="full fp-detail-actions">' + note
      + (LIVE ? '<button class="fp-btn primary" data-act="recheck" data-key="' + g.key + '"' + (live.checking[g.key] ? ' disabled' : '') + '>' + icon('refresh') + 'I fixed it: re-check now</button>' : '')
      + (t && t.state === 'inprogress' ? '<button class="fp-btn" data-act="t-clear" data-key="' + g.key + '">Not in progress</button>' : '<button class="fp-btn" data-act="t-progress" data-key="' + g.key + '">Mark in progress</button>')
      + '<button class="fp-btn" data-act="copy" data-key="' + g.key + '">' + icon('copy') + 'Copy as ticket</button>'
      + (!LIVE ? '<span class="fp-sub" style="align-self:center">After fixing, run <code>npx accessibility-check verify</code> to confirm.</span>' : '')
      + '</div>');
    return parts.join('');
  }

  // ── Lanes ─────────────────────────────────────────────────────────────────
  function laneHtml(id, cls, title, blurb, items, total, extra) {
    var collapsed = !!ui.collapsed[id];
    return '<section class="fp-lane ' + cls + '" id="fp-lane-' + esc(id) + '" aria-labelledby="fp-lh-' + esc(id) + '">'
      + '<button class="fp-lane-head" data-act="lane" data-lane="' + esc(id) + '" data-focus="ln:' + esc(id) + '" aria-expanded="' + !collapsed + '" aria-controls="fp-ll-' + esc(id) + '">'
      + '<span class="fp-caret">' + icon('caret') + '</span><h2 id="fp-lh-' + esc(id) + '">' + esc(title) + ' <span class="fp-lane-tag">' + (total != null && total !== items ? items + '/' + total : items) + '</span></h2></button>'
      + (blurb ? '<p class="fp-lane-blurb">' + esc(blurb) + '</p>' : '')
      + '<div id="fp-ll-' + esc(id) + '"' + (collapsed ? ' hidden' : '') + '>' + (collapsed ? '' : extra) + '</div></section>';
  }

  function renderLanes() {
    var out = '';
    var shown = 0, totalOpen = 0;
    var active = D.groups.filter(function (g) { return !isAside(g); });
    var aside = D.groups.filter(isAside);
    totalOpen = active.length;
    if (ui.groupBy === 'tier') {
      D.tiers.forEach(function (t) {
        var all = active.filter(function (g) { return g.tier === t.id; });
        var vis = all.filter(visible);
        shown += vis.length;
        if (!all.length && (t.id === 'later' || t.id === 'review')) return;
        var body = vis.length ? '<ol class="fp-list">' + vis.map(cardHtml).join('') + '</ol>'
          : '<div class="fp-empty">' + (all.length ? 'No issues match the filter.' : t.id === 'now' ? 'Nothing blocking. Nice work.' : 'Nothing here.') + '</div>';
        out += laneHtml(t.id, 't-' + t.id, t.label, t.blurb, vis.length, all.length, body);
      });
    } else {
      var buckets = {};
      active.filter(visible).forEach(function (g) {
        var names = ui.groupBy === 'page' ? g.pages.map(function (p) { return p.name; }) : [g.locations[0] ? g.locations[0].file : 'No source location found'];
        names.forEach(function (n) { (buckets[n] = buckets[n] || []).push(g); });
        shown++;
      });
      var keys = Object.keys(buckets).sort(function (a, b) { return buckets[a][0].rank - buckets[b][0].rank; });
      if (!keys.length) out += '<div class="fp-empty" style="margin-top:22px">No issues match the filter.</div>';
      keys.forEach(function (n) {
        var list = buckets[n];
        var urgent = list.filter(function (g) { return g.tier === 'now'; }).length;
        out += laneHtml('g:' + n, 't-group', n, urgent ? plural(urgent, 'issue') + ' to fix first' : '', list.length, null, '<ol class="fp-list">' + list.map(cardHtml).join('') + '</ol>');
      });
    }
    if (aside.length) {
      out += laneHtml('aside', 't-aside', 'Set aside', 'Snoozed or marked won\'t fix. Snoozed items return automatically.', aside.length, null,
        '<ol class="fp-list">' + aside.map(cardHtml).join('') + '</ol>');
    }
    var doneBody = D.done.length ? '<ol class="fp-list">' + D.done.map(function (d) {
      return '<li class="fp-done-item"><span class="fp-check" aria-hidden="true">✓</span><div class="grow"><div><b>' + esc(d.title) + '</b></div>'
        + '<span class="fp-meta"><span>' + esc(d.pages.join(', ')) + '</span>' + (d.location ? '<span><code>' + esc(baseName(d.location)) + '</code></span>' : '')
        + (d.fixedAt ? '<span>Fixed ' + esc(ago(d.fixedAt)) + '</span>' : '') + '</span></div></li>';
    }).join('') + '</ol>' : '<div class="fp-empty">Fixes show up here once a re-check proves them.' + (LIVE ? ' Use “Re-check” after fixing.' : ' Run <code>npx accessibility-check verify</code> after fixing.') + '</div>';
    out += laneHtml('done', 't-done', 'Done', 'Proven fixed by a re-check.', D.done.length, null, doneBody);
    var lanes = document.getElementById('fp-lanes');
    var focus = document.activeElement && document.activeElement.getAttribute && document.activeElement.getAttribute('data-focus');
    lanes.innerHTML = out;
    if (focus) { var el = lanes.querySelector('[data-focus="' + focus.replace(/"/g, '') + '"]'); if (el) el.focus({ preventScroll: true }); }
    var toFix = active.filter(function (g) { return WORK.indexOf(g.tier) !== -1; }).length;
    var toDecide = active.length - toFix;
    document.getElementById('fp-count').textContent = (ui.q || ui.page || ui.quick)
      ? 'Showing ' + shown + ' of ' + totalOpen
      : toFix + ' to fix' + (toDecide ? ' · ' + toDecide + ' to decide or defer' : '');
  }

  function renderActivity() {
    var el = document.getElementById('fp-activity');
    if (!LIVE || !live.run) { if (!live.lastResult) { el.hidden = true; return; } }
    var r = live.run;
    if (r) {
      var pct = r.total ? Math.round(r.doneCount / r.total * 100) : 5;
      el.className = 'fp-activity';
      el.innerHTML = '<span class="fp-spin" style="width:16px;height:16px;border:2px solid var(--review);border-right-color:transparent;border-radius:50%;animation:fp-rot .8s linear infinite" aria-hidden="true"></span>'
        + '<div class="grow"><b>' + esc(r.label) + '</b>' + (r.current ? ' · ' + esc(r.current) : '')
        + '<div class="fp-mini" role="progressbar" aria-label="Re-check progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '"><span style="width:' + pct + '%"></span></div></div>'
        + '<button class="fp-btn small" data-act="log">' + (live.showLog ? 'Hide' : 'Show') + ' log</button>'
        + (live.showLog ? '<pre class="fp-log">' + esc(live.log.slice(-200).join('\n')) + '</pre>' : '');
      el.hidden = false;
      return;
    }
    var res = live.lastResult;
    el.className = 'fp-activity ' + (res.ok ? 'ok' : 'error');
    el.innerHTML = '<div class="grow"><b>' + esc(res.title) + '</b>' + (res.detail ? ' · ' + esc(res.detail) : '') + '</div>'
      + '<button class="fp-btn small" data-act="log">' + (live.showLog ? 'Hide' : 'Show') + ' log</button>'
      + '<button class="fp-btn small ghost" data-act="dismiss-activity" aria-label="Dismiss">✕</button>'
      + (live.showLog ? '<pre class="fp-log">' + esc(live.log.slice(-200).join('\n')) + '</pre>' : '');
    el.hidden = false;
  }

  function render() { renderHeader(); renderHero(); renderLanes(); renderActivity(); }

  // ── Toasts & announcements ────────────────────────────────────────────────
  function announce(msg) { var a = document.getElementById('fp-announce'); a.textContent = ''; setTimeout(function () { a.textContent = msg; }, 50); }
  function toast(kind, title, body) {
    var box = document.getElementById('fp-toasts');
    var t = document.createElement('div');
    t.className = 'fp-toast ' + (kind || '');
    t.setAttribute('role', kind === 'err' ? 'alert' : 'status');
    t.innerHTML = '<div><b>' + esc(title) + '</b>' + (body ? '<span>' + esc(body) + '</span>' : '') + '</div><button aria-label="Dismiss">×</button>';
    t.querySelector('button').onclick = function () { t.remove(); };
    box.appendChild(t);
    while (box.children.length > 4) box.firstChild.remove();
    setTimeout(function () { if (t.parentNode) t.remove(); }, kind === 'err' ? 12000 : 7000);
  }

  // ── Clipboard ─────────────────────────────────────────────────────────────
  function copy(text, what) {
    var done = function () { toast('', 'Copied', what); };
    if (navigator.clipboard && window.isSecureContext) { navigator.clipboard.writeText(text).then(done, fallback); } else fallback();
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { toast('err', 'Could not copy', 'Select the text and copy it manually.'); }
      ta.remove();
    }
  }
  function ticket(g) {
    var lines = ['## [A11y] ' + g.title, '',
      '**Priority:** ' + tierById(g.tier).label + ' (#' + g.rank + ') · **Impact:** ' + g.impact + ' · **Effort:** ' + g.effort.label,
      '**WCAG:** ' + ((g.criteria || []).map(function (c) { return c.id + ' ' + c.name + ' (' + c.level + ')'; }).join(', ') || 'Best practice'),
      '**Pages:** ' + g.pages.map(function (p) { return p.name; }).join(', '), '',
      '### Why it matters', g.reasons.map(function (r) { return '- ' + r; }).join('\n'), '',
      '### How to fix', (g.fix && g.fix.fix) || g.failureSummary || g.help, ''];
    if (g.locations.length) lines.push('### Where', g.locations.map(function (l) { return '- `' + l.file + (l.line ? ':' + l.line : '') + '`'; }).join('\n'), '');
    if (g.elements[0]) lines.push('### Example element', '```html', g.elements[0].html || g.elements[0].target, '```', '');
    if (g.helpUrl) lines.push('Reference: ' + g.helpUrl);
    return lines.join('\n');
  }

  // ── Menus ─────────────────────────────────────────────────────────────────
  function closeMenus(except) {
    root.querySelectorAll('.fp-menu-pop').forEach(function (m) {
      if (m === except) return;
      if (!m.hidden) { m.hidden = true; var b = m.previousElementSibling; if (b) b.setAttribute('aria-expanded', 'false'); }
    });
  }
  function openMenu(btn) {
    var pop = btn.nextElementSibling;
    var willOpen = pop.hidden;
    closeMenus(pop);
    pop.hidden = !willOpen;
    btn.setAttribute('aria-expanded', String(willOpen));
    if (willOpen) { var first = pop.querySelector('button'); if (first) first.focus(); }
  }

  // ── Actions ───────────────────────────────────────────────────────────────
  function toggleCard(key, force) {
    ui.open[key] = force != null ? force : !ui.open[key];
    ui.current = key;
    renderLanes();
  }
  function gotoCard(key) {
    var g = groupByKey(key);
    if (!g) return;
    if (isAside(g)) ui.collapsed.aside = false;
    else if (ui.groupBy === 'tier') ui.collapsed[g.tier] = false;
    ui.q = ''; ui.page = ''; ui.quick = false;
    document.getElementById('fp-q').value = ''; document.getElementById('fp-page').value = ''; document.getElementById('fp-quick').checked = false;
    ui.open[key] = true; ui.current = key;
    renderLanes();
    var card = root.querySelector('.fp-card[data-key="' + key + '"]');
    if (card) {
      card.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
      var b = card.querySelector('.fp-open'); if (b) b.focus({ preventScroll: true });
    }
  }
  function moveCurrent(dir) {
    var cards = [].slice.call(root.querySelectorAll('.fp-card'));
    if (!cards.length) return;
    var ix = cards.findIndex(function (c) { return c.getAttribute('data-key') === ui.current; });
    ix = ix === -1 ? 0 : Math.max(0, Math.min(cards.length - 1, ix + dir));
    ui.current = cards[ix].getAttribute('data-key');
    cards.forEach(function (c) { c.classList.toggle('is-current', c === cards[ix]); });
    var b = cards[ix].querySelector('.fp-open'); if (b) b.focus();
    cards[ix].scrollIntoView({ block: 'nearest' });
  }
  function snooze(g, days) { return setTriage(g, { state: 'snoozed', until: new Date(Date.now() + days * 86400000).toISOString() }).then(function () { toast('', 'Snoozed', g.title); }); }

  root.addEventListener('click', function (e) {
    var el = e.target.closest('[data-act]');
    if (!el || !root.contains(el)) { if (!e.target.closest('.fp-menu')) closeMenus(); return; }
    var act = el.getAttribute('data-act');
    var key = el.getAttribute('data-key');
    var g = key ? groupByKey(key) : null;
    if (act !== 'menu') closeMenus();
    switch (act) {
      case 'toggle': toggleCard(key); break;
      case 'goto': gotoCard(key); break;
      case 'menu': openMenu(el); break;
      case 'lane': {
        var id = el.getAttribute('data-lane');
        ui.collapsed[id] = !ui.collapsed[id];
        saveUi(); renderLanes(); break;
      }
      case 'jump': {
        var tier = el.getAttribute('data-tier');
        if (ui.groupBy !== 'tier') { ui.groupBy = 'tier'; document.getElementById('fp-group').value = 'tier'; }
        ui.collapsed[tier] = false; saveUi(); renderLanes();
        var lane = document.getElementById('fp-lane-' + tier);
        if (lane) { lane.scrollIntoView({ block: 'start' }); var h = lane.querySelector('.fp-lane-head'); if (h) h.focus({ preventScroll: true }); }
        else toast('info', 'Nothing in that group', '');
        break;
      }
      case 'all-els': ui.showAllEls[key] = true; renderLanes(); break;
      case 'shot': {
        var ex = g && g.elements[+el.getAttribute('data-ix')];
        if (!ex) break;
        document.getElementById('fp-shot-img').src = ex.screenshot;
        document.getElementById('fp-shot-img').alt = 'Screenshot: ' + g.title + ' on ' + ex.page;
        document.getElementById('fp-shot-title').textContent = g.title + ' · ' + ex.page;
        document.getElementById('fp-shot').showModal();
        break;
      }
      case 'close-dialog': { var d = el.closest('dialog'); if (d) d.close(); break; }
      case 'keys': document.getElementById('fp-keys').showModal(); break;
      case 't-progress': setTriage(g, { state: 'inprogress' }).then(function () { announce('Marked in progress: ' + g.title); }); break;
      case 't-clear': setTriage(g, null); break;
      case 't-snooze-1': snooze(g, 1); break;
      case 't-snooze-7': snooze(g, 7); break;
      case 't-snooze-30': snooze(g, 30); break;
      case 't-wontfix': {
        var dlg = document.getElementById('fp-wontfix');
        document.getElementById('fp-wontfix-title').textContent = g.title;
        var ta = document.getElementById('fp-wontfix-reason');
        ta.value = '';
        dlg.onclose = function () {
          if (dlg.returnValue === 'ok' && ta.value.trim()) setTriage(g, { state: 'wontfix', reason: ta.value.trim() }).then(function () { toast('', 'Set aside', g.title); });
        };
        dlg.showModal();
        break;
      }
      case 'copy': copy(ticket(g), 'Ticket text for “' + g.title + '”'); break;
      case 'copy-cmd': copy('npx accessibility-check fix', 'npx accessibility-check fix'); break;
      case 'recheck': recheckGroups([g]); break;
      case 'recheck-all': recheckGroups(D.groups.filter(function (x) { return !isAside(x); }), true); break;
      case 'log': live.showLog = !live.showLog; renderActivity(); break;
      case 'dismiss-activity': live.lastResult = null; renderActivity(); break;
    }
  });

  // Menu keyboard support: arrows move between items, Escape closes.
  root.addEventListener('keydown', function (e) {
    var pop = e.target.closest && e.target.closest('.fp-menu-pop');
    if (pop && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      var items = [].slice.call(pop.querySelectorAll('button'));
      var ix = items.indexOf(e.target);
      items[(ix + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
      e.preventDefault();
    }
    if (e.key === 'Escape') {
      var openPop = root.querySelector('.fp-menu-pop:not([hidden])');
      if (openPop) { closeMenus(); var b = openPop.previousElementSibling; if (b) b.focus(); e.preventDefault(); }
    }
  });
  document.addEventListener('click', function (e) { if (!root.contains(e.target)) closeMenus(); });

  // Global shortcuts (ignored while typing).
  document.addEventListener('keydown', function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable) {
      if (e.key === 'Escape' && e.target.id === 'fp-q') { e.target.value = ''; ui.q = ''; renderLanes(); }
      return;
    }
    if (document.querySelector('dialog[open]')) return;
    if (e.key === '/') { e.preventDefault(); document.getElementById('fp-q').focus(); }
    else if (e.key === 'j') { e.preventDefault(); moveCurrent(1); }
    else if (e.key === 'k') { e.preventDefault(); moveCurrent(-1); }
    else if (e.key === '?') { e.preventDefault(); document.getElementById('fp-keys').showModal(); }
    else if (e.key === 'c' && window.A11yCommands) { e.preventDefault(); window.A11yCommands.open(document.getElementById('fp-cmds-btn')); }
    else if (ui.current && (e.key === 'r' || e.key === 'p')) {
      var g = groupByKey(ui.current);
      if (!g) return;
      if (e.key === 'r' && LIVE) recheckGroups([g]);
      if (e.key === 'p') setTriage(g, triageOf(g) && triageOf(g).state === 'inprogress' ? null : { state: 'inprogress' });
    }
  });

  // ── Live mode ─────────────────────────────────────────────────────────────
  function api(url, body) {
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-A11y-Token': LIVE.token }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; }); });
  }

  function recheckGroups(groups, all) {
    if (!LIVE) return;
    var pages = {};
    groups.forEach(function (g) { g.pages.forEach(function (p) { pages[p.name] = true; }); });
    var names = Object.keys(pages);
    if (!names.length) return;
    groups.forEach(function (g) { live.checking[g.key] = true; delete live.still[g.key]; });
    // Every card on those pages will be re-checked too — show it.
    D.groups.forEach(function (g) { if (g.pages.some(function (p) { return pages[p.name]; })) live.checking[g.key] = true; });
    render();
    api('/api/recheck', { pages: names, all: !!all }).then(function (res) {
      announce('Re-check started for ' + plural(names.length, 'page'));
      if (res && res.queued) toast('info', 'Queued', 'A re-check is already running; this one starts right after.');
    }).catch(function (e) {
      D.groups.forEach(function (g) { delete live.checking[g.key]; });
      render();
      toast('err', 'Could not start the re-check', e.message);
    });
  }

  function applyState(next, why) {
    var before = {};
    D.groups.forEach(function (g) { before[g.key] = g; });
    var after = {};
    next.groups.forEach(function (g) { after[g.key] = g; });
    var doneKeys = {};
    next.done.forEach(function (d) { doneKeys[d.key] = d; });
    var checked = live.lastPages ? live.lastPages : null;
    var touched = function (g) { return !checked || g.pages.some(function (p) { return checked[p.name]; }); };

    var fixed = [], partial = [], fresh = [], still = [];
    Object.keys(before).forEach(function (k) {
      var g = before[k];
      if (!after[k]) { if (doneKeys[k]) fixed.push(g); return; }
      if (after[k].pages.length < g.pages.length) partial.push({ g: after[k], was: g.pages.length });
      else if (touched(g) && why === 'run') still.push(after[k]);
    });
    if (why === 'run') Object.keys(after).forEach(function (k) { if (!before[k]) fresh.push(after[k]); });

    live.checking = {};
    still.forEach(function (g) { live.still[g.key] = Date.now(); });
    fresh.forEach(function (g) { live.fresh[g.key] = true; });
    fixed.forEach(function (g) { delete live.still[g.key]; });

    var swap = function () {
      // Keep local-only UI state for groups that survive.
      D = next;
      render();
    };
    if (fixed.length) {
      fixed.forEach(function (g) {
        var card = root.querySelector('.fp-card[data-key="' + g.key + '"]');
        if (!card) return;
        card.classList.add('is-fixed');
        var st = card.querySelector('.fp-side');
        if (st) st.innerHTML = '<span class="fp-status fixed">✓ Fixed</span>';
      });
      setTimeout(function () {
        fixed.forEach(function (g) { var c = root.querySelector('.fp-card[data-key="' + g.key + '"]'); if (c) c.classList.add('is-leaving'); });
        setTimeout(swap, 400);
      }, 1300);
    } else swap();

    if (why === 'run') {
      if (fixed.length === 1) toast('', '✓ Fixed', fixed[0].title + (fixed[0].pages.length > 1 ? ' (' + plural(fixed[0].pages.length, 'page') + ')' : ''));
      else if (fixed.length > 1) {
        var titles = fixed.map(function (g) { return g.title; }).filter(function (t, i, a) { return a.indexOf(t) === i; });
        toast('', '✓ ' + fixed.length + ' issues fixed', titles.slice(0, 3).join(' · ') + (titles.length > 3 ? ' …' : ''));
      }
      partial.forEach(function (p) { toast('info', 'Fixed on some pages', p.g.title + ': still on ' + plural(p.g.pages.length, 'page') + ' (was ' + p.was + ')'); });
      if (fresh.length) toast('warn', plural(fresh.length, 'new issue') + ' found', fresh.slice(0, 2).map(function (g) { return g.title + ' (' + g.pages[0].name + ')'; }).join(' · '));
      var msg = [fixed.length && plural(fixed.length, 'issue') + ' fixed', still.length && still.length + ' still failing', fresh.length && plural(fresh.length, 'new issue')].filter(Boolean).join(', ');
      if (!msg) msg = 'Nothing changed';
      announce('Re-check finished: ' + msg + '.');
      live.lastResult = { ok: !fresh.length, title: 'Re-check finished', detail: msg };
    }
  }

  function onRun(ev) {
    if (ev.phase === 'start') {
      live.log = [];
      live.lastPages = {};
      (ev.pages || []).forEach(function (p) { live.lastPages[p] = true; });
      live.run = { label: ev.all ? 'Re-checking every page' : 'Re-checking ' + plural((ev.pages || []).length, 'page'), total: (ev.pages || []).length, doneCount: 0, current: '' };
      D.groups.forEach(function (g) { if (ev.all || g.pages.some(function (p) { return live.lastPages[p.name]; })) live.checking[g.key] = true; });
      render();
    } else if (ev.phase === 'page' && live.run) {
      live.run.current = 'Scanning ' + ev.name + (ev.total ? ' (' + ev.index + ' of ' + ev.total + ')' : '');
      live.run.doneCount = Math.max(0, (ev.index || 1) - 1);
      if (ev.total) live.run.total = ev.total;
      renderActivity();
    } else if (ev.phase === 'finishing' && live.run) {
      live.run.current = 'Building the report';
      live.run.doneCount = live.run.total;
      renderActivity();
    } else if (ev.phase === 'done') {
      live.run = null;
      renderHeader();
      renderActivity();
      if (!ev.ok) {
        live.checking = {};
        live.lastResult = { ok: false, title: 'Re-check failed', detail: ev.message || 'See the log' };
        toast('err', 'Re-check failed', ev.message || 'Open the log for details.');
        render();
      }
    } else if (ev.phase === 'queued') {
      toast('info', 'Re-check queued', plural((ev.pages || []).length, 'page'));
    }
  }

  function connect() {
    var es = new EventSource('/api/events?t=' + encodeURIComponent(LIVE.token));
    es.onopen = function () { if (!live.connected) { live.connected = true; renderHeader(); } };
    es.onerror = function () { if (live.connected) { live.connected = false; renderHeader(); } };
    es.addEventListener('state', function (e) { try { applyState(JSON.parse(e.data), 'run'); } catch (err) { /* ignore */ } });
    es.addEventListener('triage', function (e) {
      try {
        var t = JSON.parse(e.data);
        var g = groupByKey(t.key);
        if (g) { g.triage = t.decision || null; render(); }
      } catch (err) { /* ignore */ }
    });
    es.addEventListener('run', function (e) { try { onRun(JSON.parse(e.data)); } catch (err) { /* ignore */ } });
    es.addEventListener('log', function (e) {
      live.log.push(e.data);
      if (live.log.length > 500) live.log.splice(0, live.log.length - 500);
      if (live.showLog) renderActivity();
    });
    es.addEventListener('watch', function (e) {
      try {
        var w = JSON.parse(e.data);
        toast('info', 'Saved ' + w.files.slice(0, 2).map(baseName).join(', ') + (w.files.length > 2 ? ' …' : ''), 'Re-checking ' + (w.pages.length ? w.pages.slice(0, 3).join(', ') + (w.pages.length > 3 ? ' …' : '') : 'open pages'));
      } catch (err) { /* ignore */ }
    });
  }

  // Keep "x min ago" fresh.
  setInterval(function () {
    root.querySelectorAll('[data-ago]').forEach(function (el) { el.textContent = ago(el.getAttribute('data-ago')); });
  }, 30000);

  shell();
  render();
  if (LIVE) connect();
})();
