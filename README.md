# accessibility-check

[![npm](https://img.shields.io/npm/v/accessibility-check.svg)](https://www.npmjs.com/package/accessibility-check)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![node >= 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)

WCAG 2.2 A + AA accessibility checks for **any web project**: React, Next.js, Angular, Vue/Nuxt, ASP.NET Core, ASP.NET Web Forms, or a plain HTML site.

- **Scans the running app** in a real browser with two rule engines (axe-core and IBM Equal Access) plus its own keyboard, focus, screen-reader, contrast, zoom and form checks. It also scans the dialogs, menus and tabs it opens.
- **Lints your source** (JSX/TSX, Vue, Angular templates, HTML) and points to the exact `file:line`.
- **Tells you what to fix first.** The fix plan ranks issues by who they block, how many pages they hit and how quick they are to fix.
- **Proves your fixes worked.** Re-checks say *fixed*, *still failing* or *new*, and never guess.
- **Handles login screens**, and runs in CI with JUnit output and a build gate.

```bash
npx accessibility-check scan https://staging.example.com
```
No install and no config. It crawls up to 20 pages and opens the report.

## Requirements
- Node.js 20 or newer.
- On first run it offers to download Chromium (~150 MB), the browser it scans with.

## Use it in your project
```bash
npx accessibility-check init      # detect your stack, write a11y.config.js, list your pages
npx accessibility-check scan      # start the app, scan every page + lint the source, open the report
npx accessibility-check fix       # live fix plan: issues tick off as you fix them
npx accessibility-check verify    # re-check: ✔ fixed · ✗ still failing · ⚠ new · ? couldn't verify
```
To pin the version and skip the download on every run, install it as a dev dependency: `npm i -D accessibility-check`.

## Commands
| Command | What it does |
|---|---|
| `scan` | Full scan of the running app plus the source lint. Opens the report. |
| `scan <url>` | Quick scan of any URL with no config (`--max-pages N`, default 20). |
| `scan --public-only` | Skip the login and scan public pages only. |
| `fix` | Live fix plan in your browser. Re-checks when you save a file or click Re-check. `--no-watch`, `--port N` |
| `verify` | Re-scan the pages that had issues and report fixed / still failing / new (`--all` for every page). |
| `lint` | Source lint only, no browser, fast enough for a pre-commit hook (`--json`, `--strict`). |
| `init` | Detect the stack, write `a11y.config.js`, discover routes (`--ci github\|azure\|gitlab` adds a pipeline). |
| `discover` | Rebuild the routes list from source (`--live` adds sitemap.xml and a read-only crawl). |
| `login` | Log in once and save the session, for scans behind a login and for CI. |
| `render` / `combine` | Rebuild reports from the last scan / merge every archived run. |

The same list, with copy buttons, is under **Commands** in the report.

## What you get
Everything is written to `a11y-report/`:

| File | Use it for |
|---|---|
| `accessibility-report.html` | **The one to share.** One self-contained file with three tabs: Dashboard, Fix plan, All findings. Screenshots are embedded. |
| `fix-plan.html` | Issues in the order to fix them: **Fix first → Fix next → Schedule → Needs a decision → Can wait → Done**. Each card says why it is ranked there, how to fix it for your stack, and where it is in your code. |
| `dashboard.html` / `report.html` | All 56 WCAG 2.2 A/AA criteria (Failed / Needs review / No automated failures / Manual / N/A) and every finding. |
| `report.json`, `a11y-results.xml` | Machine-readable results and JUnit for CI test tabs. |

Decisions you make in the fix plan (in progress, snoozed, won't fix) are saved to `a11y.triage.json`. Commit it to share them with your team.

> **What automation can and can't tell you.** Automated testing reliably covers about 30–40% of WCAG. "No automated failures" means nothing detectable is wrong, not that the site is accessible. The report lists which criteria still need a person, and how to check each one.

## Configuration
`init` writes this for you. Only `BASE_URL` is required:
```js
// a11y.config.js
module.exports = {
  BASE_URL: process.env.A11Y_BASE_URL || 'http://localhost:3000',
  REPO_PATH: '.',                      // source folder, for file:line locations and watch mode
  WEB_SERVER: { command: 'npm run dev' }, // optional: start the app before scanning
  FAIL_ON: { critical: 0 },            // optional: exit 1 above these counts
};
```
Every option is described in the [configuration reference](docs/GUIDE.md#12-configuration-reference).

## CI
```bash
npx accessibility-check init --ci github   # or azure, gitlab
```
This adds a pipeline that scans every pull request, publishes the report and JUnit results, and fails on confirmed critical violations. Thresholds are set with `A11Y_FAIL_ON_CRITICAL`, `A11Y_FAIL_ON_SERIOUS` or `A11Y_FAIL_ON_TOTAL`. Only confirmed WCAG violations count: "needs review" and best-practice findings never fail a build.

Exit codes: `0` passed · `1` gate failed, or `verify` found issues still open · `2` setup problem (no config, app not reachable, login needed).

## Learn more
**📖 [The full guide](docs/GUIDE.md)** covers setup, logging in, reading the report, the fix plan, fixing and verifying, hidden UI (dialogs, tabs), CI, Playwright tests, Docker, every config option, and FAQ.

## Contributing
```bash
npm install
npx playwright install chromium
npm test
```
How the code is organised:
- `bin/a11y.js`: the CLI.
- `scan.js`: the browser scan.
- `lib/static/`: the source lint.
- `lib/priority.js` and `lib/fixPlan.js`: the fix plan.
- `lib/fixServer.js`: `fix`.
- `lib/verify.js`: fix verification.
- `lib/adapters/`: route discovery for each stack.
- `lib/aggregate.js` → `lib/report.js`: WCAG mapping and the reports.

Releasing: [docs/PUBLISHING.md](docs/PUBLISHING.md).

## License
[MIT](LICENSE)
