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
 * Emits axe-shaped results keyed by page ({violations, incomplete, passes}):
 *   con-nav-order        → 3.2.3 Consistent Navigation
 *   con-identification   → 3.2.4 Consistent Identification
 *   con-help-missing     → 3.2.6 Consistent Help (relative ORDER of help;
 *                          a page without help is not a failure)
 *   con-multiple-ways    → 2.4.5 Multiple Ways (review only: pages that were
 *                          not scanned may provide the second way)
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
  const imgName = (el) => {
    const i = el.querySelector('img[alt]:not([alt=""]), svg[aria-label], [role="img"][aria-label]');
    return i ? (i.getAttribute('alt') || i.getAttribute('aria-label') || '') : '';
  };
  const name = (el) => (
    el.getAttribute('aria-label') || el.innerText || el.textContent || imgName(el) || el.getAttribute('title') || ''
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
    const seenPath = {};
    for (const a of navRoot.querySelectorAll('a[href]')) {
      if (!shown(a)) continue;
      const p = normPath(a.getAttribute('href'));
      if (!p) continue;
      // slot: the n-th link to this path within the nav. A logo link and a
      // "Home" link both pointing at "/" are two different components, not
      // one component labelled inconsistently.
      seenPath[p] = (seenPath[p] || 0) + 1;
      nav.push({ path: p, name: name(a), slot: seenPath[p] });
    }
  }

  // Help mechanisms, per 3.2.6: contact details, a help page, or live chat.
  // Only REPEATED blocks count (header, footer, nav, or a fixed chat
  // launcher); a "Contact us" link in one article's body is content, not a
  // help mechanism the criterion is about.
  const HELP_RE = /\b(help|support|contact|faq|documentation|docs|chat)\b/i;
  const REPEATED = 'header, footer, nav, [role="banner"], [role="contentinfo"], [role="navigation"]';
  const fixedAncestor = (el) => {
    for (let n = el; n && n !== document.body; n = n.parentElement) if (getComputedStyle(n).position === 'fixed') return true;
    return false;
  };
  const help = [];
  for (const a of document.querySelectorAll('a[href], button')) {
    if (!shown(a)) continue;
    const region = a.closest('header, [role="banner"]') ? 'header'
      : a.closest('footer, [role="contentinfo"]') ? 'footer'
        : a.closest(REPEATED) ? 'nav' : fixedAncestor(a) ? 'floating' : null;
    if (!region) continue;
    const t = name(a);
    const href = a.getAttribute('href') || '';
    if (HELP_RE.test(t) || HELP_RE.test(href)) {
      help.push({ name: t, path: normPath(href), region });
    }
  }

  // Ways of locating content, per 2.4.5. A filter box above a table is not
  // site search, so a bare input[name*=search] only counts in a repeated block
  // or when it is plainly the site search.
  const SITE_SEARCH = /^(search|search site|search the site|site search|search this site|q|query|keywords?)$/i;
  const hasSearch = !!document.querySelector('[role="search"], form[role="search"], search')
    || Array.prototype.some.call(document.querySelectorAll('input[type="search"], input[name*="search" i], input[placeholder*="search" i], input[name="q"]'), (i) => {
      if (!shown(i)) return false;
      if (i.closest(REPEATED)) return true;
      const label = (i.getAttribute('aria-label') || i.getAttribute('name') || i.getAttribute('placeholder') || '').trim();
      return SITE_SEARCH.test(label.replace(/[.…]+$/, ''));
    });
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
    out[page] = out[page] || { violations: [], incomplete: [], passes: [] };
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
  // The same component (same destination, same slot within the nav) must
  // carry the same label everywhere. Keyed on the resolved path, so "Staff"
  // linking to /manage/staff on one page and "Employees" linking to the same
  // path on another is caught. Labels are normalised first: a screen-reader
  // "(current)" marker or a live count ("Inbox (3)") is the same label.
  const norm = (n) => String(n || '')
    .replace(/\(\s*(current|selected|active)\s*\)/ig, ' ')
    .replace(/\b(current page|current|selected)\s*$/i, ' ')
    .replace(/\(\s*\d+\+?\s*\)/g, ' ')
    .replace(/\s+\d+\+?$/, ' ')
    .replace(/\s+/g, ' ').trim().toLowerCase();
  const words = (n) => new Set(norm(n).split(/[^a-z0-9]+/).filter((w) => w.length > 2));
  const namesBySlot = new Map();
  for (const p of pages) {
    for (const item of signatures[p].nav) {
      const k = item.path + '#' + (item.slot || 1);
      if (!namesBySlot.has(k)) namesBySlot.set(k, []);
      namesBySlot.get(k).push({ page: p, name: item.name, path: item.path });
    }
  }
  const inconsistent = new Map(); // page -> [messages]
  const unsure = new Map();
  for (const [, entries] of namesBySlot) {
    if (entries.length < 3) continue;
    const common = mode(entries.map((e) => norm(e.name)));
    const commonRaw = (entries.find((e) => norm(e.name) === common.value) || {}).name;
    for (const e of entries) {
      if (!norm(e.name) || !common.value || norm(e.name) === common.value) continue;
      const msg = `"${e.name}" for ${e.path} (called "${commonRaw}" on ${common.count} other pages)`;
      // Clear case: a solid majority, and the deviating label shares no word
      // with it ("Staff" vs "Employees"). "Reports" vs "All reports" is a
      // wording drift a human should judge.
      const a = words(e.name); const b = words(commonRaw);
      const overlap = [...a].some((w) => b.has(w));
      const solid = common.count >= Math.max(2, Math.ceil(entries.length * 2 / 3));
      const sink = solid && !overlap ? inconsistent : unsure;
      if (!sink.has(e.page)) sink.set(e.page, []);
      sink.get(e.page).push(msg);
    }
  }
  for (const p of pages) {
    if (inconsistent.has(p)) {
      add(p, 'violations', result('con-identification',
        'The same link is labelled differently here than on other pages', 'moderate',
        ['cat.semantics', 'wcag2aa', 'wcag324'],
        inconsistent.get(p).slice(0, 10).map((m) => node('moderate', '', 'nav',
          `This page uses ${m}. Components with the same function must be identified consistently, so a user can recognise them from page to page.`))));
    } else if (unsure.has(p)) {
      add(p, 'incomplete', result('con-identification',
        'A repeated link is worded differently here than on other pages', 'minor',
        ['cat.semantics', 'wcag2aa', 'wcag324'],
        unsure.get(p).slice(0, 10).map((m) => node('minor', '', 'nav',
          `This page uses ${m}. If both labels identify the same function consistently this is fine; otherwise use one label everywhere.`))));
    } else {
      add(p, 'passes', result('con-identification',
        'Repeated links are labelled consistently', null, ['wcag2aa', 'wcag324'], []));
    }
  }

  // ── 3.2.6 Consistent Help ───────────────────────────────────────────────
  // The criterion does not require help on every page. It requires that WHERE
  // a repeated help mechanism appears, it keeps the same relative order (and
  // block) as on the other pages. So a page without help is not a failure;
  // a page that moves "Contact" from the header to the footer, or swaps the
  // order of "Help" and "Contact", is.
  const helpKey = (h) => (h.path && h.path !== '/' ? h.path : norm(h.name));
  const withHelp = pages.filter((p) => signatures[p].help.length > 0);
  if (withHelp.length >= 3) {
    const orders = withHelp.map((p) => signatures[p].help.map((h) => `${h.region || '?'}:${helpKey(h)}`).join('>'));
    const common = mode(orders);
    const expected = common.value.split('>');
    for (const p of withHelp) {
      const actual = signatures[p].help.map((h) => `${h.region || '?'}:${helpKey(h)}`);
      const keyOf = (x) => x.slice(x.indexOf(':') + 1);
      const expKeys = expected.map(keyOf);
      const shared = actual.filter((x) => expKeys.includes(keyOf(x)));
      const expectedShared = expected.filter((x) => actual.map(keyOf).includes(keyOf(x)));
      if (shared.join('>') !== expectedShared.join('>')) {
        add(p, 'violations', result('con-help-missing',
          'Help mechanism is in a different place or order than on other pages', 'moderate',
          ['cat.semantics', 'wcag22a', 'wcag326'],
          [node('moderate', '', 'body',
            `This page places its help as [${shared.join(', ')}] while ${common.count} other pages use [${expectedShared.join(', ')}]. When help is repeated across pages, it must stay in the same relative order.`)]));
      } else {
        add(p, 'passes', result('con-help-missing',
          'Help mechanism consistent with other pages', null, ['wcag22a', 'wcag326'], []));
      }
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
  if (ways.length >= 2) {
    for (const p of pages) {
      add(p, 'passes', result('con-multiple-ways',
        `Multiple ways to locate pages (${ways.join(', ')})`, null, ['wcag2aa', 'wcag245'], []));
    }
  } else {
    // The second way may live on a page the scan never visited (an A–Z
    // index, a sitemap page, a footer link rendered later) — review, once.
    add(pages[0], 'incomplete', result('con-multiple-ways',
      'Only one way to locate pages was found across the scanned pages', 'moderate',
      ['cat.semantics', 'wcag2aa', 'wcag245'],
      [node('moderate', '', 'body',
        `Across ${pages.length} scanned pages the only way found to locate content is ${ways[0] || 'none'}. Check whether the site offers a second way (site search, sitemap, A–Z index, breadcrumbs, related links); if not, add one.`)]));
  }

  return out;
}

module.exports = { collectSignature, evaluateConsistency, signatureProbe };
