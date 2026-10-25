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
  // Media from video hosts and plugin embeds counts as media too — a page
  // with only a YouTube iframe still needs captions (1.2.x) and 1.4.2.
  const VIDEO_HOST = /(^|\.)(youtube\.com|youtube-nocookie\.com|youtu\.be|vimeo\.com|wistia\.(com|net)|fast\.wistia\.net|dailymotion\.com|dai\.ly|loom\.com|vidyard\.com|brightcove\.(net|com)|jwplayer\.com|jwplatform\.com|twitch\.tv|streamable\.com|ted\.com)$|^player\./i;
  const AUDIO_HOST = /(^|\.)(soundcloud\.com|spotify\.com|podbean\.com|anchor\.fm|buzzsprout\.com|simplecast\.com|libsyn\.com)$/i;
  const hostOf = (src) => { try { return new URL(src, location.href).hostname; } catch (e) { return ''; } };
  const frames = Array.from(q('iframe[src],iframe[data-src]'));
  const frameHost = (f) => hostOf(f.getAttribute('src') || f.getAttribute('data-src'));
  const videoFrames = frames.filter((f) => VIDEO_HOST.test(frameHost(f)) || /facebook\.com\/plugins\/video/i.test(f.getAttribute('src') || '')).length;
  const audioFrames = frames.filter((f) => AUDIO_HOST.test(frameHost(f))).length;
  const MEDIA_TYPE = /^(video|audio)\/|shockwave|x-mplayer|quicktime|x-ms-wmv/i;
  const MEDIA_EXT = /\.(mp4|webm|ogv|mov|m4v|avi|wmv|flv|mp3|wav|ogg|oga|m4a|aac|flac|swf)(\?|#|$)/i;
  const embeds = Array.from(q('object,embed')).filter((el) => MEDIA_TYPE.test(el.getAttribute('type') || '')
    || MEDIA_EXT.test(el.getAttribute('data') || el.getAttribute('src') || '')).length;

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
      audio: q('audio').length + audioFrames,
      video: q('video').length + videoFrames + embeds,
      embeddedMedia: videoFrames + audioFrames + embeds,
    },
  };
}

async function pageInventory(page) {
  try { return await page.evaluate(census); }
  catch (e) { return null; }
}

module.exports = { pageInventory };
