# Accessibility Automation Tool — Specification

WCAG 2.2 Level A + AA conformance testing for a running web application, with
source-code attribution. Built to produce the evidence behind an Accessibility
Conformance Report (VPAT), not just a list of warnings.

---

## 1. What it is

A Node.js command-line tool that drives a real Chromium browser through an
authenticated web application, runs two independent accessibility rule engines
plus twelve purpose-built dynamic check modules against every page and every
revealed UI state, and produces a single self-contained HTML report.

**Zero AI. Zero model calls. Zero outbound network requests** beyond loading the
site under test. Results are deterministic: the same page in the same state
produces the same findings on every run. This matters because the output is
used as conformance evidence, and evidence must be reproducible and
attributable.

### Dependencies — four, all open source

| Package | Role |
|---|---|
| `playwright` | Browser automation |
| `axe-core` | Deque's rule engine (primary) |
| `@axe-core/playwright` | Binding between the two |
| `accessibility-checker-engine` | IBM Equal Access engine (second opinion) |

---

## 2. Coverage

WCAG 2.2 A + AA is **56 success criteria**. The product's VPAT marks 5 as Not
Applicable (2.1.4, 2.2.2, 2.3.1, 1.2.4, 3.1.2), and 4.1.1 Parsing is obsolete
in WCAG 2.2. That leaves **50 criteria in scope**.

| Classification | Count | % of scope |
|---|---|---|
| **Fully automated** — tool returns a pass/fail verdict with no human step | **34** | **68%** |
| **Partially automated** — tool decides the mechanical half, a human closes the rest | **11** | 22% |
| **Manual only** — no automated signal | **5** | 10% |
| **Some automated coverage (full + partial)** | **45** | **90%** |

> **Counting note.** "Fully automated" means the tool produces a verdict
> unaided. It does not mean the criterion is *proven* conformant — a pass is
> only as good as the pages that were scanned.

### 2.1 Partially automated (11)

The tool decides the mechanical half; a person judges the semantic half. Each
carries a step-by-step procedure in the report.

| Criterion | What automation decides | What a human decides |
|---|---|---|
| 1.3.3 Sensory Characteristics | Flags instructions containing shape/position/colour words | Whether the cue is the *only* identifier |
| 1.4.1 Use of Color | Inline links distinguished only by colour (`link-in-text-block`) | Status pills, chart legends, colour-coded cells |
| 1.4.3 Contrast (Minimum) | Measures contrast, including pixel-sampling backgrounds axe cannot resolve | Text over photographs, where no colour holds a plurality |
| 1.4.11 Non-text Contrast | Component boundary contrast from border/fill vs surround | Controls on gradients/images; graphical objects |
| 2.4.6 Headings and Labels | Empty, duplicate, placeholder headings; duplicate/generic labels | Whether distinct text is genuinely *descriptive* |
| 2.4.11 Focus Not Obscured | IBM's `element_tabbable_unobscured` | Sticky headers at mid-scroll positions |
| 2.5.7 Dragging Movements | IBM's `draggable_alternative_exists` | Whether the alternative is genuinely equivalent |
| 3.3.3 Error Suggestion | Whether a format error carries concrete correction info (example, constraint, format mask) | Tone, and whether the advice is *right* |
| 3.3.4 Error Prevention | That every page in `CONSEQUENTIAL_FLOWS` has a confirmation/review/undo | Which flows are consequential — declared once in config |
| 3.3.7 Redundant Entry | Repeated field identities within a page and across steps of one path prefix | Whether a repeat is genuinely essential |
| 2.5.2 Pointer Cancellation | Presses each down-event control and drags away — did anything still happen? | Gesture-driven widgets the pointer test cannot drive |

### 2.2 Manual only (5)

| Criterion | Level | Why automation cannot decide it |
|---|---|---|
| 1.2.5 Audio Description | AA | Requires watching the video †|
| 1.4.5 Images of Text | AA | Requires reading text inside images (OCR) |
| 2.5.1 Pointer Gestures | A | Requires attempting the task by single pointer |
| 2.5.4 Motion Actuation | A | Requires physically moving a device |
| 3.3.8 Accessible Authentication | AA | Requires judging cognitive load of the auth step |

† On a site with no `<audio>`/`<video>` elements, all media criteria (1.2.1,
1.2.2, 1.2.3, 1.2.4, 1.2.5, 1.4.2) are reported **Not Applicable**, determined
from a direct DOM census rather than inferred from rule results. On the current
target that is the case, so 1.2.5 costs nothing today.

### 2.3 Residual manual effort

