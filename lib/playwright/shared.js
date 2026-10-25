/**
 * Bits shared by the Playwright fixture, its reporter and `a11y e2e-report`.
 */
const fs = require('fs');
const path = require('path');
const { loadConfig, mergeDefaults } = require('../config/load');
const { readManifest, matchPattern } = require('../routes/manifest');

const cache = new Map();

/** The project's a11y.config.js if there is one, else defaults writing to ./a11y-report. */
function loadE2eConfig(file) {
  const key = file || '';
  if (cache.has(key)) return cache.get(key);
  let config;
  const local = file ? path.resolve(file) : path.join(process.cwd(), 'a11y.config.js');
  if (fs.existsSync(local)) {
    config = loadConfig({ file: local });
  } else {
    config = mergeDefaults({ OUTPUT_DIR: path.join(process.cwd(), 'a11y-report'), REPORT_NAME: path.basename(process.cwd()) });
    config.CODE_EXTENSIONS = [];
    config.STACKS = [];
    config._meta = { configFile: null, configDir: process.cwd() };
  }
  // A fixture must never pop a browser tab open or block on a gate mid-run.
  config.OPEN_REPORT = false;
  cache.set(key, config);
  return config;
}

function scansDir(config) { return path.join(config.OUTPUT_DIR, '.e2e-scans'); }

/**
 * Name E2E results after the route they happened on, so they merge with
 * route scans of the same page in the combined dashboard. Falls back to the
 * URL path.
 */
function pageNameFor(url, config) {
  let u;
  try { u = new URL(url); } catch { return url; }
  const hashPath = u.hash.startsWith('#/') ? u.hash.slice(1).replace(/[?].*$/, '') : null;
  const candidates = [];
  if (config.ROUTES_FILE && fs.existsSync(config.ROUTES_FILE)) {
    try {
      for (const r of readManifest(config.ROUTES_FILE).routes) if (r.status !== 'gone') candidates.push(r);
    } catch { /* unreadable manifest — fall back to paths */ }
  }
  // Most specific first: fewer parameters wins (/users/new before /users/:id).
  candidates.sort((a, b) => (a.pattern.match(/:/g) || []).length - (b.pattern.match(/:/g) || []).length);
  for (const r of candidates) {
    const target = r.hash ? hashPath : u.pathname;
    if (target === null) continue;
    if (matchPattern(r.pattern, target)) return r.name;
  }
  for (const p of config.PAGES || []) {
    if ((p.path || '').replace(/\/+$/, '') === (u.pathname + (hashPath ? '#' + hashPath : '')).replace(/\/+$/, '')) return p.name;
  }
  return (hashPath ? '#' + hashPath : u.pathname) || '/';
}

module.exports = { loadE2eConfig, scansDir, pageNameFor };
