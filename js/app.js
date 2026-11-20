/* Solve Energy Training Portal — Application logic */

const CACHE_KEY   = 'solve_training_cache_v3';
const SESSION_KEY = 'solve_training_token';
const CACHE_TTL   = 24 * 60 * 60 * 1000; // 24 hours

let authToken    = null;
let currentUser  = null;     // { name, email, onboardingStage }
let trainingData = null;     // { blocks, completedMap, syncedAt, userPageId, onboardingStage, roles }
let currentBlocks     = [];
let currentBlockIndex = null;
let currentRoleId     = null;
let materialsTimer    = null;  // auto-refresh signed file URLs every 55 min
let autoSyncTimer     = null;  // background sync every 15 min while app is open

// AI-generated quizzes fetched from /api/quizzes — merged with static QUIZ_MAP
// Keys are block IDs with no dashes, same as QUIZ_MAP
let dynamicQuizzes = {};

// Document signing state
let signaturePads = {};
let currentSigningConfig = null;

// Colour palette — one distinct colour per pipeline stage (cycles if > 8 stages)
const STAGE_PALETTE = [
  { color: '#2563eb', bg: 'rgba(37,99,235,0.09)',   border: 'rgba(37,99,235,0.28)' },  // blue
  { color: '#7c3aed', bg: 'rgba(124,58,237,0.09)',  border: 'rgba(124,58,237,0.28)' }, // purple
  { color: '#2a9640', bg: 'rgba(42,150,64,0.09)',   border: 'rgba(42,150,64,0.28)'  }, // green
  { color: '#d97706', bg: 'rgba(217,119,6,0.09)',   border: 'rgba(217,119,6,0.28)'  }, // amber
  { color: '#0891b2', bg: 'rgba(8,145,178,0.09)',   border: 'rgba(8,145,178,0.28)'  }, // cyan
  { color: '#be185d', bg: 'rgba(190,24,93,0.09)',   border: 'rgba(190,24,93,0.28)'  }, // pink
  { color: '#c62828', bg: 'rgba(198,40,40,0.09)',   border: 'rgba(198,40,40,0.28)'  }, // red
  { color: '#65a30d', bg: 'rgba(101,163,13,0.09)',  border: 'rgba(101,163,13,0.28)' }, // lime
];
// Maps stageOrdering (number) → STAGE_PALETTE entry — populated in renderCourse
let stageOrderingColorMap = {};

// ── API helpers ──────────────────────────────────────────────
// cfg.quiet = no connection banners (used for background work); retries/waiting live in js/net.js
async function apiFetch(path, method = 'GET', body = null, cfg = {}) {
  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${authToken}`,
    },
  };
  if (body) opts.body = JSON.stringify(body);
  let res;
  try {
    res = await SolveNet.fetch(path, opts, cfg);
  } catch (netErr) {
    const e = new Error(SolveNet.friendlyError(null, null, netErr));
    e.network = true;
    throw e;
  }
  // A gateway error page is not JSON — never let that surface as "Unexpected token <"
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    // Session expired or server restarted — clear state and return to login
    if (window.SolveTour) SolveTour.abort();
    authToken    = null;
    currentUser  = null;
    trainingData = null;
    currentBlocks     = [];
    currentBlockIndex = null;
    currentRoleId     = null;
    localStorage.removeItem(SESSION_KEY);
    clearCache();
    document.body.classList.remove('logged-in');
    document.getElementById('appHeader').style.display   = 'none';
    document.getElementById('headerBack').style.display  = 'none';
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById('loginCard').style.display   = 'block';
    document.getElementById('forgotCard').style.display  = 'none';
    document.getElementById('loginScreen').style.display = 'flex';
    const errEl = document.getElementById('loginError');
    errEl.textContent = 'Your session has expired. Please sign in again.';
    errEl.classList.add('show');
    throw new Error('session_expired');
  }
  if (!res.ok) {
    const e = new Error(SolveNet.friendlyError(res, data));
    e.status = res.status;
    e.retryable = !!data.retryable;
    throw e;
  }
  return data;
}

// ── Local cache ──────────────────────────────────────────────
function loadCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function saveCache(data) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(data)); } catch {}
}

function clearCache() {
  localStorage.removeItem(CACHE_KEY);
}

// ============================================================
// LOGIN
// ============================================================
document.getElementById('loginEmail').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('loginPassword').focus(); });
document.getElementById('loginPassword').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });

async function doLogin() {
  const emailEl = document.getElementById('loginEmail');
  const passEl  = document.getElementById('loginPassword');
  const errEl   = document.getElementById('loginError');
  const btnEl   = document.getElementById('btnLogin');
  const email    = emailEl.value.trim();
  const password = passEl.value;

  errEl.classList.remove('show');
  if (!email || !password) {
    errEl.textContent = 'Please enter your email and password.';
    errEl.classList.add('show');
    return;
  }

  btnEl.disabled = true;
  btnEl.textContent = 'Signing in…';

  try {
    const data = await SolveNet.fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    }).then(r => r.json().catch(() => ({})).then(d => ({ ok: r.ok, ...d, error: r.ok ? undefined : SolveNet.friendlyError(r, d) })));

    if (!data.ok) {
      errEl.textContent = data.error || 'Login failed.';
      errEl.classList.add('show');
      btnEl.disabled = false;
      btnEl.textContent = 'Sign In';
      return;
    }

    authToken   = data.token;
    currentUser = { name: data.name, email: data.email, onboardingStage: data.onboardingStage || null, mustChangePassword: !!data.mustChangePassword };
    localStorage.setItem(SESSION_KEY, authToken);
    await initApp();
    if (data.mustChangePassword) showProfile(true);

  } catch (err) {
    errEl.textContent = SolveNet.friendlyError(null, null, err);
    errEl.classList.add('show');
    btnEl.disabled = false;
    btnEl.textContent = 'Sign In';
  }
}

// ============================================================
// FORGOT PASSWORD
// ============================================================
function showForgot() {
  // Pre-fill email from the login field if available
  const loginEmail = document.getElementById('loginEmail').value.trim();
  if (loginEmail) document.getElementById('forgotEmail').value = loginEmail;
  document.getElementById('forgotSuccess').classList.remove('show');
  document.getElementById('forgotError').classList.remove('show');
  document.getElementById('loginCard').style.display  = 'none';
  document.getElementById('forgotCard').style.display = 'block';
}

function showLogin() {
  document.getElementById('forgotCard').style.display = 'none';
  document.getElementById('loginCard').style.display  = 'block';
  document.getElementById('loginError').classList.remove('show');
}

async function doForgot() {
  const emailEl   = document.getElementById('forgotEmail');
  const btnEl     = document.getElementById('btnForgot');
  const successEl = document.getElementById('forgotSuccess');
  const errEl     = document.getElementById('forgotError');
  const email     = emailEl.value.trim();

  errEl.classList.remove('show');
  successEl.classList.remove('show');

  if (!email) {
    errEl.textContent = 'Please enter your email address.';
    errEl.classList.add('show');
    return;
  }

  btnEl.disabled = true;
  btnEl.textContent = 'Sending…';

  try {
    const res  = await SolveNet.fetch('/api/forgot-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      errEl.textContent = SolveNet.friendlyError(res, data) || 'Could not send recovery email.';
      errEl.classList.add('show');
    } else {
      successEl.textContent = data.message || 'Password sent! Check your inbox.';
      successEl.classList.add('show');
      emailEl.value = '';
    }
  } catch (err) {
    errEl.textContent = SolveNet.friendlyError(null, null, err);
    errEl.classList.add('show');
  } finally {
    btnEl.disabled = false;
    btnEl.textContent = 'Send Password';
  }
}

// ============================================================
// APP INIT
// ============================================================
function showStageBadge(stage) {
  const el = document.getElementById('headerStage');
  if (stage) {
    el.textContent = stage;
    el.style.display = 'inline-flex';
    if (window._hideHeader) el.style.margin = '0 12px';
  } else {
    el.style.display = 'none';
  }
}

async function initApp() {
  document.body.classList.add('logged-in');
  // Show header, hide login
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('appHeader').style.display = 'flex';
  document.getElementById('headerUser').style.display = 'inline-flex';
  document.getElementById('btnLogout').style.display = currentUser?.autoLogin ? 'none' : 'inline-flex';
  document.getElementById('headerUser').textContent = currentUser.name;
  showStageBadge(currentUser.onboardingStage);

  // Show loading
  showScreen('screenLoading');
  document.getElementById('loadingText').textContent = 'Loading your course data…';

  try {
    const cached = loadCache();
    const now    = Date.now();

    if (cached && cached.userEmail === currentUser.email && (now - cached.syncedAt) < CACHE_TTL) {
      // Use local cache (still fresh)
      trainingData = cached;
      // Restore onboarding stage from cache
      if (trainingData.onboardingStage && !currentUser.onboardingStage) {
        currentUser.onboardingStage = trainingData.onboardingStage;
        showStageBadge(currentUser.onboardingStage);
      }
    } else {
      // Fetch from server
      try {
        const data = await apiFetch('/api/training-data');
        trainingData = { ...data, userEmail: currentUser.email, name: currentUser.name, roles: data.roles || [] };
        if (data.onboardingStage) {
          currentUser.onboardingStage = data.onboardingStage;
          showStageBadge(currentUser.onboardingStage);
        }
        saveCache(trainingData);
      } catch (loadErr) {
        // Can't reach the back end (after waiting and retrying): fall back to the last copy saved on
        // this device, however old, rather than leaving a dead screen. The sync bar shows its age.
        if (loadErr.message === 'session_expired' || !cached || cached.userEmail !== currentUser.email) throw loadErr;
        trainingData = cached;
        SolveNet.showBanner('warn', "We couldn't refresh your course data, so you're seeing the copy saved on this device. We'll keep trying.", { autoHideMs: 12000 });
        scheduleRecoverySync();
      }
    }
    overlayPendingCompletions();

    renderRoles();
    showScreen('screenRoles');
    updateSyncBar();
    flushPendingCompletions();

    // First-ever visit on this browser: welcome screen + walkthrough (js/tour.js)
    if (window.SolveTour) setTimeout(() => SolveTour.maybeStart(), 500);

    // Auto-sync every 15 minutes (plus 0-5 minutes of random jitter) while the app is open.
    // The jitter matters: a group that logs in together would otherwise sync at the same second,
    // every time, and hit Notion's rate limit all at once.
    scheduleAutoSync();

  } catch (err) {
    if (err.message === 'session_expired') return;
    showLoadError(err.message || 'Failed to load data. Please try again.', initApp);
  }
}

const AUTO_SYNC_BASE_MS   = 15 * 60 * 1000;
const AUTO_SYNC_JITTER_MS = 5 * 60 * 1000;
function scheduleAutoSync() {
  if (autoSyncTimer) clearTimeout(autoSyncTimer);   // clearTimeout and clearInterval share one id pool
  const delay = AUTO_SYNC_BASE_MS + Math.random() * AUTO_SYNC_JITTER_MS;
  autoSyncTimer = setTimeout(async () => {
    console.log('[AutoSync] Background sync triggered');
    try { await manualSync(); } catch { /* manualSync reports its own failures */ }
    if (authToken) scheduleAutoSync();               // stop rescheduling once signed out
  }, delay);
}

// If we had to fall back to the saved copy, try the server again every minute until it answers.
let recoveryTimer = null;
function scheduleRecoverySync() {
  if (recoveryTimer) return;
  recoveryTimer = setInterval(async () => {
    if (!authToken || !trainingData) { clearInterval(recoveryTimer); recoveryTimer = null; return; }
    try {
      const data = await apiFetch('/api/training-data', 'GET', null, { quiet: true, waits: [] });
      trainingData = { ...data, userEmail: currentUser.email, name: currentUser.name, roles: data.roles || [] };
      saveCache(trainingData);
      overlayPendingCompletions();
      clearInterval(recoveryTimer); recoveryTimer = null;
      if (document.getElementById('screenRoles')?.classList.contains('active')) renderRoles();
      updateSyncBar();
      SolveNet.showBanner('ok', 'Back online — your course data is up to date ✓', { autoHideMs: 3000, dismissible: false });
    } catch { /* still down — try again next minute */ }
  }, 60000);
}

// ============================================================
// SYNC
// ============================================================
async function manualSync() {
  // The only Sync control is in the navbar now (desktop header button; the phone bar mirrors its state)
  const btnHead  = document.getElementById('headerSyncBtn');
  if (btnHead)  { btnHead.classList.add('syncing');  btnHead.disabled  = true; }
  try {
    // Anything completed while the back end was down goes first, so the refresh below can't hide it
    await flushPendingCompletions();
    // Sync returns refreshed employee data (name, onboardingStage) as well as
    // triggering a server-side cache refresh of all training content.
    const syncResult = await apiFetch('/api/sync', 'POST');

    // Apply refreshed employee data to currentUser immediately
    if (syncResult.name)            { currentUser.name = syncResult.name; document.getElementById('headerUser').textContent = currentUser.name; }
    if (syncResult.onboardingStage) { currentUser.onboardingStage = syncResult.onboardingStage; showStageBadge(currentUser.onboardingStage); }

    const data = await apiFetch('/api/training-data');
    trainingData = { ...data, userEmail: currentUser.email, name: currentUser.name, roles: data.roles || [] };
    overlayPendingCompletions();
    // training-data may also carry a refreshed onboardingStage (belt-and-suspenders)
    if (data.onboardingStage) {
      currentUser.onboardingStage = data.onboardingStage;
      showStageBadge(currentUser.onboardingStage);
    }
    saveCache(trainingData);
    // Refresh the current screen.
    // If inside a role view, rebuild currentBlocks from fresh trainingData so
    // any newly accessible stages (after a stage advance) are included before
    // renderCourse applies its stage filter. Without this, currentBlocks would
    // still hold the old stage-filtered set and the new stage wouldn't appear.
    if (currentRoleId) {
      const role = trainingData.roles.find(r => r.id === currentRoleId);
      if (role) {
        const roleBlockSet = new Set(role.blockIds);
        currentBlocks = trainingData.blocks.filter(b => roleBlockSet.has(b.id));
      }
      renderCourse(currentBlocks, true); // skipCompleteRedirect: don't jump to completion screen on background sync
    } else {
      renderRoles();
    }
    updateSyncBar();
    showToast('✅ Course data synced');
  } catch (err) {
    showToast('⚠️ Sync failed: ' + err.message);
  } finally {
    if (btnHead)  { btnHead.classList.remove('syncing');  btnHead.disabled  = false; }
  }
}

function updateSyncBar() {
  if (!trainingData) return;
  const ago = timeSince(trainingData.syncedAt);
  // Desktop navbar: the time lives beside the Sync button; on phones it is the bar button's tooltip
  const headText = document.getElementById('headerSyncText');
  if (headText) headText.textContent = `Synced ${ago}`;
  const headBtn = document.getElementById('headerSyncBtn');
  if (headBtn) headBtn.title = `Sync course data (last synced ${ago})`;
  const tabSync = document.getElementById('tabSync');
  if (tabSync) tabSync.title = `Sync (last synced ${ago})`;
}

/**
 * A completion date as someone would write it: "27 Jul 2026".
 *
 * Notion hands back whatever shape the property holds — a bare `2026-11-16`
 * for a date, or a full `2026-07-27T13:13:00.000-07:00` when a time was set —
 * and the raw second form was being printed on the card.
 *
 * Only the leading YYYY-MM-DD is read, deliberately. `new Date('2026-11-16')`
 * parses as UTC midnight and renders as the day before across North America,
 * and converting the datetime form to the viewer's timezone would show a
 * different day from the one Notion shows. The date Notion stores is the date
 * we print.
 */
const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function prettyDay(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  if (!m) return String(iso || '');
  return `${Number(m[3])} ${MONTHS_SHORT[Number(m[2]) - 1]} ${m[1]}`;
}

function timeSince(ts) {
  const secs = Math.floor((Date.now() - ts) / 1000);
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs/60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs/3600)}h ago`;
  return `${Math.floor(secs/86400)}d ago`;
}

// ============================================================
// ROLES SCREEN
// ============================================================
// Outstanding trainings are a to-do list, not an alarm: a calendar in the
// theme's amber, not a red warning triangle. Inline rather than an emoji so it
// takes the chip's colour (emoji ignore `color`) and matches at any size.
const CALENDAR_ICON =
  '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" ' +
  'stroke-width="1.6" stroke-linecap="round" aria-hidden="true" focusable="false">' +
  '<rect x="2" y="3.5" width="12" height="10.5" rx="2"/>' +
  '<path d="M2 7h12M5.5 1.8v3M10.5 1.8v3"/></svg>';

