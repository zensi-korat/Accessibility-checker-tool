/**
 * Which accessibility lint rules run, which WCAG 2.2 success criteria each one
 * is evidence for, and how far each can be trusted.
 *
 *   conf 'high'   — the rule reads markup that is wrong wherever it renders
 *                   (missing alt, invalid ARIA, positive tabindex…). Reported
 *                   as a violation: it fails the criterion.
 *   conf 'review' — the rule is a heuristic that misfires on custom components
 *                   (a <Label> that renders a <label>, a div with a delegated
 *                   key handler…). Reported as "needs review", never a failure.
 *   bp            — best practice, not a WCAG failure (autofocus, heading level
 *                   skips, tabindex on static content). No criterion; reported
 *                   as a review item tagged best-practice so it never changes a
 *                   criterion's status.
 *
 * Only rules listed here are enabled — no style rules. Rules run with the
 * plugin's own recommended options unless an entry sets `options`; the
 * project's ESLint config can still turn one off (see ./eslint.js).
 */
const R = (sc, conf, impact, options) => ({ sc, conf, impact, ...(options ? { options } : {}) });
const BP = (impact = 'minor', options) => ({ sc: [], conf: 'review', impact, bp: true, ...(options ? { options } : {}) });

const JSX = {
  'alt-text': R(['1.1.1'], 'high', 'critical'),
  'anchor-has-content': R(['2.4.4', '4.1.2'], 'high', 'serious'),
  // Only the "no href" aspect is a keyboard problem (an <a> without href is not
  // focusable); href="#" and "prefer a button" are best practice. Split by
  // message in ./eslint.js (MESSAGE_SPLIT).
  'anchor-is-valid': R(['2.1.1'], 'review', 'moderate'),
  'aria-activedescendant-has-tabindex': R(['2.1.1'], 'high', 'serious'),
  'aria-props': R(['4.1.2'], 'high', 'critical'),
  'aria-proptypes': R(['4.1.2'], 'high', 'serious'),
  // ignoreNonDOM: <UserCard role="admin"> is a prop, not an ARIA role.
  'aria-role': R(['4.1.2'], 'high', 'critical', [{ ignoreNonDOM: true }]),
  'aria-unsupported-elements': R(['4.1.2'], 'high', 'serious'),
  'autocomplete-valid': R(['1.3.5'], 'high', 'serious'),
  'click-events-have-key-events': R(['2.1.1'], 'review', 'serious'),
  'control-has-associated-label': R(['4.1.2'], 'review', 'serious'),
  'heading-has-content': R(['1.3.1', '2.4.6'], 'high', 'moderate'),
  'html-has-lang': R(['3.1.1'], 'high', 'serious'),
  'iframe-has-title': R(['4.1.2'], 'high', 'serious'),
  'img-redundant-alt': R(['1.1.1'], 'review', 'minor'),
  'interactive-supports-focus': R(['2.1.1'], 'review', 'serious'),
  'label-has-associated-control': R(['1.3.1', '3.3.2', '4.1.2'], 'review', 'serious'),
  'lang': R(['3.1.2'], 'high', 'serious'),
  'media-has-caption': R(['1.2.2'], 'review', 'serious'),
  'mouse-events-have-key-events': R(['2.1.1'], 'review', 'moderate'),
  'no-aria-hidden-on-focusable': R(['4.1.2'], 'high', 'serious'),
  'no-autofocus': BP('minor', [{ ignoreNonDOM: true }]),
  'no-distracting-elements': R(['2.2.2'], 'high', 'serious'),
  'no-interactive-element-to-noninteractive-role': R(['4.1.2'], 'high', 'serious'),
  'no-noninteractive-element-interactions': R(['2.1.1', '4.1.2'], 'review', 'moderate'),
  'no-noninteractive-element-to-interactive-role': R(['4.1.2'], 'review', 'moderate'),
  'no-noninteractive-tabindex': BP('minor'),
  'no-static-element-interactions': R(['2.1.1', '4.1.2'], 'review', 'serious'),
  'role-has-required-aria-props': R(['4.1.2'], 'high', 'critical'),
  'role-supports-aria-props': R(['4.1.2'], 'high', 'serious'),
  'scope': R(['1.3.1'], 'high', 'moderate'),
  'tabindex-no-positive': R(['2.4.3'], 'high', 'serious'),
};

