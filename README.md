# accessibility-check

WCAG 2.2 A + AA accessibility checks for **any web project**: React, Next.js, Angular, Vue/Nuxt, ASP.NET Core, ASP.NET Web Forms or a plain legacy site.

- **Scans the running app** with Playwright (axe-core + IBM Equal Access), including dialogs, menus and tabs.
- **Lints your source** (JSX, Vue, Angular templates, HTML) for the exact `file:line`.
- **Handles login screens by itself.** If there is no login it just scans; if there is one, it asks how you want to log in.
- **Tells you whether your fixes worked** when you run it again.

```bash
npx accessibility-check scan https://staging.example.com   # quick look, no setup
```

## In your project
```bash
npx accessibility-check init      # detect the stack, write a11y.config.js, list the pages
npx accessibility-check scan      # start the app, scan, lint, open the report
# … fix …
npx accessibility-check verify    # ✔ fixed · ✗ still failing · ⚠ new · ? couldn't verify
```

Other commands:
- `lint`: source only, no browser; fast enough for pre-commit.
- `login`: save a session for CI.
- `init --ci github|azure|gitlab`: add a pipeline.
- The guide also covers a Playwright fixture for checks inside your E2E tests.

The report (`a11y-report/accessibility-report.html`) covers:
- All 56 WCAG 2.2 A/AA criteria as **Failed / Needs review / Passed / Manual / N/A**.
- Every issue with a screenshot, fix advice for your stack, and its location in your code.
- Trends across runs.

> Automated testing reliably covers about 30–40% of WCAG. The report says which criteria still need a person, and how to check them.

**📖 Full guide: [docs/GUIDE.md](docs/GUIDE.md)**. It covers setup, login, reading the report, fixing and verifying, hidden UI, CI, Playwright, Docker, configuration and FAQ.

Requires Node.js 20+. The Chromium browser (~150 MB) is offered for download on first use.

## Contributing
```bash
npm install
npx playwright install chromium
npm test
```
How the pieces fit:
- `bin/a11y.js`: the CLI.
- `scan.js`: browser scan.
- `lib/auth/`: login detection.
- `lib/static/`: source lint.
- `lib/verify.js`: fix verification.
- `lib/adapters/`: route discovery per stack.
- `lib/aggregate.js` → `lib/report.js`: WCAG mapping and reports.

Releasing: [docs/PUBLISHING.md](docs/PUBLISHING.md).

## License
MIT
