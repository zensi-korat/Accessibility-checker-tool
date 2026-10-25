/**
 * Static accessibility lint of the project's source — the half of the picture
 * a browser scan can't give: exact file:line for markup that is wrong in the
 * source (JSX, Vue SFCs, Angular templates, plain HTML), including components
 * the scan never managed to render.
 *
 * Uses the tool's OWN ESLint 9 and plugins with a generated flat config
 * (overrideConfigFile: true), so the project's ESLint version, config and
 * style rules never interfere — and projects without ESLint work too. Only
 * the rules in ./wcagMap.js are enabled. The project's `eslint-disable`
 * comments are still honoured.
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
];

/** Simple .gitignore lines → flat-config ignore globs (negations are skipped). */
function gitignoreGlobs(root) {
  let text = '';
  try { text = fs.readFileSync(path.join(root, '.gitignore'), 'utf8'); } catch { return []; }
  const out = [];
  for (let line of text.split(/\r?\n/)) {
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

/**
 * The flat config for the stacks found in the project.
 * @param {string[]} stacks  stack ids from lib/adapters (react, next, vue, nuxt, angular, …)
 */
function buildConfig(root, stacks, opts = {}) {
  const has = (...ids) => ids.some((id) => stacks.includes(id));
  const overrides = opts.rules || {};
  const tsParser = require('@typescript-eslint/parser');
  const config = [
    { ignores: [...ALWAYS_IGNORED, ...gitignoreGlobs(root), ...(opts.exclude || [])] },
    { linterOptions: { reportUnusedDisableDirectives: 'off' } },
  ];
  const files = { jsx: [], vue: [], angularHtml: [], angularTs: [], html: [] };

  // JSX anywhere (any project can have .jsx/.tsx); plain .js/.ts only in React projects.
  files.jsx = ['**/*.jsx', '**/*.tsx', ...(has('react', 'next') ? ['**/*.js', '**/*.mjs', '**/*.ts'] : [])];
  config.push({
    files: files.jsx,
    plugins: { 'jsx-a11y': require('eslint-plugin-jsx-a11y') },
    languageOptions: { parser: tsParser, parserOptions: { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true } } },
    settings: opts.jsxSettings || {},
    rules: rulesFor('jsx-a11y', overrides),
  });

  if (has('vue', 'nuxt')) {
    files.vue = ['**/*.vue'];
    config.push({
      files: files.vue,
      plugins: { 'vuejs-accessibility': require('eslint-plugin-vuejs-accessibility') },
      languageOptions: { parser: require('vue-eslint-parser'), parserOptions: { parser: tsParser, ecmaVersion: 'latest', sourceType: 'module' } },
      rules: rulesFor('vuejs-accessibility', overrides),
    });
  }

  if (has('angular')) {
    const ng = require('@angular-eslint/eslint-plugin-template');
    files.angularTs = ['**/*.component.ts'];
    files.angularHtml = ['**/*.html'];
    // Inline `template:` strings are extracted as virtual *.html files.
    config.push({
      files: files.angularTs,
      plugins: { '@angular-eslint/template': ng },
      languageOptions: { parser: tsParser },
      processor: ng.processors['extract-inline-html'],
    });
    config.push({
      files: files.angularHtml,
      plugins: { '@angular-eslint/template': ng },
      languageOptions: { parser: require('@angular-eslint/template-parser') },
      rules: rulesFor('@angular-eslint/template', overrides),
    });
  } else {
    files.html = ['**/*.html', '**/*.htm'];
    config.push({
      files: files.html,
      plugins: { '@html-eslint': require('@html-eslint/eslint-plugin') },
      languageOptions: { parser: require('@html-eslint/parser') },
      rules: rulesFor('@html-eslint', overrides),
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
  const { ESLint } = require('eslint');
  const started = Date.now();
  const { config, patterns } = buildConfig(root, stacks, opts);
  const eslint = new ESLint({
    cwd: root,
    overrideConfigFile: true,
    overrideConfig: config,
    errorOnUnmatchedPattern: false,
    warnIgnored: false,
    cache: false,
  });
  const results = await eslint.lintFiles(patterns);
  const meta = eslint.getRulesMetaForResults(results);
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
  for (const r of results) {
    // Angular inline templates come back under the .ts path already.
    const abs = r.filePath;
    const rel = path.relative(root, abs).split(path.sep).join('/');
    for (const m of r.messages) {
      if (m.fatal || !m.ruleId) { if (m.fatal) unparsed.push({ file: rel, message: m.message }); continue; }
      const mapping = mappingFor(m.ruleId);
      if (!mapping) continue;
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
  return { findings: dropShadowed(findings), files: results.length, unparsed, durationMs: Date.now() - started };
}

/**
 * One element often trips a precise rule and a broader heuristic for the same
 * criterion (<a href></a>: anchor-has-content AND control-has-associated-label).
 * Keep the precise one; a heuristic on the same line adds nothing.
 */
function dropShadowed(findings) {
  const highAt = new Map();
  for (const f of findings) {
    if (f.mapping.conf !== 'high') continue;
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
    const kind = f.mapping.conf === 'high' ? 'violations' : 'incomplete';
    const k = `${kind}|${id}`;
    if (!rules.has(k)) {
      rules.set(k, {
        kind, id,
        fixRule: f.mapping.axe,
        impact: f.mapping.impact,
        tags: [...f.mapping.sc.map((sc) => 'wcag' + sc.replace(/\./g, '')), 'lint'],
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
      failureSummary: f.message + (f.mapping.conf === 'review' ? '\n(Lint heuristic — check whether the rendered component really has this problem.)' : ''),
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
  const opts = config.STATIC_LINT || {};
  if (opts.enabled === false || !config.REPO_PATH) return null;
  try {
    const lint = await lintProject(config.REPO_PATH, config.STACKS || [], opts);
    const high = lint.findings.filter((f) => f.mapping.conf === 'high').length;
    log(`Source lint: ${lint.files} file(s) in ${(lint.durationMs / 1000).toFixed(1)}s — ${high} violation(s), ${lint.findings.length - high} to review${lint.unparsed.length ? `, ${lint.unparsed.length} file(s) could not be parsed` : ''}.`);
    return { lint, scan: toScan(lint) };
  } catch (e) {
    log(`⚠ Source lint skipped (${String(e.message).split('\n')[0]})`);
    return null;
  }
}

module.exports = { lintProject, toScan, lintForConfig, buildConfig, LINT_PAGE };
