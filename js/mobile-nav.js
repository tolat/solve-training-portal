/**
 * Solve-U — the phone's navigation bar (window.SolveNav)
 *
 * It also carries the handful of other phone-only layout rules, for the same
 * cache-first reason below: a rule added to `css/styles.css` is missing on the
 * first load after a deploy, and that is the load people notice.
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
 * The bottom bar mirrors state `app.js` already keeps (`#headerBack`, `#headerSyncBtn`,
 * the active screen) instead of holding its own, so the two cannot disagree.
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

      '.nav-burger{display:none;width:40px;height:40px;align-items:center;justify-content:center;padding:0;border-radius:999px;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.16);color:#7fe38a;cursor:pointer;appearance:none;-webkit-appearance:none;flex:0 0 auto;transition:background .18s,border-color .18s;}',
      '.nav-burger:active,.nav-burger[aria-expanded="true"]{background:rgba(255,255,255,.14);border-color:rgba(255,255,255,.3);}',

      '#navDrawerBack{position:fixed;inset:0;z-index:10090;background:rgba(6,14,8,.6);backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);opacity:0;transition:opacity .22s ease;}',
      '#navDrawerBack.in{opacity:1;}',
      '#navDrawer{position:fixed;top:0;right:0;bottom:0;z-index:10091;width:min(82vw,320px);background:linear-gradient(180deg,#10261a 0%,#0a190e 100%);color:#fff;border-radius:22px 0 0 22px;border-left:1px solid rgba(78,202,90,.2);',
        'box-shadow:-10px 0 40px rgba(0,0,0,.5);transform:translateX(100%);transition:transform .24s cubic-bezier(.2,.7,.3,1);',
        'display:flex;flex-direction:column;padding:calc(14px + env(safe-area-inset-top)) 0 calc(14px + env(safe-area-inset-bottom));overscroll-behavior:contain;}',
      '#navDrawer.in{transform:translateX(0);}',
      '#navDrawer .nav-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:4px 16px 16px;border-bottom:1px solid rgba(255,255,255,.08);}',
      '#navDrawer .nav-person{display:flex;align-items:center;gap:12px;min-width:0;}',
      '#navDrawer .nav-avatar{flex:0 0 auto;width:44px;height:44px;border-radius:50%;display:flex;align-items:center;justify-content:center;',
        'background:linear-gradient(100deg,#3aae4a,#5ad768);color:#0b1a0e;font:800 18px -apple-system,"Segoe UI",sans-serif;box-shadow:0 2px 8px rgba(40,160,60,.35);}',
      '#navDrawer .nav-who{min-width:0;}',
      '#navDrawer .nav-name{font:700 15px -apple-system,"Segoe UI",sans-serif;margin-bottom:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '#navDrawer .nav-stage{display:inline-flex;align-items:center;gap:7px;font:700 11px -apple-system,"Segoe UI",sans-serif;text-transform:uppercase;letter-spacing:.6px;',
        'padding:4px 11px 4px 9px;border-radius:999px;background:rgba(78,202,90,.10);color:#7fe38a;border:1px solid rgba(78,202,90,.28);}',
      '#navDrawer .nav-stage:before{content:"";width:6px;height:6px;border-radius:50%;background:#5ad768;box-shadow:0 0 0 3px rgba(90,215,104,.18),0 0 7px rgba(90,215,104,.6);}',
      '#navDrawer .nav-close{flex:0 0 auto;width:34px;height:34px;border-radius:50%;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.14);color:rgba(255,255,255,.75);font-size:20px;line-height:1;cursor:pointer;}',
      '#navDrawer .nav-items{padding:14px 12px 0;display:flex;flex-direction:column;gap:8px;}',
      '#navDrawer .nav-item{display:flex;align-items:center;gap:12px;width:100%;padding:14px 16px;border:1px solid rgba(255,255,255,.12);border-radius:16px;background:rgba(255,255,255,.05);',
        'color:#fff;font:600 15px -apple-system,"Segoe UI",sans-serif;text-align:left;cursor:pointer;appearance:none;-webkit-appearance:none;transition:background .15s,border-color .15s;}',
      '#navDrawer .nav-item:active{background:rgba(78,202,90,.16);border-color:rgba(78,202,90,.4);}',
      '#navDrawer .nav-item svg{flex:0 0 auto;opacity:.9;color:#7fe38a;}',
      '#navDrawer .nav-item.danger{color:#ffb4ab;background:rgba(248,113,113,.07);border-color:rgba(248,113,113,.28);margin-top:6px;}',
      '#navDrawer .nav-item.danger svg{color:#ff9a8f;}',
      '#navDrawer .nav-item.danger:active{background:rgba(248,113,113,.18);}',
      '#navDrawer .nav-synced{margin-top:auto;padding:14px 22px 2px;font:500 12px -apple-system,"Segoe UI",sans-serif;color:rgba(255,255,255,.45);}',

      // ── The single-row header, phones only ──
      '@media ' + MOBILE + '{',
      '  #appHeader{flex-direction:row;align-items:center;background:linear-gradient(180deg,rgba(14,32,18,.95) 0%,rgba(9,22,12,.93) 100%);box-shadow:0 1px 0 rgba(255,255,255,.03) inset,0 4px 18px rgba(0,0,0,.28);}',
      '  .header-main{height:56px;padding:0 14px;flex:1;min-width:0;}',
      '  .header-controls{height:56px;padding:0 12px 0 0;border-top:none;background:none;gap:8px;justify-content:flex-end;}',
      // These three are shown by app.js with an inline style, so overriding
      // them needs !important. They all moved into the drawer.
      '  #headerProfileBtn{display:none !important;}',
      '  .header-controls .header-stage{display:none !important;}',
      '  .header-controls #btnLogout{display:none !important;}',
      '  .nav-burger{display:inline-flex;}',
      '  .header-back{height:36px;padding:0 16px;border-radius:999px;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.16);color:rgba(255,255,255,.92);}',
      '  .header-back:active{background:rgba(255,255,255,.14);}',

      // ── Course rows ──
      // The status sits to the right of the title on a desktop. On a phone that
      // leaves the title a narrow column — "Upload Direct Deposit Information"
      // was wrapping to three lines beside a date — so it drops to its own row
      // under the title, indented past the number badge to line up with it.
      '  .module-item{flex-wrap:wrap;row-gap:5px;padding:12px 14px;}',
      // Keep the base `flex: 1` (basis 0). Giving it `auto` makes the basis the
      // title's own width, and with flex-wrap on, a long title no longer fits
      // beside the badge and drops to the next line — which is what put the
      // number circle on its own row above the locked handbook parts.
      // The toast is `white-space: nowrap`, so a long message ("You can watch the
      // walkthrough again any time...") ran off both edges of a phone.
      '  .toast{white-space:normal;width:max-content;max-width:calc(100vw - 32px);box-sizing:border-box;text-align:center;line-height:1.4;}',
      '  .module-info{min-width:0;}',
      // The indent is part of the row's width: a 100% basis plus a 46px margin
      // is 46px more than the row, which pushed the whole page sideways.
      '  .module-status{flex:1 0 calc(100% - 46px);margin-left:46px;}',   // 32px badge + 14px gap
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
    var synced = '';
    var who    = text('headerUser') || 'Signed in';

    d.innerHTML =
      '<div class="nav-head">' +
        '<div class="nav-person">' +
          '<div class="nav-avatar" aria-hidden="true">' + esc((who.charAt(0) || '?').toUpperCase()) + '</div>' +
          '<div class="nav-who">' +
            '<div class="nav-name">' + esc(who) + '</div>' +
            (stage ? '<span class="nav-stage">' + esc(stage) + '</span>' : '') +
          '</div>' +
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
      if (act === 'out') { if (typeof confirmSignOut === 'function') confirmSignOut(); else if (typeof logout === 'function') logout(); }
    });

    document.body.appendChild(back);
    document.body.appendChild(d);
    // One frame before the transition, or it jumps straight to the end state.
    requestAnimationFrame(function () { back.classList.add('in'); d.classList.add('in'); });
    document.addEventListener('keydown', onKey);

    var burger = document.querySelector('.nav-burger');
    if (burger) burger.setAttribute('aria-expanded', 'true');
  }

  // ── The bottom bar (phones) ─────────────────────────────────
  // Back / Sync / Profile with the wordmark, fixed to the bottom where a thumb reaches. The top header is
  // hidden on phones, so the page's own background runs up under the status bar ("forehead") unbroken.
  var TAB = {
    back:    '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>',
    sync:    ICON.sync.replace('width="18" height="18"', 'width="22" height="22"'),
    profile: ICON.person.replace('width="18" height="18"', 'width="22" height="22"'),
  };

  function injectBarStyles() {
    if (document.getElementById('solve-tabbar-styles')) return;
    var el = document.createElement('style');
    el.id = 'solve-tabbar-styles';
    el.textContent = [
      '#tabBar{display:none;}',
      '@media ' + MOBILE + '{',
      '  #appHeader{display:none !important;}',
      '  body.logged-in #tabBar{display:flex;position:fixed;left:10px;right:10px;bottom:calc(10px + env(safe-area-inset-bottom));z-index:9000;',
      '    align-items:center;gap:2px;padding:6px 8px 6px 14px;border-radius:24px;',
      '    background:linear-gradient(180deg,rgba(16,38,26,.97) 0%,rgba(9,22,12,.97) 100%);border:1px solid rgba(78,202,90,.22);',
      '    box-shadow:0 8px 28px rgba(0,0,0,.28),0 1px 0 rgba(255,255,255,.04) inset;backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);}',
      '  #tabBar .tab-logo{height:22px;width:auto;flex:0 0 auto;margin-right:auto;display:block;}',
      '  #tabBar .tab-btn{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;min-width:62px;height:50px;padding:0 6px;border:0;border-radius:16px;',
      '    background:transparent;color:rgba(255,255,255,.78);font:600 10.5px/1 -apple-system,"Segoe UI",sans-serif;letter-spacing:.2px;cursor:pointer;appearance:none;-webkit-appearance:none;',
      '    -webkit-tap-highlight-color:transparent;transition:background .15s,color .15s,opacity .15s;}',
      '  #tabBar .tab-btn svg{display:block;color:#7fe38a;}',
      '  #tabBar .tab-btn:active{background:rgba(78,202,90,.16);color:#fff;}',
      '  #tabBar .tab-btn[disabled]{opacity:.3;pointer-events:none;}',
      '  #tabBar .tab-btn.on{background:rgba(78,202,90,.14);color:#fff;}',
      '  #tabBar .tab-btn.syncing svg{animation:spin .8s linear infinite;}',
      '  /* content scrolling under the bar fades out gradually instead of being cut off by it */',
      '  body.logged-in::after{content:"";position:fixed;left:0;right:0;bottom:0;height:calc(120px + env(safe-area-inset-bottom));z-index:8990;pointer-events:none;',
      '    background:linear-gradient(to bottom,rgba(242,245,242,0) 0%,rgba(242,245,242,.82) 55%,#f2f5f2 82%);}',
      '  /* room for the bar, and the page starts below the status bar */',
      '  body.logged-in{padding-bottom:calc(86px + env(safe-area-inset-bottom));padding-top:env(safe-area-inset-top);}',
      '  .toast{bottom:calc(96px + env(safe-area-inset-bottom)) !important;}',
      '  #pwaInstallBtn{bottom:calc(96px + env(safe-area-inset-bottom)) !important;}',
      '  .sign-nav{top:calc(env(safe-area-inset-top) + 8px) !important;}',
      '  #btnProfileSignOut{display:flex !important;}',
      '}',
    ].join('\n');
    document.head.appendChild(el);
  }

  function setThemeColor() {
    // The browser paints its own chrome (the "forehead") from this: match the page it sits above.
    var m = document.querySelector('meta[name="theme-color"]');
    if (!m) return;
    m.setAttribute('content', document.body.classList.contains('logged-in') ? '#f2f5f2' : '#0b1a0e');
  }

  function mount() {
    injectStyles();
    injectBarStyles();
    setThemeColor();
    new MutationObserver(setThemeColor).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    if (document.getElementById('tabBar')) return;

    var bar = document.createElement('nav');
    bar.id = 'tabBar';
    bar.setAttribute('aria-label', 'Main');
    bar.innerHTML =
      '<img class="tab-logo" src="solve_logo.png?v=3" alt="Solve University">' +
      '<button type="button" class="tab-btn" id="tabBack"    aria-label="Back">'    + TAB.back    + 'Back</button>' +
      '<button type="button" class="tab-btn" id="tabSync"    aria-label="Sync">'    + TAB.sync    + 'Sync</button>' +
      '<button type="button" class="tab-btn" id="tabProfile" aria-label="Profile">' + TAB.profile + 'Profile</button>';
    document.body.appendChild(bar);

    bar.addEventListener('click', function (e) {
      var b = e.target.closest('.tab-btn');
      if (!b || b.disabled) return;
      if (b.id === 'tabBack'    && typeof goBack     === 'function') goBack();
      if (b.id === 'tabSync'    && typeof manualSync === 'function') manualSync();
      if (b.id === 'tabProfile' && typeof showProfile === 'function') showProfile();
    });

    // Mirror state the app already keeps rather than holding our own: Back is on only when the
    // header's Back is, Sync spins while the header's Sync spins, Profile lights on the profile screen.
    var back = document.getElementById('headerBack'), sync = document.getElementById('headerSyncBtn');
    var tb = document.getElementById('tabBack'), ts = document.getElementById('tabSync'), tp = document.getElementById('tabProfile');
    function refresh() {
      var hasBack = !!back && getComputedStyle(back).display !== 'none';
      tb.disabled = !hasBack;
      if (sync) ts.classList.toggle('syncing', sync.classList.contains('syncing'));
      var prof = document.getElementById('screenProfile');
      tp.classList.toggle('on', !!prof && prof.classList.contains('active'));
    }
    var mo = new MutationObserver(refresh);
    if (back) mo.observe(back, { attributes: true, attributeFilter: ['style'] });
    if (sync) mo.observe(sync, { attributes: true, attributeFilter: ['class'] });
    document.querySelectorAll('.screen').forEach(function (sc) { mo.observe(sc, { attributes: true, attributeFilter: ['class'] }); });
    refresh();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }

  window.SolveNav = { open: open, close: close, mount: mount };
})();
