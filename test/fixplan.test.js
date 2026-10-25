/**
 * Fix plan — priority order, Done / regressions, decisions, and the live server:
 *   - tiers: critical → Fix first; a serious blocker or site-wide issue → Fix
 *     first; other serious → Fix next; a moderate blocker → Fix next; other
 *     moderate → Schedule; needs-review → Needs a decision; best practice → Can wait
 *   - the same element on several pages is ONE defect ("One fix clears N pages")
 *   - an expired snooze no longer hides an issue
 *   - Done comes from verified fixes in archived runs; a fixed defect that is
 *     open again is flagged "came back" instead
 *   - decisions: bad keys/states are rejected; clearing removes the entry
 *   - page data can't break out of its <script> (markup in issue text)
 *   - server: 127.0.0.1 only, bad Host → 403, writes need the session token,
 *     screenshots can't be used to read files outside the report folder
 *
 *   node test/fixplan.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { prioritize, defectKey } = require('../lib/priority');
const { buildPlanData, renderFixPlan, writeTriage, readTriage } = require('../lib/fixPlan');

let failures = 0;
const check = (ok, msg) => { console.log((ok ? '  ok   ' : '  FAIL ') + msg); if (!ok) failures++; };

const A = (id) => ({ id, name: id, level: 'A' });
const AA = (id) => ({ id, name: id, level: 'AA' });
const issue = (rule, o = {}) => ({
  rule, kind: 'violation', impact: 'serious', page: 'Home', url: 'http://x/', target: `#${rule}`,
  html: `<div id="${rule}">${rule}</div>`, criteria: [AA('1.4.3')], help: rule, ...o,
});

(async () => {
  console.log('priority tiers');
  const issues = [
    issue('image-alt', { impact: 'critical', criteria: [A('1.1.1')] }),
    issue('button-name', { impact: 'critical', criteria: [A('4.1.2')], page: 'Home', html: '<button class="cart"></button>' }),
    issue('button-name', { impact: 'critical', criteria: [A('4.1.2')], page: 'About', html: '<button class="cart"></button>' }),
    issue('button-name', { impact: 'critical', criteria: [A('4.1.2')], page: 'Contact', html: '<button class="cart"></button>' }),
    issue('kbd-focus-visible', { criteria: [AA('2.4.7')] }),
    issue('color-contrast'),
    issue('target-size', { criteria: [AA('2.5.8')], page: 'A', html: '<a>x</a>' }),
    issue('target-size', { criteria: [AA('2.5.8')], page: 'B', html: '<a>x</a>' }),
    issue('target-size', { criteria: [AA('2.5.8')], page: 'C', html: '<a>x</a>' }),
    issue('meta-viewport', { impact: 'moderate', criteria: [AA('1.4.4')] }),
    issue('autocomplete-valid', { impact: 'moderate', criteria: [AA('1.3.5')] }),
    issue('color-contrast', { kind: 'incomplete', html: '<p class="hero">x</p>' }),
    issue('region', { impact: 'moderate', criteria: [], category: 'best-practice' }),
  ];
  const plan = prioritize(issues);
  const tierOf = (rule, html) => plan.groups.find((g) => g.rule === rule && (!html || g.elements[0].html === html)).tier;
  check(tierOf('image-alt') === 'now', 'critical → Fix first');
  check(tierOf('kbd-focus-visible') === 'now', 'serious keyboard blocker → Fix first');
  check(tierOf('color-contrast', '<div id="color-contrast">color-contrast</div>') === 'next', 'serious, one page, not a blocker → Fix next');
  check(tierOf('target-size') === 'now', 'serious on 3+ pages → Fix first');
  check(tierOf('meta-viewport') === 'next', 'moderate blocker (zoom disabled) → Fix next');
  check(tierOf('autocomplete-valid') === 'plan', 'other moderate → Schedule');
  check(tierOf('color-contrast', '<p class="hero">x</p>') === 'review', 'needs-review → Needs a decision');
  check(tierOf('region') === 'later', 'best practice → Can wait');
  const btn = plan.groups.filter((g) => g.rule === 'button-name');
  check(btn.length === 1 && btn[0].pages.length === 3, 'same element on 3 pages is one defect');
  check(btn[0].reasons.includes('One fix clears 3 pages') && btn[0].reasons.some((r) => /^Blocks screen-reader/.test(r)), 'reasons say who it blocks and its reach');
  check(plan.groups[0].rule === 'button-name', 'the site-wide critical blocker ranks #1');
  check(btn[0].quickWin === true, 'a 5-minute critical fix is a quick win');
  check(plan.groups.every((g, i) => g.rank === i + 1), 'ranks are 1..N in order');

  const expired = prioritize([issues[0]], { triage: { [defectKey(issues[0])]: { state: 'snoozed', until: '2000-01-01T00:00:00Z' } } });
  check(expired.groups[0].triage === null, 'an expired snooze no longer hides the issue');

  console.log('\nDone and regressions');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'a11y-plan-'));
  fs.mkdirSync(path.join(out, 'reports', 'run1'), { recursive: true });
  const fixedOld = { rule: 'link-name', page: 'Home', html: '<a href="/x"></a>', target: 'a', kind: 'violation', impact: 'serious', title: 'Link has no name' };
  const fixedBack = { rule: 'image-alt', page: 'Home', html: issues[0].html, target: issues[0].target, kind: 'violation', impact: 'critical' };
  fs.writeFileSync(path.join(out, 'reports', 'manifest.json'), JSON.stringify([{ folder: 'run1', name: 'x', atISO: '2026-10-20T10:00:00Z' }]));
  fs.writeFileSync(path.join(out, 'reports', 'run1', 'report.json'), JSON.stringify({ verification: { fixed: [fixedOld, fixedBack] } }));
  const data = buildPlanData(issues, { outDir: out, meta: { reportName: 'x' }, shotPrefix: 'reports/' });
  check(data.done.length === 1 && data.done[0].rule === 'link-name', 'a verified fix that stayed fixed is in Done');
  const back = data.groups.find((g) => g.rule === 'image-alt');
  check(!!back.regressedFrom && back.reasons[0] === 'Was fixed before and came back', 'a fixed defect that is open again is flagged as came back');

  console.log('\ndecisions');
  const tf = path.join(out, 'a11y.triage.json');
  let threw = false;
  try { writeTriage(tf, '../../etc', { state: 'wontfix' }); } catch { threw = true; }
  check(threw, 'rejects a malformed key');
  threw = false;
  try { writeTriage(tf, defectKey(issues[0]), { state: 'deleted' }); } catch { threw = true; }
  check(threw, 'rejects an unknown state');
  writeTriage(tf, defectKey(issues[0]), { state: 'wontfix', reason: 'vendor widget' });
  check(readTriage(tf)[defectKey(issues[0])].reason === 'vendor widget', 'saves a won\'t-fix reason');
  writeTriage(tf, defectKey(issues[0]), null);
  check(!readTriage(tf)[defectKey(issues[0])], 'clearing removes the decision');

  console.log('\npage');
  const evil = buildPlanData([issue('image-alt', { help: '</script><script>alert(1)</script>', html: '<img src=x onerror=alert(1)>' })], {});
  const html = renderFixPlan(evil, { mode: 'file' });
  const dataBlock = html.slice(html.indexOf('id="fp-data">'), html.indexOf('</script>', html.indexOf('id="fp-data">')));
  check(!/<\/script|<script|<img/i.test(dataBlock.slice(13)), 'issue text cannot break out of the embedded data');
  const bundle = renderFixPlan(data, { mode: 'bundle' });
  check(bundle.body && bundle.css && !/"screenshot":"reports\//.test(bundle.body), 'bundle mode returns a fragment without screenshot paths');

  console.log('\nlive server');
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'a11y-fix-'));
  fs.writeFileSync(path.join(proj, 'a11y.config.js'), "module.exports = { BASE_URL: 'http://127.0.0.1:9', OUTPUT_DIR: 'out', REPO_PATH: '', PAGES: [{ name: 'Home', path: '/' }] };");
  fs.mkdirSync(path.join(proj, 'out', 'shots'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'out', 'fix-plan.json'), JSON.stringify(buildPlanData(issues, {})));
  fs.writeFileSync(path.join(proj, 'out', 'shots', 'a.png'), 'png');
  fs.writeFileSync(path.join(proj, 'secret.png'), 'nope');
  const logs = [];
  const port = 47000 + Math.floor(Math.random() * 900);
  await require('../lib/fixServer').main(['--config', path.join(proj, 'a11y.config.js'), '--no-open', '--no-watch', '--port', String(port)], { log: (m) => logs.push(m) });
  const req = (method, p, { host = `127.0.0.1:${port}`, headers = {}, body } = {}) => new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: { Host: host, ...headers } }, (res) => {
      let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    r.on('error', (e) => resolve({ status: 0, body: e.message }));
    if (body) r.end(JSON.stringify(body)); else r.end();
  });
  const page = await req('GET', '/');
  check(page.status === 200 && /"mode":"live"/.test(page.body), 'serves the live plan');
  const token = (page.body.match(/"token":"([^"]+)"/) || [])[1];
  check(!!token, 'the page carries a session token');
  check((await req('GET', '/', { host: `evil.example:${port}` })).status === 403, 'rejects a foreign Host header (DNS rebinding)');
  const key = defectKey(issues[0]);
  check((await req('POST', '/api/triage', { body: { key, decision: { state: 'inprogress' } } })).status === 401, 'a write without the token is refused');
  const ok = await req('POST', '/api/triage', { headers: { 'X-A11y-Token': token, 'Content-Type': 'application/json' }, body: { key, decision: { state: 'inprogress' } } });
  check(ok.status === 200 && readTriage(path.join(proj, 'a11y.triage.json'))[key].state === 'inprogress', 'a write with the token saves the decision next to the config');
  check((await req('GET', '/shots/a.png')).status === 200, 'serves report screenshots');
  check((await req('GET', '/..%2Fsecret.png')).status === 404 && (await req('GET', '/../secret.png')).status === 404, 'cannot read files outside the report folder');
  check((await req('GET', '/api/state')).status === 401, 'plan data needs the token');

  fs.rmSync(out, { recursive: true, force: true });
  fs.rmSync(proj, { recursive: true, force: true });
  console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
