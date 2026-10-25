/**
 * Static accessibility lint of the project's source — the half of the picture
 * a browser scan can't give: exact file:line for markup that is wrong in the
 * source (JSX, Vue SFCs, Angular templates, plain HTML), including components
 * the scan never managed to render.
 *
 * Uses the tool's OWN ESLint 9 and plugins with a generated flat config
 * (overrideConfigFile: true), so the project's ESLint version and style rules
 * never interfere — and projects without ESLint work too. Only the rules in
 * ./wcagMap.js are enabled. What the project already decided is still
 * respected (readProjectEslint): `eslint-disable` comments, accessibility
 * rules it turned off or configured (e.g. anchor-is-valid for Next.js Link),
 * jsx-a11y component settings, .eslintignore and flat-config `ignores`.
 * STATIC_LINT.useProjectConfig: false turns that off.
 *
 * Tests, stories, e2e specs, fixtures, email templates and generated docs are
 * not linted — they never render in the product (STATIC_LINT.includeTests:
 * true lints test files anyway; STATIC_LINT.exclude / LINT_IGNORE add globs).
 *
 * Output is shaped like an axe scan ("page" = "Source code (lint)", state =
 * "lint") so aggregation, WCAG criteria, the matrix, the CI gate and run
 * history treat it like any other result.
 *
 * Razor (.cshtml), Web Forms (.aspx) and other server templates can't be
 * parsed as HTML; the browser scan covers them.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { mappingFor, rulesFor } = require('./wcagMap');

const LINT_PAGE = 'Source code (lint)';

const ALWAYS_IGNORED = [
  '**/node_modules/**', '**/dist/**', '**/build/**', '**/out/**', '**/.next/**', '**/.nuxt/**', '**/.output/**',
  '**/.svelte-kit/**', '**/.angular/**', '**/coverage/**', '**/bin/**', '**/obj/**', '**/vendor/**', '**/packages/**/lib/**',
  '**/storybook-static/**', '**/a11y-report/**', '**/playwright-report/**', '**/test-results/**', '**/*.min.js', '**/*.d.ts',
  '**/.git/**', '**/wwwroot/lib/**',
  // Email markup is rendered by mail clients, not the site; generated API docs aren't the product.
  '**/emails/**', '**/email-templates/**', '**/mail-templates/**',
  '**/typedoc/**', '**/jsdoc/**', '**/api-docs/**', '**/_site/**', '**/docs/**/*.html', '**/doc/**/*.html',
];

// Code that never renders in the product (same idea as codeMap's index filter).
const TEST_IGNORED = [
  '**/*.{test,spec,stories,story,e2e,cy}.{js,jsx,ts,tsx,mjs,cjs,vue,html}', '**/*.stories.mdx',
  '**/__tests__/**', '**/__mocks__/**', '**/__fixtures__/**', '**/fixtures/**',
  '**/test/**', '**/tests/**', '**/e2e/**', '**/cypress/**', '**/playwright/**', '**/stories/**', '**/.storybook/**',
];

// Directory names skipped by the small file walks below (Angular inline
// templates, project-config samples). Mirrors the globs above.
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', '.output', '.svelte-kit', '.angular',
  'coverage', 'bin', 'obj', 'vendor', 'storybook-static', 'a11y-report', 'playwright-report', 'test-results', '.turbo', '.cache']);
const TEST_DIRS = new Set(['__tests__', '__mocks__', '__fixtures__', 'fixtures', 'test', 'tests', 'e2e', 'cypress', 'playwright', 'stories', '.storybook']);
const TEST_FILE = /\.(test|spec|stories|story|e2e|cy)\.[cm]?[jt]sx?$|\.d\.ts$/i;

function walk(root, accept, { includeTests = false, limit = Infinity } = {}) {
  const out = [];
  const go = (dir) => {
    if (out.length >= limit) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= limit) return;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || (!includeTests && TEST_DIRS.has(e.name))) continue;
        go(path.join(dir, e.name));
      } else if ((includeTests || !TEST_FILE.test(e.name)) && accept(e.name)) out.push(path.join(dir, e.name));
    }
  };
  go(root);
  return out;
}

/** Simple .gitignore lines → flat-config ignore globs (negations are skipped). */
function gitignoreGlobs(root, file = '.gitignore') {
  let text = '';
  try { text = fs.readFileSync(path.join(root, file), 'utf8'); } catch { return []; }
  return ignoreLinesToGlobs(text.split(/\r?\n/));
}