function renderRoles() {
  if (!trainingData) return;
  const { roles, completedMap, blocks } = trainingData;

  const firstName = String(currentUser.name || '').trim().split(/\s+/)[0];
  document.getElementById('rolesTitle').textContent = firstName ? `Welcome Back, ${firstName}` : 'Welcome Back';

  // Show inline profile button when header-main is hidden
  if (window._hideHeader) {
    const bar    = document.getElementById('inlineProfileBar');
    const nameEl = document.getElementById('inlineProfileName');
    if (bar)    bar.style.display  = 'flex';
    if (nameEl) nameEl.textContent = currentUser.name;
  }

  const empOrdering = trainingData.employeeStageOrdering ?? 999;

  // Returns true if a block should be shown for the given role.
  // - importContractorTrainings roles: show only blocks with a Contractor stage
  // - Regular employee roles: show only blocks with an Employee stage (within progression)
  function isVisibleForRole(b, role) {
    if (b.isContractorBlock || b.isDealerBlock) return true;
    if (role.importContractorTrainings) {
      return b.hasContractorStage || b.contractorStageOrdering < 999;
    } else if (role.isDealerRole) {
      return b.hasDealerStage || b.dealerStageOrdering < 999;
    } else {
      if (completedMap[b.id]) return true; // always show blocks with an existing training record
      if (b.stageOrdering === 999 && b.hasEmployeeStage) return true;
      if (!b.hasEmployeeStage) return false;
      if (empOrdering < 999 && b.stageOrdering > empOrdering) return false;
      return true;
    }
  }

  // Global count across all roles (deduplicated).
  // Each role uses its own completedMap if it has one (contractor roles do).
  const seenIds   = new Set();
  let totalVisible = 0, totalDone = 0;
  (roles || []).forEach(role => {
    const roleMap = role.completedMap || completedMap;
    role.blockIds.map(id => blocks.find(b => b.id === id)).filter(Boolean)
      .filter(b => isVisibleForRole(b, role))
      .forEach(b => {
        if (seenIds.has(b.id)) return;
        seenIds.add(b.id);
        totalVisible++;
        if (roleMap[b.id]?.status === 'OK') totalDone++;
      });
  });
  document.getElementById('rolesSubtitle').textContent = `${totalDone} of ${totalVisible} modules completed across all roles`;

  const grid = document.getElementById('rolesGrid');
  grid.innerHTML = '';

  (roles || []).forEach(role => {
    // Use the role's own completedMap when available (contractor roles carry one)
    const roleMap       = role.completedMap || completedMap;
    if (role.importContractorTrainings) {
      console.log(`[renderRoles] ${role.name} — has own completedMap: ${!!role.completedMap}, entries: ${Object.keys(roleMap).length}, statuses:`, Object.fromEntries(Object.entries(roleMap).map(([k,v])=>[k.slice(0,8),v.status])));
    }
    const roleBlocks    = role.blockIds.map(id => blocks.find(b => b.id === id)).filter(Boolean);
    const visibleBlocks = roleBlocks.filter(b => isVisibleForRole(b, role));
    const resources = role.resources || [];
    if (!visibleBlocks.length && !resources.length) return; // skip roles with nothing visible at this stage
    const done    = visibleBlocks.filter(b => roleMap[b.id]?.status === 'OK').length;
    const overdue = visibleBlocks.filter(b => roleMap[b.id]?.status === 'Overdue').length;
    const total   = visibleBlocks.length;
    const pct = total ? Math.round(done / total * 100) : 0;

    const card = document.createElement('div');
    card.className = 'role-card' + (total ? '' : ' role-card-resources-only');
    card.innerHTML = `
      <div class="role-card-head">
        <div class="role-card-name">${escHtml(role.name)}${role.contractorName ? `<span style="font-size:12px;font-weight:400;color:var(--gray);margin-left:8px;">${escHtml(role.contractorName)}</span>` : ''}</div>
        ${total ? '<button type="button" class="btn btn-primary role-card-go">Go to courses <span aria-hidden="true">→</span></button>' : ''}
      </div>
      ${total ? `
      <div class="role-card-stats">
        <span>${done} of ${total} completed</span>
        <span>${pct}%</span>
      </div>
      <div class="role-card-bar"><div class="role-card-fill" style="width:${pct}%"></div></div>
      ${overdue ? `<div class="role-card-due">${CALENDAR_ICON}${overdue} course${overdue === 1 ? '' : 's'} due</div>` : ''}` : ''}
      ${resources.length ? `<div class="role-card-resources" data-role-id="${escHtml(role.id)}"></div>` : ''}
    `;
    if (total) card.onclick = () => openRole(role.id, role.name);
    grid.appendChild(card);
  });

  if (!grid.children.length) {
    grid.innerHTML = `
      <div style="text-align:center;padding:48px 24px;color:var(--gray);">
        <div style="font-size:36px;margin-bottom:12px;">🎓</div>
        <div style="font-size:16px;font-weight:600;color:var(--text);margin-bottom:6px;">No courses available</div>
        <div style="font-size:13px;">You have no courses assigned at your current stage.</div>
      </div>`;
  }

  showScreen('screenRoles');
  loadRoleResources(roles || []);
  // Issued certificates sit under the course cards. Loaded separately so a slow
  // or failed certificate lookup never delays the courses themselves.
  if (window.SolveCerts) window.SolveCerts.renderSection();
}

// ============================================================
// ISSUED CERTIFICATES
// ============================================================

/**
 * Show the "you've earned a certificate" modal, if this completion issued one.
 *
 * Every completion path calls this with whatever the server returned; the
 * server sends `certificate: null` when the block does not issue one, so there
 * is nothing for callers to check. Refreshes the main-page list too, so the
 * certificate is already there when they go back.
 */
/**
 * The role whose course the person is currently working through, by name.
 *
 * The server needs it to resolve a `Certificate Title` like "Certified [Role]".
 * Null when there is no role in context — "Other Assigned Trainings" — and the
 * server falls back to the block's own name rather than printing the tag.
 */
function currentRoleName() {
  if (!currentRoleId || !trainingData?.roles) return null;
  const role = trainingData.roles.find(r => r.id === currentRoleId);
  return role?.name || null;
}

function awardCertificate(certificate) {
  if (!certificate || !window.SolveCerts) return;
  try {
    // The list is cached for both the main page and the per-block panel, so it
    // has to be dropped or neither shows the certificate just issued.
    window.SolveCerts.invalidate();
    window.SolveCerts.showAward(certificate);
    window.SolveCerts.renderSection();
    window.SolveCerts.renderForBlock(certificate.blockId || null, document.getElementById('blockCertificate'));
  } catch (err) {
    // A failed celebration must never cost someone their completion.
    console.warn('Could not show the certificate:', err && err.message);
  }
}

// ============================================================
// GENERAL RESOURCES — document grid inside each role card
// ============================================================
// Blocks tagged "General Resource" (Path documents, handbook parts...) list
// their Guidance files here. One batched request covers every role card;
// results are kept for 15 minutes because Notion's signed URLs expire.
let resourceDataByBlock = {};   // blockId → { files: [{ name, url, group }], link }
let resourceFilesTs     = 0;
const RESOURCE_FILES_TTL_MS = 15 * 60 * 1000;
const RESOURCE_TILES_COLLAPSED = 6;

function resourceLabel(name) {
  return String(name || '').replace(/^.*Handbook:\s*/i, '').replace(/\s*\(complete\)\s*$/i, '').trim() || String(name || '');
}

// One tile per file (Guidance, Associated forms, Files & media) plus one for the Training link.
// A block with a single item is labelled with the block's name; with several, each file
// carries its own file name.
function resourceTilesFor(role) {
  const tiles = [];
  (role.resources || []).forEach(r => {
    const data  = resourceDataByBlock[r.id] || { files: [], link: null };
    const count = data.files.length + (data.link ? 1 : 0);
    data.files.forEach(f => {
      const fileLabel = String(f.name || '').replace(/\.[a-z0-9]{2,5}$/i, '').replace(/_/g, ' ');
      tiles.push({ file: f, label: count === 1 ? resourceLabel(r.name) : fileLabel });
    });
    if (data.link) {
      tiles.push({ link: data.link, label: count === 1 ? resourceLabel(r.name) : `${resourceLabel(r.name)} (link)` });
    }
  });
  return tiles;
}

function resourceLinkCardHtml(tile) {
  const video = isVideoLink(tile.link);
  return `
    <a class="material-card resource-tile" href="${escHtml(tile.link)}" target="_blank" rel="noopener" title="${escHtml(tile.label)}">
      <div class="material-card-thumb material-card-generic">
        <span class="material-card-icon">${video ? '📹' : '🔗'}</span>
        <span class="material-card-ext-badge">${video ? 'VIDEO' : 'LINK'}</span>
        ${materialHoverOverlay('Open ↗')}
      </div>
      <div class="resource-tile-label">${escHtml(tile.label)}</div>
    </a>`;
}

function resourceCardHtml(tile) {
  if (tile.link) return resourceLinkCardHtml(tile);
  const label = `<div class="resource-tile-label">${escHtml(tile.label)}</div>`;
  // materialCardHtml ends with its own closing tag; the label goes inside the card
  return materialCardHtml({ name: tile.file.name, url: tile.file.url, group: 'Resource' })
    .replace(/<\/(a|div)>\s*$/, label + '</$1>')
    .replace('class="material-card"', 'class="material-card resource-tile"')
    .replace('class="material-card material-card-clickable"', 'class="material-card material-card-clickable resource-tile"');
}

// Placeholder tiles shown while the document list loads: same grid, same tile shape, so nothing jumps
// when the real ones arrive. Styles are injected here (not styles.css) because the service worker serves
// the stylesheet cache-first: new markup would otherwise meet the previous deploy's CSS.
function injectSkeletonStyles() {
  if (document.getElementById('solveSkeletonStyles')) return;
  const st = document.createElement('style');
  st.id = 'solveSkeletonStyles';
  st.textContent = `
    .skel-tile { border: 1px solid var(--border); border-radius: 10px; overflow: hidden; background: var(--white, #fff); min-width: 0; }
    .skel-thumb { aspect-ratio: 4 / 3; width: 100%; }
    .skel-label { padding: 10px; border-top: 1px solid var(--border); }
    .skel-line { height: 9px; border-radius: 5px; margin-bottom: 7px; }
    .skel-line:last-child { width: 60%; margin-bottom: 0; }
    .skel-thumb, .skel-line {
      background: linear-gradient(90deg, rgba(128,128,128,.12) 25%, rgba(128,128,128,.24) 37%, rgba(128,128,128,.12) 63%);
      background-size: 400% 100%; animation: solveSkel 1.4s ease infinite;
    }
    @keyframes solveSkel { 0% { background-position: 100% 50%; } 100% { background-position: 0 50%; } }
    /* document cover: shimmer until the image / first PDF page has actually painted */
    .material-card-thumb.thumb-loading {
      background: linear-gradient(90deg, rgba(128,128,128,.12) 25%, rgba(128,128,128,.24) 37%, rgba(128,128,128,.12) 63%);
      background-size: 400% 100%; animation: solveSkel 1.4s ease infinite;
    }
    .material-card-thumb.thumb-loading .material-card-ext-badge { opacity: .55; }
    @media (prefers-reduced-motion: reduce) { .skel-thumb, .skel-line, .material-card-thumb.thumb-loading { animation: none; } }`;
  document.head.appendChild(st);
}

function resourceSkeletonHtml(role) {
  injectSkeletonStyles();
  const n = Math.min(RESOURCE_TILES_COLLAPSED, Math.max(2, (role.resources || []).length));
  const tile = '<div class="skel-tile"><div class="skel-thumb"></div><div class="skel-label"><div class="skel-line"></div><div class="skel-line"></div></div></div>';
  return `<div class="resource-grid" role="status" aria-label="Loading documents">${tile.repeat(n)}</div>`;
}

function renderRoleResources(box, role, expanded) {
  const tiles = resourceTilesFor(role);
  if (!tiles.length) {
    const card = box.closest('.role-card');
    box.remove();
    // A card that only existed for its documents has nothing left to show
    if (card?.classList.contains('role-card-resources-only')) card.remove();
    return;
  }
  const shown = expanded ? tiles : tiles.slice(0, RESOURCE_TILES_COLLAPSED);
  const more  = tiles.length - shown.length;
  box.innerHTML = `
    <div class="materials-title">📚 Quick Reference Documents</div>
    <div class="resource-grid">${shown.map(resourceCardHtml).join('')}</div>
    ${more > 0 ? `<button type="button" class="resource-more-btn">Show all ${tiles.length} documents</button>` : ''}
    ${expanded && tiles.length > RESOURCE_TILES_COLLAPSED ? `<button type="button" class="resource-more-btn">Show fewer</button>` : ''}
  `;
  box.querySelector('.resource-more-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    renderRoleResources(box, role, !expanded);
  });
  renderPdfThumbnails(box);
}

async function loadRoleResources(roles) {
  const withDocs = roles.filter(r => (r.resources || []).length);
  if (!withDocs.length) return;

  const boxFor = (role) => document.querySelector(`.role-card-resources[data-role-id="${CSS.escape(role.id)}"]`);
  withDocs.forEach(role => {
    const box = boxFor(role);
    if (!box) return;
    // The grid area must never trigger the card's own click (open the role)
    box.onclick = (e) => e.stopPropagation();
    if (!box.innerHTML) box.innerHTML = `<div class="materials-title">📚 Quick Reference Documents</div>${resourceSkeletonHtml(role)}`;
  });

  const ids   = [...new Set(withDocs.flatMap(r => r.resources.map(x => x.id)))];
  const fresh = Date.now() - resourceFilesTs < RESOURCE_FILES_TTL_MS && ids.every(id => id in resourceDataByBlock);
  try {
    if (!fresh) {
      const data = await apiFetch('/api/resource-files', 'POST', { blockIds: ids });
      resourceDataByBlock = data.resources || {};
      resourceFilesTs = Date.now();
    }
  } catch (err) {
    if (err.message !== 'session_expired') console.error('loadRoleResources error:', err);
    withDocs.forEach(role => boxFor(role)?.remove());
    return;
  }
  withDocs.forEach(role => { const box = boxFor(role); if (box) renderRoleResources(box, role, false); });
}

function openRole(roleId, roleName) {
  currentRoleId = roleId;
  // Filter blocks to only those in this role
  const role = trainingData.roles.find(r => r.id === roleId);
  if (!role) return;
  // Set currentBlocks to role-filtered blocks (preserving full sorted order)
  const roleBlockSet = new Set(role.blockIds);
  currentBlocks = trainingData.blocks.filter(b => roleBlockSet.has(b.id));

  // Show back button
  document.getElementById('headerBack').style.display = 'inline-flex';
  renderCourse(currentBlocks, true); // skipCompleteRedirect: user explicitly opened this role
}

// ============================================================
// COURSE OVERVIEW
// ============================================================
/**
 * Returns the completedMap relevant to the current role context.
 * Contractor roles carry their own per-contractor completedMap so that
 * completion status from one contractor doesn't bleed into another.
 * All other roles (employee, dealer, supplement) use the global map.
 */
function getActiveCompletedMap() {
  if (currentRoleId) {
    const role = (trainingData?.roles || []).find(r => r.id === currentRoleId);
    if (role?.completedMap) return role.completedMap;
  }
  return trainingData?.completedMap || {};
}

function isBlockCompleted(blockId) {
  return getActiveCompletedMap()[blockId]?.status === 'OK';
}

function isBlockOverdue(blockId) {
  return getActiveCompletedMap()[blockId]?.status === 'Overdue';
}

/** Write a local completion entry to the correct map (role-specific or global). */
function markBlockCompleteLocally(blockId, data) {
  const role = currentRoleId ? (trainingData?.roles || []).find(r => r.id === currentRoleId) : null;
  if (role?.completedMap) {
    role.completedMap[blockId] = data;
  } else {
    if (!trainingData.completedMap) trainingData.completedMap = {};
    trainingData.completedMap[blockId] = data;
  }
  saveCache(trainingData);
}

// ── Completions waiting to be saved ──────────────────────────
// If recording a passed quiz fails even after waiting and retrying (e.g. Notion is down), the pass is
// kept on this device and re-sent automatically. (Sync only re-READS Notion, so without this queue
// a pass that never reached Notion would vanish at the next sync and the quiz would have to be redone.)
const PENDING_KEY = 'solve_pending_completions_v1';
let pendingFlushing = false, pendingTimer = null;
const pendingStoreKey = () => `${PENDING_KEY}:${currentUser?.email || ''}`;
function loadPending() { try { return JSON.parse(localStorage.getItem(pendingStoreKey()) || '[]'); } catch { return []; } }
function savePending(list) {
  try { list.length ? localStorage.setItem(pendingStoreKey(), JSON.stringify(list)) : localStorage.removeItem(pendingStoreKey()); } catch {}
}

function queueCompletion(block) {
  const list = loadPending();
  if (!list.some(p => p.blockId === block.id)) {
    // roleName rides along so a completion replayed later still resolves a
    // `Certificate Title` pattern like "Certified [Role]".
    list.push({ blockId: block.id, blockName: block.name, roleName: currentRoleName(), date: new Date().toISOString().split('T')[0], queuedAt: Date.now() });
    savePending(list);
  }
  schedulePendingFlush();
}

