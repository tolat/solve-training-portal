/**
 * Solve University — first-login welcome + guided tour.
 *
 *   SolveTour.maybeStart()  → shows the welcome screen once per person (per browser)
 *   SolveTour.replay()      → runs the walkthrough again (profile screen button)
 *   SolveTour.abort()       → tears everything down (sign out / session expiry)
 *
 * Works on phones and desktops: the spotlight and tooltip are measured against the
 * live layout, so they follow resizes, rotation and scrolling. Steps whose target is
 * not on screen (for example the header in embedded mode) are skipped quietly.
 *
 * Relies on globals from app.js: currentUser, trainingData, showScreen, renderRoles, goBack.
 */
(function () {
  'use strict';

  // ── Settings ────────────────────────────────────────────────
  const SEEN_PREFIX = 'solveu_tour_seen_v1:';
  const HERO_HOLD_MS = 2800;          // how long the "Welcome…" headline stays before it animates out
  const prefersReducedMotion = () =>
    !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  // ── Helpers ─────────────────────────────────────────────────
  const $  = (sel, root = document) => root.querySelector(sel);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const activeScreen = () => document.querySelector('.screen.active')?.id || null;

  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  }

  async function waitFor(test, timeout = 2500) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try { if (test()) return true; } catch (_) { /* keep waiting */ }
      await sleep(60);
    }
    return false;
  }

  // "Seen" is remembered per person in this browser. null means storage is unavailable
  // (private mode, blocked in an embed): then we never auto-start, to avoid nagging on every load.
  function seenKey() { return SEEN_PREFIX + String(currentUser?.email || '').trim().toLowerCase(); }
  function hasSeen() {
    try { return !!localStorage.getItem(seenKey()); } catch (_) { return null; }
  }
  function markSeen() {
    try { localStorage.setItem(seenKey(), String(Date.now())); } catch (_) { /* ignore */ }
  }

  function firstName() {
    return String(currentUser?.name || '').trim().split(/\s+/)[0] || '';
  }

  // ── Tour steps ──────────────────────────────────────────────
  // Each target is a function returning the element(s) to spotlight (their union is used).
  const firstGoCard = () => {
    const go = $('#rolesGrid .role-card-go');
    return go ? go.closest('.role-card') : null;
  };
  const firstDocsCard = () =>
    [...document.querySelectorAll('#rolesGrid .role-card')].find(c => c.querySelector('.resource-tile')) || null;

  // The row to point at in the course list: the first one still to do, else any unlocked one
  const pickRow = () =>
    $('#moduleList .module-item.overdue') || $('#moduleList .module-item:not(.locked)') || $('#moduleList .module-item');

  const STEPS = [
    {
      id: 'profile', screen: 'roles',
      target: () => [isVisible($('#headerProfileBtn')) ? $('#headerProfileBtn') : $('#inlineProfileBar')],
      title: 'Your profile',
      text: 'Tap your name to see your account: your roles, your onboarding stage, and where to change your password. You can also take this tour again from there.',
    },
    {
      id: 'stage', screen: 'roles',
      target: () => [$('#headerStage')],
      title: 'Your onboarding stage',
      text: 'This is where you are in onboarding. Trainings for later stages stay hidden until you reach them, so your list grows as you progress.',
    },
    {
      id: 'sync', screen: 'roles',
      target: () => [$('#syncBarRoles')],
      title: 'Staying up to date',
      text: 'The portal refreshes itself every 15 minutes. If something has just changed, such as a new training, tap Sync now to pull it in right away.',
    },
    {
      id: 'overall', screen: 'roles',
      target: () => [$('#screenRoles .roles-page-header')],
      title: 'Your overall progress',
      text: 'The total number of modules you have completed across every role you hold.',
    },
    {
      id: 'role', screen: 'roles',
      target: () => { const c = firstGoCard(); return c ? [$('.role-card-head', c), $('.role-card-bar', c)] : []; },
      title: 'One card per role',
      text: 'Each card is a role you hold at Solve. The bar shows how much of that role’s training you have completed, and a red line counts anything overdue.',
    },
    {
      id: 'go', screen: 'roles',
      target: () => { const c = firstGoCard(); return c ? [$('.role-card-go', c)] : []; },
      title: 'Go to courses',
      text: 'This opens the list of trainings for the role. Let’s look inside one.',
    },
    {
      id: 'docs', screen: 'roles',
      available: () => (trainingData?.roles || []).some(r => (r.resources || []).length),
      target: () => {
        const c = firstDocsCard();
        return c ? [$('.role-card-resources .materials-title', c), $('.role-card-resources .resource-tile', c)] : [];
      },
      title: 'Documents',
      text: 'Your role’s handbook, Path and any forms live here. Tap a tile to open it, any time you need to look something up.',
    },
    {
      id: 'course-header', screen: 'course', needsCourse: true,
      target: () => [$('#screenCourse .course-header')],
      title: 'Progress for this role',
      text: 'How many modules this role has and how many you have finished.',
    },
    {
      id: 'course-phase', screen: 'course', needsCourse: true,
      target: () => [$('#moduleList .section-header.stage')],
      title: 'Phases',
      text: 'Trainings are grouped by phase of your onboarding. The badge on the right shows how many in that phase are done.',
    },
    {
      id: 'course-module', screen: 'course', needsCourse: true,
      target: () => [pickRow()],
      title: 'A training',
      text: 'Each row is one training. Tap it to open it: read the material, then take the quiz, upload a document or sign, depending on what it asks for.',
    },
    {
      id: 'course-status', screen: 'course', needsCourse: true,
      target: () => { const row = pickRow(); return row ? [$('.module-status', row)] : []; },
      title: 'What the colours mean',
      text: () => {
        const hasLocked = !!$('#moduleList .module-item.locked');
        return 'Red means it is still to do, either not completed yet or overdue. Green with a tick means it is done.'
          + (hasLocked ? ' A padlock means it unlocks once the trainings before it are finished.' : '');
      },
    },
    {
      id: 'done', screen: 'roles', center: true,
      target: () => [],
      title: 'You’re all set',
      text: 'That is everything you need to get started. Open any role to begin, and you can replay this tour from your profile whenever you like.',
      last: true,
    },
  ];

  // ── State ───────────────────────────────────────────────────
  let welcomeEl = null;
  let layer = null, spot = null, tip = null, arrow = null;
  let list = [];
  let idx = 0;
  let active = false;
  let busy = false;
  let startedFromWelcome = false;
  let rafPending = false;

  // ── Welcome screen ──────────────────────────────────────────
  function buildWelcome() {
    const name = firstName();
    const words = ['Welcome', 'to', 'Solve', 'University' + (name ? ',' : '')];
    const heroWords = words.map((w, i) => `<span class="tw-word" style="--i:${i}">${esc(w)}</span>`).join(' ')
      + (name ? ` <span class="tw-word tw-name" style="--i:${words.length}">${esc(name)}</span>` : '');

    const el = document.createElement('div');
    el.id = 'tourWelcome';
    el.className = 'tour-welcome';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-labelledby', 'tourWelcomeTitle');
    el.innerHTML = `
      <div class="tw-glow" aria-hidden="true"></div>
      <div class="tw-stage tw-hero">
        <img class="tw-logo" src="solve_logo.png?v=3" alt="" style="--i:0">
        <h1 id="tourWelcomeTitle">${heroWords}</h1>
      </div>
      <div class="tw-stage tw-intro" aria-hidden="true">
        <div class="tw-item tw-kicker" style="--i:0">What is this?</div>
        <p class="tw-item tw-copy" style="--i:1">
          Solve University is your home for training at Solve. Each role you hold has its own
          courses: read the material, pass a short quiz, upload or sign what is asked of you,
          and your progress is saved automatically. Your role’s handbook and Path live here
          too, always a tap away.
        </p>
        <p class="tw-item tw-copy tw-copy-sub" style="--i:2">Want a one-minute walkthrough of how it all works?</p>
        <div class="tw-item tw-actions" style="--i:3">
          <button type="button" class="tw-btn tw-btn-primary" id="tourTakeBtn">Take me to the walkthrough</button>
          <button type="button" class="tw-btn tw-btn-ghost" id="tourSkipBtn">Skip for now</button>
        </div>
      </div>`;
    return el;
  }

  async function showWelcome() {
    if (welcomeEl) return;
    welcomeEl = buildWelcome();
    document.body.appendChild(welcomeEl);
    const hero  = $('.tw-hero', welcomeEl);
    const intro = $('.tw-intro', welcomeEl);
    let advanced = false;

    // 1. overlay fades in, headline animates in
    requestAnimationFrame(() => requestAnimationFrame(() => {
      welcomeEl.classList.add('in');
      hero.classList.add('in');
    }));

    // 2. after a beat (or a tap / Enter) the headline animates out and the description comes in
    const advance = async () => {
      if (advanced || !welcomeEl) return;
      advanced = true;
      welcomeEl.removeEventListener('click', onTap);
      hero.classList.remove('in');
      hero.classList.add('out');
      await sleep(prefersReducedMotion() ? 120 : 650);
      if (!welcomeEl) return;
      hero.style.display = 'none';
      intro.removeAttribute('aria-hidden');
      intro.classList.add('in');
      $('#tourTakeBtn', welcomeEl)?.focus({ preventScroll: true });
    };
    const onTap = () => advance();
    welcomeEl.addEventListener('click', onTap);
    welcomeEl._advance = advance;
    welcomeEl._timer = setTimeout(advance, HERO_HOLD_MS + (prefersReducedMotion() ? 0 : 800));

    $('#tourTakeBtn', welcomeEl).addEventListener('click', (e) => { e.stopPropagation(); closeWelcome().then(() => startTour(true)); });
    $('#tourSkipBtn', welcomeEl).addEventListener('click', (e) => {
      e.stopPropagation();
      closeWelcome().then(() => toast('No problem. You can take the tour any time from your profile.'));
    });
  }

  async function closeWelcome() {
    if (!welcomeEl) return;
    markSeen();
    clearTimeout(welcomeEl._timer);
    welcomeEl.classList.remove('in');
    welcomeEl.classList.add('out');
    await sleep(prefersReducedMotion() ? 50 : 520);
    welcomeEl.remove();
    welcomeEl = null;
  }

  function toast(msg) {
    if (typeof showToast === 'function') showToast(msg);
  }

  // ── Spotlight tour ──────────────────────────────────────────
  function buildLayer() {
    layer = document.createElement('div');
    layer.className = 'tour-layer';
    layer.innerHTML = `
      <div class="tour-block"></div>
      <div class="tour-spot" aria-hidden="true"></div>
      <div class="tour-tip" role="dialog" aria-modal="true" aria-labelledby="tourTipTitle" aria-live="polite">
        <div class="tour-arrow" aria-hidden="true"></div>
        <div class="tour-body">
          <div class="tour-progress" aria-hidden="true"></div>
          <h3 class="tour-title" id="tourTipTitle"></h3>
          <p class="tour-text"></p>
          <div class="tour-actions">
            <button type="button" class="tour-btn tour-btn-link" data-act="skip">Skip tour</button>
            <span class="tour-spacer"></span>
            <button type="button" class="tour-btn tour-btn-ghost" data-act="back">Back</button>
            <button type="button" class="tour-btn tour-btn-primary" data-act="next">Next</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(layer);
    spot  = $('.tour-spot', layer);
    tip   = $('.tour-tip', layer);
    arrow = $('.tour-arrow', layer);

    // The page behind must not scroll or react while the tour is open
    const block = $('.tour-block', layer);
    block.addEventListener('wheel', e => e.preventDefault(), { passive: false });
    block.addEventListener('touchmove', e => e.preventDefault(), { passive: false });
    layer.addEventListener('click', onLayerClick);
    window.addEventListener('resize', schedulePosition);
    window.addEventListener('orientationchange', schedulePosition);
    window.addEventListener('scroll', schedulePosition, true);
    document.addEventListener('keydown', onKey, true);
  }

  function destroyLayer() {
    window.removeEventListener('resize', schedulePosition);
    window.removeEventListener('orientationchange', schedulePosition);
    window.removeEventListener('scroll', schedulePosition, true);
    document.removeEventListener('keydown', onKey, true);
    layer?.remove();
    layer = spot = tip = arrow = null;
  }

  function onLayerClick(e) {
    const btn = e.target.closest('[data-act]');
    if (!btn || busy) return;
    const act = btn.dataset.act;
    if (act === 'next') go(1);
    else if (act === 'back') go(-1);
    else if (act === 'skip') finish(false);
  }

  function onKey(e) {
    if (!active) return;
    if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    else if (e.key === 'ArrowRight' || e.key === 'Enter') { if (document.activeElement?.dataset?.act !== 'skip' && document.activeElement?.dataset?.act !== 'back') { e.preventDefault(); if (!busy) go(1); } }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); if (!busy) go(-1); }
  }

  const resolveTargets = (step) => (step.target ? step.target() : []).filter(isVisible);

  function unionRect(els) {
    let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
    els.forEach(el => {
      const q = el.getBoundingClientRect();
      l = Math.min(l, q.left); t = Math.min(t, q.top); r = Math.max(r, q.right); b = Math.max(b, q.bottom);
    });
    return { left: l, top: t, right: r, bottom: b, width: r - l, height: b - t };
  }

  async function ensureScreen(step) {
    if (step.screen === 'roles' && activeScreen() !== 'screenRoles') {
      if (activeScreen() === 'screenCourse' && typeof goBack === 'function') goBack();
      else { document.getElementById('headerBack').style.display = 'none'; renderRoles(); showScreen('screenRoles'); }
      await waitFor(() => activeScreen() === 'screenRoles');
      await sleep(250);
    }
    if (step.screen === 'course' && activeScreen() !== 'screenCourse') {
      if (activeScreen() !== 'screenRoles') {
        document.getElementById('headerBack').style.display = 'none';
        renderRoles(); showScreen('screenRoles');
        await waitFor(() => activeScreen() === 'screenRoles');
      }
      const goBtn = $('#rolesGrid .role-card-go');
      if (goBtn) goBtn.click();
      await waitFor(() => activeScreen() === 'screenCourse' && $('#moduleList .module-item'), 3000);
      await sleep(250);
    }
  }

  function stepAvailable(step) {
    if (step.needsCourse && !$('#rolesGrid .role-card-go') && activeScreen() !== 'screenCourse') return false;
    if (typeof step.available === 'function' && !step.available()) return false;
    if (step.screen === 'roles' && step.target && !step.center) {
      // Roles-screen targets can be checked up front (the course ones only exist after we open it)
      if (activeScreen() === 'screenRoles' && !resolveTargets(step).length && step.id !== 'docs') return false;
    }
    return true;
  }

  function renderProgress() {
    const total = list.length;
    $('.tour-progress', tip).innerHTML = list.map((_, i) =>
      `<span class="tour-dot${i === idx ? ' on' : i < idx ? ' done' : ''}"></span>`).join('');
    $('[data-act="back"]', tip).style.visibility = idx === 0 ? 'hidden' : 'visible';
    const next = $('[data-act="next"]', tip);
    next.textContent = list[idx].last ? 'Finish' : 'Next';
    $('[data-act="skip"]', tip).style.visibility = list[idx].last ? 'hidden' : 'visible';
    return total;
  }

  async function show(i, dir) {
    busy = true;
    idx = i;
    // Walk past steps whose target is missing (in the direction we are travelling)
    for (;;) {
      if (idx < 0) { idx = 0; dir = 1; }
      if (idx >= list.length) { busy = false; return finish(true); }
      const step = list[idx];
      await ensureScreen(step);
      if (step.center || resolveTargets(step).length) break;
      idx += dir || 1;
    }
    const step = list[idx];

    // Fade the old text out, then bring the target on screen and measure
    tip.classList.add('swap');
    const els = resolveTargets(step);
    if (els.length) {
      const q = unionRect(els);
      const vh = window.innerHeight;
      if (q.top < 70 || q.bottom > vh - 20) {
        window.scrollBy({ top: (q.top + q.height / 2) - vh / 2, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
        await sleep(prefersReducedMotion() ? 60 : 420);
      }
    }
    $('.tour-title', tip).textContent = step.title;
    $('.tour-text', tip).textContent = typeof step.text === 'function' ? step.text() : step.text;
    renderProgress();
    position(true);
    tip.classList.remove('swap');
    layer.classList.add('show');
    $('[data-act="next"]', tip)?.focus({ preventScroll: true });
    busy = false;
  }

  function go(dir) {
    if (busy) return;
    const step = list[idx];
    if (dir > 0 && step.last) return finish(true);
    show(idx + dir, dir);
  }

  function schedulePosition() {
    if (rafPending || !active) return;
    rafPending = true;
    setTimeout(() => { rafPending = false; position(false); }, 30);
  }

  function position() {
    if (!active || !layer || !tip) return;
    if (!document.body.classList.contains('logged-in')) { abort(); return; }   // signed out underneath us
    const step = list[idx];
    if (!step) return;
    const vw = window.innerWidth, vh = window.innerHeight;
    const margin = 12, gap = 14, pad = 8;
    const els = step.center ? [] : resolveTargets(step);

    tip.style.width = Math.min(360, vw - margin * 2) + 'px';
    const tipH = tip.offsetHeight, tipW = tip.offsetWidth;

    if (!els.length) {
      // No target (final step, or it vanished): dim everything and centre the card
      spot.style.cssText = `left:${vw / 2}px;top:${vh / 2}px;width:0;height:0;opacity:0`;
      arrow.style.display = 'none';
      tip.style.left = Math.max(margin, (vw - tipW) / 2) + 'px';
      tip.style.top  = Math.max(margin, (vh - tipH) / 2) + 'px';
      return;
    }

    const q = unionRect(els);
    const sl = q.left - pad, st = q.top - pad, sw = q.width + pad * 2, sh = q.height + pad * 2;
    spot.style.cssText = `left:${sl}px;top:${st}px;width:${sw}px;height:${sh}px;opacity:1`;

    // Prefer below the target, then above; if neither fits, overlay on the roomier side
    const below = vh - (st + sh) - gap - margin;
    const above = st - gap - margin;
    let place = 'below';
    if (tipH > below && tipH <= above) place = 'above';
    else if (tipH > below && tipH > above) place = below >= above ? 'below' : 'above';

    let top = place === 'below' ? st + sh + gap : st - gap - tipH;
    top = Math.max(margin, Math.min(top, vh - tipH - margin));
    let left = q.left + q.width / 2 - tipW / 2;
    left = Math.max(margin, Math.min(left, vw - tipW - margin));
    tip.style.left = left + 'px';
    tip.style.top  = top + 'px';

    // Arrow points at the spotlight; hidden if the card had to overlap it
    const overlaps = !(top + tipH <= st || top >= st + sh);
    if (overlaps) { arrow.style.display = 'none'; return; }
    arrow.style.display = 'block';
    const ax = Math.max(18, Math.min(q.left + q.width / 2 - left - 7, tipW - 32));
    arrow.style.left = ax + 'px';
    arrow.className = 'tour-arrow ' + (top > st ? 'up' : 'down');
  }

  // ── Lifecycle ───────────────────────────────────────────────
  async function startTour(fromWelcome) {
    if (active) return;
    startedFromWelcome = !!fromWelcome;
    active = true;
    markSeen();
    buildLayer();

    // The tour always begins on the main page
    document.getElementById('headerBack').style.display = 'none';
    if (activeScreen() !== 'screenRoles') {
      renderRoles(); showScreen('screenRoles');
      await waitFor(() => activeScreen() === 'screenRoles');
    }
    // Let the document grids finish loading so they can be pointed at
    await waitFor(() => !$('#rolesGrid .materials-loading'), 3000);
    await sleep(200);

    list = STEPS.filter(stepAvailable);
    if (!list.length) return finish(false);
    show(0, 1);
  }

  async function finish(completed) {
    if (!active) return;
    active = false;
    busy = true;
    markSeen();
    if (layer) { layer.classList.remove('show'); layer.classList.add('leaving'); }
    // Put the user back on the main page
    if (activeScreen() === 'screenCourse' && typeof goBack === 'function') goBack();
    await sleep(prefersReducedMotion() ? 40 : 300);
    destroyLayer();
    busy = false;
    window.scrollTo({ top: 0, behavior: 'auto' });
    if (!completed) toast('You can take the tour again any time from your profile.');
  }

  function abort() {
    active = false; busy = false;
    if (welcomeEl) { clearTimeout(welcomeEl._timer); welcomeEl.remove(); welcomeEl = null; }
    destroyLayer();
  }

  // ── Public API ──────────────────────────────────────────────
  function maybeStart() {
    if (active || welcomeEl) return;
    if (!currentUser || !trainingData || !(trainingData.roles || []).length) return;
    if (currentUser.mustChangePassword) return;          // after the forced password change instead
    if (hasSeen() !== false) return;                     // seen already, or storage unavailable
    if (activeScreen() !== 'screenRoles' && activeScreen() !== 'screenProfile') return;
    showWelcome();
  }

  function replay() {
    if (!currentUser || !trainingData) return;
    if (active) return;
    if (welcomeEl) abort();
    startTour(false);
  }

  window.SolveTour = { maybeStart, replay, abort };
})();