function ignoreLinesToGlobs(lines) {
  const out = [];
  for (let line of lines) {
    line = String(line);
    line = line.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    const anchored = line.startsWith('/');
    line = line.replace(/^\/+/, '');
    const dir = line.endsWith('/');
    line = line.replace(/\/+$/, '');
    if (!line) continue;
    const base = anchored || line.includes('/') ? line : `**/${line}`;
    out.push(dir ? `${base}/**` : base, `${base}/**`);
  }
  return [...new Set(out)];
}

const stripJsonComments = (t) => t.replace(/("(?:[^"\\]|\\.)*")|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m, str) => str || '');

/** Legacy .eslintrc* / package.json eslintConfig → { rules, settings, ignorePatterns, file } or null. */
function readLegacyEslintrc(root) {
  for (const f of ['.eslintrc.json', '.eslintrc', '.eslintrc.js', '.eslintrc.cjs', 'package.json']) {
    const abs = path.join(root, f);
    if (!fs.existsSync(abs)) continue;
    let cfg = null;
    try {
      if (/\.c?js$/.test(f)) cfg = require(abs);
      else {
        const parsed = JSON.parse(stripJsonComments(fs.readFileSync(abs, 'utf8')));
        cfg = f === 'package.json' ? parsed.eslintConfig : parsed;
      }
    } catch { cfg = null; }
    if (!cfg || typeof cfg !== 'object') continue;
    const ignorePatterns = [].concat(cfg.ignorePatterns || []);
    return { rules: cfg.rules || {}, settings: cfg.settings || {}, ignorePatterns, file: f };
  }
  return null;
}

/**
 * What the project's own ESLint setup says about our rules. Never throws: if
 * the config can't be read or loaded, the lint runs exactly as before.
 *   → { source, rules: {jsx, vue, angular, html}, settings, ignores: [globs], isIgnored(abs) | null }
 */
async function readProjectEslint(root, stacks, opts = {}) {
  const out = { source: null, rules: { jsx: {}, vue: {}, angular: {}, html: {} }, settings: {}, ignores: [], isIgnored: null };
  out.ignores.push(...gitignoreGlobs(root, '.eslintignore'));
  if (opts.useProjectConfig === false) return out;

  const flat = ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts', 'eslint.config.mts', 'eslint.config.cts']
    .find((f) => fs.existsSync(path.join(root, f)));
  if (flat) {
    try {
      const { ESLint } = require('eslint');
      const user = new ESLint({ cwd: root, errorOnUnmatchedPattern: false });
      const samples = {
        jsx: /\.(jsx|tsx)$/, vue: /\.vue$/, angular: /\.html$/, html: /\.html?$/,
      };
      for (const [kind, re] of Object.entries(samples)) {
        const prefer = walk(path.join(root, 'src'), (n) => re.test(n), { limit: 1 });
        const sample = prefer[0] || walk(root, (n) => re.test(n), { limit: 1 })[0];
        if (!sample) continue;
        const cfg = await user.calculateConfigForFile(sample).catch(() => null);
        if (!cfg) continue;
        out.rules[kind] = cfg.rules || {};
        if (kind === 'jsx' && cfg.settings) out.settings = cfg.settings;
      }
      out.isIgnored = (abs) => user.isPathIgnored(abs).catch(() => false);
      out.source = flat;
      return out;
    } catch { /* config needs something we can't load — fall back to legacy/none */ }
  }
  const legacy = readLegacyEslintrc(root);
  if (legacy) {
    for (const k of Object.keys(out.rules)) out.rules[k] = legacy.rules;
    out.settings = legacy.settings;
    out.ignores.push(...ignoreLinesToGlobs(legacy.ignorePatterns));
    out.source = legacy.file;
  }
  return out;
}

