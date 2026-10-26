/**
 * Next.js 15/16 route discovery (app router):
 *   - route groups like (dashboard) don't appear in URLs
 *   - build-manifest internals (/_global-error, /_not-found) and metadata
 *     routes (/favicon.ico, /icon.png, /sitemap.xml) are not pages
 *   - proxy.ts (Next 16) is read as the auth guard, and its PUBLIC_PATHS
 *     are not marked as needing a login
 *
 *   node test/next16.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const next = require('../lib/adapters/next');

let failures = 0;
const check = (ok, msg) => { console.log((ok ? '  ok   ' : '  FAIL ') + msg); if (!ok) failures++; };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a11y-next16-'));
const w = (f, body = 'export default function P() { return null; }\n') => { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), body); };
w('package.json', JSON.stringify({ dependencies: { next: '16.0.0', react: '19.0.0' } }));
w('app/layout.tsx');
w('app/(dashboard)/page.tsx');
w('app/(dashboard)/reports/page.tsx');
w('app/(dashboard)/users/[id]/page.tsx');
w('app/login/page.tsx');
w('app/forgot-password/page.tsx');
w('app/api/health/route.ts', 'export function GET() {}');
w('proxy.ts', `import { NextResponse } from 'next/server';
const PUBLIC_PATHS = ['/login', '/forgot-password'];
export function proxy(req) { const token = req.cookies.get('session'); if (!token && !PUBLIC_PATHS.some((p) => req.nextUrl.pathname.startsWith(p))) return NextResponse.redirect('/login'); }
`);
w('.next/routes-manifest.json', JSON.stringify({ staticRoutes: [{ page: '/' }, { page: '/_global-error' }, { page: '/_not-found' }, { page: '/favicon.ico' }, { page: '/icon.png' }, { page: '/sitemap.xml' }, { page: '/reports' }], dynamicRoutes: [] }));
w('.next/app-path-routes-manifest.json', JSON.stringify({ '/(dashboard)/page': '/', '/favicon.ico/route': '/favicon.ico', '/_global-error/page': '/_global-error' }));

const { routes } = next.discoverRoutes({ root });
const pats = routes.map((r) => r.pattern);
const by = (p) => routes.find((r) => r.pattern === p);
check(pats.includes('/') && pats.includes('/reports') && pats.includes('/users/:id'), 'route groups are dropped from URLs: /, /reports, /users/:id');
check(!pats.some((p) => /_global-error|_not-found/.test(p)), 'build-manifest internals (/_global-error, /_not-found) are not pages');
check(!pats.some((p) => /favicon|icon\.png|sitemap/.test(p)), 'metadata routes (/favicon.ico, /icon.png, /sitemap.xml) are not pages');
check(!pats.some((p) => p.startsWith('/api')), 'API route handlers are not pages');
check(by('/reports').guarded === true && by('/').guarded === true, 'proxy.ts guards the app pages');
check(by('/login').guarded === false && by('/forgot-password').guarded === false, 'PUBLIC_PATHS in proxy.ts are not marked as needing a login');


console.log('\ni18n: app/[locale]/…');
{
  const { mergeManifest, pagesFromManifest } = require('../lib/routes/manifest');
  const r2 = fs.mkdtempSync(path.join(os.tmpdir(), 'a11y-next-intl-'));
  const w2 = (f, body = 'export default function P() { return null; }\n') => { fs.mkdirSync(path.dirname(path.join(r2, f)), { recursive: true }); fs.writeFileSync(path.join(r2, f), body); };
  w2('package.json', JSON.stringify({ dependencies: { next: '15.0.0', 'next-intl': '4.0.0' } }));
  w2('src/app/[locale]/page.tsx');
  w2('src/app/[locale]/about/page.tsx');
  w2('src/app/[locale]/(shop)/products/page.tsx');
  w2('src/app/[locale]/users/[id]/page.tsx');
  w2('src/i18n/routing.ts', "import { defineRouting } from 'next-intl/routing';\nexport const routing = defineRouting({ locales: ['ar', 'en'], defaultLocale: 'ar' });\n");
  const found = next.discoverRoutes({ root: r2 }).routes;
  const pages = pagesFromManifest(mergeManifest(null, found));
  const paths = pages.map((p) => p.path);
  check(paths.includes('/ar') && paths.includes('/ar/about') && paths.includes('/ar/products'), 'locale pages are scanned with the default locale from i18n/routing.ts (/ar, /ar/about, /ar/products)');
  check(!paths.some((p) => p.includes('users')), 'a route that still needs another id (/:locale/users/:id) stays out until it has one');
  fs.rmSync(path.join(r2, 'src/i18n'), { recursive: true });
  w2('messages/en.json', '{}'); w2('messages/fr.json', '{}');
  const p2 = pagesFromManifest(mergeManifest(null, next.discoverRoutes({ root: r2 }).routes)).map((p) => p.path);
  check(p2.includes('/en/about'), 'without an i18n config, the messages/ folder decides (en preferred)');
  fs.rmSync(r2, { recursive: true, force: true });
}

fs.rmSync(root, { recursive: true, force: true });
console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
process.exitCode = failures ? 1 : 0;