// Show queued completions as done, whatever a fresh copy of the data from the server says
function overlayPendingCompletions() {
  const list = loadPending();
  if (!list.length || !trainingData) return;
  for (const p of list) {
    const entry = { date: p.date, recordId: null, status: 'OK' };
    if (!trainingData.completedMap) trainingData.completedMap = {};
    if (trainingData.completedMap[p.blockId]?.status !== 'OK') trainingData.completedMap[p.blockId] = entry;
    for (const role of (trainingData.roles || [])) {
      if (role.completedMap && (role.blockIds || []).includes(p.blockId) && role.completedMap[p.blockId]?.status !== 'OK') {
        role.completedMap[p.blockId] = entry;
      }
    }
  }
}

function schedulePendingFlush(delay = 60000) {
  clearTimeout(pendingTimer);
  pendingTimer = setTimeout(flushPendingCompletions, delay);
}

async function flushPendingCompletions() {
  if (pendingFlushing || !authToken || !currentUser) return;
  if (!loadPending().length) return;
  pendingFlushing = true;
  let saved = 0;
  try {
    for (const p of loadPending()) {
      try {
        const r = await apiFetch('/api/complete', 'POST', { blockId: p.blockId, blockName: p.blockName, roleName: p.roleName || null }, { quiet: true, waits: [3000] });
        savePending(loadPending().filter(x => x.blockId !== p.blockId));
        saved++;
        // The server may already hold this record (it updates rather than duplicates); record its id locally
        const entry = { date: r.date || p.date, recordId: r.recordId, status: 'OK' };
        if (trainingData) {
          if (!trainingData.completedMap) trainingData.completedMap = {};
          trainingData.completedMap[p.blockId] = entry;
          for (const role of (trainingData.roles || [])) {
            if (role.completedMap && (role.blockIds || []).includes(p.blockId)) role.completedMap[p.blockId] = entry;
          }
        }
      } catch (e) {
        if (e.message === 'session_expired') return;
        break; // still can't reach it — keep the rest queued and try again later
      }
    }
  } finally {
    pendingFlushing = false;
  }
  if (saved) {
    if (trainingData) saveCache(trainingData);
    showToast('✅ Your completed course has been saved');
    if (document.getElementById('screenRoles')?.classList.contains('active')) renderRoles();
  }
  if (loadPending().length) schedulePendingFlush();
}
window.addEventListener('online', () => flushPendingCompletions());

function renderCourse(blocksOverride, skipCompleteRedirect = false) {
  if (!trainingData) return;
  const completedMap = getActiveCompletedMap();
  const allBlocks = blocksOverride || trainingData.blocks;

  // ── Filter to visible blocks based on current role type ───────
  const empOrdering  = trainingData.employeeStageOrdering ?? 999;
  const currentRole  = (trainingData.roles || []).find(r => r.id === currentRoleId);
  const importing    = currentRole?.importContractorTrainings || false;
  const isDealer     = currentRole?.isDealerRole || false;

  const blocks = allBlocks.filter(b => {
    if (b.isContractorBlock || b.isDealerBlock) return true;
    if (importing) {
      return b.hasContractorStage || b.contractorStageOrdering < 999;
    } else if (isDealer) {
      return b.hasDealerStage || b.dealerStageOrdering < 999;
    } else {
      if (completedMap[b.id]) return true; // always show blocks with an existing training record
      if (b.stageOrdering === 999 && b.hasEmployeeStage) return true;
      if (!b.hasEmployeeStage) return false;
      if (empOrdering < 999 && b.stageOrdering > empOrdering) return false;
      return true;
    }
  });

  currentBlocks = blocks;

  // Stats (based on visible filtered blocks)
  const done = blocks.filter(b => isBlockCompleted(b.id)).length;
  const pct  = blocks.length ? Math.round(done / blocks.length * 100) : 0;

  const currentRoleObj = currentRoleId ? trainingData.roles.find(r => r.id === currentRoleId) : null;
  const roleLabel = currentRoleObj
    ? currentRoleObj.name + (currentRoleObj.contractorName ? ` — ${currentRoleObj.contractorName}` : '')
    : currentUser.name + "'s Courses";
  document.getElementById('courseRoleName').textContent       = roleLabel;
  document.getElementById('courseTotalCount').textContent     = blocks.length;
  document.getElementById('courseCompletedCount').textContent = done;
  document.getElementById('progressPct').textContent          = pct + '%';
  document.getElementById('progressFill').style.width         = pct + '%';

  const list = document.getElementById('moduleList');
  list.innerHTML = '';

  // Helper — stage section header (numbered badge + name + done/total pill)
  function addStageHeader(stageName, stageIdx, stageBlocks) {
    const stageDone  = stageBlocks.filter(b => isBlockCompleted(b.id)).length;
    const stageTotal = stageBlocks.length;
    const p   = STAGE_PALETTE[stageIdx % STAGE_PALETTE.length];
    const hdr = document.createElement('div');
    hdr.className = 'section-header stage';
    hdr.style.color             = p.color;
    hdr.style.borderBottomColor = p.border;
    hdr.innerHTML = `
      <span class="stage-badge" style="background:${p.color};color:#fff">${stageIdx + 1}</span>
      ${escHtml(stageName)}
      <span class="section-count" style="background:${p.bg};color:${p.color}">${stageDone}/${stageTotal}</span>
    `;
    list.appendChild(hdr);
  }

  // Helper — module item row
  // displayNumber: the block's real Notion "Ordering" value when set, otherwise
  // its position in the visible list (see listPosition below).
  function addModuleItem(block, globalIndex, cls, statusText, clickable, displayNumber) {
    const item = document.createElement('div');
    const typeStr = (block.types || []).join(', ') || 'General';
    item.className = 'module-item ' + cls;
    const numLabel = cls.includes('completed') ? '✓'
                   : cls.includes('overdue')   ? '!'
                   : displayNumber;
    item.innerHTML = `
      <div class="module-num">${numLabel}</div>
      <div class="module-info">
        <div class="module-name">${escHtml(block.name)}</div>
        <div class="module-type">${escHtml(typeStr)}</div>
      </div>
      <div class="module-status">${statusText}</div>
    `;
    if (clickable) item.onclick = () => openBlock(globalIndex);
    list.appendChild(item);
  }

  // ── Group blocks by pipeline stage (preserving sorted order) ──
  const stageGroups = [];   // [{stageName, stageOrdering, blocks: []}]
  const stageIndex  = new Map(); // stageName → group

  for (const block of blocks) {
    const key      = importing ? (block.contractorStageName || block.stageName || 'Other')
                   : isDealer  ? (block.dealerStageName     || block.stageName || 'Other')
                               : (block.stageName || 'Other');
    const ordering = importing ? (block.contractorStageOrdering ?? block.stageOrdering)
                   : isDealer  ? (block.dealerStageOrdering     ?? block.stageOrdering)
                               : block.stageOrdering;
    if (!stageIndex.has(key)) {
      const group = { stageName: key, stageOrdering: ordering, blocks: [] };
      stageIndex.set(key, group);
      stageGroups.push(group);
    }
    stageIndex.get(key).blocks.push(block);
  }

  // Sort stage groups by ordering, with "Other" always last
  stageGroups.sort((a, b) => {
    if (a.stageName === 'Other' && b.stageName !== 'Other') return 1;
    if (b.stageName === 'Other' && a.stageName !== 'Other') return -1;
    return a.stageOrdering - b.stageOrdering;
  });

  // ── Work out the whole render order before drawing anything ───
  // An "Unlock Sequentially" block is locked against everything ABOVE it on the
  // page, across phases, so the finished order has to exist first.
  //
  // Within a phase: unordered blocks (no Ordering) come first, sorted by
  // status; ordered blocks follow in their exact Ordering sequence.
  const statusPri = b => isBlockCompleted(b.id) ? 0 : isBlockOverdue(b.id) ? 1 : 2;
  const sections  = stageGroups.map(group => {
    const unordered = group.blocks.filter(b => b.blockOrdering == null)
      .sort((a, b) => statusPri(a) - statusPri(b));
    const ordered = group.blocks.filter(b => b.blockOrdering != null)
      .sort((a, b) => a.blockOrdering - b.blockOrdering);
    return { group, ordered, rows: [...unordered, ...ordered] };
  });
  const sequence = sections.flatMap(s => s.rows);
  const seqIndex = new Map(sequence.map((b, i) => [b.id, i]));

  function isBlockLocked(block, orderedBlocks) {
    // "Unlock Sequentially": nothing above it on the page may be outstanding,
    // including the phases before this one.
    if (unlocksSequentially(block)) {
      const upto = seqIndex.get(block.id) ?? 0;
      for (let i = 0; i < upto; i++) {
        if (!isBlockCompleted(sequence[i].id)) return true;
      }
    }
    // The ordinary rule: a numeric Ordering, with a lower-ordered block in the
    // same phase still outstanding.
    if (block.blockOrdering == null) return false;
    return orderedBlocks.some(
      b => b.blockOrdering < block.blockOrdering && !isBlockCompleted(b.id)
    );
  }

  // ── Render one section per stage ──────────────────────────────
  let listPosition = 0; // fallback display number for blocks with no Ordering value
  sections.forEach(({ group, ordered, rows }, idx) => {
    addStageHeader(group.stageName, idx, group.blocks);

    for (const block of rows) {
      listPosition++;
      const gi        = blocks.indexOf(block);
      const completed = isBlockCompleted(block.id);
      const overdue   = isBlockOverdue(block.id);
      const locked    = isBlockLocked(block, ordered);
      const dispNum   = block.blockOrdering != null ? block.blockOrdering : listPosition;

      if (completed) {
        const dateStr    = completedMap[block.id]?.date || '';
        const statusText = `✓ Done${dateStr ? ' · ' + prettyDay(dateStr) : ''}`;
        addModuleItem(block, gi, 'completed', statusText, true, dispNum);
      } else if (locked) {
        addModuleItem(block, gi, 'locked', '🔒 Complete previous courses first', false, dispNum);
      } else if (overdue) {
        addModuleItem(block, gi, 'overdue current', '⚠️ Overdue — Open', true, dispNum);
      } else {
        // No training record yet. The block is still outstanding, so it shows red like an
        // overdue one; the record is created when they complete it (/api/complete and friends).
        addModuleItem(block, gi, 'overdue current', '⚠️ Incomplete — Open', true, dispNum);
      }
    }
  });

  // Add an "all complete" notice at the top of the list when the user
  // is browsing a fully-completed role (not when auto-redirecting to completion).
  if (done === blocks.length && blocks.length > 0) {
    if (skipCompleteRedirect) {
      const banner = document.createElement('div');
      banner.className = 'completion-notice';
      banner.innerHTML = `
        <span class="completion-notice-icon">🎉</span>
        <span>All courses complete! You can still click any module below to review its resources.</span>
      `;
      list.insertBefore(banner, list.firstChild);
      showScreen('screenCourse');
    } else {
      renderCompletion();
      showScreen('screenComplete');
    }
  } else {
    showScreen('screenCourse');
  }
}

// ============================================================
// TRAINING BLOCK
// ============================================================

// Renders the contextual blue guidance blurb — tells the user exactly what
// to do with the resource/link (and, once known, the Training Materials
// section below it). Called once synchronously in openBlock (hasMaterials
// not yet known) and again after loadMaterials resolves.
function renderGuidanceBlurb(block, { isSignature, isDocUpload, isHRDocUpload, needsQuiz, hasMaterials }) {
  const blurbEl = document.getElementById('blockGuidanceBlurb');
  if (!blurbEl) return;

  if (isSignature && !needsQuiz) {
    blurbEl.style.display = 'none';
    return;
  }

  const hasLink = !!block.trainingLink;
  const isVideo = hasLink && isVideoLink(block.trainingLink);

  // Upload blocks: "upload below" already covers the whole lower section,
  // so the Training Materials section isn't called out separately here.
  if (isDocUpload || isHRDocUpload) {
    const uploadAction = isHRDocUpload ? 'upload your HR document below' : 'upload your certificate below';
    if (isVideo) {
      blurbEl.innerHTML = `📹 <strong>Watch the video above</strong>, then ${uploadAction} to complete this module.`;
      blurbEl.style.display = 'block';
    } else if (hasLink) {
      blurbEl.innerHTML = `🔗 <strong>Review the resource at the link above</strong>, then ${uploadAction} to complete this module.`;
      blurbEl.style.display = 'block';
    } else {
      blurbEl.style.display = 'none'; // noLinkBox upload message already covers this
    }
    return;
  }

  const materialsPhrase = hasMaterials ? ' and review the course materials below' : '';
  // Signature + quiz blocks: the signature is a follow-up step after the quiz
  const signatureSuffix = needsQuiz ? ' After you pass the quiz, you\'ll sign the document to complete this module.' : '';
  const noLinkBox = document.getElementById('noLinkBox');

  if (isVideo) {
    blurbEl.innerHTML = `📹 <strong>Watch the video above${materialsPhrase}</strong>, then click <strong>"I've reviewed this course — start quiz"</strong> when you're ready to take the quiz.${signatureSuffix}`;
    blurbEl.style.display = 'block';
  } else if (hasLink) {
    blurbEl.innerHTML = `🔗 <strong>Complete the course at the link above${materialsPhrase}</strong>, then click <strong>"I've reviewed this course — start quiz"</strong> when you're done.${signatureSuffix}`;
    blurbEl.style.display = 'block';
  } else {
    // No link — guide the user to review embedded materials below
    blurbEl.innerHTML = '📄 <strong>Read or review the materials below</strong>, then click <strong>"I\'ve reviewed this course — start quiz"</strong> when you\'re ready.' + signatureSuffix;
    blurbEl.style.display = 'block';
    if (noLinkBox) noLinkBox.style.display = 'none'; // blurb replaces the generic noLinkBox for regular blocks
  }
}

// Signature blocks whose "Associated forms" has no PDF — there is nothing to sign.
const blocksMissingSigningForm = new Set();

// hasPdfForm: true / false from the block's files, or null when unknown (leave UI alone).
function applySigningFormAvailability(block, hasPdfForm) {
  if (!isSignatureBlock(block) || hasPdfForm === null) return;
  if (currentBlocks[currentBlockIndex]?.id !== block.id) return; // user already moved on
  const missing = hasPdfForm === false;
  if (missing) blocksMissingSigningForm.add(block.id); else blocksMissingSigningForm.delete(block.id);

  let note = document.getElementById('signUnavailableNote');
  if (missing) {
    const signBtn = document.getElementById('btnSignDoc');
    if (signBtn) signBtn.style.display = 'none';
    if (!note) {
      note = document.createElement('div');
      note.id        = 'signUnavailableNote';
      note.className = 'no-link-box';
      const actions = document.getElementById('blockActions');
      actions.parentNode.insertBefore(note, actions);
    }
    note.textContent   = '✍️ This document isn\'t ready to sign yet — please contact your manager.';
    note.style.display = 'block';
  } else if (note) {
    note.style.display = 'none';
  }
}

