/**
 * Finds, loads and normalises a scan config so scan.js / render.js /
 * combine-reports.js never depend on where the tool itself is installed.
 *
 * Lookup order (first hit wins):
 *   1. --config <file>  or  A11Y_CONFIG=<file>   (relative to cwd)
 *   2. ./a11y.config.js in the current directory  (what `a11y init` writes)
 *
 * The result is defaults ⟵ config file ⟵ A11Y_* env overrides, with every
 * path made absolute and PAGES extended by the reviewed routes manifest.
 */
const fs = require('fs');
const path = require('path');
const DEFAULTS = require('./defaults');
const { applyEnvOverrides } = require('../ci');
const { readManifest, pagesFromManifest } = require('../routes/manifest');

const TOOL_DIR = path.resolve(__dirname, '..', '..');

function findConfigFile(argv = process.argv, env = process.env, cwd = process.cwd()) {
  const i = argv.indexOf('--config');
  const explicit = (i > -1 && argv[i + 1]) || env.A11Y_CONFIG;
  if (explicit) {
    const candidates = path.isAbsolute(explicit)
      ? [explicit]
      : [path.resolve(cwd, explicit)];
    for (const c of candidates) {
      for (const f of [c, c + '.js']) if (fs.existsSync(f) && fs.statSync(f).isFile()) return f;
    }
    throw new Error(`Config file not found: ${explicit}`);
  }
  const local = path.join(cwd, 'a11y.config.js');
  if (fs.existsSync(local)) return local;
  const cli = require('../cliName')();
  throw new Error(`No a11y.config.js here. Run \`${cli} init\` in your project, pass --config <file>, or quick-scan a URL with \`${cli} scan <url>\`.`);
}

// Shallow merge, except nested objects that are partial-override friendly.
function mergeDefaults(user) {
  const out = { ...DEFAULTS, ...user };
  for (const k of ['SCREENSHOTS', 'VIEWPORT', 'STATIC_LINT']) {
    if (user[k] && typeof user[k] === 'object') out[k] = { ...DEFAULTS[k], ...user[k] };
  }
  out.LOGIN = { ...DEFAULTS.LOGIN, ...(user.LOGIN || {}) };
  return out;
}

function resolveFrom(dir, p) {
  if (!p) return p;
  return path.isAbsolute(p) ? p : path.resolve(dir, p);
}

/**
 * @param {{argv?:string[], env?:object, cwd?:string, log?:Function, file?:string}} opts
 */