Realistic residual effort is **30–45 minutes per page**. That covers triaging
the tool's confirmed findings for false positives, working the unresolved
contrast and colour review queues, the eleven partially automated criteria, the
five manual ones, and recording outcomes for the VPAT. It assumes the reviewer
works from pre-filtered queues with screenshots and source locations, not from
a blank page.

| Scope | Unassisted manual audit | With this tool | Reduction |
|---|---|---|---|
| Top 40 pages (99.7% of usage) | ~193 h | **~45–55 h** | ~3.5× |
| All 83 pages — first pass | ~400 h | **~85–100 h** | ~4× |
| Each subsequent re-audit | ~400 h | **~25–35 h** | ~13× |

First-pass figures include roughly 20 hours of one-off work: configuring the
page inventory, declaring consequential flows, establishing baselines and
triaging the initial backlog. Re-audits are far cheaper because the tool re-runs
unattended and only deltas need human attention — that recurring saving is the
real return, since a manual audit decays the moment the next sprint ships.

These are planning estimates derived from a measured scan rate of ~47 s/page
plus reviewer-effort assumptions. They have not been validated against a timed
audit.

---

---

## 3. Architecture — how it is built

### 3.1 Execution flow

1. **Load config**, then apply environment overrides so one config file serves
   local and CI without edits.
2. **Launch Chromium** and create a browser context with the configured
   viewport and, if present, a saved `storageState` (the login session).
3. **Instrument listeners** via `addInitScript`, which runs *before* the page's
   own scripts on every navigation. This is the only way to observe
   `addEventListener` registrations, and it is what makes 2.1.1 and 2.5.2
   testable at all — install it late and the page has already bound its
   handlers.
4. **Authenticate** — reuse the saved session, or open a headed window once for
   a manual login and save the result.
5. **For each configured page**: navigate, then run `analyze()` on the base
   state, then replay the page's `actions` and re-run `analyze()` at each
   `snapshot` marker, producing one result set per revealed UI state.
6. **Cross-page evaluation** once every page has been visited — consistency
   (3.2.3/3.2.4/3.2.6/2.4.5) and redundant entry across flow steps (3.3.7).
7. **Aggregate** all states into per-criterion status, a deduplicated issue
   list, a page × criterion matrix, and headline statistics.
8. **Lifecycle** — diff against archived runs for defect age, regression
   escapes, burn-up and resolutions.
9. **Write outputs** — single-file HTML report, `report.json`, JUnit XML, and
   a raw-results cache.
10. **Evaluate the gate** and exit with a status code the pipeline reads.

### 3.2 What `analyze()` does for one state

Order matters, and each step is wrapped so that one failure cannot kill the run:

| Step | Purpose |
|---|---|
| axe-core | Primary rule engine, retried once if the page navigates mid-analysis |
| Screenshots | Per-issue capture with a red highlight box, before any module mutates the page |
| `keyboard` / `screenReader` / `clickable` | Real Tab-walk, accessibility-tree analysis, unreachable click handlers |
| `viewport` | Base state only — resizes, then **always restores** |
| `interact` guard + `liveRegion` / `contextChange` / `pointerCancel` | Base state only; the guard is installed, locked, then uninstalled |
| `headings` / `uiContrast` / `formFlow` | Structural and boundary checks |
| `contrastPixel` | Resolves the colour-contrast results axe returned as *incomplete* |
| IBM engine | Independent second opinion over the same DOM |

### 3.3 The module contract

Every check module — regardless of what it tests or how — returns the same
shape axe-core does:

```
{ violations: [...], incomplete: [...], passes: [...] }
```

where each entry is `{ id, help, description, helpUrl, impact, tags, nodes }`
and `tags` includes a `wcagNNN` tag. That single convention is the entire
integration surface. The aggregator maps `wcagNNN` → criterion, so:

- adding a new criterion means writing a module that emits the right tag —
  no aggregator changes, no report changes, no config changes;
- new axe rules are picked up automatically as axe-core is upgraded;
- custom modules and vendor engines are indistinguishable downstream.

### 3.4 State exploration without clicking

Pages declare `actions`: `click`, `hover`, `fill`, `select`, `press`,
`waitFor`, `show`, `hide`, `css`, `snapshot`. The important ones are `show` and
`css` — they reveal a pre-rendered modal or an off-canvas drawer by overriding
its styles directly, *without* triggering any application JavaScript or server
call. That is how the tool reaches modal content on a live system that must not
be mutated. `snapshot` marks a point at which the full analysis re-runs.

### 3.5 Source attribution