function openBlock(index) {
  currentBlockIndex = index;
  const block   = currentBlocks[index];
  const passed  = isBlockCompleted(block.id);

  // Lazily fetch this block's AI quiz in the background so it's ready if the user taps "Start Quiz"
  if ((!isSignatureBlock(block) || blockNeedsQuizAndSignature(block)) && !isDocumentUploadBlock(block) && !isHRDocumentUploadBlock(block)) {
    prefetchQuizForBlock(block.id);
  }

  document.getElementById('stepRoleName').textContent  = currentUser.name;
  document.getElementById('stepModuleNum').textContent = `Module ${index + 1}`;
  document.getElementById('stepBlockName').textContent = block.name;
  document.getElementById('blockTitle').textContent    = block.name;

  // Badge
  const typeVal  = (block.types && block.types[0]) || 'General';
  const badgeMap = {
    'Policy / Procedure': ['badge-green','📋'],
    'WorkSafe BC':        ['badge-orange','⚠️'],
    'Internal Briefing':  ['badge-blue','📢'],
    'Guidance':           ['badge-purple','📖'],
    'Worksite':           ['badge-red','🦺'],
    '3rd Party Trainer':  ['badge-yellow','🎓'],
    'Pre-Employment Check': ['badge-gray','✅'],
    'Contract':           ['badge-gray','📝'],
    'Certificate':        ['badge-green','🏆'],
    'Job Role SOPs':      ['badge-blue','🔧'],
  };
  const [badgeCls, badgeIcon] = badgeMap[typeVal] || ['badge-gray','📄'];
  const badgeEl = document.getElementById('blockBadge');
  badgeEl.className = 'badge ' + badgeCls;
  badgeEl.textContent = badgeIcon + ' ' + typeVal;

  // Policy ref
  const policyDiv = document.getElementById('blockPolicy');
  policyDiv.innerHTML = block.policyNo ? `Policy Reference: <strong>${escHtml(block.policyNo)}</strong>` : '';

  // Notes
  const notesDiv = document.getElementById('blockNotes');
  if (block.notes) {
    notesDiv.style.display = 'block';
    notesDiv.textContent   = block.notes;
  } else {
    notesDiv.style.display = 'none';
  }

  // Training resource area — video embed, plain link, or "in-person" notice
  const resourceArea = document.getElementById('trainingResourceArea');
  const noLinkBox    = document.getElementById('noLinkBox');
  if (block.trainingLink) {
    noLinkBox.style.display = 'none';
    resourceArea.innerHTML  = buildTrainingResourceHTML(block.trainingLink);
    if (!isVideoLink(block.trainingLink)) loadLinkPreview(block.id, resourceArea);
  } else {
    resourceArea.innerHTML  = '';
    noLinkBox.style.display = 'block';
  }

  const viewedConfirm = document.getElementById('viewedConfirm');
  const btnViewed     = document.getElementById('btnViewed');
  const quizSection   = document.getElementById('quizSection');
  const quizResult    = document.getElementById('quizResult');
  const uploadSection = document.getElementById('uploadSection');
  const blockActions  = document.getElementById('blockActions');
  const isDocUpload   = isDocumentUploadBlock(block);
  const isHRDocUpload = isHRDocumentUploadBlock(block);
  const isSignature   = isSignatureBlock(block);
  const needsQuiz     = blockNeedsQuizAndSignature(block); // signature + quiz-type tag(s)
  const staleSignNote = document.getElementById('signUnavailableNote');
  if (staleSignNote) staleSignNote.style.display = 'none'; // belongs to the previous block

  // Update the no-link notice text to match the block type.
  // Signature blocks: suppress the notice entirely — the sign button is self-explanatory.
  if (noLinkBox.style.display !== 'none') {
    if (isSignature && !needsQuiz) {
      noLinkBox.style.display = 'none';
    } else {
      noLinkBox.textContent = isHRDocUpload
        ? '📋 Use the section below to upload your HR document. It will be filed securely.'
        : isDocUpload
        ? '📎 Use the section below to upload your certificates or documents for this course.'
        : '📄 This course is delivered in-person or via your manager. Review the materials below and confirm with your trainer before proceeding.';
    }
  }

  // Guidance blurb — tells the user exactly what to do with the resource/link.
  // hasMaterials isn't known yet (Training Materials load asynchronously below),
  // so render once now and again once loadMaterials resolves.
  renderGuidanceBlurb(block, { isSignature, isDocUpload, isHRDocUpload, needsQuiz, hasMaterials: false });

  // For signature blocks: hide quiz and upload sections via inline style.
  // For normal/upload blocks: clear inline style so CSS classes (.quiz-section, .show) work normally.
  if (isSignature && !needsQuiz) {
    quizSection.style.display   = 'none';
    uploadSection.style.display = 'none';
    blockActions.style.display  = '';
  } else if (isDocUpload || isHRDocUpload) {
    quizSection.style.display   = 'none';
    uploadSection.style.display = 'block';
    blockActions.style.display  = 'none';
    // Update upload UI labels to match block type
    const uploadTitle = uploadSection.querySelector('.quiz-title');
    const uploadSub   = uploadSection.querySelector('.quiz-sub');
    const btnSubmit   = document.getElementById('btnSubmitUpload');
    if (isHRDocUpload) {
      if (uploadTitle) uploadTitle.textContent = '📋 HR Document Upload';
      if (uploadSub)   uploadSub.textContent   = 'Upload your HR document below. It will be filed securely.';
      if (btnSubmit)   btnSubmit.textContent   = 'Submit Document';
    } else {
      if (uploadTitle) uploadTitle.textContent = '📎 Certificate Upload';
      if (uploadSub)   uploadSub.textContent   = 'Upload your certificate or supporting documents to complete this course.';
      if (btnSubmit)   btnSubmit.textContent   = 'Submit Certificate';
    }
  } else {
    quizSection.style.display   = '';  // defer to .quiz-section class + .show modifier
    uploadSection.style.display = '';  // defer to .quiz-section class + .show modifier
    blockActions.style.display  = '';
  }

  if (isSignature) {
    // Show blockActions area for the sign button, but hide the "I've reviewed" button
    blockActions.style.display  = '';
    btnViewed.style.display     = 'none'; // for signature+quiz blocks it is re-shown below
    // Insert or reuse the sign button
    let signBtn = document.getElementById('btnSignDoc');
    if (!signBtn) {
      signBtn = document.createElement('button');
      signBtn.id        = 'btnSignDoc';
      signBtn.className = 'btn btn-primary';
      signBtn.textContent = '✍️ Sign Document';
      signBtn.onclick   = () => openSigningView(block);
      blockActions.appendChild(signBtn);
    } else {
      signBtn.style.display = '';
      signBtn.onclick       = () => openSigningView(block);
    }
    // Signature + quiz blocks: the sign button only appears once the quiz is passed
    if (needsQuiz) {
      signBtn.textContent = '✍️ Sign Document';
      signBtn.style.display = (passed || quizPassedAwaitingSignature.has(block.id)) ? '' : 'none';
    }
    // Reuse what we already learned about this block's form; the files fetch below refreshes it
    applySigningFormAvailability(block, blocksMissingSigningForm.has(block.id) ? false : null);
  } else {
    // Hide the sign button when not a signature block
    const signBtn = document.getElementById('btnSignDoc');
    if (signBtn) signBtn.style.display = 'none';
  }

  // Document Upload and HR Document Upload blocks skip the acknowledge step entirely
  if (isDocUpload || isHRDocUpload) {
    btnViewed.style.display = 'none';
    viewedConfirm.classList.remove('show');
  } else if (!isSignature || needsQuiz) {
    btnViewed.textContent   = '✓ I\'ve reviewed this course — start quiz';
    btnViewed.style.display = (passed || quizPassedAwaitingSignature.has(block.id)) ? 'none' : 'inline-flex';
  }

  if (passed) {
    if (!isDocUpload && !isSignature) {
      viewedConfirm.classList.add('show');
      // Update the confirmation text to a review-mode message (not the "complete quiz" prompt)
      viewedConfirm.innerHTML = '📖 <strong>Reviewing completed course.</strong> Resources and materials are available below.';
    }
    const dateStr = getActiveCompletedMap()[block.id]?.date || '';
    const completedHTML = `
      <div class="quiz-result-title">✅ Already Completed${dateStr ? ' — ' + prettyDay(dateStr) : ''}</div>
      <div class="quiz-result-msg">You've already completed this module. You can review the materials above at any time.</div>
      <button class="btn btn-outline" onclick="goBack()">← Back to Course</button>
    `;
    if (isSignature) {
      // Signature block: show completed notice in viewedConfirm (always visible on block screen)
      viewedConfirm.classList.add('show');
      viewedConfirm.innerHTML = `✅ <strong>Already signed & completed${dateStr ? ' — ' + dateStr : ''}.</strong> You can sign again using the button below.`;
      // Update sign button to "Sign Again"
      const signBtn = document.getElementById('btnSignDoc');
      if (signBtn) { signBtn.textContent = '✍️ Sign Again'; }
    } else if (isDocUpload) {
      uploadSection.classList.add('show');
      quizSection.classList.remove('show');
      document.getElementById('uploadResult').className = 'quiz-result pass show';
      document.getElementById('uploadResult').innerHTML = completedHTML;
    } else {
      showQuiz(block, true);
      quizSection.classList.add('show');
      uploadSection.classList.remove('show');
      quizResult.className = 'quiz-result pass show';
      quizResult.innerHTML = completedHTML;
    }
  } else {
    viewedConfirm.classList.remove('show'); // clear any notice left over from the previous block
    quizSection.classList.remove('show');
    quizResult.className    = 'quiz-result';
    quizResult.style.display = 'none';
    resetQuiz();
    if (needsQuiz && quizPassedAwaitingSignature.has(block.id)) {
      viewedConfirm.classList.add('show');
      viewedConfirm.innerHTML = '✅ <strong>Quiz passed.</strong> Sign the document below to complete this module.';
    }
    if (isDocUpload) {
      // Show upload panel immediately — no acknowledge step needed
      resetUpload();
      uploadSection.classList.add('show');
    } else if (isSignature && !needsQuiz) {
      // Signature block: just show the sign button (already set up above)
      uploadSection.classList.remove('show');
    } else {
      uploadSection.classList.remove('show');
      resetUpload();
    }
  }

  // Show materials section (guidance/forms/media) for all block types.
  // For Document Upload blocks, also append previously-uploaded certificates below.
  // The certificate Solve issued for this block, if any, above its materials.
  if (window.SolveCerts) {
    window.SolveCerts.renderForBlock(block.id, document.getElementById('blockCertificate'));
  }

  const materialsDiv = document.getElementById('blockMaterials');
  if (materialsDiv) {
    const contractorPageId = currentRoleId?.startsWith('__contractor__')
      ? currentRoleId.replace('__contractor__', '')
      : null;
    if (isDocUpload) {
      if (materialsTimer) clearInterval(materialsTimer);
      // Load guidance/forms/media first, then append uploaded certificates beneath them
      loadMaterials(block.id, materialsDiv, true)
        .then(({ hasPdfForm }) => {
          applySigningFormAvailability(block, hasPdfForm);
          return loadCertificates(block.id, materialsDiv, contractorPageId, true);
        });
      materialsTimer = setInterval(
        () => loadMaterials(block.id, materialsDiv, false)
                .then(() => loadCertificates(block.id, materialsDiv, contractorPageId, true)),
        55 * 60 * 1000
      );
    } else {
      loadMaterials(block.id, materialsDiv, true).then(({ count, hasPdfForm }) => {
        applySigningFormAvailability(block, hasPdfForm);
        if (count > 0) renderGuidanceBlurb(block, { isSignature, isDocUpload, isHRDocUpload, needsQuiz, hasMaterials: true });
      });
      if (materialsTimer) clearInterval(materialsTimer);
      materialsTimer = setInterval(() => loadMaterials(block.id, materialsDiv, false), 55 * 60 * 1000);
    }
  }

  showScreen('screenBlock');
  document.getElementById('headerBack').style.display = 'inline-flex';
}

// ============================================================
// VIDEO + PDF HELPERS
// ============================================================

/**
 * Given a URL, return HTML for the training resource area:
 *   – YouTube/Vimeo → responsive iframe embed
 *   – Direct video file → <video> player
 *   – Anything else → plain link box (same look as before)
 */
function buildTrainingResourceHTML(url) {
  if (!url) return '';

  const embed = videoEmbedHtml(url);
  if (embed) {
    let fallbackLabel = null;
    if (/youtube\.com|youtu\.be/.test(url)) fallbackLabel = 'YouTube';
    else if (/vimeo\.com/.test(url)) fallbackLabel = 'Vimeo';
    const fallback = fallbackLabel
      ? `<div class="video-fallback-link"><a href="${escHtml(url)}" target="_blank" rel="noopener">▶ Open on ${fallbackLabel} ↗</a></div>`
      : '';
    return embed + fallback;
  }

  // ── Plain link (default) ──────────────────────────────────
  return `
    <div class="link-box">
      <div class="link-box-icon">🔗</div>
      <div class="link-box-text">
        <div class="link-box-label">Course Resource</div>
        <div class="link-box-url">
          <a href="${escHtml(url)}" target="_blank" rel="noopener">${escHtml(url)}</a>
        </div>
      </div>
    </div>`;
}

// Fetches Open Graph metadata for a block's Training Link and, if a
// title+image were found, upgrades the plain link-box into a rich preview
// card. Silently leaves the plain link box in place otherwise.
function loadLinkPreview(blockId, resourceArea) {
  const linkBox = resourceArea.querySelector('.link-box');
  if (!linkBox) return;
  const url = linkBox.querySelector('.link-box-url a')?.href;
  if (!url) return;

  apiFetch(`/api/block/${blockId}/link-preview`).then(data => {
    if (!data?.image || !data?.title) return;
    linkBox.outerHTML = `
      <a class="link-preview-card" href="${escHtml(url)}" target="_blank" rel="noopener">
        <div class="link-preview-thumb"><img src="${escHtml(data.image)}" alt="" loading="lazy"></div>
        <div class="link-preview-text">
          <div class="link-preview-title">${escHtml(data.title)}</div>
          <div class="link-preview-site">${escHtml(data.siteName || '')}</div>
        </div>
      </a>`;
  }).catch(err => {
    if (err.message === 'session_expired') return;
    console.error('loadLinkPreview error for block', blockId, err);
  });
}

/**
 * Returns embed player HTML for a video URL (YouTube/Vimeo/direct file),
 * or null if the URL isn't a recognized video. Shared by the inline
 * training-resource area and the video popup modal.
 */
function videoEmbedHtml(url, { autoplay = false } = {}) {
  if (!isVideoLink(url)) return null;

  const ytMatch = url.match(
    /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/
  );
  if (ytMatch) {
    const embedUrl = `https://www.youtube-nocookie.com/embed/${ytMatch[1]}?rel=0${autoplay ? '&autoplay=1' : ''}`;
    return `
      <div class="video-embed-wrapper">
        <iframe class="video-embed"
          src="${escHtml(embedUrl)}"
          title="YouTube video"
          frameborder="0"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowfullscreen></iframe>
      </div>`;
  }

  const vimeoMatch = url.match(/vimeo\.com\/(?:video\/)?(\d+)/);
  if (vimeoMatch) {
    const embedUrl = `https://player.vimeo.com/video/${vimeoMatch[1]}?title=0&byline=0&portrait=0${autoplay ? '&autoplay=1' : ''}`;
    return `
      <div class="video-embed-wrapper">
        <iframe class="video-embed"
          src="${escHtml(embedUrl)}"
          title="Vimeo video"
          frameborder="0"
          allow="autoplay; fullscreen; picture-in-picture"
          allowfullscreen></iframe>
      </div>`;
  }

  // Direct video file
  return `
    <video class="video-direct" controls ${autoplay ? 'autoplay' : ''} preload="metadata">
      <source src="${escHtml(url)}">
      <p>Your browser doesn't support HTML5 video.
         <a href="${escHtml(url)}" target="_blank" rel="noopener">Download the video</a>.</p>
    </video>`;
}

// Opens a video (from a material attachment card) in a popup instead of a new tab.
function openVideoModal(url) {
  const embed = videoEmbedHtml(url, { autoplay: true });
  if (!embed) { window.open(url, '_blank', 'noopener'); return; }

  const overlay = document.createElement('div');
  overlay.className = 'video-modal-overlay';
  overlay.innerHTML = `
    <div class="video-modal">
      <button type="button" class="video-modal-close" aria-label="Close video">✕</button>
      <div class="video-modal-body">${embed}</div>
    </div>`;
  document.body.appendChild(overlay);

  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  overlay.querySelector('.video-modal-close').addEventListener('click', close);
  document.addEventListener('keydown', onKey);
}

// Event delegation for material-card video triggers (materialsDiv content is
// re-rendered on every load, so a single body-level listener is used instead
// of binding per-card).
document.addEventListener('click', e => {
  const trigger = e.target.closest('[data-video-url]');
  if (trigger) openVideoModal(trigger.dataset.videoUrl);
});
document.addEventListener('keydown', e => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const trigger = e.target.closest('[data-video-url]');
  if (trigger) { e.preventDefault(); openVideoModal(trigger.dataset.videoUrl); }
});

// ── Material/attachment preview cards ──────────────────────
const MATERIAL_IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'];
const MATERIAL_VIDEO_EXTS = ['mp4', 'mov', 'webm', 'ogg'];
const MATERIAL_TYPE_META = {
  pdf:  { icon: '📕', label: 'PDF' },
  doc:  { icon: '📘', label: 'DOC' },  docx: { icon: '📘', label: 'DOC' },
  ppt:  { icon: '📙', label: 'PPT' },  pptx: { icon: '📙', label: 'PPT' },
  xls:  { icon: '📗', label: 'XLS' },  xlsx: { icon: '📗', label: 'XLS' },  csv: { icon: '📗', label: 'CSV' },
  zip:  { icon: '🗜️', label: 'ZIP' },  rar:  { icon: '🗜️', label: 'RAR' },
  mp4:  { icon: '🎬', label: 'MP4' },  mov:  { icon: '🎬', label: 'MOV' },  webm: { icon: '🎬', label: 'WEBM' },
  mp3:  { icon: '🎵', label: 'MP3' },  wav:  { icon: '🎵', label: 'WAV' },
  txt:  { icon: '📄', label: 'TXT' },
};

function getFileExt(name) {
  const m = /\.([a-z0-9]+)$/i.exec((name || '').split('?')[0]);
  return m ? m[1].toLowerCase() : '';
}

function materialHoverOverlay(label) {
  return `
    <div class="material-card-hover">
      <span class="material-card-open-btn">${label}</span>
    </div>`;
}

