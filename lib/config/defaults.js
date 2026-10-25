/**
 * Every setting the scanner understands, with its default. A project config
 * (a11y.config.js) only needs the keys it wants to change — BASE_URL at
 * minimum. Values here are deliberately generic: nothing in this file may
 * assume a particular app, stack, login page or UI library.
 *
 * Paths (OUTPUT_DIR, REPO_PATH, ROUTES_FILE, LOGIN.stateFile) are resolved
 * relative to the directory of the config file that set them, so a config
 * checked into a project's repo works from any working directory.
 */
module.exports = {
  BASE_URL: '',                 // required — where the running app is served
  IGNORE_HTTPS_ERRORS: true,    // self-signed dev certs
  HEADLESS: undefined,          // undefined: headless unless a manual login is needed

  // Where dashboard.html, report.html, shots/ and reports/ are written.
  // Default '.' = next to the config file (keeps the original single-folder layout).
  OUTPUT_DIR: '.',

  // Source code for file:line mapping. '' disables it.
  REPO_PATH: '',
  // undefined → derived from the detected stack (see lib/adapters).
  CODE_EXTENSIONS: undefined,
  // ASP.NET WebForms rewrites ids (ctl00_MainContent_btnSave). undefined →
  // on only when the code extensions include WebForms markup.
  STRIP_SERVER_IDS: undefined,

  // Pages to scan. Merged with the reviewed entries of ROUTES_FILE.
  PAGES: [],
  // Output of `a11y discover` — '' disables it.
  ROUTES_FILE: 'a11y.routes.json',

  // 'auto' (default): detect a login screen; if there is one, ask how to log in
  // (browser window / credentials / skip protected pages). In CI it uses
  // A11Y_STORAGE_STATE(_B64) or A11Y_USER/A11Y_PASS, or fails with instructions.
  // 'manual' | 'form' | 'none' pin a behaviour — see docs/GUIDE.md.
  LOGIN: { mode: 'auto', stateFile: '.a11y-auth.json' },

  // Start the app before scanning (see lib/webServer.js), e.g.
  // { command: 'npm run start', url: 'http://localhost:3000', reuseExisting: true }
  WEB_SERVER: null,

  // Accessibility lint of the source (JSX, Vue, Angular templates, plain HTML)
  // with the tool's own ESLint — runs with every scan when REPO_PATH is set.
  //   include: globs to lint instead of the defaults; exclude: extra ignores;
  //   rules: per-rule overrides, e.g. { 'jsx-a11y/no-autofocus': 'off' }.
  STATIC_LINT: { enabled: true, include: [], exclude: [], rules: {} },

  // Read source locations from dev builds (React/Vue/Angular/Svelte) — lib/runtimeSource.js.
  RUNTIME_SOURCE: true,
  // Stack ids for stack-specific fix advice; undefined → detected from REPO_PATH.
  STACKS: undefined,

  AUTO_EXPLORE: false,
  SAFE_MODE: true,
  DYNAMIC_CHECKS: true,
  DYNAMIC_ON_ALL_STATES: false,
  KEYBOARD_MAX_TABS: 50,

  SCREENSHOTS: { enabled: true, maxPerRule: 3, maxPerState: 15, padding: 24, maxWidth: 900, maxHeight: 650 },

  AXE_TAGS: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'],
  VIEWPORT: { width: 1440, height: 900 },
  SETTLE_MS: 900,

  OPEN_REPORT: true,
  REPORT_NAME: '',
};