When `REPO_PATH` is set, each finding is matched back to a probable source
location by searching the repository with ranked clues: element `id` first,
then image filename, then `aria-label`/`title`, then an unusual class
combination, then visible text. WebForms server-generated ids are normalised
first (`ctl00_MainContent_btnSave` → `btnSave`), without which nothing would
match. The result is a `file:line` on each finding, which is also what makes
inline pull-request comments possible.

### 3.6 Re-rendering without re-scanning

Raw results are cached to `.scan-cache.json`, so `npm run render` rebuilds every
report from the last scan. Report and dashboard changes can be iterated on in
seconds without touching the live site.

### 3.7 Design decisions worth knowing

- **Deterministic by construction.** No AI, no model calls, no network beyond
  the site under test. The output is conformance evidence, and evidence must be
  reproducible and attributable.
- **Absence of evidence is never a pass.** A criterion with no rule behind it
  reports `manual` and is flagged `untested`. Every module returns *no result*
  rather than a pass when it had nothing to exercise.
- **Confirmed and unconfirmed findings are kept apart.** Only confirmed
  violations gate a build; review items are published as a queue.
- **Writes are blocked at the network layer, not guessed at from markup.**
- **The second engine fills gaps, never overrides.** IBM decides a criterion
  only where our own engines produced nothing at all.

## 4. How verdicts are produced

### 4.1 Engines and modules

| Source | Criteria covered |
|---|---|
| `axe-core` (tags `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22a`, `wcag22aa`, `best-practice`, `experimental`) | The majority of static/markup criteria |
| `lib/keyboard.js` | 2.1.2, 2.4.3, 2.4.7 — real Tab-walk |
| `lib/screenReader.js` | 4.1.2 — accessibility-tree analysis |
| `lib/clickable.js` | 2.1.1 — click handlers on non-focusable elements |
| `lib/viewport.js` | 1.4.10, 1.4.4, 1.4.12, 1.3.4 — resize/zoom/spacing/orientation |
| `lib/liveRegion.js` | 4.1.3, 3.3.1, 3.3.3 — triggers validation; checks live regions and message quality |
| `lib/contextChange.js` | 3.2.1, 3.2.2, 1.4.13 — context change on focus/input/hover |
| `lib/consistency.js` | 3.2.3, 3.2.4, 3.2.6, 2.4.5 — cross-page comparison |
| `lib/contrastPixel.js` | 1.4.3 — pixel-samples backgrounds axe cannot resolve |
| `lib/headings.js` | 2.4.6 — heading/label structure |
| `lib/uiContrast.js` | 1.4.11 — component boundary contrast |
| `lib/formFlow.js` | 3.3.7 redundant entry, 3.3.4 error prevention (declared flows) |
| `lib/pointerCancel.js` | 2.5.2 — press, drag away, release; did anything happen? |
| `lib/interact.js` | No criteria — the write guard that makes the interactive modules safe |
| `accessibility-checker-engine` (IBM) | Gap-fill only — decides a criterion **only** where the above produce nothing |

### 4.2 Status resolution

Per criterion, in order:

1. `na` — obsolete, or a media criterion on a site with no media
2. `fail` — any confirmed violation
3. `review` — any inconclusive result
4. `pass` — a rule ran and found nothing wrong
5. **IBM verdict**, if our own engines produced nothing at all
6. `manual` — needs a human

> **Design rule: absence of evidence is never reported as a pass.** A criterion
> with no rule behind it reports `manual` and is flagged `untested`, not `pass`.
> Every module returns *no result* rather than a pass when it had nothing to
> exercise (no forms, no headings, no components).

### 4.3 Confirmed vs review

The quality gate counts **confirmed violations only**. "Incomplete" results —
where an engine could not determine the outcome — are published as a review
queue but never fail a build. On the current target the difference is 83
confirmed against 7,469 incomplete, so conflating them would make the gate
~90× louder than the real defect count.

---

## 5. Safety model

The tool runs against **real staging data**, so interaction is tiered and
enforced at the network layer rather than by guessing which control writes.

| Tier | Example | Status |
|---|---|---|
| 1 — client-side only | Open a modal, trigger validation | **On** |
| 2 — read-only server | Search, filter, sort (GET) | **On** |
| 3 — writes | Save, delete, approve (POST/PUT/PATCH/DELETE) | **Off** — requires `allowWrites: true` |

`lib/interact.js` intercepts every request. Non-GET requests are answered
**HTTP 204 No Content**, which blocks the write while keeping the current
document alive (`route.abort()` destroys the page and loses all revealed
state). While locked it also blocks destructive-looking GETs
(`/records/delete?id=42`) and navigation away from the page under test.

