/**
 * Live discovery: sitemap + read-only crawl of a running app, folded into
 * the routes found in source.
 *
 * The test server is built to catch the ways a crawler goes wrong:
 *   - a POST fired on page load            → must be blocked (nothing written)
 *   - a /logout link                       → must never be followed
 *   - a SPA redirect via history.pushState → must still be recorded
 *   - /orders/1001, /orders/1002           → one /orders/:orderId template
 *   - 12 blog slugs                        → one /blog/:slug template
 *   - /app/users/42 (sitemap only)         → sample id for the source route /app/users/:id
 *
 *   node test/live.test.js
 */
const http = require('http');
const path = require('path');
const { discoverLive, applyLive } = require('../lib/routes/live');
const { discover } = require('../lib/adapters');
const { mergeManifest } = require('../lib/routes/manifest');
const { mergeDefaults } = require('../lib/config/load');

let failures = 0;
const check = (ok, msg) => { console.log((ok ? '  ok   ' : '  FAIL ') + msg); if (!ok) failures++; };

let posts = 0, logouts = 0;
const page = (body, extra = '') => `<!doctype html><html lang="en"><head><title>t</title></head><body>${body}${extra}</body></html>`;
const slugs = Array.from({ length: 12 }, (_, i) => `post-${i + 1}`);
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (req.method !== 'GET') { posts++; res.writeHead(200); return res.end('{}'); }
  if (u.pathname === '/logout') { logouts++; res.writeHead(302, { location: '/' }); return res.end(); }
  if (u.pathname === '/robots.txt') { res.writeHead(200); return res.end(`User-agent: *\nSitemap: http://localhost:${port}/sitemap-main.xml\n`); }
  if (u.pathname === '/sitemap-main.xml') {
    res.writeHead(200, { 'content-type': 'application/xml' });
    return res.end(`<?xml version="1.0"?><urlset><url><loc>http://localhost:${port}/app/users/42</loc></url><url><loc>https://elsewhere.example/app/x</loc></url></urlset>`);
  }
  if (u.pathname === '/sitemap.xml') { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': 'text/html' });
  if (u.pathname === '/') {
    return res.end(page(`<a href="/app">App</a> <a href="/logout">Log out</a> <a href="/blog">Blog</a> <a href="/orders/1001">#1001</a> <a href="/orders/1002">#1002</a> <a href="/files/report.pdf">PDF</a>`,
      `<script>fetch('/api/track', { method: 'POST', body: '{}' });</script>`));
  }
  if (u.pathname === '/app') return res.end(page('<a href="/app/about">About</a>', `<script>history.pushState({}, '', '/app/welcome');</script>`));
  if (u.pathname === '/blog') return res.end(page(slugs.map((s) => `<a href="/blog/${s}">${s}</a>`).join(' ')));
  return res.end(page('<p>page</p>'));
});
let port;

(async () => {
  await new Promise((r) => server.listen(0, r));
  port = server.address().port;
  const config = { ...mergeDefaults({}), BASE_URL: `http://localhost:${port}`, SETTLE_MS: 50 };
  const live = await discoverLive(config, { maxPages: 40 });
  const seen = new Set(live.found.map((f) => f.path));

  console.log('\ncrawl safety');
  check(posts === 0, `POST fired by a page was blocked (server saw ${posts})`);
  check(logouts === 0 && !seen.has('/logout'), '/logout was never requested');
  check(!seen.has('/files/report.pdf'), 'file downloads are not treated as pages');
  check(!live.found.some((f) => f.path === '/app/x'), 'sitemap URLs on another origin are ignored');

  console.log('\nwhat it finds');
  check(seen.has('/app/welcome'), 'SPA navigation via history.pushState is recorded');
  check(seen.has('/app/users/42') && live.found.find((f) => f.path === '/app/users/42').via === 'sitemap', 'sitemap listed in robots.txt is read');

  // Source routes of the React fixture use basename /app.
  const src = discover(path.join(__dirname, 'fixtures', 'projects', 'react-jsx'));
  const applied = applyLive(src.routes, live.found);
  const by = (p) => applied.routes.find((r) => r.pattern === p);
  check(by('/app/users/:id') && by('/app/users/:id').sample && by('/app/users/:id').sample.id === '42', 'dynamic source route gets its sample id from the live site');
  check(by('/app/about').sources.some((s) => /live site/.test(s)), 'source routes seen live are marked as confirmed');
  check(!!by('/orders/:orderId') && by('/orders/:orderId').sample.orderId === '1001', 'numeric ids collapse into /orders/:orderId');
  check(!!by('/blog/:slug') && !applied.routes.some((r) => /^\/blog\/post-/.test(r.pattern)), '12 sibling slugs collapse into /blog/:slug');
  check(!!by('/app/welcome') && by('/app/welcome').notes[0].includes('live site only'), 'URL no source route explains is added with a note');

  const manifest = mergeManifest(null, applied.routes);
  const users = manifest.routes.find((r) => r.pattern === '/app/users/:id');
  check(users.include === true && users.params.id === '42' && users.paramsFrom === 'live site', 'sampled dynamic route becomes scannable in the manifest');

  // Human edits still win: an explicit sample is not replaced on re-discovery.
  users.params.id = '7';
  const again = mergeManifest(manifest, applied.routes).routes.find((r) => r.pattern === '/app/users/:id');
  check(again.params.id === '7', "a human-chosen sample is not overwritten by the live site's");

  server.close();
  console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
  process.exitCode = failures ? 1 : 0;
})().catch((e) => { console.error(e); server.close(); process.exitCode = 1; });
