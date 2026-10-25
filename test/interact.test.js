/**
 * lib/interact.js — the guard that lets the scan click and type against a real
 * staging database.
 *
 * The thing under test is a safety property, so the assertions are written
 * against GROUND TRUTH: what the HTTP server actually received. Checking only
 * what the guard *says* it blocked would pass even if the guard were bypassed.
 *
 * Two traps are deliberately covered, both of which produced a false pass
 * during development:
 *   - asserting "no POST arrived" while native constraint validation had
 *     silently stopped the submit, so the guard was never exercised;
 *   - blocking with route.abort(), which stops the write but destroys the
 *     document, losing every revealed modal on the page.
 *
 *   node test/interact.test.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { installGuard, looksDestructive } = require('../lib/interact');

const FIXTURE = path.join(__dirname, 'fixtures', 'interact.html');

let failures = 0;
const check = (ok, msg) => {
  console.log((ok ? '  ok   ' : '  FAIL ') + msg);
  if (!ok) failures++;
};

(async () => {
  const received = [];
  const server = http.createServer((req, res) => {
    received.push(`${req.method} ${req.url}`);
    res.setHeader('content-type', 'text/html');
    res.end(fs.readFileSync(FIXTURE, 'utf8'));
  }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;

  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const guard = await installGuard(page, { log: (m) => console.log("    " + m.trim()) });

  // ── Unlocked: the scan's own navigation must work, even to a URL whose
  //    filename contains a destructive word. This is why the GET filter is
  //    locked-only — it would otherwise block the page it was told to scan.
  console.log('\nunlocked (normal scanning)');
  await page.goto(base + '/manage/apps/RemoveDuplicates.aspx');
  check(received.some((r) => r === 'GET /manage/apps/RemoveDuplicates.aspx'),
    'GET to a page with "Remove" in its path is allowed while unlocked');

  await page.goto(base + '/');
  guard.lock();
  console.log('\nlocked (interaction phase)');

  // ── Reaching UI that does not exist in the static DOM.
  await page.click('#openDrawer');
  check(await page.isVisible('#drawer'), 'click reveals a drawer to scan');

  // ── Typing produces a status message in a live region: the 4.1.3 signal.
  await page.fill('#email', 'not-an-email');
  await page.keyboard.press('Tab'); // blur the way a user does
  check((await page.textContent('#err')).trim().length > 0,
    'typing produces a validation status message');
  check(await page.getAttribute('#err', 'role') === 'alert',
    '  it landed in a role="alert" live region');

  // ── A genuine submit attempt. The field is made valid first, or native
  //    validation stops the submit and the guard is never tested at all.
  await page.fill('#email', 'real@example.com');
  await page.click('#save').catch(() => {});
  await page.waitForTimeout(400);
  check(await page.evaluate(() => window.__sent.includes('form-submit')),
    'the form genuinely attempted to submit');
  check(!received.some((r) => r.startsWith('POST')),
    '  the POST never reached the server');
  // The whole point of 204-over-abort: the page must survive being blocked.
  check(page.url() === base + '/', '  the page did not navigate to an error page');
  check(await page.isVisible('#drawer'), '  the open drawer survived the blocked submit');

  // ── A write dressed as a read.
  await page.click('#del').catch(() => {});
  await page.waitForTimeout(300);
  check(!received.some((r) => r.includes('/records/delete')),
    'destructive GET never reached the server');

  // ── A stray navigation must not move us off the page mid-scan.
  await page.click('#nav').catch(() => {});
  await page.waitForTimeout(300);
  check(page.url() === base + '/', 'navigation away is blocked while locked');
  check(!received.some((r) => r === 'GET /other'), '  and never reached the server');

  // ── Unlocking restores normal navigation.
  guard.unlock();
  await page.goto(base + '/other');
  check(page.url() === base + '/other', 'navigation works again once unlocked');

  // ── Tier 3 is a deliberate switch, not an emergent default. Verified by
  //    letting a write through on a SEPARATE page, so the guarantee above is
  //    proven to be a choice rather than an accident of the fixture.
  console.log('\ntier 3 (writes)');
  check(!received.some((r) => r.startsWith('POST')),
    'writes are off by default — no POST all run');
  const wPage = await ctx.newPage();
  const wGuard = await installGuard(wPage, { allowWrites: true });
  await wPage.goto(base + '/');
  await wPage.fill('#email', 'real@example.com');
  await wPage.click('#save').catch(() => {});
  await wPage.waitForTimeout(400);
  check(received.some((r) => r.startsWith('POST')),
    'allowWrites:true lets the write through (so the block above was real)');
  await wGuard.uninstall();
  await wPage.close();

  console.log('\nlabel classifier');
  for (const [label, want] of [['Delete user', true], ['Remove', true], ['Log out', true],
    ['Save', false], ['Open Filters', false], ['Search', false]]) {
    check(looksDestructive(label) === want, `looksDestructive(${JSON.stringify(label)}) === ${want}`);
  }

  console.log('\nserver received: ' + JSON.stringify(received));
  console.log('guard blocked:   ' + guard.blocked.map((b) => b.method + ' ' + b.reason).join(' | '));

  await guard.uninstall();
  await browser.close();
  server.close();
  console.log(failures ? `\n${failures} assertion(s) failed` : '\nAll assertions passed');
  process.exit(failures ? 1 : 0);
})();
