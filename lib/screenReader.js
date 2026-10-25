/**
 * SCREEN-READER analysis via the accessibility tree.
 *
 * You can't reliably drive VoiceOver/NVDA from code, but screen readers read
 * from the accessibility tree — so we inspect that: compute each control's
 * accessible name/role the way assistive tech would, and flag what a screen
 * reader would announce badly.
 *
 * Emits axe-shaped results tagged with WCAG criteria:
 *   sr-broken-aria-ref   → 4.1.2 (aria-labelledby/describedby/controls → missing id)
 *   sr-unnamed-control   → 4.1.2 (focusable control a screen reader announces blank)
 *   sr-duplicate-name    → 4.1.2 (many controls with identical names, no context)
 *
 * Also returns a `preview` (heading outline + landmarks + sample announcements)
 * describing what a screen-reader user would perceive on the page.
 */

const HELP_URLS = {
  'sr-broken-aria-ref': 'https://www.w3.org/WAI/WCAG22/Understanding/name-role-value.html',
  'sr-unnamed-control': 'https://www.w3.org/WAI/WCAG22/Understanding/name-role-value.html',
  'sr-duplicate-name': 'https://www.w3.org/WAI/WCAG22/Understanding/name-role-value.html',
};

function result(id, help, impact, tags, nodes) {
  return { id, help, description: help, helpUrl: HELP_URLS[id] || '', impact, tags, nodes };
}
function node(impact, html, sel, failureSummary) {
  return { impact, html: String(html || '').slice(0, 400), target: [sel], failureSummary };
}

