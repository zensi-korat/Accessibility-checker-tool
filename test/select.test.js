/**
 * Custom select (lib/ui/select.js) — the WAI-ARIA select-only combobox that
 * replaces native <select> in the dashboard and the fix plan:
 *   - combobox/listbox roles, accessible name from the <label>, expanded state
 *   - keyboard: ↓ opens, ↓/Enter chooses, Escape closes without changing,
 *     Home/End, type-ahead, Tab chooses and moves on
 *   - the native select stays the source of truth: 'change' fires, and
 *     setting .value in code updates what is shown
 *   - disabled options are skipped
 *
 *   node test/select.test.js
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

let failures = 0;
const check = (ok, msg) => { console.log((ok ? '  ok   ' : '  FAIL ') + msg); if (!ok) failures++; };

const css = fs.readFileSync(path.join(__dirname, '..', 'lib', 'ui', 'select.css'), 'utf8');
const js = fs.readFileSync(path.join(__dirname, '..', 'lib', 'ui', 'select.js'), 'utf8');
const html = `<!doctype html><html lang="en"><head><style>${css}</style></head><body>
<label for="fruit">Fruit</label>
<select id="fruit" data-a11y-select><option value="a">Apple</option><option value="b" disabled>Banana</option><option value="c">Cherry</option><option value="d">Date</option></select>
<button id="after">after</button>
<script>window.changes = []; document.getElementById('fruit').addEventListener('change', function (e) { changes.push(e.target.value); });</script>
<script>${js}</script></body></html>`;

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setContent(html);
  const combo = page.locator('[role=combobox]');
  const shown = async () => (await combo.textContent()).trim();
  const native = () => page.$eval('#fruit', (s) => s.value);

  check(await combo.count() === 1, 'renders one combobox');
  check(await combo.getAttribute('aria-label') === 'Fruit', 'takes its name from the <label for>');
  check(await page.$eval('#fruit', (s) => s.getAttribute('aria-hidden') === 'true' && s.tabIndex === -1), 'the native select is hidden from AT and the tab order');
  check(await combo.getAttribute('aria-expanded') === 'false' && await shown() === 'Apple', 'starts closed, showing the selected option');

  await combo.focus();
  await page.keyboard.press('ArrowDown');
  check(await combo.getAttribute('aria-expanded') === 'true', 'ArrowDown opens the list');
  check(await page.locator('[role=listbox] [role=option]').count() === 4, 'lists every option');
  await page.keyboard.press('ArrowDown');
  const activeId = await combo.getAttribute('aria-activedescendant');
  check(/opt-2$/.test(activeId || ''), 'ArrowDown skips the disabled option (aria-activedescendant)');
  await page.keyboard.press('Enter');
  check(await shown() === 'Cherry' && await native() === 'c', 'Enter chooses and updates the native select');
  check(JSON.stringify(await page.evaluate(() => changes)) === '["c"]', 'a change event fires once');
  check(await combo.getAttribute('aria-expanded') === 'false', 'and the list closes');

  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('End');
  await page.keyboard.press('Escape');
  check(await shown() === 'Cherry' && await combo.getAttribute('aria-expanded') === 'false', 'Escape closes without changing the value');
  check(await page.evaluate(() => document.activeElement.getAttribute('role')) === 'combobox', 'focus stays on the combobox');

  await page.keyboard.press('a');
  check(await shown() === 'Apple', 'type-ahead jumps to a match while closed');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Home');
  await page.keyboard.press('d');
  await page.keyboard.press('Tab');
  check(await native() === 'd' && await page.evaluate(() => document.activeElement.id) === 'after', 'Tab chooses the active option and moves on');

  await page.$eval('#fruit', (s) => { s.value = 'a'; });
  check(await shown() === 'Apple', 'setting .value in code updates the display');

  await combo.click();
  await page.locator('[role=option]', { hasText: 'Date' }).click();
  check(await native() === 'd' && await combo.getAttribute('aria-expanded') === 'false', 'mouse: clicking an option chooses it');
  await combo.click();
  await page.mouse.click(5, 300);
  check(await combo.getAttribute('aria-expanded') === 'false', 'clicking outside closes the list');

  await page.setContent(`<!doctype html><html lang="en"><body><label for="f">F</label><select id="f" data-a11y-select><option>A</option></select><script>${js}</script><script>${js}</script></body></html>`);
  check(await page.locator('[role=combobox]').count() === 1, 'loading the script twice (single-file report) enhances once');

  check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  await browser.close();
  console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
