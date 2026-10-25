/**
 * A raw DOM census, independent of pass/fail — "what accessibility-relevant
 * material exists on this page" (mirrors EqualWeb's "Detected on page" +
 * "Content elements crawled" panels). Not a check; just an inventory.
 *
 * Captured once per page, on its initial/base state (not on every revealed
 * modal, so counts describe the page a user first lands on).
 */

// Runs in the browser. Self-contained (page.evaluate serializes it).
function census() {
  const q = (s) => document.querySelectorAll(s);
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const isPdf = (href) => /\.pdf(\?|#|$)/i.test(href || '');

  const images = Array.from(q('img'));
  const links = Array.from(q('a[href]'));

  return {
    detected: {
      roleAttributes: q('[role]').length,
      ariaAttributes: q('[aria-label],[aria-labelledby],[aria-describedby],[aria-hidden],[aria-expanded],[aria-live],[aria-controls],[aria-current],[aria-invalid],[aria-required],[aria-checked],[aria-selected],[aria-haspopup],[aria-owns],[aria-details],[aria-pressed],[aria-valuemin],[aria-valuemax],[aria-valuenow]').length,
      accessKeys: q('[accesskey]').length,
      headings: q('h1,h2,h3,h4,h5,h6,[role="heading"]').length,
      fieldsWithoutLabel: Array.from(q('input:not([type="hidden"]),select,textarea')).filter((el) => {
        if (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby')) return false;
        if (el.id) {
          try { if (document.querySelector(`label[for="${(window.CSS && CSS.escape) ? CSS.escape(el.id) : el.id}"]`)) return false; } catch (e) { /* ignore */ }
        }
        if (el.closest && el.closest('label')) return false;
        return true;
      }).length,
      altlessImages: images.filter((img) => !img.hasAttribute('alt')).length,
    },
    crawled: {
      iframes: q('iframe').length,
      images: images.length,
      pdfs: links.filter((a) => isPdf(a.getAttribute('href'))).length,
      links: links.length,
      audio: q('audio').length,
      video: q('video').length,
    },
  };
}

async function pageInventory(page) {
  try { return await page.evaluate(census); }
  catch (e) { return null; }
}

module.exports = { pageInventory };
