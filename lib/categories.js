/**
 * Issue types: groups every rule the tool can report (axe, the custom checks,
 * the source lint) into a handful of categories people actually ask for —
 * "just the contrast issues", "ARIA and links only".
 *
 * Used twice:
 *   - the reports and the fix plan filter by it (issue.topic / group.topic)
 *   - `--only <ids>` / ONLY scans just those types (see scopeConfig): axe runs
 *     only the matching rules, unrelated custom checks are skipped, and
 *     anything else is dropped before aggregation.
 *
 * Each rule belongs to exactly one category, so the counts add up.
 */
const path = require('path');

const CATEGORIES = [
  { id: 'contrast', label: 'Contrast & color' },
  { id: 'aria', label: 'ARIA & roles' },
  { id: 'links', label: 'Links & buttons' },
  { id: 'images', label: 'Images & media' },
  { id: 'forms', label: 'Forms & labels' },
  { id: 'keyboard', label: 'Keyboard & focus' },
  { id: 'structure', label: 'Headings & structure' },
  { id: 'layout', label: 'Zoom & reflow' },
  { id: 'other', label: 'Other' },
];
const IDS = CATEGORIES.map((c) => c.id);
// What people type: `--only color,roles,buttons`.
const ALIASES = {
  color: 'contrast', colour: 'contrast', roles: 'aria', role: 'aria', link: 'links', buttons: 'links', button: 'links', names: 'links',
  image: 'images', media: 'images', alt: 'images', form: 'forms', labels: 'forms', label: 'forms', focus: 'keyboard',
  headings: 'structure', heading: 'structure', landmarks: 'structure', zoom: 'layout', reflow: 'layout', viewport: 'layout',
};

// Exact rule ids (axe, custom checks, lint rule names without the plugin prefix).
const EXACT = {
  contrast: ['color-contrast', 'color-contrast-enhanced', 'link-in-text-block', 'contrast-sampled'],
  aria: ['presentation-role-conflict', 'nested-interactive', 'lr-status-not-announced',
    'valid-aria', 'role-has-required-aria', 'no-invalid-role', 'no-abstract-roles', 'no-role-presentation-on-focusable',
    'no-interactive-element-to-noninteractive-role', 'no-noninteractive-element-to-interactive-role', 'no-nested-interactive'],
  links: ['link-name', 'button-name', 'input-button-name', 'identical-links-same-purpose', 'skip-link', 'summary-name',
    'sr-unnamed-control', 'sr-duplicate-name', 'anchor-has-content', 'elements-content', 'anchor-is-valid', 'no-heading-inside-button'],
  images: ['image-alt', 'input-image-alt', 'role-img-alt', 'svg-img-alt', 'object-alt', 'area-alt', 'image-redundant-alt',
    'server-side-image-map', 'video-caption', 'audio-caption', 'no-autoplay-audio', 'blink', 'marquee',
    'alt-text', 'img-redundant-alt', 'require-img-alt', 'media-has-caption', 'no-distracting-elements'],
  forms: ['label', 'label-title-only', 'label-content-name-mismatch', 'form-field-multiple-labels', 'select-name', 'autocomplete-valid',
    'label-has-associated-control', 'form-control-has-label', 'require-input-label', 'control-has-associated-label', 'label-has-for'],
  keyboard: ['accesskeys', 'tabindex', 'focus-order-semantics', 'scrollable-region-focusable', 'frame-focusable-content',
    'click-events-have-key-events', 'interactive-supports-focus', 'mouse-events-have-key-events', 'no-static-element-interactions',
    'no-noninteractive-element-interactions', 'tabindex-no-positive', 'no-positive-tabindex', 'no-autofocus',
    'no-noninteractive-tabindex', 'aria-activedescendant-has-tabindex'],
  structure: ['bypass', 'region', 'document-title', 'html-has-lang', 'html-lang-valid', 'html-xml-lang-mismatch', 'valid-lang',
    'heading-order', 'empty-heading', 'page-has-heading-one', 'p-as-heading', 'list', 'listitem', 'dlitem', 'definition-list',
    'empty-table-header', 'scope-attr-valid', 'table-duplicate-name', 'table-fake-caption', 'td-has-header', 'td-headers-attr',
    'th-has-data-cells', 'frame-title', 'frame-title-unique', 'frame-tested', 'duplicate-id', 'duplicate-id-active', 'duplicate-id-aria',
    'meta-refresh', 'meta-refresh-no-exceptions', 'hidden-content',
    'heading-has-content', 'lang', 'scope', 'table-scope', 'require-lang', 'require-title', 'require-frame-title', 'iframe-has-title',
    'no-empty-headings', 'no-skip-heading-levels'],
  layout: ['meta-viewport', 'meta-viewport-large', 'avoid-inline-spacing', 'target-size', 'css-orientation-lock', 'no-non-scalable-viewport'],
};
const BY_ID = new Map();
for (const [cat, ids] of Object.entries(EXACT)) for (const id of ids) BY_ID.set(id, cat);

