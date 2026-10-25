# Changelog

## 0.1.0 — first public release

- `scan` — WCAG 2.2 A + AA scan of the running app with Playwright (axe-core + IBM Equal Access), including modals, tabs and other revealed states.
- `scan <url>` — quick scan of any URL with no config: crawls up to 20 pages.
- Login handling — detects a login screen by itself (form, identifier-first, HTTP Basic, SSO redirect) and asks how to log in. In CI it uses `A11Y_USER` / `A11Y_PASS`, a saved session, or `--public-only`.
- `lint` — accessibility lint of the source with the tool's own ESLint (jsx-a11y, vuejs-accessibility, angular-eslint template, html-eslint), mapped to WCAG. Also runs as part of every `scan`.
- `verify` — re-checks the previous issues after a fix: fixed / still failing / new / couldn't verify.
- `init` / `discover` — detect the stack (React, Next.js, Angular, Vue/Nuxt, ASP.NET Core, Web Forms) and read routes from source; `--live` adds the sitemap and a read-only crawl.
- Playwright fixture and reporter for checks inside existing E2E tests.
- CI templates for GitHub Actions, Azure Pipelines and GitLab.