function materialCardHtml(f) {
  injectSkeletonStyles();
  const ext  = getFileExt(f.name || f.url || '');
  const url  = escHtml(f.url);
  const name = escHtml(f.name);

  if (MATERIAL_IMAGE_EXTS.includes(ext)) {
    return `
      <a class="material-card" href="${url}" target="_blank" rel="noopener" title="${name}">
        <div class="material-card-thumb thumb-loading">
          <img src="${url}" alt="${name}" loading="lazy" onload="this.parentNode.classList.remove('thumb-loading')" onerror="this.parentNode.classList.remove('thumb-loading')">
          ${materialHoverOverlay('Open ↗')}
        </div>
      </a>`;
  }
  if (ext === 'pdf') {
    return `
      <a class="material-card" href="${url}" target="_blank" rel="noopener" title="${name}">
        <div class="material-card-thumb thumb-loading" data-pdf-url="${url}">
          <canvas></canvas>
          <span class="material-card-icon" style="display:none">📕</span>
          <span class="material-card-ext-badge">PDF</span>
          ${materialHoverOverlay('Open ↗')}
        </div>
      </a>`;
  }
  if (MATERIAL_VIDEO_EXTS.includes(ext)) {
    const meta = MATERIAL_TYPE_META[ext] || { icon: '🎬', label: ext.toUpperCase() };
    return `
      <div class="material-card material-card-clickable" data-video-url="${url}"
           role="button" tabindex="0" title="${name}">
        <div class="material-card-thumb material-card-generic">
          <span class="material-card-icon">${meta.icon}</span>
          <span class="material-card-ext-badge">${meta.label}</span>
          ${materialHoverOverlay('▶ Play')}
        </div>
      </div>`;
  }
  const meta = MATERIAL_TYPE_META[ext] || { icon: '📄', label: ext ? ext.toUpperCase() : 'FILE' };
  return `
    <a class="material-card" href="${url}" target="_blank" rel="noopener" title="${name}">
      <div class="material-card-thumb material-card-generic">
        <span class="material-card-icon">${meta.icon}</span>
        <span class="material-card-ext-badge">${meta.label}</span>
        ${materialHoverOverlay('Open ↗')}
      </div>
    </a>`;
}

// Ensures the pdf.js worker is configured. Safe to call repeatedly.
function ensurePdfWorker() {
  if (typeof pdfjsLib === 'undefined') return false;
  if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
  }
  return true;
}

// Renders a first-page thumbnail into every [data-pdf-url] card inside container.
// Falls back to the 📕 icon per-card if a given PDF can't be loaded/rendered.
async function renderPdfThumbnails(container) {
  const thumbs = container.querySelectorAll('.material-card-thumb[data-pdf-url]');
  if (!thumbs.length) return;
  if (!ensurePdfWorker()) {
    thumbs.forEach(el => showMaterialThumbFallback(el));
    return;
  }
  for (const thumbEl of thumbs) {
    const url = thumbEl.dataset.pdfUrl;
    try {
      const pdf = await pdfjsLib.getDocument(url).promise;
      const page = await pdf.getPage(1);
      const dpr = window.devicePixelRatio || 1;
      const targetWidth = (thumbEl.clientWidth || 160) * dpr;
      const baseViewport = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: targetWidth / baseViewport.width });
      const canvas = thumbEl.querySelector('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      thumbEl.classList.remove('thumb-loading');
    } catch (e) {
      console.error('PDF thumbnail render failed for', url, e);
      showMaterialThumbFallback(thumbEl);
    }
  }
}

function showMaterialThumbFallback(thumbEl) {
  thumbEl.classList.remove('thumb-loading');
  thumbEl.querySelector('canvas')?.remove();
  const iconEl = thumbEl.querySelector('.material-card-icon');
  if (iconEl) iconEl.style.display = '';
}

// Fetch (or silently refresh) signed file URLs for a training block.
// showSpinner=true on first load; false on background refresh so links don't flash.
// Returns a Promise so callers can chain .then() after the DOM is updated.
function loadMaterials(blockId, materialsDiv, showSpinner) {
  if (showSpinner) materialsDiv.innerHTML = '<p class="materials-loading">Loading materials…</p>';
  return apiFetch(`/api/block/${blockId}/files`).then(files => {
    const allFiles = [
      ...(files.associatedForms || []).map(f => ({ ...f, group: 'Associated Forms' })),
      ...(files.guidance        || []).map(f => ({ ...f, group: 'Guidance' })),
      ...(files.media           || []).map(f => ({ ...f, group: 'Files & Media' })),
    ];
    const hasPdfForm = (files.associatedForms || []).some(f => (f.name || '').toLowerCase().endsWith('.pdf'));
    if (!allFiles.length) { materialsDiv.innerHTML = ''; return { count: 0, hasPdfForm }; }
    const groups = {};
    allFiles.forEach(f => {
      if (!groups[f.group]) groups[f.group] = [];
      groups[f.group].push(f);
    });

    materialsDiv.innerHTML = `
      <div class="materials-section">
        <div class="materials-title">📎 Course Materials</div>
        ${Object.entries(groups).map(([label, flist]) => `
          <div class="material-group">
            <div class="material-group-label">${escHtml(label)}</div>
            <div class="material-group-grid">
              ${flist.map(materialCardHtml).join('')}
            </div>
          </div>
        `).join('')}
      </div>
    `;
    renderPdfThumbnails(materialsDiv);
    return { count: allFiles.length, hasPdfForm };
  }).catch(err => {
    if (err.message === 'session_expired') return { count: 0, hasPdfForm: null }; // handled globally
    console.error('loadMaterials error for block', blockId, err);
    if (showSpinner) materialsDiv.innerHTML = `<p class="materials-loading" style="color:var(--danger)">⚠ Could not load materials (${escHtml(err.message)})</p>`;
    return { count: 0, hasPdfForm: null }; // unknown — don't block signing on a transient error
  });
}

function isDocumentUploadBlock(block) {
  return (block?.types || []).some(t => t.toLowerCase().replace(/[\s_-]/g, '') === 'documentupload');
}

/**
 * "Unlock Sequentially" — this block stays locked until **every** course above
 * it on the page is complete, earlier phases included. The ordinary ordering
 * rule only looks within the block's own phase.
 */
function unlocksSequentially(block) {
  return (block?.types || []).some(t => t.toLowerCase().replace(/[\s_-]/g, '') === 'unlocksequentially');
}

function isHRDocumentUploadBlock(block) {
  return (block?.types || []).some(t => t.toLowerCase().replace(/[\s_-]/g, '') === 'hrdocumentupload');
}

function isSignatureBlock(block) {
  return (block?.types || []).includes('Signature Required');
}

// A Signature Required block that also carries any other (non-upload) tag still gets
// that tag's normal quiz — the signature is an extra step on top, not a replacement.
// Plain "Signature Required"-only blocks stay signature-only.
function blockNeedsQuizAndSignature(block) {
  if (!isSignatureBlock(block)) return false;
  if (isDocumentUploadBlock(block) || isHRDocumentUploadBlock(block)) return false;
  // General Resource only controls where a block is listed (the Documents grid), not how it is completed.
  // Completion Certificate only says a certificate is issued on completion — it does not change how the
  // block is completed either. Any new display-only tag must be added here, or every block carrying it
  // starts demanding a quiz and a signature.
  const special = new Set(['signaturerequired', 'documentupload', 'hrdocumentupload', 'generalresource',
                           'completioncertificate', 'unlocksequentially']);
  return (block.types || []).some(t => !special.has(String(t).toLowerCase().replace(/[\s_-]/g, '')));
}

// Blocks whose quiz was passed this session but still await the signature.
// (Completion is only recorded in Notion once the signature is done.)
const quizPassedAwaitingSignature = new Set();

/** Returns true if the URL is a video (YouTube, Vimeo, or direct video file). */
function isVideoLink(url) {
  if (!url) return false;
  if (/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/)|youtu\.be\/)[a-zA-Z0-9_-]{11}/.test(url)) return true;
  if (/vimeo\.com\/\d+/.test(url)) return true;
  if (/\.(mp4|webm|ogg|mov)(\?|$)/i.test(url)) return true;
  return false;
}

function markViewed() {
  document.getElementById('viewedConfirm').classList.add('show');
  document.getElementById('btnViewed').style.display = 'none';
  const block = currentBlocks[currentBlockIndex];

  if (isDocumentUploadBlock(block)) {
    // Show upload section instead of quiz
    resetUpload();
    document.getElementById('uploadSection').classList.add('show');
    document.getElementById('quizSection').classList.remove('show');
  } else {
    showQuiz(block, false);
    document.getElementById('quizSection').classList.add('show');
    document.getElementById('uploadSection').classList.remove('show');
    document.getElementById('quizResult').style.display = 'none';
  }
}

// Fetch and display uploaded certificates for a Document Upload block.
// contractorPageId: scope the lookup to the contractor currently being viewed.
// append: when true, add a certificates section after existing content (e.g. after guidance);
//         when false (default), replace the entire div.
function loadCertificates(blockId, materialsDiv, contractorPageId = null, append = false) {
  if (!append) materialsDiv.innerHTML = '<p class="materials-loading">Loading certificates…</p>';
  // Remove any stale certificates section before (re)inserting
  materialsDiv.querySelector('.certificates-section')?.remove();
  const certUrl = contractorPageId
    ? `/api/block/${blockId}/certificates?contractorId=${encodeURIComponent(contractorPageId)}`
    : `/api/block/${blockId}/certificates`;
  apiFetch(certUrl).then(({ certificates }) => {
    if (!certificates?.length) {
      if (!append) materialsDiv.innerHTML = '';
      return;
    }
    const html = `
      <div class="materials-section certificates-section">
        <div class="materials-title">📎 Uploaded Certificates</div>
        <div class="material-group">
          <div class="material-group-grid">
            ${certificates.map(materialCardHtml).join('')}
          </div>
        </div>
      </div>
    `;
    if (append) {
      materialsDiv.insertAdjacentHTML('beforeend', html);
    } else {
      materialsDiv.innerHTML = html;
    }
    renderPdfThumbnails(materialsDiv.querySelector('.certificates-section') || materialsDiv);
  }).catch(err => {
    if (err.message === 'session_expired') return;
    console.error('loadCertificates error:', err);
    if (!append) materialsDiv.innerHTML = '';
  });
}

// ============================================================
// DOCUMENT SIGNING
// ============================================================

async function openSigningView(block) {
  injectSignStyles();
  showToast('Loading document…');
  try {
    const config = await apiFetch(`/api/block/${block.id}/signing-config`);
    currentSigningConfig = config;
    document.getElementById('signTitle').textContent = block.name;
    // Clear any previous result
    const signResultEl = document.getElementById('signResult');
    if (signResultEl) { signResultEl.className = 'quiz-result'; signResultEl.innerHTML = ''; }
    await renderSigningPDF(config, block);
    setupSignatureNav(config);
    showScreen('screenSign');
    watchSignatureLayout();
    fitSignaturePads();
    document.getElementById('headerBack').style.display = 'inline-flex';
  } catch (err) {
    if (err.message === 'session_expired') return;
    showToast('⚠️ Could not load signing document: ' + err.message);
  }
}

async function renderSigningPDF(config, block) {
  const container = document.getElementById('signPdfContainer');
  container.innerHTML = '';
  // Clear old signature pads
  signaturePads = {};

  if (!config.pdfUrl) {
    container.innerHTML = '<p style="color:var(--danger);padding:16px;">No PDF available for this document.</p>';
    return;
  }

  if (!ensurePdfWorker()) {
    container.innerHTML = '<p style="color:var(--danger);padding:16px;">PDF viewer library not loaded. Please refresh the page.</p>';
    return;
  }

  let pdf;
  try {
    pdf = await pdfjsLib.getDocument(config.pdfUrl).promise;
  } catch (e) {
    container.innerHTML = `<p style="color:var(--danger);padding:16px;">Could not load PDF: ${escHtml(e.message)}</p>`;
    return;
  }

  // Render at up to 1.5x (sharp on desktop). On a phone there is no point rendering far more pixels than
  // the screen can show — smaller canvases also keep long documents from exhausting phone memory.
  const baseW = (await (await pdf.getPage(1)).getViewport({ scale: 1 })).width;
  const dpr   = Math.min(window.devicePixelRatio || 1, 2);
  const scale = Math.max(1, Math.min(1.5, ((window.innerWidth - 32) * dpr) / baseW));

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement('canvas');
    canvas.width  = viewport.width;
    canvas.height = viewport.height;
    // The page is as wide as it was rendered, or as the screen allows if narrower (so desktop is unchanged and
    // a phone shrinks it to fit rather than overflowing). The canvas fills the
    // wrapper and the wrapper takes the canvas's height, so the %-positioned field overlays always line
    // up with the page — on a phone the whole page shrinks to fit instead of overflowing off-screen.
    canvas.style.width  = '100%';
    canvas.style.height = 'auto';
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;

    const pageDiv = document.createElement('div');
    pageDiv.className    = 'sign-page-wrapper';
    pageDiv.style.cssText = `position:relative; display:block; width:min(${viewport.width}px, calc(100vw - 32px)); overflow:visible;`;
    pageDiv.appendChild(canvas);

    // Add field overlays for this page (0-indexed page = pageNum - 1)
    if (!config.addedSignaturePage) {
      // Sort by Y so we can cap each field's height to the space before the next one
      const pageFields = (config.fields || [])
        .filter(f => f.page === pageNum - 1)
        .slice()
        .sort((a, b) => a.y - b.y);
      for (let i = 0; i < pageFields.length; i++) {
        const field = pageFields[i];
        const nextY = pageFields[i + 1]?.y ?? (field.y + field.height + 0.01);
        const maxH  = Math.max(nextY - field.y - 0.005, field.height); // leave 0.5% gap
        addFieldOverlay({ ...field, height: Math.min(field.height, maxH) }, pageDiv, viewport.width, viewport.height);
      }
    }

    container.appendChild(pageDiv);
  }

  // If addedSignaturePage: append a synthetic signature page div
  if (config.addedSignaturePage) {
    // A US-letter page (612x792 pt), at most 918px wide and shrinking to fit the screen. Fields are
    // positioned in % of the page so they stay put at any size.
    const synthDiv = document.createElement('div');
    synthDiv.className = 'sign-synthetic-page';
    synthDiv.style.width  = '100%';
    synthDiv.style.aspectRatio = '612 / 792';

    const today = new Date().toISOString().split('T')[0];
    synthDiv.innerHTML = `
      <h2>Electronic Signature</h2>
      <p>By signing below I confirm I have read and understood the above document.</p>
    `;

    // Render each field defined in the config on this synthetic page
    for (const field of (config.fields || [])) {
      const wrapper = document.createElement('div');
      wrapper.style.cssText = `position:absolute;left:${(field.x * 100).toFixed(3)}%;top:${(field.y * 100).toFixed(3)}%;width:${(field.width * 100).toFixed(3)}%;height:${(field.height * 100).toFixed(3)}%;`;
      wrapper.className = 'sign-field-overlay';
      if (field.type === 'signature' || field.type === 'initials') wrapper.dataset.sig = '1';
      wrapper.dataset.fieldId = field.id; // used by the signature navigation bar

      // Label
      const labelEl = document.createElement('div');
      labelEl.className   = 'sign-field-label';
      labelEl.textContent = field.label || field.id;
      wrapper.appendChild(labelEl);

      if (field.type === 'signature' || field.type === 'initials') {
        bindSignatureTap(wrapper, field);
        const sigCanvas = document.createElement('canvas');
        sigCanvas.width  = 300;   // placeholder — fitSignaturePads() sizes it to its real on-screen size
        sigCanvas.height = 100;
        wrapper.appendChild(sigCanvas);
        if (typeof SignaturePad !== 'undefined') {
          const pad = new SignaturePad(sigCanvas, { penColor: '#1a3c6e' });
          signaturePads[field.id] = pad;
        }
      } else {
        const input = document.createElement('input');
        input.type      = field.type === 'date' ? 'date' : 'text';
        input.className = 'sign-field-input';
        input.dataset.fieldId = field.id;
        // Auto-fill name and date
        if (field.type === 'name' && currentUser?.name)  input.value = currentUser.name;
        if (field.type === 'date') input.value = today;
        wrapper.appendChild(input);
      }

      // Synthetic page is relative-positioned container
      synthDiv.style.position = 'relative';
      synthDiv.appendChild(wrapper);
    }

    const pageDiv = document.createElement('div');
    pageDiv.className = 'sign-page-wrapper';
    pageDiv.style.cssText = 'position:relative; display:block; width:min(918px, calc(100vw - 32px));';
    pageDiv.appendChild(synthDiv);
    container.appendChild(pageDiv);
  }
}

// ── Signature navigation ("Take Me To Signatures" / "Next Signature") ──
let signatureNavEls = [];   // signature/initials overlays in document order
let signatureNavIdx = -1;   // -1 = not started, otherwise the field last scrolled to

function setupSignatureNav(config) {
  const nav = document.getElementById('signNav');
  const sigIds = new Set((config.fields || [])
    .filter(f => f.type === 'signature' || f.type === 'initials')
    .map(f => f.id));
  // DOM order = page order, then top-to-bottom within a page
  signatureNavEls = [...document.querySelectorAll('#signPdfContainer .sign-field-overlay')]
    .filter(el => sigIds.has(el.dataset.fieldId));
  signatureNavIdx = -1;
  if (!signatureNavEls.length) { nav.style.display = 'none'; return; }
  nav.style.display = 'flex';
  updateSignatureNav();
}

function updateSignatureNav() {
  const n = signatureNavEls.length;
  const status = document.getElementById('signNavStatus');
  const btn = document.getElementById('btnSignNext');
  if (n === 1) {
    status.textContent = '1 signature to complete';
    btn.textContent = '✍️ Take Me To Signature';
  } else if (signatureNavIdx < 0) {
    status.textContent = `${n} signatures to complete`;
    btn.textContent = '✍️ Take Me To Signatures';
  } else {
    status.textContent = `Signature ${signatureNavIdx + 1} of ${n}`;
    btn.textContent = signatureNavIdx >= n - 1 ? '↑ Back To First Signature' : 'Next Signature ↓';
  }
}

