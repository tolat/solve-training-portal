/**
 * Solve-U — issued completion certificates (window.SolveCerts)
 *
 * Two surfaces:
 *   1. The award moment. Finish a module that issues a certificate and a modal
 *      congratulates you and shows it.
 *   2. "My Certificates" on the main page — everything Solve has ever issued
 *      you, newest first.
 *
 * Reads only `Internal Certificates` (what Solve issued), never `Certificates`
 * (what the trainee uploaded as proof). The server keeps them apart; so does this.
 *
 * Styles are injected from here rather than living in styles.css because the
 * service worker serves CSS cache-first: on the first load after a deploy, new
 * JS would otherwise run against a stale stylesheet and render unstyled.
 */
(function () {
  'use strict';

  var STYLE_ID = 'solve-cert-styles';

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
      '.cert-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:12px;}',
      '.cert-tile{display:flex;align-items:center;gap:11px;padding:13px 14px;border-radius:12px;background:var(--card,#fff);border:1px solid rgba(0,0,0,.09);text-decoration:none;color:inherit;transition:transform .12s ease,box-shadow .12s ease;}',
      '.cert-tile:hover{transform:translateY(-1px);box-shadow:0 6px 18px rgba(0,0,0,.09);}',
      '.cert-tile .ct-icon{font-size:22px;flex:0 0 auto;line-height:1;}',
      // Spans are inline by default: without display:block the name and date
      // render on one line and run into each other.
      '.cert-tile .ct-body{min-width:0;display:block;}',
      '.cert-tile .ct-name{display:block;font:700 13.5px -apple-system,"Segoe UI",sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.cert-tile .ct-date{display:block;font:500 12px -apple-system,"Segoe UI",sans-serif;opacity:.62;margin-top:3px;}',
      '.cert-empty{font:500 13px -apple-system,"Segoe UI",sans-serif;opacity:.6;}',
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
        '<p class="ca-sub">' + esc(cert.blockName || 'Training complete') + '</p>' +
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
    return '<a class="cert-tile" href="' + esc(f.url || '#') + '" target="_blank" rel="noopener">' +
             '<span class="ct-icon">🏅</span>' +
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
  async function renderSection() {
    injectStyles();

    var host = document.getElementById('certSection');
    if (!host) return;

    try {
      var fetcher = (window.SolveNet && window.SolveNet.fetch) ? window.SolveNet.fetch : window.fetch;
      var res = await fetcher('/api/my-certificates', { credentials: 'same-origin' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var data  = await res.json();
      var items = (data && data.certificates) || [];

      if (!items.length) { host.style.display = 'none'; host.innerHTML = ''; return; }

      host.style.display = '';
      host.innerHTML =
        '<h2 class="roles-section-title">My Certificates</h2>' +
        '<div class="cert-grid">' + items.map(tile).join('') + '</div>';
    } catch (err) {
      // A certificates list that cannot load must never take the main page with
      // it — the person still has courses to get on with.
      console.warn('Could not load certificates:', err && err.message);
      host.style.display = 'none';
    }
  }

  window.SolveCerts = { showAward: showAward, renderSection: renderSection, closeAward: closeAward };
})();