const VUE = {
  'alt-text': R(['1.1.1'], 'high', 'critical'),
  'anchor-has-content': R(['2.4.4', '4.1.2'], 'high', 'serious'),
  'aria-props': R(['4.1.2'], 'high', 'critical'),
  'aria-role': R(['4.1.2'], 'high', 'critical'),
  'aria-unsupported-elements': R(['4.1.2'], 'high', 'serious'),
  'click-events-have-key-events': R(['2.1.1'], 'review', 'serious'),
  'form-control-has-label': R(['1.3.1', '3.3.2', '4.1.2'], 'review', 'serious'),
  'heading-has-content': R(['1.3.1', '2.4.6'], 'high', 'moderate'),
  'iframe-has-title': R(['4.1.2'], 'high', 'serious'),
  'interactive-supports-focus': R(['2.1.1'], 'review', 'serious'),
  // The rule's default demands nesting AND for/id; either one is a valid label.
  'label-has-for': R(['1.3.1', '3.3.2'], 'review', 'serious', [{ required: { some: ['nesting', 'id'] }, allowChildren: true }]),
  'media-has-caption': R(['1.2.2'], 'review', 'serious'),
  'mouse-events-have-key-events': R(['2.1.1'], 'review', 'moderate'),
  'no-aria-hidden-on-focusable': R(['4.1.2'], 'high', 'serious'),
  'no-autofocus': BP('minor'),
  'no-distracting-elements': R(['2.2.2'], 'high', 'serious'),
  'no-role-presentation-on-focusable': R(['4.1.2'], 'high', 'serious'),
  'no-static-element-interactions': R(['2.1.1', '4.1.2'], 'review', 'serious'),
  'role-has-required-aria-props': R(['4.1.2'], 'high', 'critical'),
  'tabindex-no-positive': R(['2.4.3'], 'high', 'serious'),
};

const ANGULAR = {
  'alt-text': R(['1.1.1'], 'high', 'critical'),
  'elements-content': R(['2.4.4', '4.1.2'], 'high', 'serious'),
  'label-has-associated-control': R(['1.3.1', '3.3.2', '4.1.2'], 'review', 'serious'),
  'table-scope': R(['1.3.1'], 'high', 'moderate'),
  'valid-aria': R(['4.1.2'], 'high', 'critical'),
  'role-has-required-aria': R(['4.1.2'], 'high', 'critical'),
  'click-events-have-key-events': R(['2.1.1'], 'review', 'serious'),
  'mouse-events-have-key-events': R(['2.1.1'], 'review', 'moderate'),
  'interactive-supports-focus': R(['2.1.1'], 'review', 'serious'),
  'no-autofocus': BP('minor'),
  'no-distracting-elements': R(['2.2.2'], 'high', 'serious'),
  'no-positive-tabindex': R(['2.4.3'], 'high', 'serious'),
};

const HTML = {
  'require-lang': R(['3.1.1'], 'high', 'serious'),
  'require-img-alt': R(['1.1.1'], 'high', 'critical'),
  'require-title': R(['2.4.2'], 'high', 'serious'),
  'require-frame-title': R(['4.1.2'], 'high', 'serious'),
  'no-positive-tabindex': R(['2.4.3'], 'high', 'serious'),
  'no-aria-hidden-body': R(['4.1.2'], 'high', 'critical'),
  'no-aria-hidden-on-focusable': R(['4.1.2'], 'high', 'serious'),
  'no-abstract-roles': R(['4.1.2'], 'high', 'serious'),
  'no-invalid-role': R(['4.1.2'], 'high', 'serious'),
  'no-nested-interactive': R(['4.1.2'], 'high', 'serious'),
  'no-non-scalable-viewport': R(['1.4.4'], 'high', 'critical'),
  'no-empty-headings': R(['1.3.1', '2.4.6'], 'high', 'moderate'),
  'require-input-label': R(['1.3.1', '3.3.2', '4.1.2'], 'review', 'serious'),
  'no-skip-heading-levels': BP('minor'),
  'no-heading-inside-button': R(['4.1.2'], 'review', 'moderate'),
};

