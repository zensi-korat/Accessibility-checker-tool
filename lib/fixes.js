/**
 * Human fix guidance keyed by axe rule id. axe already gives a generic
 * `help` + `helpUrl`; this adds concrete advice, plus — from STACK_NOTES —
 * what the fix looks like in the project's own framework (JSX, Angular
 * templates, Vue SFCs, Razor, Web Forms controls). Only the notes for the
 * stacks detected in the project are shown.
 *
 * If a rule isn't listed, the report falls back to axe's own help text.
 */
const FIXES = {
  'image-alt': {
    what: 'An <img> has no text alternative.',
    fix: 'Add alt text. Meaningful image: `<img src="logo.png" alt="Acme Corp" />`. Decorative only: `alt=""`. For CSS/background icons used as content, add `role="img"` + `aria-label`.',
  },
  'input-image-alt': {
    what: 'An <input type="image"> button has no alt text.',
    fix: 'Add `alt="Search"` (describe the action, not the picture).',
  },
  'area-alt': { what: 'Image-map <area> lacks alt.', fix: 'Give every <area> an `alt` describing its destination.' },
  'role-img-alt': { what: 'role="img" element has no accessible name.', fix: 'Add `aria-label` or `aria-labelledby`.' },
  'svg-img-alt': { what: 'SVG treated as an image has no name.', fix: 'Add `role="img"` + `<title>` inside the SVG, or `aria-label` on the <svg>.' },
  'object-alt': { what: '<object> has no text alternative.', fix: 'Add fallback text between the <object> tags or an `aria-label`.' },

  'color-contrast': {
    what: 'Text contrast is below 4.5:1 (or 3:1 for large text).',
    fix: 'Darken the text or lighten the background. Muted/secondary text colours and theme grays are the usual culprits. Fix at the CSS variable / SASS level (e.g. `$text-muted`) so it applies site-wide instead of per element.',
  },
  'link-in-text-block': {
    what: 'Links are distinguished from surrounding text by color alone.',
    fix: 'Add `text-decoration: underline` (or a non-color cue) to inline links, or raise contrast between link and body text to ≥ 3:1.',
  },

  label: {
    what: 'A form field has no associated label.',
    fix: 'Add `<label for="fieldId">…</label>` matching the input `id`, or wrap the input in the label. A `placeholder` is NOT a label. If the label must be visually hidden, hide it with a screen-reader-only class (e.g. `.sr-only` / `.visually-hidden`) rather than removing it.',
  },
  'label-title-only': { what: 'Field is only labelled via title/placeholder.', fix: 'Add a real <label>; keep title as extra help only.' },
  'form-field-multiple-labels': { what: 'Field has more than one label.', fix: 'Keep a single <label>; use aria-describedby for hints.' },
  'select-name': { what: '<select> has no accessible name.', fix: 'Associate a <label for> or add aria-label.' },
  'aria-input-field-name': { what: 'ARIA input has no name.', fix: 'Add aria-label / aria-labelledby to the role="textbox|combobox|…" element.' },

  'document-title': { what: 'Page has no <title>.', fix: 'Set a unique, descriptive title for every page/route.' },
  'html-has-lang': { what: '<html> has no lang attribute.', fix: 'Add a `lang` attribute to the root element of every page, e.g. `<html lang="en">`, in the shared layout or HTML shell.' },
  'html-lang-valid': { what: '<html> lang value is invalid.', fix: 'Use a valid BCP-47 code, e.g. `lang="en"` or `lang="en-US"`.' },
  'valid-lang': { what: 'A lang attribute value is invalid.', fix: 'Use a valid language subtag on the element with `lang`.' },

  'link-name': {
    what: 'A link has no discernible text.',
    fix: 'Give the <a> visible text, or an `aria-label`. Icon-only links: `<a href="/edit" aria-label="Edit user"><i class="fa fa-pencil" aria-hidden="true"></i></a>`. Avoid empty `<a href="#">` used as JS hooks — use a <button>.',
  },
  'button-name': {
    what: 'A button has no discernible text.',
    fix: 'Add text or `aria-label`. Icon buttons: `<button aria-label="Close"><i class="fa fa-times" aria-hidden="true"></i></button>`.',
  },
  'frame-title': { what: 'An <iframe> has no title.', fix: 'Add `title="…"` describing the frame contents.' },

  list: { what: '<ul>/<ol> contains non-<li> children.', fix: 'Only <li> (and <script>/<template>) may be direct children of a list.' },
  listitem: { what: '<li> is not inside a <ul>/<ol>.', fix: 'Wrap list items in a proper list element.' },
  'definition-list': { what: '<dl> structure is malformed.', fix: 'Use <dt>/<dd> pairs directly inside <dl>.' },
  dlitem: { what: '<dt>/<dd> not inside a <dl>.', fix: 'Wrap them in a <dl>.' },

  'heading-order': { what: 'Heading levels are skipped (e.g. h2 → h4).', fix: 'Use headings in order. Don’t pick heading level for size — style the size with CSS instead.' },
  'empty-heading': { what: 'A heading has no text.', fix: 'Remove the empty heading or give it text. Common with card or panel templates that leave a heading placeholder empty.' },
  'page-has-heading-one': { what: 'Page has no <h1>.', fix: 'Give each page one clear <h1> (usually the page/view title).' },

  'landmark-one-main': { what: 'Page has no <main> landmark.', fix: 'Wrap primary content in `<main>` (or `role="main"`) in your layout.' },
  'landmark-unique': { what: 'Multiple landmarks share a role without labels.', fix: 'Add `aria-label` to distinguish e.g. two <nav> regions ("Primary", "Breadcrumb").' },
  region: { what: 'Content is outside any landmark region.', fix: 'Use <header>, <nav>, <main>, <footer> (or roles) so screen-reader users can jump between sections.' },
  'skip-link': { what: 'Skip link target is missing/broken.', fix: 'Add `<a class="visually-hidden-focusable" href="#main">Skip to main content</a>` and give <main> `id="main"`.' },
  bypass: { what: 'No way to bypass repeated blocks.', fix: 'Add a skip link and/or landmark regions (<main>, <nav>).' },

  'aria-allowed-attr': { what: 'An ARIA attribute isn’t allowed on this role.', fix: 'Remove the attribute or change the role to one that supports it.' },
  'aria-required-attr': { what: 'A required ARIA attribute is missing.', fix: 'Add the required attribute (e.g. role="checkbox" needs aria-checked).' },
  'aria-required-children': { what: 'ARIA role is missing required child roles.', fix: 'e.g. role="list" must contain role="listitem"; role="tablist" must contain role="tab".' },
  'aria-required-parent': { what: 'ARIA role is missing its required parent.', fix: 'e.g. role="option" must be inside role="listbox".' },
  'aria-roles': { what: 'Invalid ARIA role value.', fix: 'Use a valid role from the ARIA spec, or remove it.' },
  'aria-valid-attr': { what: 'Invalid ARIA attribute name.', fix: 'Fix the typo (e.g. aria-labeledby → aria-labelledby).' },
  'aria-valid-attr-value': { what: 'Invalid ARIA attribute value.', fix: 'Use an allowed value; check IDs referenced by aria-labelledby/-describedby actually exist.' },
  'aria-hidden-body': { what: 'aria-hidden="true" on <body>.', fix: 'Never hide the whole page from assistive tech; remove it.' },
  'aria-hidden-focus': { what: 'Focusable element inside aria-hidden.', fix: 'Don’t place focusable controls inside aria-hidden="true"; hide with `hidden`/display:none or move focus out.' },
  'aria-command-name': { what: 'ARIA button/link/menuitem has no name.', fix: 'Add aria-label or visible text.' },
  'aria-toggle-field-name': { what: 'ARIA toggle has no name.', fix: 'Add an accessible name to the checkbox/switch/radio.' },
  'aria-tooltip-name': { what: 'role="tooltip" has no name.', fix: 'Add aria-label / text content.' },
  'aria-meter-name': { what: 'role="meter" has no name.', fix: 'Add aria-label.' },
  'aria-progressbar-name': { what: 'role="progressbar" has no name.', fix: 'Add aria-label describing what is progressing.' },

  tabindex: { what: 'Positive tabindex breaks natural focus order.', fix: 'Use `tabindex="0"` (focusable in order) or `-1` (programmatic only); never positive values.' },
  'scrollable-region-focusable': { what: 'A scrollable region isn’t keyboard focusable.', fix: 'Add `tabindex="0"` so keyboard users can scroll it.' },
  'nested-interactive': { what: 'Interactive element nested in another.', fix: 'Don’t put a <button> inside an <a> (or similar). Restructure.' },

  'meta-refresh': { what: '<meta http-equiv="refresh"> reloads/redirects the page.', fix: 'Remove timed refresh, or make the timing adjustable/dismissable server-side.' },
  'meta-viewport': { what: 'Zoom is disabled via viewport meta.', fix: 'Remove `user-scalable=no` / `maximum-scale=1` from the viewport meta so users can zoom.' },
  marquee: { what: '<marquee> scrolls content automatically.', fix: 'Replace <marquee> with static content or a carousel that has a pause control.' },
  blink: { what: '<blink> flashes content.', fix: 'Remove <blink>.' },
  'no-autoplay-audio': { what: 'Audio/video autoplays with sound.', fix: 'Remove autoplay, or provide a visible pause/stop control near the top of the page.' },

  'target-size': { what: 'Touch target is smaller than 24×24 px.', fix: 'Increase padding/min-size of the control, or add spacing. For icon buttons add `min-width:24px;min-height:24px`.' },
  'autocomplete-valid': { what: 'autocomplete attribute value is invalid.', fix: 'Use a valid token, e.g. `autocomplete="email"`, `"name"`, `"tel"`.' },
  'th-has-data-cells': { what: 'A table header has no associated data cells.', fix: 'Ensure <th> scope and <td> structure are correct, or the layout table shouldn’t use <th>.' },
  'td-headers-attr': { what: 'headers attribute references bad IDs.', fix: 'Point `headers` at real <th> id values.' },
  'scope-attr-valid': { what: 'Invalid scope attribute on a cell.', fix: 'Use scope="col" or scope="row" on <th> only.' },
  'table-fake-caption': { what: 'Table caption is faked with a data cell.', fix: 'Use a real <caption> element.' },
  'empty-table-header': { what: 'A <th> is empty.', fix: 'Give the header text, or use <td> if it’s a spacer.' },
  'duplicate-id-aria': { what: 'An id referenced by ARIA is duplicated.', fix: 'Make ids unique — a real risk in server controls that auto-generate ids; check ClientIDMode.' },

  // ── Dynamic keyboard checks ────────────────────────────────────────────────
  'kbd-click-not-focusable': {
    what: 'An element responds to mouse clicks but cannot be reached or activated by keyboard.',
    fix: 'Use a native `<button>` — it is focusable, announces its role, and fires on Enter and Space for free. If the element must stay a div/span/th, add all three: `tabindex="0"`, `role="button"`, and a keydown handler for Enter (13) and Space (32) that calls the same function as the click handler.',
  },
  'kbd-click-not-focusable-review': {
    what: 'An element has its own click handler, is not keyboard-focusable, and contains a focusable control.',
    fix: 'Determine whether the container performs a DIFFERENT action from the control inside it. If it does — for example a table cell that opens an editor while containing an unrelated colour picker — keyboard users cannot reach the container action, and it needs `tabindex="0"` plus Enter/Space handling, or the action should move onto a real button. If an equivalent keyboard-reachable control for the same action already exists elsewhere in the row, the functionality is operable and this is a redundant mouse-only affordance: lower priority, but worth removing for consistency.',
  },
  'kbd-role-not-focusable': {
    what: 'An element declares an interactive ARIA role but is not keyboard-focusable.',
    fix: 'A role tells assistive technology "this is a control", so it must behave like one. Add `tabindex="0"` plus Enter/Space key handling. For composite widgets (tablist, menu, listbox, radiogroup, tree) use the roving-tabindex pattern instead: exactly one item has `tabindex="0"`, the rest `tabindex="-1"`, and arrow keys move focus between them.',
  },
  'kbd-focus-visible': {
    what: 'A keyboard-focusable element shows no visible focus indicator.',
    fix: 'Add a visible focus style. Never use bare `outline:none`. Provide a `:focus-visible` outline or box-shadow ring, e.g. `:focus-visible{outline:2px solid #1a6dd4;outline-offset:2px}`. In Tailwind/shadcn use `focus-visible:ring-2 focus-visible:ring-ring`.',
  },
  'kbd-keyboard-trap': {
    what: 'Focus appears to get stuck (possible keyboard trap).',
    fix: 'Ensure Tab moves past every control and out of dialogs. In a modal, trap focus WITHIN it only while open, and restore focus on close; Esc should close it. Avoid widgets that swallow Tab.',
  },
  'kbd-positive-tabindex': {
    what: 'A positive tabindex overrides the natural focus order.',
    fix: 'Replace `tabindex="1"` (etc.) with `tabindex="0"` (natural order) or `-1` (focusable only via script). Order should follow DOM order.',
  },

  // ── Screen-reader (accessibility-tree) checks ──────────────────────────────
  'sr-broken-aria-ref': {
    what: 'An ARIA relationship attribute points to an id that is not on the page.',
    fix: 'Make `aria-labelledby` / `aria-describedby` / `aria-controls` reference an element that actually renders. In React this often breaks when the referenced node renders conditionally or its id is generated separately — reference a stable, always-present id.',
  },
  'sr-broken-aria-relationship': {
    what: 'An aria-controls/owns points to an element not currently in the DOM.',
    fix: 'Usually fine for lazily-mounted panels (Radix Tabs/Accordion render the panel only when active). Confirm the target id exists when the control is activated; if the panel is always present, ensure its id matches.',
  },
  'sr-unnamed-control': {
    what: 'A control is announced with no name by a screen reader.',
    fix: 'Give it an accessible name: visible text, `aria-label`, or an associated `<label>`. Icon-only buttons need `aria-label`; mark the icon `aria-hidden="true"`.',
  },
  'sr-duplicate-name': {
    what: 'Many controls announce with the identical name and no context.',
    fix: 'Add distinguishing context to the accessible name, e.g. `aria-label="Edit — Invoice #1042"` instead of five bare "Edit" buttons, so screen-reader users can tell them apart.',
  },
};

