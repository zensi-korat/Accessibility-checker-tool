/**
 * Interaction guard — makes clicking and typing safe against a real database.
 *
 * Modals, drawers and validation messages do not exist in a static DOM, so a
 * read-only scan cannot see them. Reaching them means clicking buttons and
 * typing into fields. The risk is that some of those actions write.
 *
 * ── Why this is enforced at the network layer ──────────────────────────────
 * The obvious approach — "click anything except submit buttons" — does not
 * work on this app. It is ASP.NET WebForms: only 21 of 5,435 button-like
 * elements are type="submit", and any of the other 5,414 can call
 * __doPostBack() from a handler that is invisible in the markup. Classifying
 * controls by their markup is a guess, and on a shared staging database a
 * wrong guess writes real data.
 *
 * So no control is trusted. Every request the page tries to make is inspected,
 * and anything that could mutate is stopped before it leaves the browser. That
 * makes clicking and typing safe by construction rather than by heuristic.
 *
 * ── Why blocked requests are answered 204 and not aborted ──────────────────
 * route.abort() on a form submission kills the document: the tab lands on
 * chrome-error://chromewebdata and every revealed modal, filled field and
 * open drawer is lost, which ruins the scan of that page. HTTP 204 No Content
 * means "there is nothing to navigate to", so the browser keeps the current
 * document and the page survives intact. Verified: after a blocked POST the
 * URL is unchanged and an open drawer is still open.
 *
 * ── Why a blank 204 is not safe for every request ──────────────────────────
 * Confirmed in practice: pressing one shift-template status toggle produced
 * dozens of identical blocked POSTs to the same .asmx endpoint within a single
 * page visit. The guard was not driving the same click repeatedly — the app
 * was. ASP.NET AJAX script services (`*.asmx`) always return JSON wrapped as
 * `{"d": ...}`, which the caller's own success/error handler expects. Fed a
 * blank body, `JSON.parse('')` throws inside the APP's ajax plumbing, lands in
 * its OWN error handler, and that handler retried the identical call — a
 * self-inflicted retry storm caused by the shape of our response, not by the
 * scan. So a request that declares JSON (`.asmx`, or a JSON Content-Type/
 * Accept header) gets a real, parseable empty envelope (`{"d":null}`, 200)
 * instead of a blank 204. The write is still fully blocked either way; only
 * the shape of "nothing happened" changes so the app's own code reads it as
 * a completed no-op rather than a malformed response worth retrying.
 *
 * ── Locked vs unlocked ─────────────────────────────────────────────────────
 * Unlocked (default) the guard blocks writes only, so the scan's own
 * page.goto() and normal page loads work untouched. Locked — during the
 * interaction phase — it additionally blocks destructive-looking GETs and any
 * navigation away from the page being scanned, so a stray click cannot
 * silently move us somewhere else mid-scan.
 *
 * What this CANNOT do: because saves are blocked, the app never reaches states
 * that require a successful write. Step 2+ of a multi-step wizard stays
 * unscanned. Only a disposable database fixes that.
 */

// Verbs that mutate, matched against a GET's path + query. A link like
// /records/delete?id=42 is a write dressed as a read, and those exist.
const DESTRUCTIVE_GET = /\b(delete|remove|destroy|drop|purge|deactivate|disable|archive|void|cancel|approve|reject|publish|send|pay|checkout|logout|signout)\b/i;

// Second layer, defence in depth: never click a control that says it does
// something irreversible, even though the network guard would stop it anyway.
// Belt and braces, because a blocked click still costs a page-state reset.
const DESTRUCTIVE_LABEL = /\b(delete|remove|destroy|erase|purge|deactivate|disable|archive|void|terminate|approve|reject|publish|send|pay|log ?out|sign ?out)\b/i;

/**
 * Installs the guard on a page.
 *
 * ── Tiers ──────────────────────────────────────────────────────────────────
 * Interaction is not one risk level, it is three:
 *   1. client-side only  — open a modal, trigger validation. No network at
 *                          all, so no risk. Always on.
 *   2. read-only server  — search, filter, sort. GET only, no mutation.
 *                          Always on.
 *   3. writes            — save, delete, approve. POST/PUT/PATCH/DELETE.
 *                          OFF, and stays off until someone passes
 *                          allowWrites:true deliberately.
 * Tiers 1 and 2 cover the large majority of real 4.1.3 and 3.3.1 cases, so
 * the default posture buys most of the coverage at none of the risk.
 *
 * @param {import('playwright').Page} page
 * @param {{log?: (msg: string) => void, locked?: boolean, allowWrites?: boolean}} [opts]
 * @returns {Promise<{lock: () => void, unlock: () => void, isLocked: () => boolean,
 *                    blocked: Array<{method: string, url: string, reason: string}>,
 *                    uninstall: () => Promise<void>}>}
 */
