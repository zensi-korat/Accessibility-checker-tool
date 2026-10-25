/**
 * Route discovery per stack, against small fixture projects that use the
 * patterns real apps use: cross-file `/*` mounts, route constants, lazy
 * Angular modules, basePath/baseHref, auth guards, hash routing, monorepos.
 *
 * Each case pins the exact set of URL patterns. A route that goes missing
 * means a page silently drops out of every scan; one that appears from
 * nowhere means scanning something that is not a page — both are failures.
 *
 *   node test/adapters.test.js
 */
const path = require('path');
const { discover, detectStacks } = require('../lib/adapters');

let failures = 0;
const check = (ok, msg) => { console.log((ok ? '  ok   ' : '  FAIL ') + msg); if (!ok) failures++; };
const FIX = path.join(__dirname, 'fixtures', 'projects');

function run(name) {
  const r = discover(path.join(FIX, name));
  const by = new Map(r.routes.map((x) => [(x.hash ? '#' : '') + x.pattern, x]));
  return { ...r, by, patterns: [...by.keys()].sort() };
}
function expectRoutes(name, expected, extra = () => {}) {
  console.log(`\n${name}`);
  const r = run(name);
  const want = [...expected].sort();
  const missing = want.filter((p) => !r.by.has(p));
  const unexpected = r.patterns.filter((p) => !want.includes(p));
  check(!missing.length && !unexpected.length,
    `routes = ${want.length}` + (missing.length ? ` · missing ${missing.join(', ')}` : '') + (unexpected.length ? ` · unexpected ${unexpected.join(', ')}` : ''));
  extra(r);
}
const guarded = (r, p) => !!(r.by.get(p) && r.by.get(p).guarded);
const skippedReasons = (r) => r.skipped.map((s) => s.reason.split(' ')[0]).sort().join(',');

expectRoutes('react-jsx', ['/app', '/app/about', '/app/users', '/app/users/:id', '/app/users/new', '/app/admin/reports', '/app/settings'], (r) => {
  check(guarded(r, '/app/users/:id'), 'routes nested under <RequireAuth> are guarded');
  check(!guarded(r, '/app/about'), 'unguarded sibling stays public');
  check(skippedReasons(r) === 'not-found,path,redirect', 'skips <Navigate>, the 404 catch-all, and a runtime-only path (reported, not guessed)');
  check(r.by.get('/app/users/:id').sources[0].includes('src/pages/Users.tsx'), 'nested <Routes> are attributed to the file that defines them');
});

expectRoutes('react-objects', ['/', '/products/:productId?', '/admin', '/admin/users', '/help', '/login'], (r) => {
  check(guarded(r, '/admin/users'), 'guard on a parent element (<ProtectedRoute/>) covers imported children');
});

expectRoutes('react-framework', ['/', '/about', '/login', '/concerts', '/concerts/:city', '/:lang?/docs', '/signup', '/files/:rest*', '/posts/:slug'], (r) => {
  check(!r.patterns.some((p) => p.includes('rss')), 'resource route (no default export) is not a page');
});

expectRoutes('react-tanstack', ['/', '/posts/:postId', '/dashboard'], (r) => {
  check(guarded(r, '/dashboard'), '_auth layout marks its routes guarded');
});

expectRoutes('next-app', ['/portal', '/portal/blog/:slug', '/portal/shop/:all*?', '/portal/pricing', '/portal/dashboard', '/portal/dashboard/:team/settings', '/portal/docs/:slug*'], (r) => {
  check(guarded(r, '/portal/dashboard/:team/settings'), 'auth middleware matcher marks /dashboard/** guarded');
  check(!guarded(r, '/portal/pricing'), 'routes outside the matcher stay public');
});

expectRoutes('angular-app', ['/shop', '/shop/login', '/shop/admin', '/shop/admin/users/:id', '/shop/legacy/reports', '/shop/old', '/shop/products', '/shop/products/:id'], (r) => {
  check(guarded(r, '/shop/admin/users/:id'), 'canActivate on a lazy parent covers its children');
  check(skippedReasons(r) === 'not-found,redirect', "skips redirectTo and '**'");
});

expectRoutes('angular-hash', ['#/', '#/about']);

expectRoutes('vue-app', ['/portal', '/portal/about', '/portal/users', '/portal/users/:id', '/portal/profile', '/portal/admin', '/portal/admin/settings'], (r) => {
  check(guarded(r, '/portal/admin/settings'), 'meta.requiresAuth on a parent covers imported children');
  check(!guarded(r, '/portal/about'), 'unguarded route stays public');
  check(skippedReasons(r) === 'not-found,redirect', "skips redirect and the '/:pathMatch(.*)*' catch-all");
});

expectRoutes('nuxt-app', ['/', '/pricing', '/:lang?', '/docs/:slug*', '/users/:id', '/users/:id/edit'], (r) => {
  check(guarded(r, '/users/:id/edit') && !guarded(r, '/users/:id'), "definePageMeta({ middleware: 'auth' }) guards just that page");
});

expectRoutes('aspnet-core-app', ['/', '/Privacy', '/Admin', '/Users/Edit/:id', '/invoices/:year?', '/counter', '/counter/:start',
  '/Home/Contact', '/orders', '/orders/:id', '/orders/track', '/Products', '/Products/Show/:id?'], (r) => {
  check(guarded(r, '/Admin'), 'AuthorizeFolder("/Admin") convention in Program.cs');
  check(guarded(r, '/Users/Edit/:id'), '[Authorize] on the PageModel (.cshtml.cs)');
  check(guarded(r, '/orders/:id') && !guarded(r, '/orders/track'), '[Authorize] on the controller, lifted by [AllowAnonymous]');
  check(guarded(r, '/counter/:start'), 'Blazor @attribute [Authorize]');
  check(!r.patterns.some((p) => /api|Delete|Ignored|Card|_Layout/.test(p)), 'skips API controllers, non-GET actions, partials/layouts and bin/');
});
expectRoutes('webforms', ['/Default.aspx', '/manage/Staff.aspx', '/manage/GoogleCallBack.aspx'], (r) => {
  check(r.by.get('/manage/GoogleCallBack.aspx').include === false, 'callback-looking page is listed but not included');
});

console.log('\nmonorepo');
const stacks = detectStacks(path.join(FIX, 'monorepo'));
check(stacks.length === 1 && stacks[0].id === 'angular' && stacks[0].root.endsWith(path.join('Api', 'ClientApp')),
  'finds the Angular ClientApp inside a .NET project folder');
const mono = run('monorepo');
check(mono.routes[0].sources[0].startsWith('angular Api/ClientApp/src/'), 'sources are relative to the scanned root');

console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
process.exitCode = failures ? 1 : 0;
