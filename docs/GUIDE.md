# accessibility-check — User Guide

Checks a web project against **WCAG 2.2 Level A + AA**. It works on React, Next.js, Angular, Vue/Nuxt, ASP.NET Core, ASP.NET Web Forms and plain or legacy HTML sites. It does two complementary things:

| | What it looks at | What it gives you |
|---|---|---|
| **Browser scan** | The running app, page by page, including dialogs, menus and tabs it opens | Problems exactly as users meet them, with a screenshot of each |
| **Source lint** | Your JSX / Vue / Angular templates / HTML files | The exact `file:line` to change, even for screens the scan never reached |

Both feed one report. Each issue is mapped to a WCAG success criterion and comes with fix advice for your stack. When you re-run the tool after fixing, it tells you what is actually fixed.

---

## Contents
1. [Requirements](#1-requirements)
2. [Quick scan of any URL (2 minutes)](#2-quick-scan-of-any-url)
3. [Set it up in your project](#3-set-it-up-in-your-project)
4. [Logging in](#4-logging-in)
5. [Reading the report](#5-reading-the-report)
6. [Fixing issues and checking your fixes](#6-fixing-issues-and-checking-your-fixes)
7. [Dialogs, tabs and other hidden UI](#7-dialogs-tabs-and-other-hidden-ui)
8. [Source lint on its own](#8-source-lint-on-its-own)
9. [Continuous integration](#9-continuous-integration)
10. [Inside your Playwright tests](#10-inside-your-playwright-tests)
11. [Docker](#11-docker)
12. [Configuration reference](#12-configuration-reference)
13. [Troubleshooting & FAQ](#13-troubleshooting--faq)

---

## 1. Requirements
- **Node.js 20 or newer** (`node -v`).
- About 150 MB for the Chromium browser. The first scan offers to download it, or run `npx playwright install chromium` yourself.
- Nothing has to be added to your project's `package.json`. `npx` downloads the tool on demand.

The commands below use `npx accessibility-check …`. If you install it globally (`npm i -g accessibility-check`), the short name `a11y …` works too.

## 2. Quick scan of any URL
```bash
npx accessibility-check scan https://staging.example.com
```
- It crawls the site read-only, scans up to 20 pages (`--max-pages 50` for more) and writes `./a11y-report/`.
- It opens `a11y-report/accessibility-report.html` when done. This single file is the one to share.
- If the site has a login screen, it asks how you want to log in (see [§4](#4-logging-in)).

A quick scan is good for a first look. For anything you'll repeat, set the project up as below.

## 3. Set it up in your project
Run these from your project's root folder:

```bash
npx accessibility-check init        # 1. detect the stack, write a11y.config.js, list routes
#    → open a11y.config.js and check BASE_URL / WEB_SERVER
npx accessibility-check discover --live   # 2. (optional) add pages found on the running site
#    → review a11y.routes.json
npx accessibility-check scan        # 3. scan
```

**What `init` does**
- **Detects the framework** from your source. It reads routes from React Router, Next.js `pages/` + `app/`, Angular `Routes`, Vue Router / Nuxt `pages/`, Razor Pages / MVC / Blazor, or `.aspx` files.
- **Writes `a11y.config.js`.** It guesses `BASE_URL` (the dev-server URL) and `WEB_SERVER` (the command that starts your app), and the scan starts and stops the app for you.
- **Writes `a11y.routes.json`**, the list of pages to scan:
  - `"include": false` leaves a page out.
  - Dynamic routes like `/users/:id` need a sample value in `"params"`, e.g. `{ "id": "42" }`. `discover --live` fills these in from real URLs.
- **Adds** `a11y-report/` and `.a11y-auth.json` to your `.gitignore` (if the project has one).

**Other stacks** (Svelte, Laravel, Django, Rails, PHP, static sites): `init` won't find routes in the source. Use `discover --live`, which reads `sitemap.xml` and crawls the running site, or list pages under `PAGES` in the config.

Re-run `discover` whenever routes change. Your edits to `include`/`params` are kept, and routes that disappeared are marked `"gone"`.

## 4. Logging in
You don't need to configure anything. On every scan the tool checks whether pages redirect to a login screen:

- **No login screen:** it scans straight away.
- **Login screen found:** it asks:
  ```
  🔒 Login required. Pages redirect to a login screen (/login).
     1) Log in myself in a browser window  (works with SSO, MFA, captchas)
     2) Enter username and password here  (password is not saved; only the session cookie is)
     3) Skip protected pages — scan only what is public
  ```
  1. **Browser window:** a Chrome window opens and you log in normally. Use this for Microsoft/Google/Okta SSO and anything with MFA.
  2. **Username & password:** the tool finds the login form and fills it in. It handles one-page forms and two-step "username → Next → password" forms. Your typing is masked.
  3. **Skip:** pages behind the login are listed in the report as *not scanned*.

After a successful login:
- The session is saved in `.a11y-auth.json` and reused next time, so you won't be asked again until it expires. Delete the file to log in again. **Never commit it**; it contains live cookies.
- The tool offers to write the working login settings into `a11y.config.js`. It writes selectors only, never your password, so CI can log in the same way.
- **The login page itself is scanned too**, since it is often the most-used screen.

It also detects HTTP Basic/Windows authentication (it asks for credentials and keeps them in memory only) and redirects to external sign-in providers.

**Different roles** (admin vs. staff): use one config per role, each with its own `LOGIN.stateFile` and `REPORT_NAME`. Then run `npx accessibility-check combine` to merge the runs into one report.

**For CI**, see [§9](#9-continuous-integration). In short:
- `A11Y_USER` / `A11Y_PASS` secrets for a test account, or
- a saved session from `npx accessibility-check login`, or
- `--public-only`.

## 5. Reading the report
`a11y-report/` contains:

| File | What it is |
|---|---|
| `accessibility-report.html` | **Start here.** One self-contained file with three tabs (Dashboard, Fix plan, All findings) and embedded screenshots. Safe to email or attach to a ticket. |
| `fix-plan.html` / `fix-plan.json` | The issues in the order to fix them; see [§6](#6-fixing-issues-and-checking-your-fixes). |
| `dashboard.html` / `report.html` | The same as two linked pages. |
| `report.json` | Machine-readable results (CI, scripts). |
| `a11y-results.xml` | JUnit, one test per page, for CI test tabs. |
| `reports/` | History of every run, used for trends and fix verification. Keep it between runs. |

`a11y.triage.json` (next to your config, not in `a11y-report/`) holds the fix-plan decisions: in progress, snoozed, won't fix. Commit it.

**Commands.** The **Commands** button on the dashboard and the fix plan lists every command (re-scan, verify, lint, login, CI setup…) with a Copy button. In the fix plan, press <kbd>c</kbd>.

**WCAG criteria status.** All 56 WCAG 2.2 A/AA criteria are listed, each with one status:

| Status | Meaning | What to do |
|---|---|---|
| **Failed** | At least one confirmed violation. | Fix the listed issues. |
| **Needs review** | The engine found something it couldn't decide, e.g. contrast over an image, or a lint heuristic on a custom component. | A person checks it; often real, sometimes not. |
| **No automated failures** | A rule or check examined matching elements on the scanned pages and found nothing wrong. Automation covers part of a criterion, never all of it. | Nothing urgent; the card lists what a person should still check. |
| **Manual** | Automation can't test this criterion (e.g. "captions are accurate"), or its rules ran but found nothing to examine (e.g. no `<meta refresh>` for 2.2.1). | A person checks it. The card says how. |
| **N/A** | Doesn't apply (e.g. media criteria on a site with no video). | |

> **Be clear about what automation proves.** Automated tools can reliably check about 30–40% of WCAG. A report with no failures means "nothing automatically detectable is wrong". It does not mean "the site is accessible". The Manual list is the rest of the job.

**Each issue shows:**
- **Severity:** critical / serious / moderate / minor.
- **Type:** *Violation*, *Needs review*, or *Best practice* (an axe rule with no WCAG criterion; listed as advice, not counted as a violation and never fails the build).
- **Repeats:** the same problem on several pages (a shared header button) is one issue per page, and the report also counts it once as a *unique* problem. When the tool's own check and axe flag the same element, it is one issue.
- **Source:** *Browser* (found in the running app) or *Source lint* (found in your files). If both found the same problem, it says so: *"also reported by the source lint at src/Nav.tsx:42 — one fix closes both"*.
- **WCAG criteria** it breaks.
- **The element's HTML** and a **screenshot** with the element highlighted.
- **How to fix it**, with notes for your stack (JSX, Angular templates, Vue SFCs, Razor, Web Forms).
- **Where it is in your code:**
  - *exact* / *high*: read from a dev build or the lint, so trust it.
  - *medium*: a best text-search guess.

**Exact locations from the browser scan.** Scan a **dev server** (`npm run dev`, `ng serve`, …) to get exact locations. Dev builds of React, Vue, Angular and Svelte record which file each element came from. Production builds fall back to text search.

**Report filters:** severity, violation vs. review, browser vs. source lint, and a per-page view on the dashboard.

## 6. Fixing issues and checking your fixes
The loop is: **scan → fix → verify**. The easiest way to run it is the live fix plan.

### The fix plan: what to fix first
Every scan writes `a11y-report/fix-plan.html`. It is also the **Fix plan** tab in the single-file report, and the dashboard's **Where to start** panel links to it. Instead of one long list sorted by severity, it groups each unique defect into a tier:

| Tier | What goes there |
|---|---|
| **Fix first** | Critical issues, and serious ones that block a group of people (no accessible name, unreachable by keyboard, no focus indicator) or appear on 3+ pages |
| **Fix next** | Other serious failures, and moderate ones that still block someone (for example, zoom disabled) |
| **Schedule** | Moderate and minor WCAG failures |
| **Needs a decision** | The scanner couldn't decide; a person checks and fixes or dismisses each one |
| **Can wait** | Best practice, not a WCAG failure |
| **Done** | Proven fixed by a re-check |

Within a tier, defects are ordered by impact, WCAG level (A before AA), how many pages they appear on, and a rough effort estimate. Every card says *why* it is ranked where it is ("Blocks screen-reader users · One fix clears 4 pages · Quick fix"). Fixes estimated at about 5 minutes in the top two tiers are marked **quick wins** and have their own filter. The same element on several pages is one card, because it is one fix.

Each card has the fix advice for your stack, the source location (`file:line` with a confidence level), the affected elements with screenshots, and **Copy as ticket** (Markdown for Jira, GitHub or Azure Boards). You can mark a card **in progress**, **snooze** it, or set it aside as **won't fix** with a reason.

### Live: watch issues tick off as you fix them
```bash
npx accessibility-check fix
```
This opens the fix plan in your browser at `http://127.0.0.1:4777` and keeps it current:
- **Re-check** on a card (or **Re-check all open**) re-scans just the pages involved, the same way `verify` does. Fixed cards turn green and move to **Done**, the progress bar updates, and anything new is flagged.
- **Save a file and it re-checks by itself** (needs `REPO_PATH` in the config). The pages whose issues point at that file are re-checked; a change nothing maps to, such as a stylesheet, re-checks every open page. Turn this off with `--no-watch`.
- **Decisions are saved to `a11y.triage.json`** next to your config. Commit it so the team shares them. Snoozed items return on their own when the snooze ends.
- If there is no scan yet, it runs one first (and asks you to log in if needed). With `WEB_SERVER` in the config, it starts your app once and keeps it running.

Options: `--port N`, `--no-open`, `--no-watch`, or a URL for a project without a config (`npx accessibility-check fix https://staging.example.com`). The server listens on 127.0.0.1 only and accepts changes only from the page it served.

Keyboard: <kbd>/</kbd> filter, <kbd>j</kbd>/<kbd>k</kbd> move between cards, <kbd>Enter</kbd> open, <kbd>r</kbd> re-check, <kbd>p</kbd> in progress, <kbd>?</kbd> help.

### Without the live page

```bash
npx accessibility-check scan      # find issues
# … fix them …
npx accessibility-check verify    # re-check
```

`verify` re-scans **only the pages that had issues** (add `--all` for everything) plus the source lint. It compares each issue with the previous scan of the same page:

```
Fix verification (vs. the previous scan of each page):
  ✔ 14 fixed · ✗ 3 still failing · ⚠ 1 new · ? 2 couldn't verify
    ✗ Users · button-name
    ⚠ Settings · label
    ? Users · image-alt  — the element is hidden this time (did its dialog / tab open?)
```

| Result | Meaning |
|---|---|
| **✔ fixed** | The element was found again, visible, and the rule now passes. For lint: the rule no longer fires on that line. |
| **✗ still failing** | Same problem, same element. |
| **⚠ new** | Wasn't there last time; usually introduced by recent changes. |
| **? couldn't verify** | The element or the dialog it lived in wasn't there this time, so the tool can't prove a fix. Check by hand or make the dialog open (see [§7](#7-dialogs-tabs-and-other-hidden-ui)). |

`verify` exits with code 1 while anything is still failing or new, so you can use it as a PR check. The dashboard shows the same breakdown under **Fix verification**.

A normal `scan` also prints this comparison whenever there is a previous run to compare with.

Tips:
- Lint findings follow the code. Moving a line up or down doesn't count as fixed.
- Removing an element is not counted as a fix. It shows as *couldn't verify*, because a vanished button is more often missing test data than a real fix.

## 7. Dialogs, tabs and other hidden UI
A plain page scan only sees what is on screen. To check a dialog, menu, accordion or tab, describe how to open it in `a11y.config.js` (or on the route in `a11y.routes.json`):

```js
PAGES: [{
  name: 'Users', path: '/users',
  actions: [
    { type: 'click', selector: 'button:has-text("Add user")' },
    { type: 'waitFor', selector: '[role="dialog"]' },
    { type: 'snapshot', label: 'Add user dialog' },      // ← scanned here
    { type: 'press', selector: '[role="dialog"]', value: 'Escape' },
    { type: 'click', selector: '[role="tab"]:has-text("Archived")' },
    { type: 'snapshot', label: 'Archived tab' },         // ← and here
  ],
}],
```
**Actions:**
- `click`, `hover`, `fill`, `select`, `press`
- `waitFor` (selector), `waitForUrl`, `wait` (ms)
- `show` / `hide`: force a hidden element visible or hidden without clicking anything (for pre-rendered modals)
- `css`: style overrides for off-screen drawers
- `snapshot`: scan the current state

Selectors are Playwright selectors, so `text=…`, `:has-text()` and `role=button[name="Save"]` all work.

Or set `AUTO_EXPLORE: true` to let the tool click through buttons and tabs itself. It is read-only: `SAFE_MODE` blocks form submissions, deletes and other non-GET requests.

## 8. Source lint on its own
```bash
npx accessibility-check lint            # this project
npx accessibility-check lint src/       # a folder
npx accessibility-check lint --strict   # also fail on "needs review" findings
npx accessibility-check lint --json     # machine-readable
```
- No browser and no running app, so it takes a few seconds. That makes it a good fit for a **pre-commit hook** (e.g. with husky: `npx accessibility-check lint`).
- It uses the tool's own ESLint and accessibility plugins, so your project's ESLint version and config don't matter, and it runs even without ESLint installed. `// eslint-disable-next-line jsx-a11y/alt-text` comments in your code are respected.

**Coverage by stack:**

| Stack | Files | Rules |
|---|---|---|
| React / Next.js | `.jsx .tsx` (and `.js .ts` in React projects) | eslint-plugin-jsx-a11y |
| Vue / Nuxt | `.vue` | eslint-plugin-vuejs-accessibility |
| Angular | `.html` templates and inline `template:` in `.component.ts` | @angular-eslint/template accessibility rules |
| Other HTML | `.html .htm` | @html-eslint |
| Razor / Web Forms / PHP / other templates | — | not parseable as HTML; covered by the browser scan |

**How findings are reported:**
- **✗ violation:** rules that are reliable wherever they fire (missing `alt`, invalid ARIA, positive `tabindex`, missing `lang`). These count as failures.
- **? review:** heuristics that can misfire on custom components (e.g. "label has associated control" on your own `<FormLabel>`). These never fail a criterion on their own.

To turn rules off or skip folders:

```js
STATIC_LINT: { exclude: ['src/legacy/**'], rules: { 'jsx-a11y/no-autofocus': 'off' } }
```

## 9. Continuous integration
```bash
npx accessibility-check init --ci github    # or: azure, gitlab
```
This writes a pipeline that, on every PR and on a weekly schedule:
1. Installs your app and the checker, and starts the app (`WEB_SERVER`).
2. Runs the scan and the source lint.
3. Keeps the scan history, so the report shows trends and fix verification.
4. Publishes `accessibility-report.html` plus per-page JUnit results.
5. Fails the build when thresholds are exceeded.

**Settings (CI variables / secrets):**

| Name | Use |
|---|---|
| `A11Y_USER`, `A11Y_PASS` | Test account. The login form is detected and filled automatically. |
| `A11Y_STORAGE_STATE_B64` | Saved session for SSO/MFA logins. Create it with `npx accessibility-check login`, which prints the command to get the base64. Sessions expire; refresh when CI says so. |
| `A11Y_PUBLIC_ONLY=1` | Don't log in; scan public pages only. |
| `A11Y_FAIL_ON_CRITICAL`, `A11Y_FAIL_ON_SERIOUS`, `A11Y_FAIL_ON_TOTAL` | Fail the build above these counts of **confirmed WCAG** violations (browser + lint). "Needs review" items never fail the build unless `A11Y_GATE_INCLUDE_UNCONFIRMED=1`; best-practice findings never do. The generated pipelines default `A11Y_FAIL_ON_CRITICAL` to `0`. Without any threshold the scan warns that the build cannot fail. |
| `A11Y_GATE_UNIQUE=1` | Count a defect that repeats on many pages (a shared component) once. |
| `A11Y_BASE_URL` | Scan a deployed environment instead of starting the app. |

If a login is needed but none of the above is set, the scan stops with exit code 2 and says what to add. It never hangs waiting for a person.

**Adopting it on an existing project:** the generated pipelines fail on any confirmed critical violation (`A11Y_FAIL_ON_CRITICAL=0`). To start in report-only mode, set the `A11Y_FAIL_ON_CRITICAL` variable to a high number, then lower it as issues are fixed and add `A11Y_FAIL_ON_SERIOUS`.

## 10. Inside your Playwright tests
Your E2E tests already log in, seed data and open dialogs. You can check accessibility at those points too:
```ts
// tests/fixtures.ts
import { test as base } from '@playwright/test';
import { withA11y } from 'accessibility-check/playwright';
export const test = withA11y(base);

// in a test
await page.getByRole('button', { name: 'Add user' }).click();
const r = await a11y.check('Add user dialog');
// optional: expect(r.violations).toEqual([]);

// playwright.config.ts
reporter: [['list'], ['accessibility-check/playwright/reporter', { failOnGate: false }]],
```
`accessibility-check` must be a dev dependency for this (`npm i -D accessibility-check`).

How the results are handled:
- Results are named after the matching route and merge into the same report.
- Tests that use the fixture without calling `check()` are scanned at their final page.
- Sharded CI: set the reporter option `finalize: false`, collect the `a11y-report/.e2e-scans/` folders, then run `npx accessibility-check e2e-report`.

## 11. Docker
For machines without Node, or CI runners without a browser:
```bash
docker build -t accessibility-check .          # from this repository
docker run --rm -v "$PWD:/work" accessibility-check scan https://staging.example.com
docker run --rm -v "$PWD:/work" -e A11Y_BASE_URL=http://host.docker.internal:3000 accessibility-check scan
```
- The app runs outside the container. On macOS/Windows, reach it via `host.docker.internal`. On Linux, add `--add-host=host.docker.internal:host-gateway`.
- The container is non-interactive, so a login must come from `A11Y_USER`/`A11Y_PASS` or a saved session.

## 12. Configuration reference
`a11y.config.js` only needs `BASE_URL`; everything else has a default. A fuller example is in [`examples/a11y.config.example.js`](../examples/a11y.config.example.js).

| Setting | Default | Purpose |
|---|---|---|
| `BASE_URL` | — | Where the app runs. Env: `A11Y_BASE_URL`. |
| `WEB_SERVER` | none | `{ command, cwd, url, timeout, reuseExisting, env }`: start the app for the scan. |
| `REPO_PATH` | `'.'` (from `init`) | Source folder for lint and code locations; `''` disables both. Env: `A11Y_REPO_PATH`. |
| `OUTPUT_DIR` | `'a11y-report'` (from `init`) | Where reports and history go. |
| `REPORT_NAME` | project folder name | Name in the history; separate names keep separate histories. |
| `PAGES` | `[]` | Extra pages, with optional `actions` ([§7](#7-dialogs-tabs-and-other-hidden-ui)). |
| `ROUTES_FILE` | `'a11y.routes.json'` | Pages from `discover`; `''` disables. |
| `LOGIN` | `{ mode: 'auto' }` | `auto` (detect and ask), `manual` (always a browser window), `form` (scripted steps), `none`. Also `stateFile`, `startPath`, `timeoutMs`, `scanLoginPage: false`. |
| `STATIC_LINT` | enabled | `{ enabled, include, exclude, rules }`. |
| `FAIL_ON` | none | `{ critical, serious, total }` build thresholds. |
| `AUTO_EXPLORE` / `SAFE_MODE` | `false` / `true` | Let the tool open hidden UI itself, read-only. |
| `HEADLESS` | auto | `false` to watch the scan in a visible browser. Env: `A11Y_HEADLESS=0`. |
| `VIEWPORT` | 1440×900 | Browser size. Reflow (320 px) and zoom checks run separately. |
| `SETTLE_MS` | 900 | Wait after each navigation or action before scanning. |
| `SCREENSHOTS` | enabled | `{ enabled, maxPerRule, maxPerState }`. |
| `AXE_TAGS` | WCAG 2.0–2.2 A/AA + best practice | Which axe rules run. |
| `IGNORE_HTTPS_ERRORS` | `true` | Accept self-signed dev certificates. |
| `OPEN_REPORT` | `true` | Open the report when done (always off in CI). |

**Environment variables:**
- `A11Y_CONFIG`: config path
- `A11Y_CI=1`: force CI behaviour
- `A11Y_MAX_PAGES`, `A11Y_MIN_PAGES`
- `A11Y_TIMING=0`: hide timings
- The login and gate variables from [§9](#9-continuous-integration)

**All commands:**
```
init [dir] [--url URL] [--ci github|azure|gitlab] [--force]
discover [dir] [--live] [--max-pages N]
scan [--config FILE] [--public-only]      scan <url> [--max-pages N]
verify [--all]
lint [dir] [--strict] [--json]
login
render       rebuild the report from the last scan, without scanning
combine      merge runs (e.g. different roles) into one report
e2e-report   report from sharded Playwright runs
```

## 13. Troubleshooting & FAQ

**What do the exit codes mean?**
`0`: done, gate passed. `1`: the build gate failed, or `verify` found issues still open. `2`: a setup problem (no config, the app wasn't reachable, a login is needed in CI, or nothing could be scanned). CI can tell "the site has issues" (1) from "the scan couldn't run" (2).

**npm warns "eslint@9 … no longer supported" during install.**
Expected. The React lint rules (`eslint-plugin-jsx-a11y`) don't support ESLint 10 yet, so the tool stays on ESLint 9 for now. It uses its own copy and doesn't touch your project's ESLint.

**`npx a11y` runs a different tool.**
`a11y` is a short alias that works once the package is installed (`npm i -D accessibility-check`). Without installing, use `npx accessibility-check`, because an unrelated npm package is already called `a11y`.
**"Nothing to scan: PAGES is empty."**
Run `discover` (or `discover --live`) and check `"include"` in `a11y.routes.json`, or add `PAGES`.

**Every page says "Redirected to login".**
The saved session expired. Delete `.a11y-auth.json` and scan again. In CI, refresh `A11Y_STORAGE_STATE_B64` or use `A11Y_USER`/`A11Y_PASS`.

**The login wasn't detected / the wrong fields were filled.**
Pick option 1 (browser window), or pin a scripted login with `LOGIN: { mode: 'form', steps: [...] }` (see the example config).

**Could not start the app.**
Check `WEB_SERVER.command` runs on its own, and that `WEB_SERVER.url` (or `BASE_URL`) is the address it serves. Remove `WEB_SERVER` to start the app yourself.

**"Couldn't verify" after my fix.**
The element or its dialog wasn't on screen during the re-scan. Make sure the `actions` still open it, or check by hand.

**Too many "Needs review" contrast items.**
These are usually text over images or gradients that the engine can't measure. Check a few by eye; they never fail the build by default.

**The lint flags my custom component.**
If it's a heuristic (? review), check the rendered output. If the component is fine, add an `eslint-disable-next-line` comment with a reason, or turn the rule off in `STATIC_LINT.rules`.

**Is my data safe?**
- The crawl and `AUTO_EXPLORE` never submit forms, and they block non-GET requests.
- Passwords typed at the prompt are never written to disk.
- Session files are added to `.gitignore` by `init`.
- Reports may contain page content and screenshots, so share them like any internal document.

**Does a clean report mean we're compliant?**
No. See [§5](#5-reading-the-report). Use it to catch regressions continuously, and pair it with a manual review of the *Manual* criteria and a screen-reader pass of key flows.
