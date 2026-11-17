/**
 * Solve-U — issued completion certificates (window.SolveCerts)
 *
 * Two surfaces:
 *   1. The award moment. Finish a module that issues a certificate and a modal
 *      congratulates you and shows it.
 *   2. "My Certificates" on the main page — everything Solve has ever issued
 *      you, newest first.
 *
 * Reads only `Certificates` (what Solve issued), never `Uploads` (what the
 * trainee uploaded as proof). The server keeps them apart; so does this.
 *
 * Those two Notion properties were renamed on 2026-11-17 and the names swapped
 * sides — `Certificates` used to be `Internal Certificates`.
 *
 * Styles are injected from here rather than living in styles.css because the
 * service worker serves CSS cache-first: on the first load after a deploy, new
 * JS would otherwise run against a stale stylesheet and render unstyled.
 */
(function () {
  'use strict';

  var STYLE_ID = 'solve-cert-styles';

  // One fetch serves both the main-page list and the per-block panel. Notion's
  // file URLs are presigned for about an hour, so this is deliberately short-
  // lived: a stale entry hands someone a dead link.
  var CACHE_MS = 15 * 60 * 1000;
  var cache = { at: 0, items: null, inflight: null };

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = [
      '#certAwardOverlay{position:fixed;inset:0;z-index:10080;background:rgba(8,18,10,.72);display:flex;align-items:center;justify-content:center;padding:16px;overscroll-behavior:contain;}',
      '#certAwardOverlay .ca-card{background:#fff;color:#152219;width:100%;max-width:560px;max-height:92vh;overflow:auto;border-radius:16px;box-shadow:0 18px 50px rgba(0,0,0,.35);padding:22px 20px calc(20px + env(safe-area-inset-bottom));box-sizing:border-box;text-align:center;}',
      '#certAwardOverlay .ca-badge{font-size:40px;line-height:1;margin-bottom:8px;}',
      '#certAwardOverlay .ca-title{font:800 20px -apple-system,"Segoe UI",sans-serif;margin:0 0 6px;}',
      '#certAwardOverlay .ca-sub{font:500 14px -apple-system,"Segoe UI",sans-serif;color:rgba(0,0,0,.6);margin:0 0 16px;}',
      '#certAwardOverlay .ca-preview{width:100%;height:min(46vh,380px);border:1px solid rgba(0,0,0,.12);border-radius:10px;background:#f6f7f6;margin-bottom:16px;}',
      '#certAwardOverlay .ca-actions{display:flex;gap:10px;flex-wrap:wrap;justify-content:center;}',
      '#certAwardOverlay .ca-btn{appearance:none;border:0;border-radius:9px;padding:11px 18px;font:700 14px -apple-system,"Segoe UI",sans-serif;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;gap:7px;}',
      '#certAwardOverlay .ca-btn.primary{background:#2a9640;color:#fff;}',
      '#certAwardOverlay .ca-btn.ghost{background:rgba(0,0,0,.06);color:#152219;}',
      '.cert-section{margin-top:28px;}',
      // index.html gives .roles-section-title no bottom margin; "My Courses" gets
      // its gap from the grid below it. Scoped here so only this heading changes.
      '.cert-section .roles-section-title{margin:4px 0 14px;}',
      '.cert-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(265px,1fr));gap:12px;}',
      '.cert-tile{display:flex;align-items:flex-start;gap:11px;padding:13px 14px;border-radius:12px;background:var(--card,#fff);border:1px solid rgba(0,0,0,.09);text-decoration:none;color:inherit;transition:transform .12s ease,box-shadow .12s ease;}',
      '.cert-tile:hover{transform:translateY(-1px);box-shadow:0 6px 18px rgba(0,0,0,.09);}',
      '.cert-tile .ct-icon{font-size:22px;flex:0 0 auto;line-height:1.1;}',
      // A thumbnail of the certificate itself, roughly the height the card had
      // before it was added. Both templates are landscape (1.29 and 1.42), so
      // the box sits between them and the canvas is centred inside it.
      '.cert-tile .ct-thumb{flex:0 0 auto;width:72px;height:52px;border-radius:6px;overflow:hidden;background:#fff;border:1px solid rgba(0,0,0,.12);display:flex;align-items:center;justify-content:center;position:relative;}',
      // Cover, not contain: the canvas fills the frame and the overflow is
      // cropped. Its CSS size is set in drawThumb — a canvas sizes itself from
      // its pixel buffer, so `width:auto` means "twice as big" on a 2x screen,
      // not "fit the box", and object-fit is unreliable on a canvas.
      '.cert-tile .ct-thumb canvas{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);display:block;}',
      // Shown until a page is rendered, and left showing if one never is.
      '.cert-tile .ct-thumb .ct-icon{font-size:20px;}',
      // Spans are inline by default: without display:block the name and date
      // render on one line and run into each other.
      '.cert-tile .ct-body{min-width:0;display:block;}',
      // Certificate titles are patterns ("Certified Warehouse Coordinator"), so they
      // run long. Wrapping beats an ellipsis: a truncated title is unidentifiable.
      '.cert-tile .ct-name{display:block;font:700 13.5px -apple-system,"Segoe UI",sans-serif;line-height:1.3;overflow-wrap:anywhere;}',
      '.cert-tile .ct-date{display:block;font:500 12px -apple-system,"Segoe UI",sans-serif;opacity:.62;margin-top:3px;}',
      '.cert-empty{font:500 13px -apple-system,"Segoe UI",sans-serif;opacity:.6;}',
      '.cert-block-panel{display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;padding:14px 16px;margin-bottom:16px;border-radius:12px;background:rgba(42,150,64,.07);border:1px solid rgba(42,150,64,.22);}',
      '.cert-block-head{display:flex;align-items:center;gap:11px;min-width:0;}',
      '.cert-block-title{display:block;font:700 14px -apple-system,"Segoe UI",sans-serif;}',
      // The award modal's button styles are scoped to #certAwardOverlay, so the
      // panel needs its own or the Download control renders as a bare link.
      '.cert-block-panel .cert-btn{appearance:none;border:0;border-radius:9px;padding:9px 16px;background:#2a9640;color:#fff;font:700 13px -apple-system,"Segoe UI",sans-serif;text-decoration:none;display:inline-flex;align-items:center;gap:6px;flex:0 0 auto;}',
      '.cert-block-panel .cert-btn:hover{background:#217832;}',
    ].join('\n');
    document.head.appendChild(el);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function prettyDate(iso) {
    if (!iso) return '';
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso));
    if (!m) return String(iso);
    // Build from parts, not new Date(iso) — that parses as UTC midnight and
    // renders as the previous day in every North American timezone.
    var MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    return Number(m[3]) + ' ' + MONTHS[Number(m[2]) - 1] + ' ' + m[1];
  }

  /**
   * Should we show the certificate inline?
   *
   * No on iOS, where Safari renders an embedded PDF as a blank frame. No on any
   * narrow screen either: the certificate is landscape A4, and a phone-width
   * frame crops it to an unreadable strip rather than fitting it. Phones get the
   * Download button, which opens it in a proper viewer.
   */
  function canInlinePdf() {
    if (/iPad|iPhone|iPod/.test(navigator.userAgent || '')) return false;
    return (window.innerWidth || 0) >= 700;
  }

  // ─── The award moment ───────────────────────────────────────

  function closeAward() {
    var o = document.getElementById('certAwardOverlay');
    if (o) o.remove();
    document.removeEventListener('keydown', onAwardKey);
  }

  function onAwardKey(e) { if (e.key === 'Escape') closeAward(); }

  /**
   * @param {{name:string, blockName?:string, url?:string}} cert
   */
  function showAward(cert) {
    if (!cert) return;
    injectStyles();
    closeAward();

    var url = cert.url || '';
    var preview = (url && canInlinePdf())
      ? '<iframe class="ca-preview" src="' + esc(url) + '#toolbar=0&navpanes=0" title="Your certificate"></iframe>'
      : '';

    var overlay = document.createElement('div');
    overlay.id = 'certAwardOverlay';
    overlay.innerHTML =
      '<div class="ca-card" role="dialog" aria-modal="true" aria-label="Certificate earned">' +
        '<div class="ca-badge">🏅</div>' +
        '<h2 class="ca-title">Congratulations — you\'ve earned a certificate</h2>' +
        '<p class="ca-sub">' + esc(cert.blockName || 'Course complete') + '</p>' +
        preview +
        '<div class="ca-actions">' +
          (url ? '<a class="ca-btn primary" href="' + esc(url) + '" target="_blank" rel="noopener" download>Download</a>' : '') +
          '<button type="button" class="ca-btn ghost" data-cert-close>Close</button>' +
        '</div>' +
      '</div>';

    overlay.addEventListener('click', function (e) {
      if (e.target === overlay || e.target.hasAttribute('data-cert-close')) closeAward();
    });
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onAwardKey);
  }

  // ─── "My Certificates" on the main page ─────────────────────

  function tile(item) {
    var f = (item.files && item.files[0]) || {};
    var isPdf = /\.pdf(\?|$)/i.test(f.url || '') || /\.pdf$/i.test(f.name || '');
    // The medal stays as the fallback inside the frame: it is what shows while
    // the page renders, and what is left if pdf.js is unavailable or the fetch
    // fails. A card with an empty white box would look broken.
    var thumb = isPdf
      ? '<span class="ct-thumb" data-cert-pdf="' + esc(f.url) + '"><span class="ct-icon">🏅</span></span>'
      : '<span class="ct-icon">🏅</span>';
    return '<a class="cert-tile" href="' + esc(f.url || '#') + '" target="_blank" rel="noopener">' +
             thumb +
             '<span class="ct-body">' +
               '<span class="ct-name">' + esc(item.name || 'Certificate') + '</span>' +
               '<span class="ct-date">' + esc(prettyDate(item.date)) + '</span>' +
             '</span>' +
           '</a>';
  }

  /**
   * Render the section under "My Courses". Hidden entirely when the person has
   * no certificates — an empty "My Certificates" heading reads like something
   * is broken.
   */
  /** Every certificate issued to this person, cached briefly. */
  async function list(force) {
    if (!force && cache.items && Date.now() - cache.at < CACHE_MS) return cache.items;
    if (cache.inflight) return cache.inflight;

    cache.inflight = (async function () {
      try {
        var data  = await apiFetch('/api/my-certificates', 'GET', null, { quiet: true });
        var items = (data && data.certificates) || [];
        cache.items = items;
        cache.at = Date.now();
        return items;
      } finally {
        cache.inflight = null;
      }
    })();
    return cache.inflight;
  }

  /** Drop the cache so the next read reflects a certificate just issued. */
  function invalidate() { cache.items = null; cache.at = 0; }

  /**
   * Show the certificate for one block, beside its training materials.
   * Hides the host entirely when there is none — most blocks never issue one.
   */
  async function renderForBlock(blockId, host) {
    injectStyles();
    if (!host) return;
    host.style.display = 'none';
    host.innerHTML = '';
    if (!blockId) return;

    try {
      var items = await list();
      var item  = items.find(function (c) { return c.blockId === blockId; });
      if (!item) return;
      var f = (item.files && item.files[0]) || {};
      if (!f.url) return;

      host.style.display = '';
      host.innerHTML =
        '<div class="cert-block-panel">' +
          '<div class="cert-block-head">' +
            '<span class="ct-icon">\uD83C\uDFC5</span>' +
            '<span><span class="cert-block-title">Your certificate</span>' +
            '<span class="ct-date">' + esc(prettyDate(item.date)) + '</span></span>' +
          '</div>' +
          '<a class="cert-btn" href="' + esc(f.url) + '" target="_blank" rel="noopener" download>Download</a>' +
        '</div>';
    } catch (err) {
      console.warn('Could not load this block\'s certificate:', err && err.message);
    }
  }

  /**
   * Draw page one of a certificate into its card.
   *
   * Reuses the portal's existing pdf.js setup (`ensurePdfWorker` in app.js),
   * which already renders the Quick Reference Documents thumbnails straight
   * from Notion file URLs — so this needs no proxy, those URLs are fetchable
   * cross-origin.
   *
   * Never throws: a missing thumbnail must not cost someone their certificates
   * list. On failure the medal underneath stays showing, which is also what is
   * visible while the page is being fetched — an empty white frame would read
   * as broken.
   */
  async function drawThumb(frame) {
    if (frame.dataset.certDrawn) return;
    frame.dataset.certDrawn = '1';
    try {
      var pdf  = await pdfjsLib.getDocument(frame.dataset.certPdf).promise;
      var page = await pdf.getPage(1);
      var dpr  = window.devicePixelRatio || 1;
      var base = page.getViewport({ scale: 1 });

      // Cover: the larger of the two ratios, so the page overflows the frame on
      // one axis and is cropped there rather than letterboxed.
      var fw    = frame.clientWidth  || 72;
      var fh    = frame.clientHeight || 52;
      var cover = Math.max(fw / base.width, fh / base.height);
      var view  = page.getViewport({ scale: cover * dpr });

      var canvas = document.createElement('canvas');
      canvas.width  = view.width;                       // the pixel buffer, at dpr
      canvas.height = view.height;
      canvas.style.width  = (base.width  * cover) + 'px';   // ...and its size on the page
      canvas.style.height = (base.height * cover) + 'px';
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: view }).promise;

      // Swapped in only once it has actually drawn, so a half-painted page is
      // never on screen.
      frame.innerHTML = '';
      frame.appendChild(canvas);
    } catch (err) {
      console.warn('Certificate thumbnail failed:', err && err.message);
    }
  }

  /**
   * Draw the thumbnails, but only for cards the person can actually see.
   *
   * An issued certificate is around 1.2 MB — the fonts are embedded whole, see
   * `certificates.js` — and drawing a 72px thumbnail means downloading the
   * whole file. Someone with six certificates on a phone would otherwise pull
   * 7 MB on every visit to the main page, for pictures mostly below the fold.
   * So each one is fetched when its card first comes into view, and once only.
   */
  function renderThumbs(host) {
    var frames = host.querySelectorAll('.ct-thumb[data-cert-pdf]');
    if (!frames.length) return;
    if (typeof ensurePdfWorker !== 'function' || !ensurePdfWorker()) return;

    if (typeof IntersectionObserver !== 'function') {
      Array.prototype.forEach.call(frames, drawThumb);   // old browser: just draw them
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        io.unobserve(e.target);
        drawThumb(e.target);
      });
    }, { rootMargin: '200px' });                         // start just before it scrolls in
    Array.prototype.forEach.call(frames, function (f) { io.observe(f); });
  }

  async function renderSection() {
    injectStyles();

    var host = document.getElementById('certSection');
    if (!host) return;

    try {
      // apiFetch (app.js) sends the sign-in token. A bare fetch sends none, the server answers 401 and
      // the whole section silently never appears. `quiet`: this is background work, no connection banner.
      var items = await list(true);

      if (!items.length) { host.style.display = 'none'; host.innerHTML = ''; return; }

      host.style.display = '';
      host.innerHTML =
        '<h2 class="roles-section-title">My Certificates</h2>' +
        '<div class="cert-grid">' + items.map(tile).join('') + '</div>';
      renderThumbs(host);
    } catch (err) {
      // A certificates list that cannot load must never take the main page with
      // it — the person still has courses to get on with.
      console.warn('Could not load certificates:', err && err.message);
      host.style.display = 'none';
    }
  }

  window.SolveCerts = { showAward: showAward, renderSection: renderSection, closeAward: closeAward,
                        renderForBlock: renderForBlock, list: list, invalidate: invalidate };
})();
