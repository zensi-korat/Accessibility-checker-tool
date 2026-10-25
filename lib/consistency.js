/**
 * Cross-page CONSISTENCY testing — 3.2.3, 3.2.4, 3.2.6 and 2.4.5.
 *
 * These four are the only criteria in the set that cannot be judged from a
 * single page. "Consistent navigation" has no meaning until you have two pages
 * to compare, and "multiple ways" is a property of the site, not of any one
 * URL. That is why axe has no rule for any of them — a single-page rule engine
 * structurally cannot see them.
 *
 * The scan already visits many pages, so this is nearly free: collect a small
 * signature per page while it is open, then compare the signatures afterwards.
 * No extra page loads, no extra interaction.
 *
 * Two-phase by design:
 *   collectSignature(page)            → per-page, called during the scan
 *   evaluateConsistency(signatures)   → pure function, called once at the end
 *
 * Violations are attributed to the DEVIATING page, not to the site, because
 * that is the page someone has to open to fix it. The majority shape across
 * pages is treated as the intended one.
 *
 * Emits axe-shaped results keyed by page:
 *   con-nav-order        → 3.2.3 Consistent Navigation
 *   con-identification   → 3.2.4 Consistent Identification
 *   con-help-missing     → 3.2.6 Consistent Help
 *   con-multiple-ways    → 2.4.5 Multiple Ways
 */

const HELP_URLS = {
  'con-nav-order': 'https://www.w3.org/WAI/WCAG22/Understanding/consistent-navigation.html',
  'con-identification': 'https://www.w3.org/WAI/WCAG22/Understanding/consistent-identification.html',
  'con-help-missing': 'https://www.w3.org/WAI/WCAG22/Understanding/consistent-help.html',
  'con-multiple-ways': 'https://www.w3.org/WAI/WCAG22/Understanding/multiple-ways.html',
};

function result(id, help, impact, tags, nodes) {
  return { id, help, description: help, helpUrl: HELP_URLS[id] || '', impact, tags, nodes };
}
function node(impact, html, sel, failureSummary) {
  return { impact, html: String(html || '').slice(0, 400), target: [sel], failureSummary };
}

/** Runs in the browser. Returns this page's navigation/help/search fingerprint. */
function signatureProbe() {
  const shown = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const name = (el) => (
    el.getAttribute('aria-label') || el.innerText || el.textContent || el.getAttribute('title') || ''
  ).trim().replace(/\s+/g, ' ').slice(0, 60);
  const normPath = (href) => {
    try { return new URL(href, location.href).pathname.replace(/\/+$/, '').toLowerCase() || '/'; }
    catch { return null; }
  };

  // Primary navigation: the first nav landmark with a meaningful link count.
  // Falls back to the header, because plenty of real apps never use <nav>.
  // Priority matters and cannot be expressed in one selector: querySelectorAll
  // returns matches in DOCUMENT order, not selector order, so a <header>
  // appearing above a <nav> would win and drag in logout/profile links that
  // are not navigation at all. Hence one query per tier, best tier first.
  const NAV_TIERS = ['nav, [role="navigation"]', '.navbar, #nav, .nav, .menu', 'header'];
  let navRoot = null;
  for (const tier of NAV_TIERS) {
    for (const c of document.querySelectorAll(tier)) {
      if (!shown(c)) continue;
      if (c.querySelectorAll('a[href]').length >= 3) { navRoot = c; break; }
    }
    if (navRoot) break;
  }
  const nav = [];
  if (navRoot) {
    for (const a of navRoot.querySelectorAll('a[href]')) {
      if (!shown(a)) continue;
      const p = normPath(a.getAttribute('href'));
      if (!p) continue;
      nav.push({ path: p, name: name(a) });
    }
  }

  // Help mechanisms, per 3.2.6: contact details, a help page, or live chat.
  const HELP_RE = /\b(help|support|contact|faq|documentation|docs|chat)\b/i;
  const help = [];
  for (const a of document.querySelectorAll('a[href], button')) {
    if (!shown(a)) continue;
    const t = name(a);
    const href = a.getAttribute('href') || '';
    if (HELP_RE.test(t) || HELP_RE.test(href)) {
      help.push({ name: t, path: normPath(href) });
    }
  }

  // Ways of locating content, per 2.4.5.
  const hasSearch = !!document.querySelector(
    'input[type="search"], [role="search"], input[name*="search" i], input[placeholder*="search" i]');
  const hasSitemap = [...document.querySelectorAll('a[href]')].some((a) =>
    /sitemap|site-map/i.test(a.getAttribute('href') || '') || /site ?map/i.test(name(a)));
  const hasBreadcrumb = !!document.querySelector(
    '[aria-label*="breadcrumb" i], .breadcrumb, [class*="breadcrumb" i]');

  return {
    nav,
    help: help.slice(0, 10),
    hasNav: nav.length >= 3,
    hasSearch,
    hasSitemap,
    hasBreadcrumb,
  };
}

async function collectSignature(page) {
  try { return await page.evaluate(signatureProbe); } catch { return null; }
}

/** The value occurring most often, with its count. */
function mode(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
  let best = null; let n = 0;
  for (const [v, c] of counts) if (c > n) { best = v; n = c; }
  return { value: best, count: n };
}

/**
 * @param {Record<string, object>} signatures  page name -> signature
 * @returns {Record<string, {violations: any[], passes: any[]}>}
 */