This matters because the target is ASP.NET WebForms, where only 21 of 5,435
button-like elements are `type="submit"` — any of the rest can post back from a
handler invisible in the markup. Classifying controls by markup is a guess; the
network boundary is not.

---

## 6. Configuration

One config file per role/portal (`config.site.js` = manager, 103 pages;
`config.employee.js` = employee, 10 pages). Separate configs are required
because the app sets different session variables per role, so one browser
session cannot hold both.

| Key | Purpose |
|---|---|
| `BASE_URL` | Target origin |
| `LOGIN` | `mode: 'form' \| 'manual'`, `reuse`, `stateFile`, `loginPageSelector` |
| `PAGES` | Explicit page list: `{ name, path, actions }` |
| `AUTO_EXPLORE` / `CRAWL_LINKS` / `MAX_PAGES` | Crawl mode instead of an explicit list |
| `SAFE_MODE` | Skip controls that look destructive |
| `AXE_TAGS` | Which axe rule tags to run |
| `DYNAMIC_CHECKS` / `KEYBOARD_MAX_TABS` | Keyboard/screen-reader modules |
| `LIVE_REGION_CHECKS` | Opt-in (`=== true`) for 4.1.3 / 3.3.1 / 3.3.3 interaction |
| `CONSEQUENTIAL_FLOWS` | Declared legal/financial/destructive flows, for 3.3.4 |
| `SECOND_ENGINE` | IBM engine on/off |
| `SCREENSHOTS` | Per-issue screenshots with highlight box |
| `VIEWPORT` / `SETTLE_MS` | Base viewport, settle delay |
| `REPO_PATH` / `CODE_EXTENSIONS` | Enables source attribution |
| `FAIL_ON` | Local gate thresholds |

### 6.1 Environment overrides (CI)

`A11Y_BASE_URL`, `A11Y_REPO_PATH`, `A11Y_MAX_PAGES`, `A11Y_STORAGE_STATE(_B64)`,
`A11Y_FAIL_ON_CRITICAL`, `A11Y_FAIL_ON_SERIOUS`, `A11Y_FAIL_ON_TOTAL`,
`A11Y_MIN_PAGE_COMPLETION`, `A11Y_FAIL_ON_REGRESSIONS`,
`A11Y_FAIL_ON_BLOCKER_AGE`, `A11Y_GATE_INCLUDE_UNCONFIRMED`.

### 6.2 Authentication

The app enforces SMS MFA. Its "Remember Browser" option suppresses the prompt
for ~30 days, so a `storageState` captured once by hand allows unattended runs
until it lapses. A test account with MFA disabled is the only permanent fix.

---

## 7. Output

| Artefact | Contents |
|---|---|
| `accessibility-report.html` | Single self-contained file — dashboard, every finding, screenshots inlined |
| `report.json` | Machine-readable criteria, issues, statistics |
| `a11y-results.xml` | JUnit — renders in the CI "Tests" tab |
| `.scan-cache.json` | Raw results, so `npm run render` rebuilds reports without re-scanning |

Each finding carries: rule id, impact, the offending HTML, a CSS selector, the
WCAG criteria it maps to, a plain-English fix, a screenshot, and — when
`REPO_PATH` is set — a probable `file:line` in the source.

Each criterion needing human work carries a **step-by-step manual procedure**
in the report (15 criteria currently).

### 7.1 Defect lifecycle

Findings are keyed `rule|page|target` and tracked across runs, producing defect
age, regression escapes (a previously clean page now failing), burn-up, and
resolution counts. Two lifecycle gates are available:
`A11Y_FAIL_ON_REGRESSIONS` and `A11Y_FAIL_ON_BLOCKER_AGE`.

---

## 8. CI

Azure Pipelines, weekly cron (Mondays 02:00 UTC). Two scan jobs run in
parallel (manager, employee) and feed one combine-and-gate job, so wall-clock
is the slower of the two rather than the sum.

Exit codes: `0` gate passed · `1` gate breached or fatal · `2` authentication
problem (an operational failure, explicitly *not* an accessibility regression).

Current thresholds: `A11Y_FAIL_ON_CRITICAL=40`, `A11Y_FAIL_ON_SERIOUS=90`,
`A11Y_MIN_PAGE_COMPLETION=40`. The practice is to start above current levels
and ratchet down.

---

---

## 9. Pull-request reporting (proposed)

> **Not built yet.** This section specifies the intended design so the output
> format can be agreed before implementation. Everything below describes
> behaviour that does not exist today.

