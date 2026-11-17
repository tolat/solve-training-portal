/**
 * Solve-U — the phone's navigation bar (window.SolveNav)
 *
 * On a phone the header collapses from two rows to one: the SOLVE-U mark on the
 * left, Back (when there is somewhere to go back to) and a menu button on the
 * right. Everything the second row used to carry — the onboarding stage, the
 * profile, Sign Out — plus Sync now, which used to sit on the main page, moves
 * into a drawer that slides in from the right.
 *
 * Desktop is untouched: every rule here is inside a `max-width: 600px` query.
 *
 * ── Why the styles are injected from here ──
 *
 * The service worker serves `css/styles.css` **cache-first**, so on the first
 * load after a deploy the new JS runs against the previous stylesheet. JS files
 * are network-first and arrive immediately. Anything whose markup and styling
 * ship together therefore has to carry its own CSS, or it renders unstyled
 * until the worker catches up — which is exactly what happened to the "courses
 * due" chip the day before this was written. `net.js`, `tour.js` and
 * `certificates.js` all do the same.
 *
 * ── Why it reads the header rather than holding its own state ──
 *
 * The stage and the last-synced time are already maintained by `app.js` in
 * `#headerStage` and `#syncBarRolesText`. The drawer copies them when it opens,
 * so there is nothing to keep in step and no way for the two to disagree.
 */
