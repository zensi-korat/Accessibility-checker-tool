/**
 * Regression test for a real production incident: pressing one shift-template
 * status toggle produced dozens of identical blocked POSTs to the same .asmx
 * endpoint within a single page visit — a retry storm caused by the RESPONSE
 * SHAPE the guard sent back, not by anything driving the same click twice.
 *
 * ASP.NET AJAX script services (`*.asmx`) always expect a JSON response
 * wrapped as `{"d": ...}`. A blank 204 body makes `JSON.parse('')` throw
 * inside the APP's own ajax plumbing, and its error handler retried the exact
 * same call indefinitely. The fixture reproduces that exact client pattern
 * (fetch -> JSON.parse -> catch -> retry) so this is proven against realistic
 * behaviour, not asserted against the guard's own internals.
 *
 *   node test/asmxRetry.test.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { installGuard, jsonEnvelopeFor } = require('../lib/interact');

const FIXTURE = path.join(__dirname, 'fixtures', 'asmx-retry.html');
let failures = 0;
const check = (ok, msg) => { console.log((ok ? '  ok   ' : '  FAIL ') + msg); if (!ok) failures++; };

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
  const guard = await installGuard(page);
  await page.goto(base + '/');
  guard.lock();

  await page.click('#toggle');
  // Give any retry loop room to run; a real storm keeps going far past this.
  await page.waitForTimeout(1500);

  const attempts = await page.evaluate(() => window.__attempts);
  const gaveUp = await page.evaluate(() => window.__gaveUp);
  const logText = await page.locator('#log').textContent();

  console.log('\nthe fixed guard');
  check(attempts === 1, `the app called the service exactly once (got ${attempts})`);
  check(!gaveUp, '  it did not need its own retry-limit escape hatch');
  check(logText.includes('"d":null'), `  the app's success handler ran with the {"d":null} envelope (got "${logText}")`);
  check(!received.some((r) => r.includes('.asmx')), '  the real .asmx endpoint was never reached — the write is still fully blocked');

  await guard.uninstall();
  await page.close();

  console.log('\njsonEnvelopeFor classification');
  {
    const fakeReq = (headers) => ({ headers: () => headers });
    check(!!jsonEnvelopeFor(fakeReq({}), 'http://x/api/thing.asmx/Method'),
      '.asmx URL is classified as JSON regardless of headers');
    check(!!jsonEnvelopeFor(fakeReq({ 'content-type': 'application/json' }), 'http://x/api/thing'),
      'a declared JSON Content-Type is classified as JSON');
    check(!!jsonEnvelopeFor(fakeReq({ accept: 'application/json, text/plain, */*' }), 'http://x/api/thing'),
      'a declared JSON Accept header is classified as JSON');
    check(jsonEnvelopeFor(fakeReq({}), 'http://x/save') === null,
      'a plain form POST with no JSON signal is NOT classified as JSON (stays 204)');
    const env = jsonEnvelopeFor(fakeReq({}), 'http://x/thing.asmx/M');
    check(env.status === 200 && env.body === '{"d":null}',
      'the JSON envelope is 200 + {"d":null}, the real ASP.NET AJAX success shape');
  }

  await browser.close();
  server.close();
  console.log(failures ? `\n${failures} assertion(s) failed` : '\nAll assertions passed');
  process.exit(failures ? 1 : 0);
})();
