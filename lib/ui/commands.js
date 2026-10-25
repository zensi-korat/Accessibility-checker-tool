/**
 * "Commands" dialog — every CLI command a user needs, in one place, each with
 * a Copy button. Shared by the dashboard, the fix plan and the single-file
 * report (lib/report.js, lib/fixPlan.js).
 *
 * Any element with [data-open-commands] opens it; [data-base-url] on that
 * element fills in the quick-scan example. The dialog is created on first
 * open, so a page holding several fragments still has exactly one.
 */
const CLI = 'npx accessibility-check';

const GROUPS = [
  {
    title: 'Check your fixes',
    items: [
      ['fix', 'Live fix plan in your browser. Issues tick off as you fix them, when you save a file or click Re-check.'],
      ['verify', 'Re-scan the pages that had issues and report what is fixed, still failing or new. Exits with 1 while anything is still failing.'],
      ['verify --all', 'The same, for every page.'],
    ],
  },
  {
    title: 'Scan',
    items: [
      ['scan', 'Full scan of the running app plus the source lint. Opens the report when done.'],
      ['scan {url}', 'Quick scan of any URL, with no config. Crawls up to 20 pages.'],
      ['scan --public-only', 'Skip the login and scan only the public pages.'],
      ['lint', 'Accessibility lint of the source code only. No browser, fast enough for a pre-commit hook.'],
    ],
  },
  {
    title: 'Set up',
    items: [
      ['init', 'Detect your stack, write a11y.config.js and list your pages.'],
      ['discover --live', 'Find more pages from sitemap.xml and a read-only crawl of the running app.'],
      ['login', 'Log in once and save the session, for scans behind a login and for CI.'],
      ['init --ci github', 'Add a CI pipeline that scans every pull request. Also: azure, gitlab.'],
    ],
  },
  {
    title: 'Reports',
    items: [
      ['render', 'Rebuild the reports from the last scan without opening a browser.'],
      ['combine', 'Merge every archived run into one report.'],
    ],
  },
];

const CSS = `
.a11y-cmds{border:0;border-radius:14px;padding:0;width:min(720px,calc(100vw - 32px));max-height:min(86vh,900px);box-shadow:0 24px 60px rgba(16,24,40,.25);color:#1f2733;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
.a11y-cmds::backdrop{background:rgba(16,24,40,.45)}
.a11y-cmds-head{position:sticky;top:0;z-index:1;display:flex;justify-content:space-between;align-items:flex-start;gap:12px;padding:18px 22px 14px;background:#fff;border-bottom:1px solid #edf0f4}
.a11y-cmds-head h2{margin:0 0 2px;font-size:18px;color:#111827}
.a11y-cmds-head p{margin:0;color:#5b6472;font-size:13px}
.a11y-cmds-body{padding:6px 22px 20px}
.a11y-cmds h3{margin:18px 0 8px;font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:#5b6472}
.a11y-cmds ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
.a11y-cmds li{display:flex;gap:12px;align-items:flex-start;justify-content:space-between;padding:10px 12px;border:1px solid #e2e6ec;border-radius:10px;background:#fcfcfd}
.a11y-cmds li > div{min-width:0}
.a11y-cmds code{display:inline-block;font:13px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#111827;background:#eef1f5;padding:3px 8px;border-radius:6px;overflow-wrap:anywhere}
.a11y-cmds .d{display:block;margin-top:5px;color:#5b6472;font-size:12.5px}
.a11y-cmds button{font:inherit;cursor:pointer}
.a11y-cmds .copy{flex:none;display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border:1px solid #c9d0da;border-radius:8px;background:#fff;color:#344054;font-size:12px;font-weight:500;min-height:30px}
.a11y-cmds .copy:hover{background:#f4f6f9}
.a11y-cmds .copy.done{color:#067647;border-color:#abefc6;background:#ecfdf3}
.a11y-cmds .x{flex:none;border:1px solid transparent;background:none;border-radius:8px;width:34px;height:34px;font-size:20px;line-height:1;color:#5b6472}
.a11y-cmds .x:hover{background:#f4f6f9}
.a11y-cmds :focus-visible{outline:3px solid #1a6dd4;outline-offset:2px}
.a11y-cmds .tip{margin-top:18px;padding:10px 12px;border-radius:10px;background:#eff8ff;border:1px solid #b2ddff;color:#1d4f91;font-size:12.5px}
@media (max-width:560px){.a11y-cmds li{flex-direction:column}.a11y-cmds .copy{align-self:flex-start}}
`;

