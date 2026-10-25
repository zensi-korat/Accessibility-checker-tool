/**
 * Start the app under test before scanning, stop it afterwards — the same
 * idea as Playwright's `webServer`, so CI needs no separate "start the app
 * and wait" step.
 *
 *   WEB_SERVER: {
 *     command: 'npm run start',       // shell command
 *     url: 'http://localhost:3000',   // polled until it answers (default: BASE_URL)
 *     timeout: 120000,                // ms to wait for it
 *     reuseExisting: true,            // already running (e.g. your dev server)? use it
 *     cwd: '.',                       // relative to the config file
 *     env: { PORT: '3000' },
 *   }
 */
const http = require('http');
const https = require('https');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

/** Any HTTP answer below 500 counts as "up" (a login redirect or 404 still means the server runs). */
function probe(url) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch { return resolve(false); }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(u, { rejectUnauthorized: false, timeout: 3000 }, (res) => { res.resume(); resolve(res.statusCode < 500); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
    else process.kill(-child.pid, 'SIGTERM'); // the whole process group: npm → node → next/vite
  } catch { /* already gone */ }
}

/**
 * @param {object} config  loaded config (WEB_SERVER, BASE_URL, _meta.configDir)
 * @returns {Promise<{stop: () => Promise<void>, started: boolean}>}
 */
async function startWebServer(config, { log = () => {} } = {}) {
  const ws = config.WEB_SERVER;
  const noop = { stop: async () => {}, started: false };
  if (!ws || !ws.command) return noop;
  const url = ws.url || config.BASE_URL;
  if (ws.reuseExisting !== false && await probe(url)) {
    log(`Web server: ${url} is already up — reusing it.`);
    return noop;
  }

  const cwd = path.resolve((config._meta && config._meta.configDir) || process.cwd(), ws.cwd || '.');
  log(`Web server: starting \`${ws.command}\` in ${cwd} …`);
  const child = spawn(ws.command, {
    cwd, shell: true, env: { ...process.env, ...(ws.env || {}) },
    detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
  });
  const tail = [];
  const keep = (b) => { for (const l of String(b).split(/\r?\n/)) if (l.trim()) { tail.push(l); if (tail.length > 40) tail.shift(); } };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  let exited = null;
  child.on('exit', (code) => { exited = code; });
  const stopOnExit = () => killTree(child);
  process.on('exit', stopOnExit);

  const deadline = Date.now() + (ws.timeout || 120000);
  while (Date.now() < deadline) {
    if (exited !== null) {
      process.removeListener('exit', stopOnExit);
      throw new Error(`web server command exited with code ${exited} before ${url} answered.\n  Last output:\n    ${tail.slice(-15).join('\n    ')}`);
    }
    if (await probe(url)) {
      log(`Web server: ${url} is up.`);
      return {
        started: true,
        async stop() {
          process.removeListener('exit', stopOnExit);
          killTree(child);
          await new Promise((r) => { if (child.exitCode !== null) r(); else { child.once('exit', r); setTimeout(r, 5000); } });
        },
      };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  killTree(child);
  process.removeListener('exit', stopOnExit);
  throw new Error(`${url} did not answer within ${Math.round((ws.timeout || 120000) / 1000)}s of starting \`${ws.command}\`.\n  Last output:\n    ${tail.slice(-15).join('\n    ')}`);
}

module.exports = { startWebServer, probe };
