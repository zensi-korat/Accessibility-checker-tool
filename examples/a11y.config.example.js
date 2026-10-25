/**
 * Example a11y.config.js with the settings most projects touch.
 * `npx accessibility-check init` writes a starter version of this for you.
 * Every setting and its default: lib/config/defaults.js.
 *
 * Paths are relative to this file. A11Y_* environment variables override
 * values at run time (see docs/GUIDE.md → "Configuration reference").
 */
module.exports = {
  // Where the running app is. CI usually overrides it with A11Y_BASE_URL.
  BASE_URL: process.env.A11Y_BASE_URL || 'http://localhost:3000',

  // Start the app before scanning and stop it afterwards. Reused if it is
  // already running. Remove it if you start the app yourself.
  WEB_SERVER: { command: 'npm run dev', cwd: '.', reuseExisting: true, timeout: 180000 },

  // Source code: enables the source lint and file:line hints in the report.
  REPO_PATH: '.',

  // Reports, screenshots and scan history (add it to .gitignore).
  OUTPUT_DIR: 'a11y-report',
  REPORT_NAME: 'my-app',

  // Login. 'auto' detects a login screen and asks; the session is saved in
  // .a11y-auth.json (add it to .gitignore — it holds live cookies).
  LOGIN: { mode: 'auto', stateFile: '.a11y-auth.json' },
  // Pinned scripted login, e.g. for CI with A11Y_USER / A11Y_PASS secrets:
  // LOGIN: {
  //   mode: 'form', startPath: '/login', stateFile: '.a11y-auth.json',
  //   steps: [
  //     { type: 'fill',  selector: '#email',    value: '{{A11Y_USER}}' },
  //     { type: 'fill',  selector: '#password', value: '{{A11Y_PASS}}' },
  //     { type: 'click', selector: 'button[type=submit]' },
  //   ],
  //   loginPageSelector: 'input[type="password"]',
  // },

  // Pages beyond those in a11y.routes.json (written by `discover`). Add
  // `actions` to open dialogs, menus or tabs; every `snapshot` is scanned.
  PAGES: [
    {
      name: 'Users · Add user dialog',
      path: '/users',
      actions: [
        { type: 'click', selector: 'button:has-text("Add user")' },
        { type: 'waitFor', selector: '[role="dialog"]' },
        { type: 'snapshot', label: 'Add user dialog' },
        { type: 'press', selector: '[role="dialog"]', value: 'Escape' },
        { type: 'click', selector: '[role="tab"]:has-text("Archived")' },
        { type: 'snapshot', label: 'Archived tab' },
      ],
    },
  ],

  // Source lint (JSX / Vue / Angular templates / HTML). Rule ids are in
  // lib/static/wcagMap.js.
  STATIC_LINT: {
    enabled: true,
    exclude: ['src/legacy/**'],
    rules: { 'jsx-a11y/no-autofocus': 'off' },
  },

  // Build gate: fail when confirmed violations exceed these numbers.
  // (CI: A11Y_FAIL_ON_CRITICAL / A11Y_FAIL_ON_SERIOUS / A11Y_FAIL_ON_TOTAL.)
  FAIL_ON: { critical: 0, serious: 10 },

  // Click through buttons/tabs by itself to reveal hidden UI (read-only:
  // SAFE_MODE blocks form submissions and destructive-looking buttons).
  AUTO_EXPLORE: false,
  SAFE_MODE: true,
};