async function installGuard(page, opts = {}) {
  const log = opts.log || (() => {});
  const blocked = [];
  let locked = !!opts.locked;
  // Tier 3. Defaults to false and must be turned on explicitly — the whole
  // point of this module is that writes are impossible unless someone chose
  // otherwise on purpose.
  const allowWrites = opts.allowWrites === true;
  if (allowWrites) log('      ⚠ WRITES ENABLED (tier 3) — this scan can modify data');

  // Second layer against a retry storm: if the SAME method+url gets blocked
  // repeatedly in one page visit (the signature of exactly this bug), stop
  // spamming the console after a few and print one rollup line instead. This
  // does not fix the storm — the JSON envelope below does — but a future
  // retry pattern we have not seen yet should not be able to flood the log.
  const seenCounts = new Map();
  const LOG_CAP = 3;

  const block = (route, method, url, reason) => {
    blocked.push({ method, url, reason });
    const key = method + ' ' + url;
    const n = (seenCounts.get(key) || 0) + 1;
    seenCounts.set(key, n);
    if (n <= LOG_CAP) {
      log(`      ⛔ blocked ${method} ${url.slice(0, 120)} (${reason})`);
    } else if (n === LOG_CAP + 1) {
      log(`      ⛔ (further identical blocks of this request are suppressed — see final count)`);
    }
    return route.fulfill(jsonEnvelopeFor(route.request(), url) || { status: 204, body: '' });
  };

  const handler = async (route) => {
    const req = route.request();
    const method = req.method();
    const url = req.url();

    // 1. Anything that is not a GET can write. Blocked regardless of lock
    //    state — this is tier 3, and it is off unless explicitly enabled.
    if (method !== 'GET' && !allowWrites) return block(route, method, url, 'non-GET request');

    // Below here we only police GETs, and only while locked — otherwise the
    // scan's own navigation to a page like /manage/apps/RemoveDuplicates.aspx
    // would be blocked by its own filename.
    if (!locked) return route.continue();

    let parsed;
    try { parsed = new URL(url); } catch { return route.continue(); }

    // 2. A GET whose target reads like a mutation.
    if (DESTRUCTIVE_GET.test(parsed.pathname + parsed.search)) {
      return block(route, method, url, 'destructive-looking GET');
    }

    // 3. Navigation away from the page under test, in the top frame. Keeps the
    //    revealed state (open modal, filled field) intact for the rest of the
    //    checks instead of losing it to a stray link click.
    if (req.isNavigationRequest() && req.frame() === page.mainFrame()) {
      const here = page.url();
      if (stripHash(url) !== stripHash(here)) {
        return block(route, method, url, 'navigation away while locked');
      }
    }

    return route.continue();
  };

  await page.route('**/*', handler);

  return {
    lock() { locked = true; },
    unlock() { locked = false; },
    isLocked: () => locked,
    blocked,
    async uninstall() { await page.unroute('**/*', handler).catch(() => {}); },
  };
}

const stripHash = (u) => String(u).split('#')[0];

/**
 * A blocked request that DECLARES itself JSON must get back something its own
 * parser accepts, or the app's own error handler can retry indefinitely — see
 * the header comment. `.asmx` is ASP.NET AJAX's script-service extension and
 * always uses the `{"d": ...}` envelope regardless of headers, so it is
 * checked by URL shape; everything else is checked by what the request itself
 * declared it sends or accepts.
 */
function jsonEnvelopeFor(req, url) {
  let looksJson = /\.asmx(\/|\?|$)/i.test(url);
  if (!looksJson) {
    try {
      const h = req.headers();
      const accept = (h.accept || '').toLowerCase();
      const ct = (h['content-type'] || '').toLowerCase();
      looksJson = accept.includes('json') || ct.includes('json');
    } catch { /* headers() can throw on a request that has already finished */ }
  }
  if (!looksJson) return null;
  return { status: 200, contentType: 'application/json; charset=utf-8', body: '{"d":null}' };
}

/** True if this control's label suggests an irreversible action. */
function looksDestructive(label) {
  return DESTRUCTIVE_LABEL.test(String(label || ''));
}

module.exports = { installGuard, looksDestructive, jsonEnvelopeFor, DESTRUCTIVE_GET, DESTRUCTIVE_LABEL };