// Families, by prefix (checked after the exact ids).
const PREFIX = [
  [/^aria-/, 'aria'], [/^role-/, 'aria'], [/^no-aria-hidden/, 'aria'], [/^sr-broken-aria/, 'aria'],
  [/^uic-/, 'contrast'], [/^kbd-/, 'keyboard'], [/^cc-/, 'keyboard'], [/^pc-/, 'keyboard'],
  [/^hl-label-/, 'forms'], [/^hl-/, 'structure'], [/^con-/, 'structure'],
  [/^ff-/, 'forms'], [/^lr-/, 'forms'], [/^vp-/, 'layout'], [/^landmark-/, 'structure'],
];

// The screen-reader check reports every unnamed control under one rule; a text
// field without a name is a forms problem, a button or link without one is not.
const FIELD = /^<(select|textarea)\b|^<input\b(?![^>]*\btype=["']?(button|submit|reset|image)\b)|\brole=["']?(textbox|combobox|searchbox|spinbutton|slider|checkbox|radio|switch|listbox)\b/i;

/**
 * Rule id → category id. Lint ids arrive as "lint:jsx-a11y/alt-text". `html`
 * (the element's markup) refines the few rules that span categories.
 */
function categoryOf(rule, html) {
  const id = String(rule || '').replace(/^lint:/, '').replace(/^.*\//, '');
  if (id === 'sr-unnamed-control' && html && FIELD.test(String(html).trim())) return 'forms';
  if (BY_ID.has(id)) return BY_ID.get(id);
  for (const [re, cat] of PREFIX) if (re.test(id)) return cat;
  return 'other';
}

/** "contrast, roles,links" → ['contrast','aria','links']. Throws on an unknown name. */
function parseOnly(value) {
  if (!value) return [];
  const list = Array.isArray(value) ? value : String(value).split(/[\s,]+/);
  const out = [];
  for (const raw of list) {
    const v = String(raw).trim().toLowerCase();
    if (!v) continue;
    const id = IDS.includes(v) ? v : ALIASES[v];
    if (!id) throw new Error(`Unknown issue type "${raw}" for --only. Use any of: ${IDS.filter((i) => i !== 'other').join(', ')}.`);
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

const labelOf = (id) => (CATEGORIES.find((c) => c.id === id) || { label: id }).label;

/**
 * Applies ONLY (config, or --only / A11Y_ONLY via the env) to a loaded config.
 * A scoped run writes into its own folder (a11y-report/only-contrast-aria/)
 * with its own history, so it never makes the out-of-scope issues of a full
 * scan look fixed — and repeated scoped runs still verify against each other.
 */
function scopeConfig(cfg, env = process.env) {
  const only = parseOnly(env.A11Y_ONLY || cfg.ONLY);
  cfg.ONLY = only;
  if (!only.length) return cfg;
  cfg._baseOutputDir = cfg.OUTPUT_DIR;
  cfg.OUTPUT_DIR = path.join(cfg.OUTPUT_DIR, `only-${only.join('-')}`);
  return cfg;
}

const inScope = (only) => {
  if (!only || !only.length) return () => true;
  const set = new Set(only);
  return (rule) => set.has(categoryOf(rule));
};

/** Drops every result outside ONLY from one raw scan (in place). */
function scopeScan(scan, only) {
  if (!only || !only.length || !scan) return scan;
  const keep = inScope(only);
  const set = new Set(only);
  for (const k of ['violations', 'incomplete', 'passes', 'inapplicable']) {
    if (!Array.isArray(scan[k])) continue;
    scan[k] = scan[k].map((r) => {
      if (!r || r.id !== 'sr-unnamed-control' || !Array.isArray(r.nodes)) return r;
      const nodes = r.nodes.filter((n) => set.has(categoryOf(r.id, n.html)));
      return nodes.length === r.nodes.length ? r : { ...r, nodes };
    }).filter((r) => r && (keep(r.id) || (r.id === 'sr-unnamed-control' && r.nodes.length)));
  }
  return scan;
}

/** The axe rule ids in scope, for AxeBuilder.withRules (respects AXE_TAGS). */
function axeRulesFor(only, tags) {
  const axe = require('axe-core');
  const keep = inScope(only);
  return axe.getRules(tags && tags.length ? tags : undefined).map((r) => r.ruleId).filter(keep);
}

// Which categories each custom check can report — the ones that cannot
// contribute to a scoped run are skipped.
const MODULE_CATEGORIES = {
  keyboard: ['keyboard'], clickable: ['keyboard'], screenReader: ['aria', 'links'],
  headings: ['structure', 'forms'], uiContrast: ['contrast'], formFlow: ['forms'], viewport: ['layout'],
  live: ['aria', 'forms', 'keyboard'], contrastPixel: ['contrast'],
};
function moduleInScope(name, only) {
  if (!only || !only.length) return true;
  return (MODULE_CATEGORIES[name] || []).some((c) => only.includes(c));
}

module.exports = { CATEGORIES, categoryOf, labelOf, parseOnly, scopeConfig, scopeScan, axeRulesFor, moduleInScope, inScope };