The scan produces the same data whether it runs weekly or per pull request;
only the *scoping* and the *presentation* differ. Four surfaces, each doing
what it is good at.

### 9.1 Scope — which pages get scanned

Derived from the changed-file list. WebForms file-based routing makes the
common case exact: 99 of 103 configured pages are `.aspx` files whose path
equals their URL.

| Changed file | Pages scanned | Confidence |
|---|---|---|
| `*.aspx`, `*.aspx.vb` | 1 per file (direct map) | Exact |
| `*.ascx` user control | every page registering it, capped ~10 | High |
| `*.master` | pages using it, traffic-ranked, capped ~10 | Medium |
| global `*.css` / `*.js` | top N by usage, capped ~10 | Low — flagged partial |
| `App_Code/**` | none, unless it emits markup | Advisory |
| new page not in config | **none — reported NOT COVERED** | — |

That last row is a safety rule, not an omission: a change the scanner cannot
reach must be reported as uncovered, never as clean.

### 9.2 Summary comment

One comment per run, updated in place rather than appended, so the thread does
not grow with each push:

```
♿ Accessibility scan — 3 pages scanned

  NEW          2 violations   ← this PR must fix these
  FIXED        1 violation
  PRE-EXISTING 14 violations  (not gating)
  REVIEW       37 items       (not gating)

  Pages: /manage/staff/, /manage/staff/edit.aspx, /manage/apps/CapacityReport.aspx
  Criteria affected by NEW: 1.4.3 Contrast, 4.1.2 Name Role Value

  ⚠ Partial coverage: Site.css changed — scanned the 10 highest-traffic
    pages of an estimated 60 affected.

  Full report ↓ (build artifact)   |   Scan took 4m 12s
```

The gate fails on the **NEW** row only. Pre-existing findings and review items
are shown for context and never block a merge — without that rule the check
drowns every pull request in accumulated debt and people stop reading it.

### 9.3 Inline comments

One thread per new finding, anchored to the `file:line` produced by the source
attribution described in §3.5:

```
♿ Contrast 2.6:1 — needs 4.5:1   ·   WCAG 1.4.3 (AA)   ·   serious

<span class="muted">Last updated 14/03/2026</span>

Measured #9b9b9b on #ffffff from the rendered page.
Use #767676 or darker to reach 4.5:1.

New in this PR · page /manage/staff/ · rule color-contrast
```

Capped at roughly ten threads per run, with the remainder summarised. Threads
auto-resolve when the finding disappears on a later push.

### 9.4 Status check and test results

- **Status check** — a single pass/fail the branch policy can require.
- **Tests tab** — the JUnit file already produced (§7) renders as one test
  suite per page and one test case per criterion, so a reviewer can see exactly
  which criterion failed on which page without opening an artifact.
- **Build artifact** — the single self-contained HTML report, linked from the
  summary comment, for anyone who wants screenshots and full detail.

### 9.5 Rules that keep the results trustworthy

- Gate on **new** violations only, using the existing defect-lifecycle
  signature (`rule|page|target`) diffed against the target-branch baseline.
- Count **confirmed** violations only; unconfirmed items outnumber them by
  roughly 100 to 1 in real-world runs.
- **Fail loudly on operational failure.** An expired session or a crashed
  browser must never read as "no findings" — distinct exit codes and a minimum
  page-completion threshold already enforce this.
- **State partial coverage explicitly** whenever a blast-radius cap applied.

## 10. Verification

`npm test` — 9 suites covering `viewport`, `interact`, `liveRegion`,
`contextChange`, `consistency`, `contrastPixel`, `headings`/`uiContrast`, `formFlow`, `pointerCancel`.

Tests assert against ground truth (what an HTTP server actually received,
independently recomputed contrast values) rather than what a module claims,
and fixtures carry deliberate traps — an off-canvas menu and a wide data table
that overflow but are not defects; a page with nothing to test, which must
produce no verdict rather than a pass.

---

## 11. Known limits

- **Scans a running site.** Anything not deployed cannot be checked.
- **Blocked writes bound coverage.** States requiring a successful save (step 2+
  of a wizard) are never reached. Only a disposable database fixes this.
- **A pass means "on the pages scanned."** 103 of the product's ~83–110 pages
  are configured for the manager portal; coverage claims are bounded by that.
- **Viewport checks resize without reloading**, to preserve revealed state.
  Layout and media queries re-evaluate, but JS that reads width once at startup
  will not re-run.
- **Pixel contrast sampling needs a permissive CSP.** Where `data:` images are
  blocked, those findings remain review items.
- **Cross-page consistency needs 3+ pages** before it will compare anything.