function loadConfig(opts = {}) {
  const log = opts.log || (() => {});
  const file = opts.file || findConfigFile(opts.argv, opts.env, opts.cwd);
  delete require.cache[require.resolve(file)];
  const raw = require(file);
  const dir = path.dirname(file);
  const cfg = mergeDefaults(raw);

  cfg.OUTPUT_DIR = resolveFrom(dir, cfg.OUTPUT_DIR || '.');
  cfg.REPO_PATH = cfg.REPO_PATH ? resolveFrom(dir, cfg.REPO_PATH) : '';
  cfg.ROUTES_FILE = cfg.ROUTES_FILE ? resolveFrom(dir, cfg.ROUTES_FILE) : '';
  // The saved login session lives beside the config, like every other path.
  cfg.LOGIN.stateFile = resolveFrom(dir, cfg.LOGIN.stateFile || '.a11y-auth.json');

  const withEnv = applyEnvOverrides(cfg, log);
  // An env-supplied REPO_PATH is relative to where the command was run.
  if (withEnv.REPO_PATH) withEnv.REPO_PATH = path.resolve(opts.cwd || process.cwd(), withEnv.REPO_PATH);

  // Stack ids drive code extensions and stack-specific fix advice. Explicit
  // STACKS wins; else detect from the source; else infer from CODE_EXTENSIONS
  // (legacy configs list WebForms markup but have no REPO_PATH locally).
  const { detectStacks, codeExtensionsFor } = require('../adapters');
  const detected = withEnv.REPO_PATH ? detectStacks(withEnv.REPO_PATH) : [];
  if (!withEnv.CODE_EXTENSIONS && withEnv.REPO_PATH) withEnv.CODE_EXTENSIONS = codeExtensionsFor(detected);
  withEnv.CODE_EXTENSIONS = withEnv.CODE_EXTENSIONS || [];
  if (!withEnv.STACKS) {
    withEnv.STACKS = [...new Set(detected.map((s) => s.id))];
    // Only extensions the user chose say anything about the stack — the
    // fallback list for an undetected project includes .aspx too.
    if (!withEnv.STACKS.length && (raw.CODE_EXTENSIONS || []).some((e) => /^\.(aspx|ascx|master)$/i.test(e))) withEnv.STACKS = ['aspnet-webforms'];
  }
  if (withEnv.STRIP_SERVER_IDS === undefined) {
    withEnv.STRIP_SERVER_IDS = withEnv.CODE_EXTENSIONS.some((e) => /^\.(aspx|ascx|master)$/i.test(e));
  }

  // Reviewed routes from `a11y discover` join the hand-written PAGES. A page
  // listed in both keeps the hand-written entry (it may carry reveal actions).
  const manifestFile = withEnv.ROUTES_FILE;
  if (manifestFile && fs.existsSync(manifestFile)) {
    const manifest = readManifest(manifestFile);
    const extra = pagesFromManifest(manifest, withEnv.PAGES);
    if (extra.length) log(`Routes manifest: +${extra.length} page(s) from ${path.basename(manifestFile)}`);
    // Dynamic routes (/users/:id) are left out until they have a sample value.
    // Say so — otherwise a project with many of them just looks half-scanned.
    const needIds = (manifest.routes || []).filter((r) => r.include === false && r.params && Object.values(r.params).some((v) => v === '' || v == null) && r.status !== 'gone');
    if (needIds.length) {
      const cli = require('../cliName')();
      log(`  ${needIds.length} dynamic route(s) skipped because they need a sample id (e.g. ${needIds.slice(0, 2).map((r) => r.pattern).join(', ')}). `
        + `Add one under "params" in ${path.basename(manifestFile)} and set "include": true, or run \`${cli} discover --live\` to fill them from the running app.`);
    }
    withEnv.PAGES = [...withEnv.PAGES, ...extra];
  }

  withEnv._meta = { configFile: file, configDir: dir, toolDir: TOOL_DIR };
  return withEnv;
}

/**
 * Config for `a11y scan <url>` when there is no a11y.config.js: defaults, the
 * URL, output in ./a11y-report, pages found by crawling the site (scan.js
 * does that, see _meta.quick). If the current folder is a recognisable
 * project, it is used for source lint and file:line hints too.
 */
function quickConfig(url, { cwd = process.cwd(), log = () => {}, maxPages = 20 } = {}) {
  const cfg = mergeDefaults({});
  cfg.BASE_URL = url.replace(/\/$/, '');
  cfg.OUTPUT_DIR = path.join(cwd, 'a11y-report');
  cfg.ROUTES_FILE = '';
  cfg.REPORT_NAME = (() => { try { return new URL(url).host; } catch { return 'quick-scan'; } })();
  cfg.LOGIN = { ...cfg.LOGIN, stateFile: path.join(cwd, '.a11y-auth.json') };
  const { detectStacks, codeExtensionsFor } = require('../adapters');
  const stacks = detectStacks(cwd);
  cfg.REPO_PATH = stacks.length ? cwd : '';
  cfg.STACKS = [...new Set(stacks.map((s) => s.id))];
  cfg.CODE_EXTENSIONS = stacks.length ? codeExtensionsFor(stacks) : [];
  cfg.STRIP_SERVER_IDS = cfg.CODE_EXTENSIONS.some((e) => /^\.(aspx|ascx|master)$/i.test(e));
  const withEnv = applyEnvOverrides(cfg, log);
  withEnv._meta = { configFile: null, configDir: cwd, toolDir: TOOL_DIR, quick: { maxPages } };
  return withEnv;
}

/** The URL in `scan <url>`, if any (first non-flag argument that is http(s)). */
function urlArg(argv = process.argv) {
  return argv.slice(2).find((a) => /^https?:\/\//i.test(a)) || null;
}

module.exports = { loadConfig, quickConfig, urlArg, findConfigFile, mergeDefaults, TOOL_DIR };