/** Angular components with an inline `template:` (any *.ts — v20+ drops the .component suffix). */
function inlineTemplateFiles(root, includeTests) {
  const re = /@Component\s*\(\s*\{[\s\S]*?\btemplate\s*:/;
  return walk(root, (n) => /\.ts$/.test(n) && !/\.d\.ts$/.test(n), { includeTests })
    .filter((f) => { try { return re.test(fs.readFileSync(f, 'utf8')); } catch { return false; } })
    .map((f) => path.relative(root, f).split(path.sep).join('/').replace(/[[\]{}()*?!+@]/g, '\\$&'));
}

/**
 * The flat config for the stacks found in the project.
 * @param {string[]} stacks  stack ids from lib/adapters (react, next, vue, nuxt, angular, …)
 */
function buildConfig(root, stacks, opts = {}) {
  const has = (...ids) => ids.some((id) => stacks.includes(id));
  const overrides = opts.rules || {};
  const project = opts.project || { rules: {}, settings: {}, ignores: [] };
  const projectRules = (kind) => (project.rules && project.rules[kind]) || {};
  const tsParser = require('@typescript-eslint/parser');
  const config = [
    { ignores: [...ALWAYS_IGNORED, ...(opts.includeTests ? [] : TEST_IGNORED), ...gitignoreGlobs(root), ...(project.ignores || []), ...(opts.exclude || [])] },
    { linterOptions: { reportUnusedDisableDirectives: 'off' } },
  ];
  const userJsxSettings = (project.settings && project.settings['jsx-a11y']) ? { 'jsx-a11y': project.settings['jsx-a11y'] } : {};
  const files = { jsx: [], vue: [], angularHtml: [], angularTs: [], html: [] };

  // JSX anywhere (any project can have .jsx/.tsx); plain .js/.ts only in React projects.
  files.jsx = ['**/*.jsx', '**/*.tsx', ...(has('react', 'next') ? ['**/*.js', '**/*.mjs', '**/*.ts'] : [])];
  config.push({
    files: files.jsx,
    plugins: { 'jsx-a11y': require('eslint-plugin-jsx-a11y') },
    languageOptions: { parser: tsParser, parserOptions: { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true } } },
    settings: { ...userJsxSettings, ...(opts.jsxSettings || {}) },
    rules: rulesFor('jsx-a11y', overrides, projectRules('jsx')),
  });

  if (has('vue', 'nuxt')) {
    files.vue = ['**/*.vue'];
    config.push({
      files: files.vue,
      plugins: { 'vuejs-accessibility': require('eslint-plugin-vuejs-accessibility') },
      languageOptions: { parser: require('vue-eslint-parser'), parserOptions: { parser: tsParser, ecmaVersion: 'latest', sourceType: 'module' } },
      rules: rulesFor('vuejs-accessibility', overrides, projectRules('vue')),
    });
  }

  if (has('angular')) {
    const ng = require('@angular-eslint/eslint-plugin-template');
    files.angularTs = inlineTemplateFiles(root, opts.includeTests);
    files.angularHtml = ['**/*.html'];
    // Inline `template:` strings are extracted as virtual *.html files.
    if (files.angularTs.length) config.push({
      files: files.angularTs,
      plugins: { '@angular-eslint/template': ng },
      languageOptions: { parser: tsParser },
      processor: ng.processors['extract-inline-html'],
    });
    config.push({
      files: files.angularHtml,
      plugins: { '@angular-eslint/template': ng },
      languageOptions: { parser: require('@angular-eslint/template-parser') },
      rules: rulesFor('@angular-eslint/template', overrides, projectRules('angular')),
    });
  } else {
    files.html = ['**/*.html', '**/*.htm'];
    config.push({
      files: files.html,
      plugins: { '@html-eslint': require('@html-eslint/eslint-plugin') },
      languageOptions: { parser: require('@html-eslint/parser') },
      rules: rulesFor('@html-eslint', overrides, projectRules('html')),
    });
  }
  const patterns = opts.include && opts.include.length
    ? opts.include
    : [...new Set([...files.jsx, ...files.vue, ...files.angularTs, ...files.angularHtml, ...files.html])];
  return { config, patterns };
}

const hash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 10);

/**
 * Lint the project.
 * @returns {Promise<{findings:Array, files:number, unparsed:{file:string,message:string}[], durationMs:number}>}
 *   findings: { ruleId, file (relative), abs, line, column, message, source, docsUrl, mapping, key }
 */