// Runs in the browser. Returns raw findings; the Node side turns them into
// axe-shaped results. Fully self-contained.
function analyzeTree() {
  const all = Array.prototype.slice.call(document.querySelectorAll('*'));
  // Unique selector. tag.class is not unique: three different unnamed
  // `button.icon-btn` collapsed into one finding (and verify re-checked the
  // wrong element). Short readable form when unique, structural path otherwise.
  const esc = (v) => (window.CSS && CSS.escape ? CSS.escape(v) : v);
  const sel = (el) => {
    const tag = el.tagName.toLowerCase();
    if (el.id && document.getElementById(el.id) === el) return tag + '#' + esc(el.id);
    const cls = (n, take) => (typeof n.className === 'string' && n.className.trim())
      ? '.' + n.className.trim().split(/\s+/).slice(0, take).map(esc).join('.') : '';
    const c = cls(el, 2);
    if (c) { try { if (document.querySelectorAll(tag + c).length === 1) return tag + c; } catch (e) { /* ignore */ } }
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentElement) {
      const t = n.tagName.toLowerCase();
      if (n.id && document.getElementById(n.id) === n) { parts.unshift(t + '#' + esc(n.id)); break; }
      let part = t;
      const par = n.parentElement;
      if (par) {
        const sibs = Array.prototype.filter.call(par.children, (ch) => ch.tagName === n.tagName);
        if (sibs.length > 1) part += ':nth-of-type(' + (sibs.indexOf(n) + 1) + ')';
      }
      parts.unshift(part);
    }
    return parts.join(' > ');
  };
  const isVisible = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' &&
      !el.closest('[aria-hidden="true"],[inert]');
  };
  const implicitRole = (el) => {
    const t = el.tagName.toLowerCase();
    if (t === 'a' && el.hasAttribute('href')) return 'link';
    if (t === 'button') return 'button';
    if (t === 'input') {
      const ty = (el.getAttribute('type') || 'text').toLowerCase();
      if (ty === 'checkbox') return 'checkbox';
      if (ty === 'radio') return 'radio';
      if (ty === 'button' || ty === 'submit' || ty === 'reset' || ty === 'image') return 'button';
      return 'textbox';
    }
    if (t === 'select') return 'combobox';
    if (t === 'textarea') return 'textbox';
    return t;
  };
  const role = (el) => el.getAttribute('role') || implicitRole(el);
  const accName = (el) => {
    const lb = el.getAttribute('aria-labelledby');
    if (lb) {
      // Hidden targets still name the control (innerText is '' for them).
      const t = lb.split(/\s+/).map((id) => { const n = document.getElementById(id); return n ? (n.innerText || n.textContent || '') : ''; }).join(' ').trim();
      if (t) return t;
    }
    const al = el.getAttribute('aria-label');
    if (al && al.trim()) return al.trim();
    const tag = el.tagName;
    if (tag === 'INPUT') {
      // <input type=submit value="Save"> (what asp:Button renders) is named by
      // its value; submit/reset have a browser default label; image by alt.
      const ty = (el.getAttribute('type') || 'text').toLowerCase();
      if (ty === 'submit' || ty === 'reset' || ty === 'button') {
        const v = (el.getAttribute('value') || '').trim();
        if (v) return v;
        if (ty === 'submit') return 'Submit';
        if (ty === 'reset') return 'Reset';
      }
      if (ty === 'image') {
        const a = (el.getAttribute('alt') || el.getAttribute('value') || '').trim();
        if (a) return a;
      }
    }
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
      if (el.id) {
        try { const lab = document.querySelector('label[for="' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id) + '"]'); if (lab && lab.innerText.trim()) return lab.innerText.trim(); } catch (e) {}
      }
      const wrap = el.closest && el.closest('label');
      if (wrap && wrap.innerText.trim()) return wrap.innerText.trim();
      if (el.labels && el.labels.length) {
        const t = Array.prototype.map.call(el.labels, (l) => l.textContent || '').join(' ').trim();
        if (t) return t;
      }
      const ph = (el.getAttribute('placeholder') || '').trim();
      if (ph) return ph;
    }
    if (tag === 'IMG') { const a = el.getAttribute('alt'); if (a != null) return a.trim(); }
    const txt = (el.innerText || el.textContent || '').trim();
    if (txt) return txt.slice(0, 60);
    // A control whose only content is an image/icon is named by that child's
    // alt / aria-label / title (e.g. <a><img alt="Home"></a>).
    if (el.querySelector) {
      const child = el.querySelector('img[alt]:not([alt=""]), [aria-label]:not([aria-label=""]), [title]:not([title=""])');
      if (child) {
        const cn = (child.getAttribute('alt') || child.getAttribute('aria-label') || child.getAttribute('title') || '').trim();
        if (cn) return cn;
      }
      // <svg><title>Close</title></svg> names the svg (and so the control).
      const st = el.querySelector('svg > title');
      if (st && st.textContent.trim() && !st.parentElement.closest('[aria-hidden="true"]')) return st.textContent.trim();
    }
    const ti = el.getAttribute('title');
    if (ti && ti.trim()) return ti.trim();
    return '';
  };

  // 1) Broken ARIA references. Split by impact:
  //    name/description refs (labelledby/describedby/details) → hard problem: a
  //      screen reader gets no name/description at all.
  //    relationship refs (controls/owns) → softer: often point at a panel that
  //      is lazily mounted (e.g. Radix Tabs), so flag for review, not as a fail.
  const nameRefAttrs = ['aria-labelledby', 'aria-describedby', 'aria-details'];
  const relRefAttrs = ['aria-controls', 'aria-owns'];
  const brokenNameRefs = [];
  const brokenRelRefs = [];
  for (const el of all) {
    if (!el.getAttribute) continue;
    const check = (attr, sink) => {
      const val = el.getAttribute(attr);
      if (!val) return;
      const missing = val.split(/\s+/).filter(Boolean).filter((id) => !document.getElementById(id));
      if (missing.length) sink.push({ html: el.outerHTML.slice(0, 220), sel: sel(el), attr, missing: missing.join(', ') });
    };
    for (const attr of nameRefAttrs) check(attr, brokenNameRefs);
    for (const attr of relRefAttrs) check(attr, brokenRelRefs);
    if (brokenNameRefs.length >= 30 && brokenRelRefs.length >= 30) break;
  }

  // 2) Interactive controls: names, duplicates, unnamed.
  const interactiveSel = 'a[href],button,input:not([type="hidden"]),select,textarea,[role="button"],[role="link"],[role="checkbox"],[role="tab"],[role="menuitem"],[role="option"],[role="switch"],[role="combobox"],[role="radio"]';
  const controls = Array.prototype.slice.call(document.querySelectorAll(interactiveSel)).filter(isVisible);
  const unnamed = [];
  const nameGroups = {};
  for (const el of controls) {
    const nm = accName(el);
    const rl = role(el);
    if (!nm) {
      unnamed.push({ html: el.outerHTML.slice(0, 220), sel: sel(el), role: rl });
    } else {
      const key = rl + '::' + nm.toLowerCase();
      (nameGroups[key] = nameGroups[key] || []).push({ html: el.outerHTML.slice(0, 160), sel: sel(el) });
    }
  }
  const duplicates = Object.keys(nameGroups)
    .map((k) => ({ role: k.split('::')[0], name: k.split('::').slice(1).join('::'), items: nameGroups[k] }))
    .filter((g) => g.items.length >= 3)
    .slice(0, 12);

  // 3) Announcement preview: heading outline + landmarks.
  const headings = Array.prototype.slice.call(document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]'))
    .filter(isVisible).slice(0, 40).map((h) => {
      const m = h.tagName.match(/^H(\d)$/);
      const level = m ? Number(m[1]) : Number(h.getAttribute('aria-level')) || 2;
      return { level, text: (h.innerText || '').trim().slice(0, 80) };
    });
  const landmarkSel = 'main,nav,header,footer,aside,form,section,[role="main"],[role="navigation"],[role="banner"],[role="contentinfo"],[role="complementary"],[role="search"],[role="region"]';
  const landmarks = Array.prototype.slice.call(document.querySelectorAll(landmarkSel))
    .filter(isVisible).slice(0, 30).map((l) => ({ role: role(l), name: accName(l) }));

  return {
    brokenNameRefs: brokenNameRefs.slice(0, 20),
    brokenRelRefs: brokenRelRefs.slice(0, 20),
    unnamed: unnamed.slice(0, 20),
    duplicates,
    preview: { headings, landmarks, controlCount: controls.length },
  };
}

