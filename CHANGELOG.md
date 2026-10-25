# Changelog

## Unreleased — accuracy

- One defect, one issue: a node that is "needs review" in one state and a violation in another is a violation; the tool's own checks are folded into the axe issue for the same element (`alsoFlaggedBy`); the contrast sampler replaces axe's undecided result instead of adding a second one.
- Repeats across pages are counted once in `stats.unique` and shown as "N violations (M unique)"; `A11Y_GATE_UNIQUE=1` gates on that.
- Headline numbers, health scores, charts and trends count confirmed WCAG violations only. Review items and best-practice findings are listed but shown separately; trends and Δ only compare scans of the same pages.
- Best-practice axe rules are labelled as such and never count toward the CI gate.
- A criterion whose rules were only inapplicable is no longer "Passed"; the status is renamed "No automated failures".
- IBM Equal Access: recommendation-level rules are ignored, it no longer decides manual-only criteria, and an IBM-only failure is "needs review" (no element to act on).
- 3.2.6 Consistent Help and 3.3.7 Redundant Entry are Level A.
- JUnit: `tests=` matches the real number of cases; lint findings get their own suite.
- CI templates fail on confirmed critical violations by default; the scan warns in CI when no threshold is set; non-numeric thresholds (an unset Azure variable) no longer silently disable the gate.
- Fix advice no longer names Bootstrap, `_Layout.cshtml` or jQuery for every project; stack-specific advice comes from the detected stack.

## 0.1.0 — first public release

- `scan` — WCAG 2.2 A + AA scan of the running app with Playwright (axe-core + IBM Equal Access), including modals, tabs and other revealed states.
- `scan <url>` — quick scan of any URL with no config: crawls up to 20 pages.
- Login handling — detects a login screen by itself (form, identifier-first, HTTP Basic, SSO redirect) and asks how to log in. In CI it uses `A11Y_USER` / `A11Y_PASS`, a saved session, or `--public-only`.
- `lint` — accessibility lint of the source with the tool's own ESLint (jsx-a11y, vuejs-accessibility, angular-eslint template, html-eslint), mapped to WCAG. Also runs as part of every `scan`.
- `verify` — re-checks the previous issues after a fix: fixed / still failing / new / couldn't verify.
- `init` / `discover` — detect the stack (React, Next.js, Angular, Vue/Nuxt, ASP.NET Core, Web Forms) and read routes from source; `--live` adds the sitemap and a read-only crawl.
- Playwright fixture and reporter for checks inside existing E2E tests.
- CI templates for GitHub Actions, Azure Pipelines and GitLab.