(function () {
  'use strict';

  var STYLE_ID = 'solve-nav-styles';
  var MOBILE   = '(max-width: 600px)';

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = [
      // The chip on the role cards. It lives here rather than in styles.css for
      // the cache-first reason above: its markup changed in the same deploy.
      '.role-card-due{font-size:11px;color:var(--warning);margin-top:6px;font-weight:600;display:flex;align-items:center;gap:5px;}',
      '.role-card-due svg{flex:0 0 auto;}',

      '.nav-burger{display:none;width:38px;height:38px;align-items:center;justify-content:center;padding:0;border-radius:8px;background:rgba(78,202,90,.1);border:1px solid rgba(78,202,90,.25);color:var(--green,#4eca5a);cursor:pointer;appearance:none;-webkit-appearance:none;flex:0 0 auto;}',
      '.nav-burger:active{background:rgba(78,202,90,.22);}',

      '#navDrawerBack{position:fixed;inset:0;z-index:10090;background:rgba(6,14,8,.55);opacity:0;transition:opacity .22s ease;}',
      '#navDrawerBack.in{opacity:1;}',
      '#navDrawer{position:fixed;top:0;right:0;bottom:0;z-index:10091;width:min(82vw,320px);background:#0b1a0e;color:#fff;',
        'box-shadow:-10px 0 40px rgba(0,0,0,.5);transform:translateX(100%);transition:transform .24s cubic-bezier(.2,.7,.3,1);',
        'display:flex;flex-direction:column;padding:calc(14px + env(safe-area-inset-top)) 0 calc(14px + env(safe-area-inset-bottom));overscroll-behavior:contain;}',
      '#navDrawer.in{transform:translateX(0);}',
      '#navDrawer .nav-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:4px 16px 14px;border-bottom:1px solid rgba(78,202,90,.16);}',
      '#navDrawer .nav-who{min-width:0;}',
      '#navDrawer .nav-name{font:700 15px -apple-system,"Segoe UI",sans-serif;margin-bottom:8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '#navDrawer .nav-stage{display:inline-block;font:700 11px -apple-system,"Segoe UI",sans-serif;text-transform:uppercase;letter-spacing:.5px;',
        'padding:4px 10px;border-radius:20px;background:rgba(78,202,90,.15);color:var(--green,#4eca5a);border:1px solid rgba(78,202,90,.3);}',
      '#navDrawer .nav-close{flex:0 0 auto;width:32px;height:32px;border-radius:8px;background:transparent;border:0;color:rgba(255,255,255,.65);font-size:22px;line-height:1;cursor:pointer;}',
      '#navDrawer .nav-items{padding:10px 10px 0;display:flex;flex-direction:column;gap:2px;}',
      '#navDrawer .nav-item{display:flex;align-items:center;gap:12px;width:100%;padding:13px 12px;border:0;border-radius:10px;background:transparent;',
        'color:#fff;font:600 15px -apple-system,"Segoe UI",sans-serif;text-align:left;cursor:pointer;appearance:none;-webkit-appearance:none;}',
      '#navDrawer .nav-item:active{background:rgba(78,202,90,.14);}',
      '#navDrawer .nav-item svg{flex:0 0 auto;opacity:.8;}',
      '#navDrawer .nav-item.danger{color:#ff9a8f;}',
      '#navDrawer .nav-synced{margin-top:auto;padding:14px 22px 2px;font:500 12px -apple-system,"Segoe UI",sans-serif;color:rgba(255,255,255,.45);}',

      // ── The single-row header, phones only ──
      '@media ' + MOBILE + '{',
      '  #appHeader{flex-direction:row;align-items:center;}',
      '  .header-main{height:56px;padding:0 14px;flex:1;min-width:0;}',
      '  .header-controls{height:56px;padding:0 12px 0 0;border-top:none;background:none;gap:8px;justify-content:flex-end;}',
      // These three are shown by app.js with an inline style, so overriding
      // them needs !important. They all moved into the drawer.
      '  #headerProfileBtn{display:none !important;}',
      '  .header-controls .header-stage{display:none !important;}',
      '  .header-controls #btnLogout{display:none !important;}',
      '  #syncBarRoles{display:none !important;}',
      '  .nav-burger{display:inline-flex;}',
      '  .header-back{height:34px;}',
      '}',
    ].join('\n');
    document.head.appendChild(el);
  }

  var ICON = {
    burger: '<svg viewBox="0 0 22 22" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h16M3 11h16M3 16h16"/></svg>',
    person: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>',
    sync:   '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/></svg>',
    out:    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 20H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5"/><path d="M16 16l4-4-4-4M20 12H10"/></svg>',
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function text(id) {
    var el = document.getElementById(id);
    return el ? (el.textContent || '').trim() : '';
  }

  // ── Open / close ────────────────────────────────────────────

  function close() {
    var d = document.getElementById('navDrawer');
    var b = document.getElementById('navDrawerBack');
    if (d) { d.classList.remove('in'); }
    if (b) { b.classList.remove('in'); }
    document.removeEventListener('keydown', onKey);
    // Let the slide finish before it leaves the page.
    setTimeout(function () {
      if (d && !d.classList.contains('in')) d.remove();
      if (b && !b.classList.contains('in')) b.remove();
    }, 260);
    var burger = document.querySelector('.nav-burger');
    if (burger) burger.setAttribute('aria-expanded', 'false');
  }

  function onKey(e) { if (e.key === 'Escape') close(); }

  function open() {
    injectStyles();
    if (document.getElementById('navDrawer')) return;

    var back = document.createElement('div');
    back.id = 'navDrawerBack';
    back.addEventListener('click', close);

    var d = document.createElement('div');
    d.id = 'navDrawer';
    d.setAttribute('role', 'dialog');
    d.setAttribute('aria-modal', 'true');
    d.setAttribute('aria-label', 'Menu');

    // The stage and the last-synced line are read from the header and the sync
    // bar rather than kept here, so they cannot drift out of step.
    var stage  = text('headerStage');
    var synced = text('syncBarRolesText');

    d.innerHTML =
      '<div class="nav-head">' +
        '<div class="nav-who">' +
          '<div class="nav-name">' + esc(text('headerUser') || 'Signed in') + '</div>' +
          (stage ? '<span class="nav-stage">' + esc(stage) + '</span>' : '') +
        '</div>' +
        '<button type="button" class="nav-close" aria-label="Close menu">&times;</button>' +
      '</div>' +
      '<div class="nav-items">' +
        '<button type="button" class="nav-item" data-nav="profile">' + ICON.person + 'Profile</button>' +
        '<button type="button" class="nav-item" data-nav="sync">'    + ICON.sync   + 'Sync now</button>' +
        '<button type="button" class="nav-item danger" data-nav="out">' + ICON.out + 'Sign out</button>' +
      '</div>' +
      (synced ? '<div class="nav-synced">' + esc(synced) + '</div>' : '');

    d.addEventListener('click', function (e) {
      if (e.target.closest('.nav-close')) return close();
      var item = e.target.closest('[data-nav]');
      if (!item) return;
      var act = item.dataset.nav;
      close();
      // Resolved at click time: app.js defines these and may load after us.
      if (act === 'profile' && typeof showProfile === 'function') showProfile();
      if (act === 'sync'    && typeof manualSync  === 'function') manualSync();
      if (act === 'out'     && typeof logout      === 'function') logout();
    });

    document.body.appendChild(back);
    document.body.appendChild(d);
    // One frame before the transition, or it jumps straight to the end state.
    requestAnimationFrame(function () { back.classList.add('in'); d.classList.add('in'); });
    document.addEventListener('keydown', onKey);

    var burger = document.querySelector('.nav-burger');
    if (burger) burger.setAttribute('aria-expanded', 'true');
  }

  // ── The button in the header ────────────────────────────────

  function mount() {
    injectStyles();
    if (document.querySelector('.nav-burger')) return;
    var host = document.querySelector('#appHeader .header-controls');
    if (!host) return;

    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'nav-burger';
    b.setAttribute('aria-label', 'Menu');
    b.setAttribute('aria-expanded', 'false');
    b.innerHTML = ICON.burger;
    b.addEventListener('click', function () {
      document.getElementById('navDrawer') ? close() : open();
    });
    host.appendChild(b);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }

  window.SolveNav = { open: open, close: close, mount: mount };
})();
