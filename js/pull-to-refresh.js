/**
 * Solve-U — pull down to refresh, on phones (window.SolvePull)
 *
 * Drag the page past the top and a spinner comes down with your finger; let go
 * past the threshold and it runs the same sync as the Sync now button, which is
 * otherwise two taps away in the menu.
 *
 * ── The feel ──
 *
 * The travel is rubber-banded: `MAX * (1 - e^(-dy/MAX))`, so the first pixels
 * follow the finger almost exactly and it stiffens as it goes, approaching MAX
 * without ever reaching it. A linear drag with a hard stop feels broken by
 * comparison. Releasing short of the threshold springs back with a little
 * overshoot; the indicator is clipped above the viewport, so the overshoot is
 * felt rather than seen.
 *
 * ── Why it has to take over the gesture ──
 *
 * `preventDefault()` on touchmove is what stops the browser doing its own
 * overscroll underneath ours — hence `{ passive: false }`, without which the
 * call is ignored. `overscroll-behavior-y: contain` additionally disables
 * Chrome on Android's built-in pull-to-refresh, which would otherwise reload
 * the whole page and log everyone out, since sessions are in memory.
 *
 * ── When it stays out of the way ──
 *
 * Only on phones, only at the very top of the page, only signed in, and never
 * while something is over the page (the menu, the award modal, the walkthrough)
 * or while signing a document — that screen is canvases and signature pads, and
 * a stolen touchmove there would be worse than no refresh.
 *
 * Styles are injected from here: `css/styles.css` is served cache-first by the
 * service worker, so markup that ships with its own styling has to carry them.
 */
(function () {
  'use strict';

  var STYLE_ID  = 'solve-pull-styles';
  var MAX       = 160;   // the asymptote of the rubber band, px
  var THRESHOLD = 96;    // past this, releasing refreshes — a deliberate stroke
  var RESTING   = 96;    // where the spinner sits while it works
  var TOP_GAP   = 20;    // no top header on phones any more (the nav is at the bottom): just clear the status bar
  var HIDE      = 48;    // parked above the viewport (the disc plus its shadow)

  var startY = 0, dist = 0, tracking = false, armed = false, busy = false;
  var el = null, ring = null;

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = [
      '#solvePull{position:fixed;top:0;left:50%;z-index:10085;width:38px;height:38px;margin-left:-19px;',
        'border-radius:50%;background:#fff;box-shadow:0 4px 14px rgba(0,0,0,.22);',
        'display:none;align-items:center;justify-content:center;pointer-events:none;',
        'transform:translate3d(0,-48px,0);}',
      '#solvePull.on{display:flex;}',
      // Springs back with a touch of overshoot. Only while settling — during the
      // drag the transform has to track the finger with no transition at all.
      '#solvePull.settle{transition:transform .34s cubic-bezier(.2,1.5,.4,1);}',
      '#solvePull svg{display:block;}',
      '#solvePull .pr-ring{transition:opacity .15s ease;}',
      '#solvePull.spin svg{animation:solvePullSpin .7s linear infinite;}',
      '@keyframes solvePullSpin{to{transform:rotate(360deg);}}',
      // Chrome on Android would otherwise run its own pull-to-refresh and
      // reload the page out from under this one.
      '@media (max-width:600px){html,body{overscroll-behavior-y:contain;}}',
    ].join('\n');
    document.head.appendChild(s);
  }

  function build() {
    if (el) return el;
    injectStyles();
    el = document.createElement('div');
    el.id = 'solvePull';
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML =
      '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#2a9640" ' +
      'stroke-width="2.4" stroke-linecap="round">' +
        '<circle class="pr-track" cx="12" cy="12" r="9" stroke="rgba(42,150,64,.18)"/>' +
        '<path class="pr-ring" d="M12 3a9 9 0 0 1 9 9"/>' +
      '</svg>';
    document.body.appendChild(el);
    ring = el.querySelector('.pr-ring');
    return el;
  }

  /**
   * The disc's top edge lands at `y + TOP_GAP - HIDE`, so by the time the pull
   * is anywhere near the threshold it is clear of the header rather than
   * sitting on top of it.
   */
  function place(y, settle) {
    build();
    el.classList.add('on');
    el.classList.toggle('settle', !!settle);
    el.style.transform = 'translate3d(0,' + (y + TOP_GAP - HIDE) + 'px,0)';
  }

  function hide() {
    if (!el) return;
    el.classList.add('settle');
    el.style.transform = 'translate3d(0,-' + HIDE + 'px,0)';
    el.classList.remove('spin');
    setTimeout(function () { if (!tracking && !busy && el) el.classList.remove('on'); }, 360);
  }

  /** Anything over the page, or a screen where stealing the gesture would hurt. */
  function blocked() {
    if (document.getElementById('navDrawer') || document.getElementById('signOutConfirm')) return true;
    if (document.getElementById('certAwardOverlay')) return true;
    if (document.querySelector('.tour-layer.show, .tw-intro.in')) return true;
    if (document.querySelector('#screenSign.active')) return true;
    if (document.getElementById('signPadModal')) return true;     // the phone's sign sheet
    if (document.querySelector('.video-modal-overlay')) return true;
    return false;
  }

  function eligible() {
    if (busy) return false;
    if (!window.matchMedia('(max-width: 600px)').matches) return false;
    if (!document.body.classList.contains('logged-in')) return false;
    if (typeof manualSync !== 'function') return false;
    if ((window.scrollY || document.documentElement.scrollTop || 0) > 0) return false;
    return !blocked();
  }

  function onStart(e) {
    tracking = false; armed = false; dist = 0;
    if (e.touches.length !== 1 || !eligible()) return;
    startY = e.touches[0].clientY;
    tracking = true;
  }

  function onMove(e) {
    if (!tracking || e.touches.length !== 1) return;
    var dy = e.touches[0].clientY - startY;

    // Pulling up, or the page has scrolled under us: hand the gesture back.
    if (dy <= 0 || (window.scrollY || 0) > 0) {
      if (dist > 0) { dist = 0; hide(); }
      tracking = false;
      return;
    }

    e.preventDefault();                       // needs { passive: false }
    dist = MAX * (1 - Math.exp(-dy / MAX));   // rubber band
    armed = dist >= THRESHOLD;
    place(dist, false);
    if (ring) ring.style.opacity = armed ? '1' : String(0.35 + 0.65 * (dist / THRESHOLD));
    if (el) el.style.opacity = String(Math.min(1, dist / 40));
  }

  async function onEnd() {
    if (!tracking) return;
    tracking = false;
    if (!armed || dist <= 0) { if (dist > 0) hide(); dist = 0; return; }

    dist = 0; armed = false; busy = true;
    place(RESTING, true);
    el.classList.add('spin');
    if (ring) ring.style.opacity = '1';

    try {
      await manualSync();            // reports its own success and failure
    } catch (err) {
      console.warn('Pull to refresh: sync failed:', err && err.message);
    } finally {
      busy = false;
      hide();
    }
  }

  function bind() {
    document.addEventListener('touchstart', onStart, { passive: true });
    document.addEventListener('touchmove',  onMove,  { passive: false });
    document.addEventListener('touchend',   onEnd,   { passive: true });
    document.addEventListener('touchcancel', function () {
      tracking = false; armed = false;
      if (dist > 0) { dist = 0; hide(); }
    }, { passive: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { injectStyles(); bind(); });
  } else {
    injectStyles(); bind();
  }

  window.SolvePull = { threshold: THRESHOLD, max: MAX };
})();
