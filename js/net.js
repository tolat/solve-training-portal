/* Solve-U — resilient networking (window.SolveNet)
 *
 *  - SolveNet.fetch(): fetch() that waits and retries when the back end hiccups (network error,
 *    429, 502, 503, 504 — the server answers 503 when Notion stayed unavailable after ITS retries),
 *    and waits for the connection to come back when the device is offline.
 *  - A small status banner tells the person what is happening: reconnecting, slow, back online,
 *    or "couldn't reach the system" (the server has already e-mailed the team by then).
 *  - SolveNet.friendlyError(): the message to show for a failed request.
 *
 * Its styles are injected from here (not styles.css) because the service worker serves CSS
 * cache-first, so new JS could otherwise run against stale CSS for a visit (same reason as tour.js).
 */
(function () {
  'use strict';

  const RETRY_WAITS = [2000, 5000, 10000];     // waits between tries → up to 4 tries
  const RETRYABLE   = new Set([429, 502, 503, 504]);
  const SLOW_AFTER  = 8000;                    // "still working…" after this long without an answer
  const OFFLINE_MAX = 120000;                  // wait this long for the connection to return
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ── Banner ─────────────────────────────────────────────────
  let bannerEl = null, hideTimer = null, bannerSeq = 0;

  function ensureBanner() {
    if (bannerEl) return bannerEl;
    const style = document.createElement('style');
    style.textContent = `
      #netBanner { position: fixed; left: 50%; bottom: 72px; transform: translate(-50%, 12px); z-index: 10060;
        max-width: min(560px, calc(100vw - 24px)); box-sizing: border-box; display: flex; align-items: flex-start; gap: 10px;
        padding: 11px 14px; border-radius: 10px; font: 500 13px/1.4 -apple-system, "Segoe UI", Roboto, sans-serif;
        box-shadow: 0 6px 24px rgba(0,0,0,0.28); opacity: 0; pointer-events: none; transition: opacity .25s, transform .25s; }
      #netBanner.show { opacity: 1; transform: translate(-50%, 0); pointer-events: auto; }
      #netBanner.warn  { background: #fff4d6; color: #6b4600; border: 1px solid #f0c36a; }
      #netBanner.info  { background: #e8f0fe; color: #1c3d7a; border: 1px solid #aac4f2; }
      #netBanner.error { background: #fde8e8; color: #8a1c1c; border: 1px solid #f0a3a3; }
      #netBanner.ok    { background: #e3f6e8; color: #1a5c2c; border: 1px solid #98d4a8; }
      #netBanner .nb-msg { flex: 1; }
      #netBanner .nb-x { background: none; border: 0; color: inherit; font-size: 18px; line-height: 1; cursor: pointer; padding: 0 2px; opacity: .6; }
      #netBanner .nb-x:hover { opacity: 1; }
      #netBanner .nb-spin { width: 14px; height: 14px; margin-top: 2px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: nbspin .8s linear infinite; flex: none; }
      @keyframes nbspin { to { transform: rotate(360deg); } }`;
    document.head.appendChild(style);
    bannerEl = document.createElement('div');
    bannerEl.id = 'netBanner';
    bannerEl.setAttribute('role', 'status');
    bannerEl.setAttribute('aria-live', 'polite');
    document.body.appendChild(bannerEl);
    return bannerEl;
  }

  /** kind: warn | info | error | ok. autoHideMs: 0 = stay until replaced/dismissed. Returns a token. */
  function showBanner(kind, text, { autoHideMs = 0, spinner = false, dismissible = true } = {}) {
    const el = ensureBanner();
    clearTimeout(hideTimer);
    const token = ++bannerSeq;
    el.className = kind;
    el.innerHTML = (spinner ? '<span class="nb-spin"></span>' : '') +
      '<span class="nb-msg"></span>' +
      (dismissible ? '<button class="nb-x" aria-label="Dismiss">×</button>' : '');
    el.querySelector('.nb-msg').textContent = text;
    const x = el.querySelector('.nb-x');
    if (x) x.onclick = () => hideBanner(token);
    requestAnimationFrame(() => el.classList.add('show'));
    if (autoHideMs) hideTimer = setTimeout(() => hideBanner(token), autoHideMs);
    return token;
  }
  /** Hide the banner — only if it is still the one identified by token (or no token given). */
  function hideBanner(token) {
    if (!bannerEl || (token && token !== bannerSeq)) return;
    clearTimeout(hideTimer);
    bannerEl.classList.remove('show');
  }

  // ── Retrying fetch ─────────────────────────────────────────
  function waitOnline(maxMs) {
    if (navigator.onLine !== false) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (v) => { window.removeEventListener('online', onOn); clearTimeout(t); resolve(v); };
      const onOn = () => done(true);
      const t = setTimeout(() => done(false), maxMs);
      window.addEventListener('online', onOn);
    });
  }

  function retryAfterMs(res) {
    const v = res && res.headers && res.headers.get('Retry-After');
    const secs = Number(v);
    return Number.isFinite(secs) && secs > 0 ? Math.min(secs * 1000, 30000) : null;
  }

  /**
   * Like fetch(), but waits and retries on a network error or a 429/502/503/504 answer.
   * Returns the final Response (the caller still checks res.ok); throws only if the network
   * stayed unreachable. cfg.quiet = no banners (background work); cfg.waits = custom backoff.
   */
  async function netFetch(path, opts = {}, cfg = {}) {
    const waits = cfg.waits || RETRY_WAITS;
    const tries = waits.length + 1;
    const quiet = !!cfg.quiet;
    let sawProblem = false;

    for (let attempt = 1; ; attempt++) {
      if (navigator.onLine === false) {
        sawProblem = true;
        const tok = quiet ? 0 : showBanner('warn', "You're offline. We'll carry on automatically as soon as your connection is back.", { spinner: true });
        const back = await waitOnline(OFFLINE_MAX);
        if (!back) { if (!quiet) showBanner('error', "Still offline — please check your connection and try again."); throw new Error('offline'); }
        if (tok) hideBanner(tok);
      }

      let res = null, netErr = null, slowTok = 0;
      const slowTimer = quiet ? null : setTimeout(() => {
        slowTok = showBanner('info', 'Still working — the course system is responding slowly…', { spinner: true, dismissible: false });
      }, SLOW_AFTER);
      try { res = await fetch(path, opts); } catch (e) { netErr = e; }
      clearTimeout(slowTimer);
      if (slowTok) hideBanner(slowTok);

      const failed = !!netErr || RETRYABLE.has(res.status);
      if (!failed) {
        if (sawProblem && !quiet) showBanner('ok', 'Back online ✓', { autoHideMs: 2500, dismissible: false });
        return res;
      }
      sawProblem = true;

      if (attempt >= tries) {
        if (!quiet) {
          // 503 + notified: the server already e-mailed the team. Anything else may be the person's own connection.
          const notified = res && (await res.clone().json().then((d) => !!d.notified).catch(() => false));
          showBanner('error', notified
            ? "We couldn't reach the course system. Our team has been notified — please try again in a few minutes."
            : "We couldn't reach the course system. Please check your connection and try again in a moment.",
            { autoHideMs: 15000 });
        }
        if (netErr) throw netErr;
        return res;
      }

      const wait = (res && retryAfterMs(res)) || waits[attempt - 1];
      if (!quiet) showBanner('warn', `Having trouble reaching the course system — trying again (attempt ${attempt + 1} of ${tries})…`, { spinner: true });
      await sleep(wait);
    }
  }

  /** The message to show when a request failed: the server's own words, or a plain-English fallback. */
  function friendlyError(res, data, netErr) {
    if (netErr) return 'Could not reach the course system. Please check your connection and try again.';
    if (data && data.error) return data.error;
    if (res && RETRYABLE.has(res.status)) return 'The course system is temporarily unavailable. Please try again in a few minutes.';
    return `Server error ${res ? res.status : ''}`.trim();
  }

  window.SolveNet = { fetch: netFetch, friendlyError, showBanner, hideBanner };
})();