function evaluateConsistency(signatures) {
  const out = {};
  const pages = Object.keys(signatures).filter((p) => signatures[p]);
  const add = (page, kind, res) => {
    out[page] = out[page] || { violations: [], passes: [] };
    out[page][kind].push(res);
  };
  // Consistency is undefined for a single page, and one comparison page is too
  // thin to call anything a majority. Emit nothing rather than guess.
  if (pages.length < 3) return out;

  // ── 3.2.3 Consistent Navigation ─────────────────────────────────────────
  // Compare the ORDER of nav destinations. Pages legitimately differ in which
  // items are present (permissions, current section), so a page is only at
  // fault when the items it does share appear in a different relative order.
  const navPages = pages.filter((p) => signatures[p].hasNav);
  if (navPages.length >= 3) {
    const orders = navPages.map((p) => signatures[p].nav.map((n) => n.path).join('>'));
    const common = mode(orders);
    const expected = common.value.split('>');
    for (let i = 0; i < navPages.length; i++) {
      const page = navPages[i];
      const actual = signatures[page].nav.map((n) => n.path);
      const shared = actual.filter((p) => expected.includes(p));
      const expectedShared = expected.filter((p) => actual.includes(p));
      if (shared.join('>') !== expectedShared.join('>')) {
        add(page, 'violations', result('con-nav-order',
          'Navigation items appear in a different order than on other pages', 'moderate',
          ['cat.semantics', 'wcag2aa', 'wcag323'],
          [node('moderate', '', 'nav',
            `This page orders its navigation as [${shared.join(', ')}] while ${common.count} other pages use [${expectedShared.join(', ')}]. Repeated navigation must keep the same relative order on every page.`)]));
      } else {
        add(page, 'passes', result('con-nav-order',
          'Navigation order matches other pages', null, ['wcag2aa', 'wcag323'], []));
      }
    }
  }

  // ── 3.2.4 Consistent Identification ─────────────────────────────────────
  // The same destination must carry the same label everywhere. Keyed on the
  // resolved path, so "Staff" linking to /manage/staff on one page and
  // "Employees" linking to the same path on another is caught.
  const namesByPath = new Map();
  for (const p of pages) {
    for (const item of signatures[p].nav) {
      if (!namesByPath.has(item.path)) namesByPath.set(item.path, []);
      namesByPath.get(item.path).push({ page: p, name: item.name });
    }
  }
  const inconsistent = new Map(); // page -> [messages]
  for (const [pathKey, entries] of namesByPath) {
    if (entries.length < 3) continue;
    const common = mode(entries.map((e) => e.name));
    for (const e of entries) {
      if (e.name && common.value && e.name !== common.value) {
        if (!inconsistent.has(e.page)) inconsistent.set(e.page, []);
        inconsistent.get(e.page).push(
          `"${e.name}" for ${pathKey} (called "${common.value}" on ${common.count} other pages)`);
      }
    }
  }
  for (const p of pages) {
    if (inconsistent.has(p)) {
      add(p, 'violations', result('con-identification',
        'The same link is labelled differently here than on other pages', 'moderate',
        ['cat.semantics', 'wcag2aa', 'wcag324'],
        inconsistent.get(p).slice(0, 10).map((m) => node('moderate', '', 'nav',
          `This page uses ${m}. Components with the same function must be identified consistently, so a user can recognise them from page to page.`))));
    } else {
      add(p, 'passes', result('con-identification',
        'Repeated links are labelled consistently', null, ['wcag2aa', 'wcag324'], []));
    }
  }

  // ── 3.2.6 Consistent Help ───────────────────────────────────────────────
  // Only applies if the site offers help at all. If most pages have it and a
  // few do not, those few are the defect.
  const withHelp = pages.filter((p) => signatures[p].help.length > 0);
  if (withHelp.length >= Math.ceil(pages.length * 0.6) && withHelp.length !== pages.length) {
    for (const p of pages) {
      if (signatures[p].help.length === 0) {
        add(p, 'violations', result('con-help-missing',
          'Help is available on other pages but not on this one', 'moderate',
          ['cat.semantics', 'wcag22a', 'wcag326'],
          [node('moderate', '', 'body',
            `${withHelp.length} of ${pages.length} scanned pages offer a help or contact mechanism; this page offers none. When help is provided, it must appear on every page in the same relative order.`)]));
      } else {
        add(p, 'passes', result('con-help-missing',
          'Help mechanism present, consistent with other pages', null, ['wcag22a', 'wcag326'], []));
      }
    }
  } else if (withHelp.length === pages.length) {
    for (const p of pages) {
      add(p, 'passes', result('con-help-missing',
        'Help mechanism present on every page', null, ['wcag22a', 'wcag326'], []));
    }
  }

  // ── 2.4.5 Multiple Ways ─────────────────────────────────────────────────
  // A property of the site, so it is evaluated once and reported on every
  // page — the matrix should not imply one page is better than another here.
  const ways = [];
  if (pages.some((p) => signatures[p].hasNav)) ways.push('a navigation menu');
  if (pages.some((p) => signatures[p].hasSearch)) ways.push('a search field');
  if (pages.some((p) => signatures[p].hasSitemap)) ways.push('a sitemap link');
  if (pages.some((p) => signatures[p].hasBreadcrumb)) ways.push('breadcrumbs');
  for (const p of pages) {
    if (ways.length >= 2) {
      add(p, 'passes', result('con-multiple-ways',
        `Multiple ways to locate pages (${ways.join(', ')})`, null, ['wcag2aa', 'wcag245'], []));
    } else {
      add(p, 'violations', result('con-multiple-ways',
        'Only one way to locate pages across the site', 'moderate',
        ['cat.semantics', 'wcag2aa', 'wcag245'],
        [node('moderate', '', 'body',
          `Across ${pages.length} scanned pages the only way found to locate content is ${ways[0] || 'none'}. Provide at least two of: navigation menu, site search, sitemap, or breadcrumbs.`)]));
    }
  }

  return out;
}

module.exports = { collectSignature, evaluateConsistency, signatureProbe };