function script() {
  const data = JSON.stringify({ cli: CLI, groups: GROUPS }).replace(/</g, '\\u003c');
  return `<script>
(function () {
  'use strict';
  if (window.A11yCommands) return;
  var DATA = ${data};
  var dlg = null, lastTrigger = null;
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function build(baseUrl) {
    var url = baseUrl || 'https://your-site.example';
    var html = '<div class="a11y-cmds-head"><div><h2 id="a11y-cmds-title">Commands</h2>'
      + '<p>Run these in a terminal at your project root, the folder with a11y.config.js.</p></div>'
      + '<button type="button" class="x" data-cmds-close aria-label="Close">×</button></div><div class="a11y-cmds-body">';
    DATA.groups.forEach(function (g) {
      html += '<h3>' + esc(g.title) + '</h3><ul>';
      g.items.forEach(function (it) {
        var cmd = DATA.cli + ' ' + it[0].replace('{url}', url);
        html += '<li><div><code>' + esc(cmd) + '</code><span class="d">' + esc(it[1]) + '</span></div>'
          + '<button type="button" class="copy" data-cmd="' + esc(cmd) + '" aria-label="Copy: ' + esc(cmd) + '">Copy</button></li>';
      });
      html += '</ul>';
    });
    html += '<p class="tip"><b>Tip:</b> fix, then run <code>' + esc(DATA.cli) + ' verify</code>, or keep <code>' + esc(DATA.cli) + ' fix</code> open while you work. '
      + '<code>' + esc(DATA.cli) + ' --help</code> lists every option.</p>'
      + '<p class="a11y-cmds-live" aria-live="polite" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)"></p></div>';
    var d = document.createElement('dialog');
    d.className = 'a11y-cmds';
    d.setAttribute('aria-labelledby', 'a11y-cmds-title');
    d.innerHTML = html;
    d.addEventListener('click', function (e) {
      if (e.target === d) { d.close(); return; } // backdrop
      if (e.target.closest('[data-cmds-close]')) { d.close(); return; }
      var b = e.target.closest('.copy');
      if (b) copy(b.getAttribute('data-cmd'), b);
    });
    d.addEventListener('close', function () { if (lastTrigger && document.contains(lastTrigger)) lastTrigger.focus(); });
    document.body.appendChild(d);
    return d;
  }
  function copy(text, btn) {
    var done = function () {
      btn.textContent = 'Copied ✓'; btn.classList.add('done');
      var live = dlg.querySelector('.a11y-cmds-live'); if (live) live.textContent = 'Copied ' + text;
      setTimeout(function () { btn.textContent = 'Copy'; btn.classList.remove('done'); }, 1800);
    };
    if (navigator.clipboard && window.isSecureContext) { navigator.clipboard.writeText(text).then(done, fallback); } else fallback();
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      dlg.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { btn.textContent = 'Select and copy'; }
      ta.remove();
    }
  }
  function open(trigger) {
    lastTrigger = trigger || document.activeElement;
    if (!dlg) dlg = build(trigger && trigger.getAttribute('data-base-url'));
    dlg.showModal();
    var first = dlg.querySelector('.copy'); if (first) first.focus();
  }
  document.addEventListener('click', function (e) {
    var t = e.target.closest && e.target.closest('[data-open-commands]');
    if (t) { e.preventDefault(); open(t); }
  });
  window.A11yCommands = { open: open };
})();
</script>`;
}

module.exports = { CSS, script, GROUPS, CLI };