async function screenReaderChecks(page) {
  const out = { violations: [], incomplete: [], passes: [], preview: null };
  let data;
  try { data = await page.evaluate(analyzeTree); } catch (e) { return out; }
  out.preview = data.preview;

  if (data.brokenNameRefs.length) {
    out.violations.push(result('sr-broken-aria-ref',
      'ARIA name/description reference points to an element id that does not exist', 'serious',
      ['cat.aria', 'wcag2a', 'wcag412'],
      data.brokenNameRefs.map((b) => node('serious', b.html, b.sel,
        `${b.attr}="${b.missing}" references an id that is not on the page, so a screen reader gets no name/description. Fix the id or remove the attribute.`))));
  }
  if (data.brokenRelRefs.length) {
    out.incomplete.push(result('sr-broken-aria-relationship',
      'ARIA relationship reference points to an id not currently in the DOM', 'moderate',
      ['cat.aria', 'wcag2a', 'wcag412'],
      data.brokenRelRefs.map((b) => node('moderate', b.html, b.sel,
        `${b.attr}="${b.missing}" targets an element not in the DOM right now. Often fine for lazily-mounted panels (e.g. Radix Tabs), but verify the target exists when the control is used.`))));
  }

  if (data.unnamed.length) {
    out.violations.push(result('sr-unnamed-control',
      'Interactive control has no accessible name (screen reader announces it blank)', 'serious',
      ['cat.name-role-value', 'wcag2a', 'wcag412'],
      data.unnamed.map((u) => node('serious', u.html, u.sel,
        `A screen reader announces this ${u.role} with no name. Add visible text, aria-label, or an associated <label>.`))));
  }

  if (data.duplicates.length) {
    out.incomplete.push(result('sr-duplicate-name',
      'Several controls share the same accessible name with no distinguishing context', 'moderate',
      ['cat.name-role-value', 'wcag2aa', 'wcag412'],
      data.duplicates.map((g) => node('moderate', g.items[0].html, g.items[0].sel,
        `${g.items.length} "${g.name}" ${g.role}s on this page sound identical to a screen-reader user. Add context (e.g. aria-label "Edit — Invoice #1042").`))));
  }

  return out;
}

module.exports = { screenReaderChecks };