function goToNextSignature() {
  const n = signatureNavEls.length;
  if (!n) return;
  signatureNavIdx = (signatureNavIdx + 1) % n;
  const el = signatureNavEls[signatureNavIdx];

  // Offsets of the sticky app header and this bar so the field lands in clear view
  const header = document.getElementById('appHeader');
  const headerH = header && getComputedStyle(header).display !== 'none' ? header.offsetHeight : 0;
  const nav = document.getElementById('signNav');
  nav.style.top = headerH + 'px';
  const clear = headerH + nav.offsetHeight;
  const r = el.getBoundingClientRect();
  const spare = Math.max(32, (window.innerHeight - clear - r.height) / 2);
  window.scrollTo({ top: Math.max(0, window.scrollY + r.top - clear - spare), behavior: 'smooth' });

  el.classList.remove('sign-field-flash');
  void el.offsetWidth; // restart the animation
  el.classList.add('sign-field-flash');
  setTimeout(() => el.classList.remove('sign-field-flash'), 1500);
  updateSignatureNav();
}

// Keep the sticky bar flush under the header when it changes height (mobile rotation etc.)
window.addEventListener('resize', () => {
  const nav = document.getElementById('signNav');
  const header = document.getElementById('appHeader');
  if (nav && header) nav.style.top = (getComputedStyle(header).display !== 'none' ? header.offsetHeight : 0) + 'px';
});

function addFieldOverlay(field, pageDiv, pageW, pageH) {
  const xPct    = (field.x      * 100).toFixed(3);
  const yPct    = (field.y      * 100).toFixed(3);
  const wPct    = (field.width  * 100).toFixed(3);
  const hPct    = (field.height * 100).toFixed(3);
  const displayH = Math.max(parseFloat(hPct), 2).toFixed(3);
  const isSig   = field.type === 'signature' || field.type === 'initials';

  const overlay = document.createElement('div');
  overlay.className = 'sign-field-overlay';
  overlay.dataset.fieldId = field.id;
  if (isSig) overlay.dataset.sig = '1';
  overlay.style.cssText = [
    `position:absolute`,
    `left:${xPct}%`, `top:${yPct}%`,
    `width:${wPct}%`, `height:${displayH}%`,
    `border:${isSig ? '2px' : '1.5px'} dashed #2a9640`,
    `border-radius:3px`,
    `background:${isSig ? 'rgba(42,150,64,0.06)' : 'rgba(42,150,64,0.04)'}`,
    `box-sizing:border-box`,
  ].join(';');

  // ── Drag handle — sits OUTSIDE the box to the left ───────
  const handle = document.createElement('div');
  handle.style.cssText = [
    'position:absolute', 'top:0', 'left:-20px', // outside the overlay
    'width:18px', 'height:100%',
    'background:#2a9640', 'border-radius:3px 0 0 3px',
    'cursor:grab', 'z-index:10',
    'display:flex', 'align-items:center', 'justify-content:center',
    'font-size:9px', 'color:#fff', 'line-height:1', 'user-select:none',
  ].join(';');
  handle.textContent = '⠿';
  handle.dataset.dragHandle = '1';

  // Tooltip
  const tooltip = document.createElement('div');
  tooltip.textContent = 'Drag to reposition';
  tooltip.style.cssText = [
    'position:absolute', 'left:22px', 'top:50%', 'transform:translateY(-50%)',
    'background:#1a1a1a', 'color:#fff',
    'font-size:10px', 'white-space:nowrap',
    'padding:3px 7px', 'border-radius:4px',
    'pointer-events:none', 'opacity:0',
    'transition:opacity 0.15s', 'z-index:20',
  ].join(';');
  // Arrow pointing right toward the handle
  tooltip.style.cssText += ';box-shadow:0 1px 4px rgba(0,0,0,0.25)';
  handle.appendChild(tooltip);

  handle.addEventListener('mouseenter', () => { tooltip.style.opacity = '1'; });
  handle.addEventListener('mouseleave', () => { tooltip.style.opacity = '0'; });

  overlay.appendChild(handle);

  // Label (sits above the field, hidden during drag)
  const labelEl = document.createElement('div');
  labelEl.textContent = field.label || field.id;
  labelEl.style.cssText = 'position:absolute; top:-16px; left:0; font-size:9px; color:#2a9640; font-weight:600; white-space:nowrap; pointer-events:none;';
  overlay.appendChild(labelEl);

  const today = new Date().toISOString().split('T')[0];

  if (isSig) {
    const pxW = Math.round(field.width * pageW);
    const pxH = Math.round(parseFloat(displayH) / 100 * pageH);
    const sigCanvas = document.createElement('canvas');
    sigCanvas.width  = pxW;
    sigCanvas.height = pxH;
    sigCanvas.style.cssText = 'display:block; width:100%; height:100%; cursor:crosshair;';
    overlay.appendChild(sigCanvas);
    if (typeof SignaturePad !== 'undefined') {
      const pad = new SignaturePad(sigCanvas, { penColor: '#1a3c6e', minWidth: 1, maxWidth: 2.5 });
      signaturePads[field.id] = pad;
    }
  } else {
    const input = document.createElement('input');
    input.type = field.type === 'date' ? 'date' : 'text';
    input.dataset.fieldId = field.id;
    input.style.cssText = 'width:100%; height:100%; border:none; background:transparent; font-size:11px; padding:0 4px; box-sizing:border-box; font-family:inherit; color:#1a1a1a; outline:none;';
    if (field.type === 'name' && currentUser?.name) input.value = currentUser.name;
    if (field.type === 'date') input.value = today;
    overlay.appendChild(input);
  }

  pageDiv.appendChild(overlay);
  makeDraggable(handle, overlay, field, pageDiv, pageW, pageH);
  if (isSig) bindSignatureTap(overlay, field);
}

// Drag-to-reposition — pointer events so it works on mouse and touch
function makeDraggable(handle, overlay, field, pageDiv, pageW, pageH) {
  let startPx, startPy, startLeft, startTop;

  handle.addEventListener('pointerdown', e => {
    e.preventDefault();
    handle.style.cursor = 'grabbing';
    handle.setPointerCapture(e.pointerId);

    // Current pixel offsets of the overlay within pageDiv
    startPx   = e.clientX;
    startPy   = e.clientY;
    startLeft = parseFloat(overlay.style.left);  // already in %
    startTop  = parseFloat(overlay.style.top);

    // Temporarily raise z-index so it floats above siblings
    overlay.style.zIndex = '100';
  });

  handle.addEventListener('pointermove', e => {
    if (!handle.hasPointerCapture(e.pointerId)) return;

    // Convert pixel delta → % of pageDiv (its current on-screen size — pages shrink to fit phones)
    const box = pageDiv.getBoundingClientRect();
    const deltaXPct = (e.clientX - startPx) / (box.width  || pageW) * 100;
    const deltaYPct = (e.clientY - startPy) / (box.height || pageH) * 100;

    const newLeft = Math.max(0, Math.min(100 - parseFloat(overlay.style.width),  startLeft + deltaXPct));
    const newTop  = Math.max(0, Math.min(100 - parseFloat(overlay.style.height), startTop  + deltaYPct));

    overlay.style.left = newLeft.toFixed(3) + '%';
    overlay.style.top  = newTop.toFixed(3)  + '%';
  });

  handle.addEventListener('pointerup', e => {
    handle.style.cursor = 'grab';
    overlay.style.zIndex = '';

    // Persist new position back into currentSigningConfig
    const newX = parseFloat(overlay.style.left)  / 100;
    const newY = parseFloat(overlay.style.top)   / 100;
    if (currentSigningConfig?.fields) {
      const f = currentSigningConfig.fields.find(f => f.id === field.id);
      if (f) { f.x = newX; f.y = newY; }
    }

    // Auto-save corrected positions to server so they persist for future users
    if (currentSigningConfig?.blockId) {
      apiFetch(`/api/block/${currentSigningConfig.blockId}/signing-cache`, 'PATCH',
        { fields: currentSigningConfig.fields }
      ).catch(() => {}); // fire-and-forget
    }
  });
}

// A signature canvas's drawing buffer must match its on-screen size or strokes land in the wrong place.
// The size changes with the screen (phones shrink the page to fit), so measure instead of assuming;
// strokes already drawn are kept and rescaled when the size changes (rotation, window resize).
function fitSignaturePads() {
  const ratio = Math.min(Math.max(window.devicePixelRatio || 1, 1), 3);
  for (const pad of Object.values(signaturePads)) {
    const canvas = pad.canvas;
    if (!canvas) continue;
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) continue;                 // screen not visible yet
    const w = Math.round(r.width * ratio), h = Math.round(r.height * ratio);
    if (canvas.width === w && canvas.height === h && canvas._cssW) continue;
    const data = pad.toData();
    const kx = canvas._cssW ? r.width  / canvas._cssW : 1;
    const ky = canvas._cssH ? r.height / canvas._cssH : 1;
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').scale(ratio, ratio);
    pad.clear();
    if (canvas._imgUrl) {
      pad.fromDataURL(canvas._imgUrl, { ratio, width: r.width, height: r.height });   // signed via the phone pad
    } else if (data.length && canvas._cssW) {
      data.forEach(g => g.points.forEach(pt => { pt.x *= kx; pt.y *= ky; }));
      pad.fromData(data);
    }
    canvas._cssW = r.width; canvas._cssH = r.height;
  }
}
let signFitFrame = 0, signResizeObserver = null;
function scheduleSignaturePadFit() {
  cancelAnimationFrame(signFitFrame);
  signFitFrame = requestAnimationFrame(fitSignaturePads);
}
function watchSignatureLayout() {
  if (signResizeObserver || typeof ResizeObserver === 'undefined') return;
  signResizeObserver = new ResizeObserver(scheduleSignaturePadFit);
  signResizeObserver.observe(document.getElementById('signPdfContainer'));
  window.addEventListener('orientationchange', scheduleSignaturePadFit);
}

function clearAllSignatures() {
  for (const pad of Object.values(signaturePads)) {
    pad.clear();
    if (pad.canvas) {
      delete pad.canvas._imgUrl;
      const ov = pad.canvas.closest('.sign-field-overlay');
      if (ov) ov.classList.remove('is-signed');
    }
  }
}

// ── Phone signing: tap a signature box → roomy full-width pad ──
// A page shrunk to a phone's width leaves signature boxes only a few millimetres tall, and dense forms
// put several fields a finger-width apart. So on a phone the box is a tap target ("Tap to sign") that
// opens a big pad; Done trims the signature and fits it into the box. Desktop signs in place as before.
const isPhoneLayout = () => window.matchMedia('(max-width: 700px)').matches;

function injectSignStyles() {
  if (document.getElementById('signPadStyles')) return;
  const st = document.createElement('style');
  st.id = 'signPadStyles';
  st.textContent = `
    @media (max-width: 700px) {
      #screenSign { padding: 12px 8px; }
      .sign-field-overlay[data-sig="1"] { min-height: 44px; z-index: 5; cursor: pointer; }
      .sign-field-overlay:not([data-sig]) { min-height: 28px; }
      .sign-field-overlay input { font-size: 16px !important; }   /* 16px stops iOS zooming the page on focus */
      .sign-field-overlay[data-sig="1"] canvas { pointer-events: none; }
      .sign-field-overlay[data-sig="1"]:not(.is-signed)::after { content: 'Tap to sign'; position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font: 700 12px/1 -apple-system, "Segoe UI", sans-serif; color: #2a9640; pointer-events: none; }
      .sign-field-overlay.is-signed { background: rgba(42,150,64,0.12) !important; }
      .sign-nav { top: 100px; }
      .sign-synthetic-page { padding: 6% 7%; }
      .sign-synthetic-page h2 { font-size: 16px; }
    }
    #signPadModal { position: fixed; inset: 0; z-index: 10070; background: rgba(8,18,10,0.62); display: flex; align-items: flex-end; justify-content: center; }
    #signPadModal .sp-sheet { background: #fff; color: #152219; width: 100%; max-width: 640px; box-sizing: border-box; padding: 16px 16px calc(16px + env(safe-area-inset-bottom)); border-radius: 16px 16px 0 0; box-shadow: 0 -8px 30px rgba(0,0,0,0.3); }
    #signPadModal .sp-title { font: 700 16px -apple-system, "Segoe UI", sans-serif; margin-bottom: 10px; }
    #signPadModal .sp-canvas { display: block; width: 100%; height: 220px; box-sizing: border-box; border: 2px dashed #2a9640; border-radius: 10px; background: #fff; touch-action: none; }
    #signPadModal .sp-hint { font: 500 12px -apple-system, "Segoe UI", sans-serif; color: rgba(0,0,0,0.5); margin: 8px 0 12px; }
    #signPadModal .sp-actions { display: flex; gap: 10px; }
    #signPadModal .sp-actions .btn { flex: 1; justify-content: center; }`;
  document.head.appendChild(st);
}

function bindSignatureTap(overlayEl, field) {
  overlayEl.addEventListener('click', (e) => {
    if (!isPhoneLayout() || e.target.closest('[data-drag-handle]')) return;
    openSignaturePadModal(field.id, field.label || (field.type === 'initials' ? 'Initials' : 'Signature'));
  });
}

let signPadModal = null;
function closeSignaturePadModal() {
  if (!signPadModal) return;
  signPadModal.remove();
  signPadModal = null;
  document.body.style.overflow = '';
}