// Framework-specific additions, keyed rule → family. Families: react (also
// used for Next.js), next, angular, vue, razor (ASP.NET Core MVC / Razor
// Pages / Blazor), webforms.
const STACK_NOTES = {
  'image-alt': {
    react: 'JSX: `<img src={logo} alt="Acme Corp" />`; for next/image the `alt` prop is required — pass `alt=""` for decorative images.',
    angular: 'Bound alt: `<img [src]="user.photo" [alt]="user.name">` (an empty binding renders no alt — fall back to `alt=""` when decorative).',
    vue: 'Bound alt: `<img :src="user.photo" :alt="user.name">`.',
    razor: 'Tag helpers pass `alt` straight through: `<img src="~/img/logo.png" alt="Acme Corp" asp-append-version="true" />`.',
    webforms: '`<asp:Image ID="imgLogo" runat="server" AlternateText="Acme Corp" />`; decorative: `GenerateEmptyAlternateText="true"`.',
  },
  'input-image-alt': {
    webforms: 'ASP.NET `<asp:ImageButton>` → set `AlternateText`.',
  },
  label: {
    react: 'JSX uses `htmlFor`: `<label htmlFor={id}>Email</label><input id={id} />` — generate the id with `useId()` so it is unique per instance. Component libraries: pass `label`/`aria-label` to the input component, not just a placeholder.',
    angular: '`<label for="email">Email</label><input id="email" formControlName="email">`; Angular Material: put the `<mat-label>` inside `<mat-form-field>`.',
    vue: '`<label :for="id">Email</label><input :id="id" v-model="email">`; in Vue 3.5+ `useId()` gives a stable unique id.',
    razor: 'Tag helpers pair them for you: `<label asp-for="Email"></label><input asp-for="Email" />`.',
    webforms: '`<asp:Label AssociatedControlID="txtEmail" Text="Email" runat="server" />` renders a real `<label for>`; a plain `Text` label does not.',
  },
  'document-title': {
    react: 'SPAs keep the first title on every route — set it per route: React 19 `<title>` in the component, `react-helmet-async`, or `document.title` in an effect.',
    next: 'App router: `export const metadata = { title: "Users" }` (or `generateMetadata`) per page; pages router: `<Head><title>…</title></Head>`.',
    angular: 'Give every route a `title: \'Users\'` (Angular 14+) or set it with the `Title` service on navigation.',
    vue: 'Set `document.title` in a `router.afterEach` hook from `to.meta.title`; Nuxt: `useHead({ title })` / `definePageMeta`.',
    razor: '`@{ ViewData["Title"] = "Users – Admin"; }` rendered in the layout `<title>`.',
    webforms: '`<%@ Page Title="Users – Admin" … %>`, or `Page.Title` in code-behind.',
  },
  'button-name': {
    react: 'Icon-only: `<button aria-label="Close"><XIcon aria-hidden /></button>`. Many icon libraries render an unnamed `<svg>` — the button needs the name.',
    angular: 'Icon-only: `<button mat-icon-button aria-label="Close"><mat-icon aria-hidden="true">close</mat-icon></button>`; dynamic names: `[attr.aria-label]="\'Delete \' + item.name"`.',
    vue: 'Icon-only: `<button aria-label="Close"><CloseIcon aria-hidden="true" /></button>`; dynamic: `:aria-label="`Delete ${item.name}`"`.',
    webforms: '`<asp:LinkButton>`/`<asp:Button>` with only an icon: add `aria-label` as an attribute in markup (it is passed through).',
  },
  'link-name': {
    react: 'Router links are plain anchors: `<Link to="/cart" aria-label="Cart (3 items)"><CartIcon aria-hidden /></Link>`.',
    angular: '`<a routerLink="/cart" aria-label="Cart">…</a>` — `routerLink` renders a real `<a href>`, so it needs a name like any link.',
    vue: '`<RouterLink to="/cart" aria-label="Cart">…</RouterLink>` / `<NuxtLink>`.',
  },
  'html-has-lang': {
    react: 'Set it in the HTML shell (`index.html`, or `<html lang="en">` in Next\'s root layout / `_document`).',
    angular: 'Set `<html lang="en">` in `src/index.html`; with i18n builds Angular sets it per locale.',
    vue: 'Set `<html lang="en">` in `index.html`; Nuxt: `app.head.htmlAttrs.lang` in nuxt.config.',
    razor: 'Set `<html lang="en">` in `_Layout.cshtml` (or bind `@CultureInfo.CurrentUICulture.TwoLetterISOLanguageName`).',
    webforms: 'Set `<html lang="en">` in the Master page.',
  },
  'kbd-click-not-focusable': {
    react: 'Check the JSX: replace `<div onClick>` with `<button type="button" onClick>`.',
    angular: 'Replace `<div (click)>` with `<button type="button" (click)>`; if it must stay a div add `tabindex="0"`, `role="button"` and `(keydown.enter)` / `(keydown.space)`.',
    vue: 'Replace `<div @click>` with `<button type="button" @click>`; if it must stay a div add `tabindex="0"`, `role="button"` and `@keydown.enter` / `@keydown.space`.',
    razor: 'If the handler is bound with jQuery delegation (`$(document).on("click", ".x", …)`), bind keydown alongside it: `$(document).on("click keydown", ".x", function(e){ if(e.type==="keydown" && e.key!=="Enter" && e.key!==" ") return; … })`.',
    webforms: 'If the handler is bound with jQuery delegation (`$(document).on("click", ".x", …)`), bind keydown alongside it: `$(document).on("click keydown", ".x", function(e){ if(e.type==="keydown" && e.key!=="Enter" && e.key!==" ") return; … })`.',
  },
  'sr-broken-aria-ref': {
    angular: 'Bind ARIA ids with `[attr.aria-describedby]="hintId"`; plain `aria-describedby="{{ id }}"` is a property binding Angular rejects for ARIA.',
    vue: 'Generate ids once per component instance (`useId()` in Vue 3.5+) so the label and the field share it.',
  },
};

const FAMILY = {
  react: ['react'], next: ['react', 'next'], angular: ['angular'], vue: ['vue'], nuxt: ['vue'],
  'aspnet-core': ['razor'], 'aspnet-webforms': ['webforms'],
};

/**
 * @param {string} ruleId
 * @param {string[]} stacks  detected stack ids (lib/adapters); [] → generic advice only
 */
function fixFor(ruleId, stacks = []) {
  const base = FIXES[ruleId];
  if (!base) return null;
  const notes = STACK_NOTES[ruleId];
  if (!notes || !stacks.length) return base;
  const families = [...new Set(stacks.flatMap((s) => FAMILY[s] || []))];
  const extra = families.map((f) => notes[f]).filter(Boolean);
  return extra.length ? { ...base, fix: `${base.fix} ${extra.join(' ')}` } : base;
}

module.exports = { FIXES, STACK_NOTES, fixFor };
