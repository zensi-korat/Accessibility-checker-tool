const { test, expect } = require('./fixtures');

test('user detail page', async ({ page, a11y }) => {
  await page.goto('/app/users/7');
  const r = await a11y.check('detail');
  expect(r.page).toBe('User detail');
});

test('new user form and its dialog', async ({ page, a11y }) => {
  await page.goto('/app/users/new');
  const form = await a11y.check('empty form');
  expect(form.page).toBe('New user');                 // most specific route wins over /app/users/:id
  expect(form.violations.map((v) => v.id)).toContain('label');
  await page.getByRole('button', { name: 'Open dialog' }).click();
  const dlg = await a11y.check('dialog open');
  expect(dlg.violations.map((v) => v.id)).toContain('button-name'); // only exists after the click
});

test('a test without the a11y fixture is not scanned', async ({ page }) => {
  // Does not ask for the a11y fixture → nothing is scanned (opt-in per test).
  await page.goto('/app/about');
});

test('auto mode scans the final page', async ({ page, a11y }) => {
  void a11y;
  await page.goto('/app/settings');
});