// Crop a canvas to the pixels that were drawn on (null if blank)
function trimCanvas(src) {
  const { width: w, height: h } = src;
  const d = src.getContext('2d').getImageData(0, 0, w, h).data;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4 + 3] > 8) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    }
  }
  if (maxX < 0) return null;
  const pad = 4;
  minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
  maxX = Math.min(w - 1, maxX + pad); maxY = Math.min(h - 1, maxY + pad);
  const out = document.createElement('canvas');
  out.width = maxX - minX + 1; out.height = maxY - minY + 1;
  out.getContext('2d').drawImage(src, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

// Fit the trimmed signature into the field's own pad (same aspect ratio as the stamped box → no distortion)
async function applyPhoneSignature(targetPad, drawn) {
  const trimmed = trimCanvas(drawn);
  if (!trimmed) return false;
  const c = targetPad.canvas;
  const ratio = Math.min(Math.max(window.devicePixelRatio || 1, 1), 3);
  const tmp = document.createElement('canvas');
  tmp.width = c.width; tmp.height = c.height;
  const margin = 4 * ratio;
  const k = Math.min((tmp.width - margin * 2) / trimmed.width, (tmp.height - margin * 2) / trimmed.height);
  const dw = trimmed.width * k, dh = trimmed.height * k;
  tmp.getContext('2d').drawImage(trimmed, (tmp.width - dw) / 2, (tmp.height - dh) / 2, dw, dh);
  const url = tmp.toDataURL('image/png');
  c._imgUrl = url;
  targetPad.clear();
  await targetPad.fromDataURL(url, { ratio, width: tmp.width / ratio, height: tmp.height / ratio });
  const ov = c.closest('.sign-field-overlay');
  if (ov) ov.classList.add('is-signed');
  return true;
}

function openSignaturePadModal(fieldId, label) {
  const target = signaturePads[fieldId];
  if (!target || typeof SignaturePad === 'undefined') return;
  closeSignaturePadModal();
  injectSignStyles();

  const wrap = document.createElement('div');
  wrap.id = 'signPadModal';
  wrap.innerHTML = `
    <div class="sp-sheet" role="dialog" aria-modal="true">
      <div class="sp-title"></div>
      <canvas class="sp-canvas"></canvas>
      <div class="sp-hint">Sign with your finger inside the box.</div>
      <div class="sp-actions">
        <button class="btn btn-outline" data-a="clear">Clear</button>
        <button class="btn btn-outline" data-a="cancel">Cancel</button>
        <button class="btn btn-primary" data-a="done">Done</button>
      </div>
    </div>`;
  wrap.querySelector('.sp-title').textContent = label;
  document.body.appendChild(wrap);
  document.body.style.overflow = 'hidden';
  signPadModal = wrap;

  const canvas = wrap.querySelector('canvas');
  const ratio = Math.min(Math.max(window.devicePixelRatio || 1, 1), 3);
  const r = canvas.getBoundingClientRect();
  canvas.width = Math.round(r.width * ratio);
  canvas.height = Math.round(r.height * ratio);
  canvas.getContext('2d').scale(ratio, ratio);
  const pad = new SignaturePad(canvas, { penColor: '#1a3c6e', minWidth: 1.2, maxWidth: 3.2 });

  wrap.addEventListener('click', async (e) => {
    const a = e.target.dataset && e.target.dataset.a;
    if (e.target === wrap || a === 'cancel') return closeSignaturePadModal();
    if (a === 'clear') return pad.clear();
    if (a === 'done') {
      if (pad.isEmpty()) { showToast('Please sign in the box first'); return; }
      await applyPhoneSignature(target, canvas);
      closeSignaturePadModal();
    }
  });
}

async function submitSignedDocument() {
  if (!currentSigningConfig) return;
  const block = currentBlocks[currentBlockIndex];
  const resultEl = document.getElementById('signResult');
  const btnEl    = document.getElementById('btnSubmitSign');

  // Validate: all signature/initials pads must not be empty
  for (const field of (currentSigningConfig.fields || [])) {
    if (field.type === 'signature' || field.type === 'initials') {
      const pad = signaturePads[field.id];
      if (pad && pad.isEmpty()) {
        resultEl.className = 'quiz-result fail show';
        resultEl.innerHTML = `<div class="quiz-result-title">⚠️ Please sign the <strong>${escHtml(field.label || field.id)}</strong> field before submitting.</div>`;
        resultEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        return;
      }
    }
  }

  // Collect field values
  const fieldValues = {};
  for (const field of (currentSigningConfig.fields || [])) {
    if (field.type === 'signature' || field.type === 'initials') {
      const pad = signaturePads[field.id];
      if (pad && !pad.isEmpty()) {
        fieldValues[field.id] = pad.toDataURL('image/png');
      }
    } else {
      // Find the input element
      // Target input specifically — the overlay div also carries data-field-id so a generic
      // querySelector would match the div first and return undefined for .value
      const input = document.querySelector(`input[data-field-id="${CSS.escape(field.id)}"]`);
      if (input) fieldValues[field.id] = input.value;
    }
  }

  btnEl.disabled    = true;
  btnEl.textContent = 'Submitting…';
  resultEl.className = 'quiz-result';
  resultEl.innerHTML = '';

  try {
    const result = await apiFetch('/api/sign-document', 'POST', {
      blockId:     currentSigningConfig.blockId,
      fieldValues,
      roleName:    currentRoleName(),
    });

    // Mark block complete locally
    markBlockCompleteLocally(block.id, { date: result.date, recordId: result.recordId, status: 'OK' });
    quizPassedAwaitingSignature.delete(block.id);

    resultEl.className = 'quiz-result pass show';
    resultEl.innerHTML = `
      <div class="quiz-result-title">🎉 Document signed — course complete!</div>
      <div class="quiz-result-msg">Your signed document has been saved. This module is now marked complete.</div>
      <button class="btn btn-outline" onclick="goBack()">← Back to Course</button>
    `;
    btnEl.style.display = 'none';
    showToast('Document signed successfully ✅');
    awardCertificate(result.certificate);
    // Re-render the course to update progress
    renderCourse(currentBlocks);
  } catch (err) {
    if (err.message === 'session_expired') return;
    resultEl.className = 'quiz-result fail show';
    resultEl.innerHTML = `<div class="quiz-result-title">❌ Signing failed: ${escHtml(err.message)}</div>`;
    btnEl.disabled    = false;
    btnEl.textContent = '✍️ Sign & Submit';
  }
}

// ============================================================
// DOCUMENT UPLOAD
// ============================================================
let uploadFiles = [];

function resetUpload() {
  uploadFiles = [];
  const input = document.getElementById('uploadFileInput');
  if (input) input.value = '';
  renderUploadFileList();
  const result = document.getElementById('uploadResult');
  if (result) { result.className = 'quiz-result'; result.innerHTML = ''; }
  const btn = document.getElementById('btnSubmitUpload');
  if (btn) { btn.disabled = false; btn.textContent = 'Submit Certificate'; }
}

function renderUploadFileList() {
  const list = document.getElementById('uploadFileList');
  if (!list) return;
  if (!uploadFiles.length) {
    list.innerHTML = '';
    document.getElementById('uploadLabelText').textContent = 'Click to select files or drag and drop here';
    return;
  }
  document.getElementById('uploadLabelText').textContent = 'Add more files';
  list.innerHTML = uploadFiles.map((f, i) => `
    <div class="upload-file-item">
      📄 ${escHtml(f.name)} <span style="color:var(--gray);font-size:11px">(${(f.size/1024).toFixed(0)} KB)</span>
      <button class="remove-file" onclick="removeUploadFile(${i})" title="Remove">✕</button>
    </div>
  `).join('');
}

function removeUploadFile(idx) {
  uploadFiles.splice(idx, 1);
  renderUploadFileList();
}

// Wire up file input and drag-drop after DOM is ready
window.addEventListener('load', () => {
  const input   = document.getElementById('uploadFileInput');
  const dropZone = document.getElementById('uploadDropZone');
  if (!input || !dropZone) return;

  input.addEventListener('change', () => {
    uploadFiles = [...uploadFiles, ...Array.from(input.files)];
    input.value = '';
    renderUploadFileList();
  });

  dropZone.addEventListener('dragover',  e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    uploadFiles = [...uploadFiles, ...Array.from(e.dataTransfer.files)];
    renderUploadFileList();
  });
});