async function lintProject(root, stacks, opts = {}) {
  root = path.resolve(root);
  const { ESLint } = require('eslint');
  const started = Date.now();
  const project = opts.project || await readProjectEslint(root, stacks, opts);
  const { config, patterns } = buildConfig(root, stacks, { ...opts, project });
  // ESLint 9 warns about a project's legacy .eslintignore; we read it ourselves.
  const emitWarning = process.emitWarning;
  process.emitWarning = function (w, ...rest) {
    const type = (rest[0] && typeof rest[0] === 'object' ? rest[0].type : rest[0]) || (w && w.name);
    if (type === 'ESLintIgnoreWarning') return undefined;
    return emitWarning.call(process, w, ...rest);
  };
  let results;
  let meta;
  try {
    const eslint = new ESLint({
      cwd: root,
      overrideConfigFile: true,
      overrideConfig: config,
      errorOnUnmatchedPattern: false,
      warnIgnored: false,
      cache: false,
    });
    results = await eslint.lintFiles(patterns);
    meta = eslint.getRulesMetaForResults(results);
  } finally {
    process.emitWarning = emitWarning;
  }
  // Flat-config `ignores` the project set (only checked for files with findings).
  if (project.isIgnored) {
    const keep = await Promise.all(results.map((r) => (r.messages.length ? project.isIgnored(r.filePath).then((x) => !x) : true)));
    results = results.filter((_, i) => keep[i]);
  }
  const findings = [];
  const unparsed = [];
  const lineCache = new Map();
  const lineOf = (abs, n) => {
    if (!lineCache.has(abs)) {
      let lines = [];
      try { lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/); } catch { /* virtual file */ }
      lineCache.set(abs, lines);
    }
    return (lineCache.get(abs)[n - 1] || '').trim();
  };
  const linesOf = (abs, from, to) => { lineOf(abs, from); return lineCache.get(abs).slice(from - 1, Math.min(to || from, from + 12)).join('\n'); };
  const fragmentCache = new Map();
  const isFragment = (abs) => {
    if (!fragmentCache.has(abs)) {
      let text = '';
      try { text = fs.readFileSync(abs, 'utf8'); } catch { /* virtual */ }
      fragmentCache.set(abs, !/<!doctype|<html[\s>]|<body[\s>]/i.test(text));
    }
    return fragmentCache.get(abs);
  };
  for (const r of results) {
    // Angular inline templates come back under the .ts path already.
    const abs = r.filePath;
    const rel = path.relative(root, abs).split(path.sep).join('/');
    for (const m of r.messages) {
      if (m.fatal || !m.ruleId) { if (m.fatal) unparsed.push({ file: rel, message: m.message }); continue; }
      const base = mappingFor(m.ruleId);
      if (!base) continue;
      const mapping = adjustMapping(base, m, { element: () => linesOf(abs, m.line, m.endLine), fragment: () => isFragment(abs) });
      const source = lineOf(abs, m.line);
      findings.push({
        ruleId: m.ruleId, file: rel, abs, line: m.line, column: m.column, message: m.message, source,
        docsUrl: (meta[m.ruleId] && meta[m.ruleId].docs && meta[m.ruleId].docs.url) || '',
        mapping,
        // Survives the code moving up or down the file — used by `a11y verify`.
        key: `${m.ruleId}|${rel}|${hash(source)}`,
      });
    }
  }
  return {
    findings: dropShadowed(findings), files: results.length, unparsed, durationMs: Date.now() - started,
    projectConfig: project.source || null,
  };
}

/**
 * Per-finding confidence, where the rule id alone says too little.
 *   - anchor-is-valid: only a missing href is a keyboard problem (not focusable); href="#" or
 *     "use a button" on an anchor that has an href is best practice.
 *   - alt-text on an element with spread props (`{...props}`, Vue `v-bind="obj"`): alt may arrive through them.
 *   - @html-eslint on a fragment (no <html>/<body>: partials, includes, templates): it may render inside a
 *     page that supplies what's missing, so it's a review item, not a failure.
 */