// The browser-scan rule with the same meaning, so lint findings get the same
// (stack-aware) fix advice from lib/fixes.js.
const AXE_EQUIVALENT = {
  'alt-text': 'image-alt', 'require-img-alt': 'image-alt',
  'anchor-has-content': 'link-name', 'elements-content': 'link-name',
  'aria-props': 'aria-valid-attr', 'aria-proptypes': 'aria-valid-attr-value',
  'aria-role': 'aria-roles', 'valid-aria': 'aria-roles', 'no-invalid-role': 'aria-roles', 'no-abstract-roles': 'aria-roles',
  'role-has-required-aria-props': 'aria-required-attr', 'role-has-required-aria': 'aria-required-attr',
  'role-supports-aria-props': 'aria-allowed-attr', 'autocomplete-valid': 'autocomplete-valid',
  'heading-has-content': 'empty-heading', 'no-empty-headings': 'empty-heading', 'no-skip-heading-levels': 'heading-order',
  'html-has-lang': 'html-has-lang', 'require-lang': 'html-has-lang', 'lang': 'valid-lang',
  'iframe-has-title': 'frame-title', 'require-frame-title': 'frame-title', 'require-title': 'document-title',
  'no-aria-hidden-on-focusable': 'aria-hidden-focus', 'no-aria-hidden-body': 'aria-hidden-body',
  'tabindex-no-positive': 'kbd-positive-tabindex', 'no-positive-tabindex': 'kbd-positive-tabindex',
  'click-events-have-key-events': 'kbd-click-not-focusable', 'interactive-supports-focus': 'kbd-click-not-focusable',
  'no-static-element-interactions': 'kbd-click-not-focusable',
  'label-has-associated-control': 'label', 'form-control-has-label': 'label', 'require-input-label': 'label',
  'control-has-associated-label': 'label', 'label-has-for': 'label',
  'no-non-scalable-viewport': 'meta-viewport', 'no-nested-interactive': 'nested-interactive',
  'scope': 'scope-attr-valid', 'table-scope': 'scope-attr-valid',
};

/** ESLint rule id ("jsx-a11y/alt-text") → mapping, or null when not ours. */
const BY_RULE = {};
for (const [prefix, table] of [['jsx-a11y', JSX], ['vuejs-accessibility', VUE], ['@angular-eslint/template', ANGULAR], ['@html-eslint', HTML]]) {
  for (const [name, m] of Object.entries(table)) BY_RULE[`${prefix}/${name}`] = { ...m, plugin: prefix, name, axe: AXE_EQUIVALENT[name] || null };
}
const mappingFor = (ruleId) => BY_RULE[ruleId] || null;

/** The plugin's own recommended options for each rule (`{ ruleId: [opts…] }`). */
const RECOMMENDED = {};
for (const [prefix, mod] of [['jsx-a11y', 'eslint-plugin-jsx-a11y'], ['vuejs-accessibility', 'eslint-plugin-vuejs-accessibility']]) {
  let rules = {};
  try {
    const plugin = require(mod);
    const cfg = (plugin.configs && plugin.configs.recommended) || {};
    rules = cfg.rules || (Array.isArray(plugin.configs['flat/recommended']) ? Object.assign({}, ...plugin.configs['flat/recommended'].map((c) => c.rules || {})) : {});
  } catch { /* plugin missing — plain 'error' */ }
  for (const [id, v] of Object.entries(rules)) if (Array.isArray(v) && v.length > 1 && id.startsWith(prefix + '/')) RECOMMENDED[id] = v.slice(1);
}

/**
 * `{ 'jsx-a11y/alt-text': 'error' | ['error', opts], … }` for one plugin.
 *   overrides  STATIC_LINT.rules (wins over everything)
 *   project    the project's own ESLint settings for these rules: 'off' drops
 *              the rule, options replace ours (severity stays 'error').
 */
function rulesFor(prefix, overrides = {}, project = {}) {
  const out = {};
  for (const id of Object.keys(BY_RULE)) {
    if (BY_RULE[id].plugin !== prefix) continue;
    const opts = BY_RULE[id].options || RECOMMENDED[id];
    out[id] = opts ? ['error', ...opts] : 'error';
  }
  for (const [id, v] of Object.entries(project)) {
    if (!(id in out)) continue;
    const sev = Array.isArray(v) ? v[0] : v;
    if (sev === 'off' || sev === 0 || sev === '0') delete out[id];
    else if (Array.isArray(v) && v.length > 1) out[id] = ['error', ...v.slice(1)];
  }
  for (const [id, v] of Object.entries(overrides)) if (id.startsWith(prefix + '/')) out[id] = v;
  return out;
}

module.exports = { mappingFor, rulesFor, BY_RULE };
