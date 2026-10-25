/**
 * lib/formFlow.js — 3.3.7 Redundant Entry, 3.3.4 Error Prevention
 * and the 3.3.3 Error Suggestion classifier in lib/liveRegion.js.
 *
 * All three were previously written off as manual. Each is automatable once
 * the human judgement is isolated to a single declaration (3.3.4) or shown to
 * be unnecessary (3.3.7, 3.3.3).
 *
 *   node test/formFlow.test.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { installGuard } = require('../lib/interact');
const { formFlowChecks, evaluateFlowAcrossPages } = require('../lib/formFlow');
const { liveRegionChecks } = require('../lib/liveRegion');

const FIXTURES = path.join(__dirname, 'fixtures');
let failures = 0;
const check = (ok, msg) => { console.log((ok ? '  ok   ' : '  FAIL ') + msg); if (!ok) failures++; };

(async () => {
  const server = http.createServer((req, res) => {
    const f = path.join(FIXTURES, req.url.replace(/^\//, '').split('?')[0]);
    if (!fs.existsSync(f)) { res.statusCode = 404; res.end('no'); return; }
    res.setHeader('content-type', 'text/html');
    res.end(fs.readFileSync(f, 'utf8'));
  }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const run = async (f, opts) => {
    const p = await ctx.newPage();
    await p.goto(`${base}/${f}`);
    const r = await formFlowChecks(p, opts);
    await p.close();
    return { r, v: r.violations.map((x) => x.id), p: r.passes.map((x) => x.id) };
  };

  console.log('\n3.3.7 Redundant Entry — same page');
  {
    const { r, v } = await run('flow-bad.html');
    check(v.includes('ff-redundant-entry'), 'two empty "Email address" fields flagged');
    const blamed = r.violations.find((x) => x.id === 'ff-redundant-entry').nodes.map((n) => n.target[0]);
    check(!blamed.some((b) => /p1|p2/.test(b)),
      '  "Confirm password" NOT flagged — deliberate repeats are allowed');
  }
  {
    const { p } = await run('flow-good.html');
    check(p.includes('ff-redundant-entry'), 'a form with distinct fields passes');
  }

  console.log('\n3.3.7 Redundant Entry — across steps of one flow');
  {
    const out = evaluateFlowAcrossPages({
      'Step 1': { path: '/manage/onboarding/details', fields: [{ id: 'ac:email', sel: '#e', prefilled: false }] },
      'Step 2': { path: '/manage/onboarding/contact', fields: [{ id: 'ac:email', sel: '#e2', prefilled: false }] },
      'Elsewhere': { path: '/manage/reports/list', fields: [{ id: 'ac:email', sel: '#e3', prefilled: false }] },
    });
    check(!!out['Step 2'] && out['Step 2'].incomplete.length && !out['Step 2'].violations.length,
      'undeclared: email asked again under the same path prefix is a review item, not a failure');
    check(!out['Elsewhere'], '  a different section is NOT treated as the same process');
    check(!out['Step 1'], '  the first request is not itself a violation');
    const declared = evaluateFlowAcrossPages({
      'Step 1': { path: '/manage/onboarding/details', fields: [{ id: 'ac:email', sel: '#e', prefilled: false }] },
      'Step 2': { path: '/manage/onboarding/contact', fields: [{ id: 'ac:email', sel: '#e2', prefilled: false }] },
    }, { flows: [{ name: 'Onboarding', pattern: '^/manage/onboarding/' }] });
    check(declared['Step 2'] && declared['Step 2'].violations.length === 1, 'declared flow: the repeat is a confirmed failure');
  }
  {
    const out = evaluateFlowAcrossPages({
      'Step 1': { path: '/manage/onboarding/details', fields: [{ id: 'ac:email', sel: '#e', prefilled: false }] },
      'Step 2': { path: '/manage/onboarding/contact', fields: [{ id: 'ac:email', sel: '#e2', prefilled: true }] },
    });
    check(!out['Step 2'], 'a PRE-FILLED repeat is not a violation');
  }

  console.log('\n3.3.7 — repeats that are not redundant entry');
  {
    const p = await ctx.newPage();
    await p.setContent(`<header><form role="search"><input type="search" aria-label="Search"></form></header>
      <main><form id="login"><label for="le">Email</label><input id="le" type="email"><label for="lp">Password</label><input id="lp" type="password"></form>
      <form id="reg"><label for="re">Email</label><input id="re" type="email"><label for="rp">Password</label><input id="rp" type="password"></form>
      <form id="search2"><input type="search" aria-label="Search"></form>
      <form id="cart"><label>Quantity <input id="q1"></label><label>Quantity <input id="q2"></label></form></main>`);
    const r = await formFlowChecks(p);
    check(!r.violations.some((x) => x.id === 'ff-redundant-entry'),
      'login + register forms, two search boxes and per-row quantities are not redundant entry');
    await p.close();
  }

  console.log('\n3.3.4 Error Prevention — declared flows');
  {
    const flows = [{ name: 'Payroll submission', pattern: '/flow-noguard' }];
    const { v } = await run('flow-noguard.html', { flows });
    check(v.includes('ff-no-error-prevention'), 'declared consequential page with no guard is flagged');
  }
  {
    const flows = [{ name: 'Employee deletion', pattern: '/flow-good' }];
    const { p } = await run('flow-good.html', { flows });
    check(p.includes('ff-no-error-prevention'), 'a confirm() guard satisfies the criterion');
  }
  {
    // Not declared → the tool must stay silent rather than guess.
    const { v, p } = await run('flow-noguard.html', { flows: [] });
    check(!v.includes('ff-no-error-prevention') && !p.includes('ff-no-error-prevention'),
      'an UNDECLARED page produces no 3.3.4 verdict at all');
  }

  console.log('\n3.3.3 Error Suggestion');
  {
    const mk = async (fixture) => {
      const p = await ctx.newPage();
      const g = await installGuard(p);
      await p.goto(`${base}/${fixture}`);
      const r = await liveRegionChecks(p, { guard: g });
      await g.uninstall(); await p.close();
      return { v: r.violations.map((x) => x.id), p: r.passes.map((x) => x.id) };
    };
    const bad = await mk('suggest-bad.html');
    check(bad.v.includes('lr-error-no-suggestion'), '"Invalid email." flagged — says what, not how');
    const good = await mk('suggest-good.html');
    check(!good.v.includes('lr-error-no-suggestion'),
      '"Enter an email like name@example.com" passes');
    check(good.p.includes('lr-error-no-suggestion'), '  and is explicitly passed');
    const req = await mk('suggest-required.html');
    check(!req.v.includes('lr-error-no-suggestion'),
      '"Email is required" is NOT held to 3.3.3 — the correction is inherent');
  }

  await browser.close();
  server.close();
  console.log(failures ? `\n${failures} assertion(s) failed` : '\nAll assertions passed');
  process.exit(failures ? 1 : 0);
})();