function adjustMapping(mapping, msg, ctx) {
  if (mapping.name === 'anchor-is-valid' && !/required/i.test(msg.message) && /\shref\s*=/.test(ctx.element())) {
    return { ...mapping, sc: [], bp: true, conf: 'review', impact: 'minor' };
  }
  if (mapping.name === 'alt-text' && mapping.conf === 'high') {
    const el = ctx.element();
    if (/\{\s*\.\.\.[\w$.]+\s*\}|\sv-bind\s*=\s*["']/.test(el)) {
      return { ...mapping, conf: 'review', note: 'The element spreads props/attributes; alt may be passed in. Check the rendered element.' };
    }
  }
  if (mapping.plugin === '@html-eslint' && mapping.conf === 'high' && ctx.fragment()) {
    return { ...mapping, conf: 'review', note: 'HTML fragment (partial/include/template); the page that includes it may already provide this.' };
  }
  return mapping;
}

/**
 * One element often trips a precise rule and a broader heuristic for the same
 * criterion (<a href></a>: anchor-has-content AND control-has-associated-label).
 * Keep the precise one; a heuristic on the same line adds nothing.
 */
function dropShadowed(findings) {
  const highAt = new Map();
  for (const f of findings) {
    if (f.mapping.conf !== 'high' || f.mapping.bp) continue;
    const k = `${f.file}:${f.line}`;
    highAt.set(k, [...(highAt.get(k) || []), ...f.mapping.sc]);
  }
  return findings.filter((f) => f.mapping.conf === 'high'
    || !(highAt.get(`${f.file}:${f.line}`) || []).some((sc) => f.mapping.sc.includes(sc)));
}

/** Lint findings as an axe-shaped scan entry (see header). */
function toScan(lint) {
  const rules = new Map();
  for (const f of lint.findings) {
    const id = `lint:${f.ruleId}`;
    const kind = f.mapping.conf === 'high' && !f.mapping.bp ? 'violations' : 'incomplete';
    const k = `${kind}|${id}`;
    if (!rules.has(k)) {
      rules.set(k, {
        kind, id,
        fixRule: f.mapping.axe,
        impact: f.mapping.impact,
        tags: [...f.mapping.sc.map((sc) => 'wcag' + sc.replace(/\./g, '')), ...(f.mapping.bp ? ['best-practice'] : []), 'lint'],
        help: `${f.mapping.name.replace(/-/g, ' ')} (${f.mapping.plugin})`,
        helpUrl: f.docsUrl,
        description: f.message,
        nodes: [],
      });
    }
    rules.get(k).nodes.push({
      target: [`${f.file}:${f.line}:${f.column}`],
      html: f.source.slice(0, 300),
      impact: f.mapping.impact,
      failureSummary: f.message + (f.mapping.bp ? '\n(Best practice — not a WCAG failure on its own.)'
        : f.mapping.note ? `\n(${f.mapping.note})`
          : f.mapping.conf === 'review' ? '\n(Lint heuristic — check whether the rendered component really has this problem.)' : ''),
      // Project-relative, so archived runs stay readable on another machine.
      runtimeSource: { framework: 'lint', file: f.file, line: f.line, exact: true },
      lintKey: f.key,
    });
  }
  const all = [...rules.values()];
  return {
    page: LINT_PAGE,
    url: '',
    state: 'lint',
    violations: all.filter((r) => r.kind === 'violations'),
    incomplete: all.filter((r) => r.kind === 'incomplete'),
    passes: [],
    inapplicable: [],
    lint: { files: lint.files, unparsed: lint.unparsed.length, durationMs: lint.durationMs },
  };
}

/** Run the lint for a loaded config, logging a one-line summary. Never throws. */
async function lintForConfig(config, log = () => {}) {
  const base = config.STATIC_LINT || {};
  if (base.enabled === false || !config.REPO_PATH) return null;
  const opts = { ...base, exclude: [...(base.exclude || []), ...[].concat(config.LINT_IGNORE || [])] };
  try {
    const lint = await lintProject(config.REPO_PATH, config.STACKS || [], opts);
    const high = lint.findings.filter((f) => f.mapping.conf === 'high' && !f.mapping.bp).length;
    log(`Source lint: ${lint.files} file(s) in ${(lint.durationMs / 1000).toFixed(1)}s — ${high} violation(s), ${lint.findings.length - high} to review${lint.unparsed.length ? `, ${lint.unparsed.length} file(s) could not be parsed` : ''}${lint.projectConfig ? ` (honouring ${lint.projectConfig})` : ''}.`);
    return { lint, scan: toScan(lint) };
  } catch (e) {
    log(`⚠ Source lint skipped (${String(e.message).split('\n')[0]})`);
    return null;
  }
}

module.exports = { lintProject, toScan, lintForConfig, buildConfig, readProjectEslint, dropShadowed, LINT_PAGE };