async function submitUpload() {
  const block    = currentBlocks[currentBlockIndex];
  const resultEl = document.getElementById('uploadResult');
  const btnEl    = document.getElementById('btnSubmitUpload');
  const isHRDoc  = isHRDocumentUploadBlock(block);

  if (!uploadFiles.length) {
    resultEl.className = 'quiz-result fail show';
    resultEl.innerHTML = '<div class="quiz-result-title">⚠️ Please select at least one file to upload.</div>';
    return;
  }

  btnEl.disabled    = true;
  btnEl.textContent = 'Uploading…';
  resultEl.className = 'quiz-result';
  resultEl.innerHTML = '';

  try {
    const formData = new FormData();
    formData.append('blockId', block.id);
    if (currentRoleName()) formData.append('roleName', currentRoleName());
    uploadFiles.forEach(f => formData.append('files', f));

    const endpoint = isHRDoc ? '/api/upload-hr-document' : '/api/upload-certificate';
    const res  = await SolveNet.fetch(endpoint, {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${authToken}` },
      body:    formData,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(SolveNet.friendlyError(res, data));

    // Mark locally as complete
    if (!trainingData.completedMap) trainingData.completedMap = {};
    trainingData.completedMap[block.id] = { date: data.date, recordId: data.recordId, status: 'OK' };
    saveCache(trainingData);
    awardCertificate(data.certificate);

    if (isHRDoc) {
      resultEl.className = 'quiz-result pass show';
      resultEl.innerHTML = `
        <div class="quiz-result-title">✅ Document submitted</div>
        <div class="quiz-result-msg">
          The following file(s) have been securely filed:
          <ul style="margin:8px 0 8px 18px;text-align:left">${data.files.map(f => `<li>${escHtml(f)}</li>`).join('')}</ul>
          This module is now marked complete.
        </div>
        <button class="btn btn-outline" onclick="goBack()">← Back to Course</button>
      `;
      showToast('HR document submitted ✅');
    } else {
      resultEl.className = 'quiz-result pass show';
      resultEl.innerHTML = `
        <div class="quiz-result-title">🎉 Certificate uploaded — course complete!</div>
        <div class="quiz-result-msg">Your document has been saved. This module is now marked complete.</div>
        <button class="btn btn-outline" onclick="goBack()">← Back to Course</button>
      `;
      showToast('Certificate uploaded successfully ✅');
      // Refresh the certificates panel to show the newly uploaded file (append beneath guidance)
      const mDiv = document.getElementById('blockMaterials');
      if (mDiv) {
        const contractorPageId = currentRoleId?.startsWith('__contractor__')
          ? currentRoleId.replace('__contractor__', '')
          : null;
        loadCertificates(block.id, mDiv, contractorPageId, true);
      }
    }

    document.getElementById('btnSubmitUpload').style.display = 'none';

  } catch (err) {
    resultEl.className = 'quiz-result fail show';
    resultEl.innerHTML = `<div class="quiz-result-title">❌ Upload failed: ${escHtml(err.message)}</div>`;
    btnEl.disabled    = false;
    btnEl.textContent = isHRDoc ? 'Submit Document' : 'Submit Certificate';
  }
}

// ============================================================
// QUIZ
// ============================================================
let quizState = { selected: {} };

function resetQuiz() {
  quizState = { selected: {} };
  document.getElementById('quizQuestions').innerHTML  = '';
  document.getElementById('btnSubmitQuiz').style.display = 'inline-flex';
  document.getElementById('quizResult').style.display = 'none';
}

// Blocks the server has said (404) have no quiz at all. Only for those is the generic fallback legitimate:
// a quiz that has merely not loaded yet, or failed to load, must never turn into a 2-question "quiz" that a
// person can pass (or that a completed block shows in review).
const noServerQuiz = {};

function hasQuiz(block) {
  const key = block.id.replace(/-/g, '');
  return !!(dynamicQuizzes[key] || QUIZ_MAP[key] || noServerQuiz[key]);
}

function getQuiz(block) {
  const key = block.id.replace(/-/g, '');
  // Dynamic (AI-generated) quizzes take priority over the static QUIZ_MAP;
  // genericQuiz only when the server confirmed there is no quiz for the block.
  return dynamicQuizzes[key] || QUIZ_MAP[key] || (noServerQuiz[key] ? genericQuiz(block.name) : null);
}

// Draw a block's quiz once it has actually loaded. Opening an already-passed block used to draw the review
// straight away, before the fetch finished, so it showed the generic 2-question quiz instead of the real one.
async function showQuiz(block, readonly) {
  if (!hasQuiz(block)) {
    const container = document.getElementById('quizQuestions');
    container.innerHTML = '<p class="materials-loading">Loading quiz…</p>';
    document.getElementById('btnSubmitQuiz').style.display = 'none';
    const status = await prefetchQuizForBlock(block.id);
    if (currentBlocks[currentBlockIndex]?.id !== block.id) return;   // they moved on while it loaded
    if (!hasQuiz(block) || status === 'error') {
      if (!hasQuiz(block)) {
        container.innerHTML = '<p class="materials-loading" style="color:var(--danger)">⚠ Could not load the quiz. <button type="button" class="resource-more-btn" id="quizRetryBtn">Try again</button></p>';
        container.querySelector('#quizRetryBtn').onclick = () => showQuiz(block, readonly);
        return;
      }
    }
  }
  renderQuiz(block, readonly);
}

// Lazy-loads the quiz for a single block and merges it into dynamicQuizzes.
// Called in openBlock() so the quiz is ready before the user taps "Start Quiz".
// Resolves 'ok' | 'none' (server says no quiz exists) | 'error' (could not find out). Requests for the
// same block share one in-flight fetch.
const quizFetches = {};
function prefetchQuizForBlock(blockId) {
  const key = blockId.replace(/-/g, '');
  if (dynamicQuizzes[key]) return Promise.resolve('ok'); // already cached this session
  if (quizFetches[key]) return quizFetches[key];
  quizFetches[key] = (async () => {
    try {
      const data = await apiFetch(`/api/quizzes/${key}`);
      if (data && typeof data === 'object' && data[key]) { Object.assign(dynamicQuizzes, data); return 'ok'; }
      return 'error';
    } catch (err) {
      if (err.status === 404) { noServerQuiz[key] = true; return 'none'; }   // no AI quiz yet: the static / generic one is right
      return 'error';
    } finally {
      delete quizFetches[key];
    }
  })();
  return quizFetches[key];
}

function renderQuiz(block, readonly) {
  const questions = getQuiz(block);
  if (!questions) return;   // callers go through showQuiz(), which waits for the quiz
  const container = document.getElementById('quizQuestions');
  container.innerHTML = '';
  quizState = { selected: {} };

  for (let qi = 0; qi < questions.length; qi++) {
    const q    = questions[qi];
    const card = document.createElement('div');
    card.className   = 'question-card';
    card.innerHTML   = `<div class="question-text">Q${qi+1}. ${escHtml(q.q)}</div><div class="option-list" id="opts-${qi}"></div>`;
    container.appendChild(card);
    const optList = card.querySelector(`#opts-${qi}`);

    for (let oi = 0; oi < q.options.length; oi++) {
      const btn = document.createElement('button');
      btn.className    = 'option-btn';
      btn.textContent  = q.options[oi];
      btn.dataset.qi   = qi;
      btn.dataset.oi   = oi;
      if (!readonly) {
        btn.onclick = () => selectOption(qi, oi);
      } else {
        btn.disabled = true;
        if (oi === q.correct) btn.classList.add('correct');
      }
      optList.appendChild(btn);
    }
  }
  document.getElementById('btnSubmitQuiz').style.display = readonly ? 'none' : 'inline-flex';
}

function selectOption(qi, oi) {
  quizState.selected[qi] = oi;
  const opts = document.querySelectorAll(`#opts-${qi} .option-btn`);
  opts.forEach((b, i) => b.classList.toggle('selected', i === oi));
}

async function submitQuiz() {
  const block     = currentBlocks[currentBlockIndex];
  const questions = getQuiz(block);
  if (!questions) { showToast('⚠️ The quiz has not loaded yet — please wait a moment.'); return; }
  let allAnswered = true;
  let correct     = 0;

  for (let qi = 0; qi < questions.length; qi++) {
    if (quizState.selected[qi] === undefined) { allAnswered = false; break; }
  }
  if (!allAnswered) {
    alert('Please answer all questions before submitting.');
    return;
  }

  for (let qi = 0; qi < questions.length; qi++) {
    const q      = questions[qi];
    const chosen = quizState.selected[qi];
    const opts   = document.querySelectorAll(`#opts-${qi} .option-btn`);
    opts.forEach((b, i) => {
      b.disabled = true;
      if (i === q.correct) b.classList.add(chosen === i ? 'correct' : 'show-correct');
      else if (i === chosen && i !== q.correct) b.classList.add('incorrect');
    });
    if (chosen === q.correct) correct++;
  }

  const passed    = correct === questions.length;
  const resultDiv = document.getElementById('quizResult');
  resultDiv.style.display = 'block';
  resultDiv.className     = 'quiz-result show ' + (passed ? 'pass' : 'fail');

  if (passed && blockNeedsQuizAndSignature(block)) {
    // Signature + quiz block: passing the quiz is only half the job. Don't record
    // completion yet — that happens when the document is signed.
    document.getElementById('btnSubmitQuiz').style.display = 'none';
    quizPassedAwaitingSignature.add(block.id);
    resultDiv.innerHTML = `
      <div class="quiz-result-title">🎉 Passed! ${correct}/${questions.length} correct</div>
      ${blocksMissingSigningForm.has(block.id)
        ? `<div class="quiz-result-msg">The document to sign isn't ready yet — please contact your manager to finish this module.</div>`
        : `<div class="quiz-result-msg">One more step — sign the document to complete this module.</div>`}
      <div style="display:flex;gap:10px;flex-wrap:wrap;">
        ${blocksMissingSigningForm.has(block.id) ? '' : `<button class="btn btn-primary" onclick="openSigningView(currentBlocks[currentBlockIndex])">✍️ Sign Document</button>`}
        <button class="btn btn-outline" onclick="goBack()">← Back to Overview</button>
      </div>
    `;
    const signBtn = document.getElementById('btnSignDoc');
    if (signBtn) signBtn.style.display = blocksMissingSigningForm.has(block.id) ? 'none' : '';

  } else if (passed) {
    document.getElementById('btnSubmitQuiz').style.display = 'none';

    // Record completion in Notion
    const today   = new Date().toISOString().split('T')[0];
    let savingMsg = '<span class="saving-badge">⏳ Saving to Notion…</span>';

    const isLast = currentBlockIndex === currentBlocks.length - 1;
    resultDiv.innerHTML = `
      <div class="quiz-result-title">🎉 Passed! ${correct}/${questions.length} correct ${savingMsg}</div>
      <div class="quiz-result-msg">Great work — this module is complete.</div>
    `;

    // Update local completedMap immediately for smooth UX
    markBlockCompleteLocally(block.id, { date: today, recordId: null, status: 'OK' });

    try {
      const result = await apiFetch('/api/complete', 'POST', { blockId: block.id, blockName: block.name, roleName: currentRoleName() });
      markBlockCompleteLocally(block.id, { date: today, recordId: result.recordId, status: 'OK' });
      awardCertificate(result.certificate);

      resultDiv.innerHTML = `
        <div class="quiz-result-title">🎉 Passed! ${correct}/${questions.length} correct ✅</div>
        <div class="quiz-result-msg">Great work — this module is complete and recorded in Notion.</div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;">
          ${isLast
            ? `<button class="btn btn-primary" onclick="finishCourse()">🏆 Complete Course</button>`
            : `<button class="btn btn-primary" onclick="nextBlock()">Next Module →</button>`}
          <button class="btn btn-outline" onclick="goBack()">← Back to Overview</button>
        </div>
      `;
      // Re-render the course with current blocks to update progress
      renderCourse(currentBlocks);
    } catch (err) {
      // Keep the pass on this device and keep trying in the background — no need to redo the quiz
      queueCompletion(block);
      resultDiv.innerHTML = `
        <div class="quiz-result-title">🎉 Passed! ${correct}/${questions.length} correct ⚠️</div>
        <div class="quiz-result-msg">You passed, and it's saved on this device. We couldn't record it in the course system just now (${escHtml(err.message)}), so we'll keep trying automatically — you don't need to redo the quiz.</div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;">
          ${isLast
            ? `<button class="btn btn-primary" onclick="finishCourse()">🏆 Complete Course</button>`
            : `<button class="btn btn-primary" onclick="nextBlock()">Next Module →</button>`}
          <button class="btn btn-outline" onclick="goBack()">← Back to Overview</button>
        </div>
      `;
      // Re-render the course with current blocks to update progress
      renderCourse(currentBlocks);
    }

  } else {
    resultDiv.innerHTML = `
      <div class="quiz-result-title">❌ ${correct}/${questions.length} correct — not passed</div>
      <div class="quiz-result-msg">Review the course material and try again. You must answer all questions correctly to advance.</div>
      <button class="btn btn-danger" onclick="retryQuiz()">↩ Retry Quiz</button>
    `;
  }

  resultDiv.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function retryQuiz() {
  const block = currentBlocks[currentBlockIndex];
  showQuiz(block, false);
  document.getElementById('quizResult').style.display = 'none';
  document.getElementById('quizSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function nextBlock() {
  openBlock(currentBlockIndex + 1);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function finishCourse() {
  renderCompletion();
  showScreen('screenComplete');
}

// ============================================================
// COMPLETION
// ============================================================
function renderCompletion() {
  document.getElementById('completionSub').textContent =
    `You've completed all ${currentBlocks.length} courses. Well done, ${currentUser.name}!`;
  const list = document.getElementById('completionList');
  list.innerHTML = currentBlocks.map(b => {
    const dateStr = getActiveCompletedMap()[b.id]?.date || '';
    return `<div class="completion-item"><span>✅</span><span>${escHtml(b.name)}${dateStr ? ' <span style="font-size:11px;color:#64748b">(' + prettyDay(dateStr) + ')</span>' : ''}</span></div>`;
  }).join('');
}

// ============================================================
// NAVIGATION
// ============================================================
// The loading screen doubles as the "couldn't load" screen (message + Try again button)
function resetLoadingScreen() {
  const sp = document.querySelector('#screenLoading .spinner');
  if (sp) sp.style.display = '';
  const btn = document.getElementById('loadRetryBtn');
  if (btn) btn.remove();
}
function showLoadError(message, retry) {
  showScreen('screenLoading');
  const sp = document.querySelector('#screenLoading .spinner');
  if (sp) sp.style.display = 'none';
  const txt = document.getElementById('loadingText');
  txt.textContent = '⚠️ ' + message;
  const btn = document.createElement('button');
  btn.id = 'loadRetryBtn';
  btn.className = 'btn btn-primary';
  btn.style.marginTop = '16px';
  btn.textContent = 'Try again';
  btn.onclick = () => { resetLoadingScreen(); txt.textContent = 'Loading your course data…'; retry(); };
  txt.parentNode.appendChild(btn);
}

function showScreen(id) {
  resetLoadingScreen();
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function goBack() {
  // Always stop the materials refresh timer when navigating away from a block
  if (materialsTimer) { clearInterval(materialsTimer); materialsTimer = null; }

  // Profile screen always goes back to roles
  const active = document.querySelector('.screen.active')?.id;
  if (active === 'screenProfile') {
    document.getElementById('headerBack').style.display = 'none';
    showScreen('screenRoles');
    return;
  }

  // Sign screen → go back to the block screen
  if (active === 'screenSign') {
    showScreen('screenBlock');
    document.getElementById('headerBack').style.display = 'inline-flex';
    return;
  }

  if (currentRoleId) {
    const active = document.querySelector('.screen.active')?.id;
    if (active === 'screenBlock') {
      // Back from block → role course list; never redirect to completion when navigating back
      renderCourse(currentBlocks, true);
    } else {
      // Back from role course → roles overview
      document.getElementById('headerBack').style.display = 'none';
      currentRoleId = null;
      currentBlockIndex = null;
      renderRoles();
      showScreen('screenRoles');
    }
  } else {
    const active = document.querySelector('.screen.active')?.id;
    if (active === 'screenBlock') {
      renderCourse(currentBlocks);
      showScreen('screenCourse');
      // Hide back button if on course screen
      document.getElementById('headerBack').style.display = 'none';
    }
  }
}

// ============================================================
// PROFILE
// ============================================================
function showProfile(forced = false) {
  if (!currentUser || !trainingData) return;

  // Avatar initials
  const initials = (currentUser.name || '?')
    .split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
  document.getElementById('profileAvatar').textContent = initials;
  document.getElementById('profileName').textContent   = currentUser.name || '—';
  document.getElementById('profileEmail').textContent  = currentUser.email || '—';

  // Roles
  const roleNames = (trainingData.roles || []).map(r => r.name).join(', ') || '—';
  document.getElementById('profileRoles').textContent = roleNames;

  // Stage
  document.getElementById('profileStage').textContent = currentUser.onboardingStage || '—';

  // Clear password fields and messages
  ['pwNew', 'pwConfirm'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('profileError').className   = 'login-error';
  document.getElementById('profileSuccess').className = 'forgot-success';

  if (forced) {
    const errEl = document.getElementById('profileError');
    errEl.textContent = '⚠️ You are using the default password. Please set a new one before continuing.';
    errEl.className   = 'login-error show';
  }

  document.getElementById('headerBack').style.display = forced ? 'none' : 'inline-flex';
  showScreen('screenProfile');
}

async function doChangePassword() {
  const errEl  = document.getElementById('profileError');
  const okEl   = document.getElementById('profileSuccess');
  const btnEl  = document.getElementById('btnChangePassword');
  errEl.className  = 'login-error';
  okEl.className   = 'forgot-success';

  const newPw   = document.getElementById('pwNew').value;
  const confirm = document.getElementById('pwConfirm').value;

  if (!newPw || !confirm) {
    errEl.textContent = 'Please fill in both password fields.';
    errEl.className   = 'login-error show'; return;
  }
  if (newPw !== confirm) {
    errEl.textContent = 'Passwords do not match.';
    errEl.className   = 'login-error show'; return;
  }
  if (newPw.length < 6) {
    errEl.textContent = 'New password must be at least 6 characters.';
    errEl.className   = 'login-error show'; return;
  }

  btnEl.disabled    = true;
  btnEl.textContent = 'Updating…';
  try {
    await apiFetch('/api/change-password', 'POST', { newPassword: newPw });
    okEl.textContent = '✅ Password updated successfully.';
    okEl.className   = 'forgot-success show';
    ['pwNew', 'pwConfirm'].forEach(id => document.getElementById(id).value = '');
    // A first login forces a password change; the welcome tour waits until it is done
    if (currentUser?.mustChangePassword) {
      currentUser.mustChangePassword = false;
      document.getElementById('headerBack').style.display = 'inline-flex';
      if (window.SolveTour) setTimeout(() => SolveTour.maybeStart(), 700);
    }
  } catch (e) {
    errEl.textContent = e.message || 'Failed to update password.';
    errEl.className   = 'login-error show';
  } finally {
    btnEl.disabled    = false;
    btnEl.textContent = 'Update Password';
  }
}

// ============================================================
// LOGOUT
// ============================================================
// Ask before signing out: the button sits next to Back and one stray tap used to end the session.
// Markup and styles are built here (not index.html / styles.css) for the cache-first stylesheet reason.
function confirmSignOut() {
  if (document.getElementById('signOutConfirm')) return;
  if (!document.getElementById('signOutConfirmStyles')) {
    const st = document.createElement('style');
    st.id = 'signOutConfirmStyles';
    st.textContent = `
      #signOutConfirm { position: fixed; inset: 0; z-index: 10100; display: flex; align-items: center; justify-content: center;
        padding: 20px; background: rgba(6,14,8,0.55); backdrop-filter: blur(3px); -webkit-backdrop-filter: blur(3px);
        opacity: 0; transition: opacity .18s ease; }
      #signOutConfirm.in { opacity: 1; }
      #signOutConfirm .so-card { width: min(380px, 100%); background: #fff; color: #152219; border-radius: 22px; padding: 26px 24px 20px;
        box-shadow: 0 20px 60px rgba(0,0,0,0.35); transform: translateY(8px) scale(.98); transition: transform .2s ease; text-align: center; }
      #signOutConfirm.in .so-card { transform: none; }
      #signOutConfirm .so-icon { width: 52px; height: 52px; margin: 0 auto 14px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
        background: rgba(198,40,40,0.09); color: #c62828; }
      #signOutConfirm h3 { margin: 0 0 6px; font-size: 18px; font-weight: 800; }
      #signOutConfirm p { margin: 0 0 20px; font-size: 14px; line-height: 1.5; color: rgba(21,34,25,0.65); }
      #signOutConfirm .so-actions { display: flex; gap: 10px; }
      #signOutConfirm button { flex: 1; height: 46px; border-radius: 14px; font: 700 14px/1 inherit; font-family: inherit; cursor: pointer; }
      #signOutConfirm .so-cancel { background: #fff; color: #152219; border: 1px solid rgba(0,0,0,0.16); }
      #signOutConfirm .so-cancel:hover { background: rgba(0,0,0,0.04); }
      #signOutConfirm .so-go { border: none; color: #fff; background: linear-gradient(100deg, #c62828 0%, #e05252 100%);
        box-shadow: 0 1px 2px rgba(60,10,10,0.25), 0 3px 8px rgba(198,40,40,0.22); }
      #signOutConfirm .so-go:hover { background: linear-gradient(100deg, #d03232 0%, #e86262 100%); }
      #signOutConfirm button:focus-visible { outline: 3px solid rgba(58,174,74,0.45); outline-offset: 2px; }
      @media (prefers-reduced-motion: reduce) { #signOutConfirm, #signOutConfirm .so-card { transition: none; } }`;
    document.head.appendChild(st);
  }
  const wrap = document.createElement('div');
  wrap.id = 'signOutConfirm';
  wrap.setAttribute('role', 'alertdialog');
  wrap.setAttribute('aria-modal', 'true');
  wrap.setAttribute('aria-labelledby', 'soTitle');
  wrap.innerHTML = `
    <div class="so-card">
      <div class="so-icon" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 20H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5"/><path d="M16 16l4-4-4-4M20 12H10"/></svg></div>
      <h3 id="soTitle">Sign out?</h3>
      <p>You will need your password to get back in.</p>
      <div class="so-actions">
        <button type="button" class="so-cancel">Stay signed in</button>
        <button type="button" class="so-go">Sign out</button>
      </div>
    </div>`;
  const close = () => {
    document.removeEventListener('keydown', onKey, true);
    wrap.classList.remove('in');
    setTimeout(() => wrap.remove(), 200);
  };
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
  wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
  wrap.querySelector('.so-cancel').addEventListener('click', close);
  wrap.querySelector('.so-go').addEventListener('click', () => { close(); logout(); });
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(wrap);
  requestAnimationFrame(() => { wrap.classList.add('in'); wrap.querySelector('.so-cancel').focus(); });
}

async function logout() {
  if (window.SolveTour) SolveTour.abort();
  try { await apiFetch('/api/logout', 'POST'); } catch {}
  if (materialsTimer) { clearInterval(materialsTimer); materialsTimer = null; }
  if (autoSyncTimer)  { clearTimeout(autoSyncTimer);   autoSyncTimer  = null; }
  authToken    = null;
  currentUser  = null;
  trainingData = null;
  currentBlocks     = [];
  currentBlockIndex = null;
  currentRoleId     = null;
  localStorage.removeItem(SESSION_KEY);
  clearCache();

  // Reset UI
  document.body.classList.remove('logged-in');
  document.getElementById('appHeader').style.display  = 'none';
  document.getElementById('loginScreen').style.display = 'flex';
  document.getElementById('loginEmail').value    = '';
  document.getElementById('loginPassword').value = '';
  document.getElementById('btnLogin').disabled   = false;
  document.getElementById('btnLogin').textContent = 'Sign In';
  document.getElementById('loginError').classList.remove('show');
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById('headerBack').style.display = 'none';
}

// ============================================================
// UTILS
// ============================================================
function escHtml(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

let toastTimer;
function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
}

// ============================================================
// BOOT — auto-login via ?employee_id= param OR stored token
// ============================================================
(async function boot() {
  // ── Check for employee_id URL param (password-free login) ──
  const urlParams  = new URLSearchParams(window.location.search);
  const employeeId = urlParams.get('employee_id');

  // If hideHeader=true is in the URL, drop the profile button from the header
  // (the logo stays) and show the inline profile button on the roles page instead.
  if (urlParams.get('hideHeader') === 'true') {
    const pb = document.getElementById('headerProfileBtn');
    if (pb) pb.style.display = 'none';
    window._hideHeader = true;
  }

  if (employeeId) {
    // Show loading state (hide login screen)
    document.getElementById('loginScreen').style.display = 'none';
    document.getElementById('appHeader').style.display   = 'flex';
    showScreen('screenLoading');
    document.getElementById('loadingText').textContent = 'Signing you in…';

    try {
      const res  = await SolveNet.fetch(`/api/token-by-employee-id?employee_id=${encodeURIComponent(employeeId)}`);
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        // Invalid ID — fall through to login screen with an error hint
        document.getElementById('appHeader').style.display   = 'none';
        document.getElementById('loginScreen').style.display = 'flex';
        document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
        const errEl = document.getElementById('loginError');
        errEl.textContent = data.error || 'Could not sign in with the provided employee ID.';
        errEl.classList.add('show');
        return;
      }

      authToken   = data.token;
      currentUser = { name: data.name, email: data.email, onboardingStage: data.onboardingStage || null, autoLogin: !!data.autoLogin };
      localStorage.setItem(SESSION_KEY, authToken);

      document.getElementById('headerUser').style.display  = 'inline-flex';
      document.getElementById('headerUser').textContent    = currentUser.name;
      showStageBadge(currentUser.onboardingStage);

      await initApp();
      return; // Done — skip the stored-token flow below
    } catch (err) {
      // Network error — fall through to login screen
      document.getElementById('appHeader').style.display   = 'none';
      document.getElementById('loginScreen').style.display = 'flex';
      document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
      const errEl = document.getElementById('loginError');
      errEl.textContent = SolveNet.friendlyError(null, null, err);
      errEl.classList.add('show');
      return;
    }
  }

  // ── Fallback: restore from stored session token ──
  const storedToken = localStorage.getItem(SESSION_KEY);
  if (!storedToken) return; // Stay on login screen

  authToken = storedToken;

  // Try to restore user from cache
  const cached = loadCache();
  if (cached && cached.userEmail) {
    currentUser = { name: cached.name || cached.userEmail, email: cached.userEmail, onboardingStage: cached.onboardingStage || null };
  }

  // Validate session by fetching data
  document.body.classList.add('logged-in');
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('appHeader').style.display   = 'flex';
  document.getElementById('headerUser').style.display  = 'inline-flex';
  document.getElementById('btnLogout').style.display   = currentUser?.autoLogin ? 'none' : 'inline-flex';
  document.getElementById('headerUser').textContent    = currentUser?.name || '';
  showStageBadge(currentUser?.onboardingStage || null);

  showScreen('screenLoading');
  document.getElementById('loadingText').textContent = 'Resuming your session…';

  try {
    const now = Date.now();
    if (cached && cached.userEmail && (now - cached.syncedAt) < CACHE_TTL) {
      trainingData = cached;
      currentUser  = { name: cached.name || cached.userEmail, email: cached.userEmail, onboardingStage: cached.onboardingStage || null };
      document.getElementById('headerUser').textContent = currentUser.name;
      showStageBadge(currentUser.onboardingStage);
    } else {
      const data = await apiFetch('/api/training-data');
      // A sign-in with no saved copy on the device (storage cleared) has no user yet: take it from the response
      if (!currentUser) currentUser = { name: data.name || data.email || '', email: data.email || '', onboardingStage: null };
      document.getElementById('headerUser').textContent = currentUser.name;
      trainingData = { ...data, userEmail: currentUser.email, name: currentUser.name, roles: data.roles || [] };
      if (data.onboardingStage) {
        currentUser.onboardingStage = data.onboardingStage;
        showStageBadge(data.onboardingStage);
      }
      saveCache(trainingData);
    }
    overlayPendingCompletions();
    renderRoles();
    showScreen('screenRoles');
    updateSyncBar();
    flushPendingCompletions();
    // Resumed session (e.g. reopening the installed app): the welcome is still due until
    // they have skipped or finished the tour
    if (window.SolveTour) setTimeout(() => SolveTour.maybeStart(), 500);
  } catch (err) {
    // An expired/invalid token is handled inside apiFetch (it returns them to the login screen)
    if (err.message === 'session_expired') return;
    // Anything else means the back end couldn't be reached even after waiting and retrying. The
    // sign-in is still good, so keep it: use the copy saved on this device, or offer a retry.
    if (cached && cached.userEmail && currentUser) {
      trainingData = cached;
      overlayPendingCompletions();
      renderRoles();
      showScreen('screenRoles');
      updateSyncBar();
      SolveNet.showBanner('warn', "We couldn't refresh your course data, so you're seeing the copy saved on this device. We'll keep trying.", { autoHideMs: 12000 });
      scheduleRecoverySync();
      return;
    }
    showLoadError(err.message || 'Could not load your course data.', () => location.reload());
  }
})();
