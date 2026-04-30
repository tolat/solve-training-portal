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

// AI-generated quizzes fetched from /api/quizzes — merged with static QUIZ_MAP
// Keys are block IDs with no dashes, same as QUIZ_MAP
let dynamicQuizzes = {};

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
async function apiFetch(path, method = 'GET', body = null) {
  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${authToken}`,
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  const data = await res.json();
  if (res.status === 401) {
    // Session expired or server restarted — clear state and return to login
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
  if (!res.ok) throw new Error(data.error || `Server error ${res.status}`);
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
    const data = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    }).then(r => r.json().then(d => ({ ok: r.ok, ...d })));

    if (!data.ok) {
      errEl.textContent = data.error || 'Login failed.';
      errEl.classList.add('show');
      btnEl.disabled = false;
      btnEl.textContent = 'Sign In';
      return;
    }

    authToken   = data.token;
    currentUser = { name: data.name, email: data.email, onboardingStage: data.onboardingStage || null };
    localStorage.setItem(SESSION_KEY, authToken);
    await initApp();

  } catch (err) {
    errEl.textContent = 'Could not connect to server. Is the server running?';
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
    const res  = await fetch('/api/forgot-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const data = await res.json();

    if (!res.ok) {
      errEl.textContent = data.error || 'Could not send recovery email.';
      errEl.classList.add('show');
    } else {
      successEl.textContent = data.message || 'Password sent! Check your inbox.';
      successEl.classList.add('show');
      emailEl.value = '';
    }
  } catch (err) {
    errEl.textContent = 'Could not connect to server.';
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
  document.getElementById('btnLogout').style.display = 'inline-flex';
  document.getElementById('headerUser').textContent = currentUser.name;
  showStageBadge(currentUser.onboardingStage);

  // Show loading
  showScreen('screenLoading');
  document.getElementById('loadingText').textContent = 'Loading your training data…';

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
      const data = await apiFetch('/api/training-data');
      trainingData = { ...data, userEmail: currentUser.email, name: currentUser.name, roles: data.roles || [] };
      if (data.onboardingStage) {
        currentUser.onboardingStage = data.onboardingStage;
        showStageBadge(currentUser.onboardingStage);
      }
      saveCache(trainingData);
    }

    // Load AI-generated quizzes in parallel (non-blocking)
    loadDynamicQuizzes();

    renderRoles();
    showScreen('screenRoles');
    updateSyncBar();

  } catch (err) {
    showScreen('screenLoading');
    document.getElementById('loadingText').textContent = '⚠️ ' + (err.message || 'Failed to load data. Please try again.');
  }
}

// ============================================================
// SYNC
// ============================================================
async function manualSync() {
  const btn      = document.getElementById('syncNowBtn');
  const btnRoles = document.getElementById('syncNowBtnRoles');
  if (btn)      { btn.classList.add('syncing');      btn.disabled      = true; }
  if (btnRoles) { btnRoles.classList.add('syncing'); btnRoles.disabled = true; }
  try {
    // Sync returns refreshed employee data (name, onboardingStage) as well as
    // triggering a server-side cache refresh of all training content.
    const syncResult = await apiFetch('/api/sync', 'POST');

    // Apply refreshed employee data to currentUser immediately
    if (syncResult.name)            { currentUser.name = syncResult.name; document.getElementById('headerUser').textContent = currentUser.name; }
    if (syncResult.onboardingStage) { currentUser.onboardingStage = syncResult.onboardingStage; showStageBadge(currentUser.onboardingStage); }

    const data = await apiFetch('/api/training-data');
    trainingData = { ...data, userEmail: currentUser.email, name: currentUser.name, roles: data.roles || [] };
    // training-data may also carry a refreshed onboardingStage (belt-and-suspenders)
    if (data.onboardingStage) {
      currentUser.onboardingStage = data.onboardingStage;
      showStageBadge(currentUser.onboardingStage);
    }
    saveCache(trainingData);
    loadDynamicQuizzes();
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
      renderCourse(currentBlocks);
    } else {
      renderRoles();
    }
    updateSyncBar();
    showToast('✅ Training data synced');
  } catch (err) {
    showToast('⚠️ Sync failed: ' + err.message);
  } finally {
    if (btn)      { btn.classList.remove('syncing');      btn.disabled      = false; }
    if (btnRoles) { btnRoles.classList.remove('syncing'); btnRoles.disabled = false; }
  }
}

function updateSyncBar() {
  if (!trainingData) return;
  const ago = timeSince(trainingData.syncedAt);
  document.getElementById('syncBarText').textContent = `Last synced: ${ago}`;
  const rolesText = document.getElementById('syncBarRolesText');
  if (rolesText) rolesText.textContent = `Last synced: ${ago}`;
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
function renderRoles() {
  if (!trainingData) return;
  const { roles, completedMap, blocks } = trainingData;

  document.getElementById('rolesTitle').textContent = currentUser.name + "'s Training";

  // Apply the same stage filters used in renderCourse so counts stay consistent:
  // only E-stages, only up to the employee's current stage ordering.
  const empOrdering = trainingData.employeeStageOrdering ?? 999;
  function isVisibleBlock(b) {
    if (!(b.stageName || '').trimStart().toUpperCase().startsWith('E')) return false;
    if (empOrdering < 999 && b.stageOrdering > empOrdering) return false;
    return true;
  }

  const visibleAll = blocks.filter(isVisibleBlock);
  const totalDone  = visibleAll.filter(b => completedMap[b.id]?.status === 'OK').length;
  document.getElementById('rolesSubtitle').textContent = `${totalDone} of ${visibleAll.length} modules completed across all roles`;

  const grid = document.getElementById('rolesGrid');
  grid.innerHTML = '';

  (roles || []).forEach(role => {
    const roleBlocks    = role.blockIds.map(id => blocks.find(b => b.id === id)).filter(Boolean);
    // Visible = filtered to E-stages within the employee's current stage
    const visibleBlocks = roleBlocks.filter(isVisibleBlock);
    if (!visibleBlocks.length) return; // skip roles with nothing visible at this stage
    const done    = visibleBlocks.filter(b => completedMap[b.id]?.status === 'OK').length;
    const overdue = visibleBlocks.filter(b => completedMap[b.id]?.status === 'Overdue').length;
    const total   = visibleBlocks.length;
    const pct = total ? Math.round(done / total * 100) : 0;

    const card = document.createElement('div');
    card.className = 'role-card';
    card.innerHTML = `
      <div class="role-card-name">${escHtml(role.name)}</div>
      <div class="role-card-stats">
        <span>${done} of ${total} completed</span>
        <span>${pct}%</span>
      </div>
      <div class="role-card-bar"><div class="role-card-fill" style="width:${pct}%"></div></div>
      ${overdue ? `<div class="role-card-overdue">⚠️ ${overdue} overdue</div>` : ''}
    `;
    card.onclick = () => openRole(role.id, role.name);
    grid.appendChild(card);
  });

  showScreen('screenRoles');
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
  renderCourse(currentBlocks);
}

// ============================================================
// COURSE OVERVIEW
// ============================================================
function isBlockCompleted(blockId) {
  return trainingData?.completedMap?.[blockId]?.status === 'OK';
}

function isBlockOverdue(blockId) {
  return trainingData?.completedMap?.[blockId]?.status === 'Overdue';
}

function renderCourse(blocksOverride) {
  if (!trainingData) return;
  const { completedMap } = trainingData;
  const allBlocks = blocksOverride || trainingData.blocks;

  // ── Filter to pipeline stages starting with "E" only ──────────
  const eBlocks = allBlocks.filter(b => (b.stageName || '').trimStart().toUpperCase().startsWith('E'));

  // ── Filter to stages the employee has reached ──────────────────
  // employeeStageOrdering: numeric ordering of their current stage (999 = no stage set → show all)
  const empOrdering = trainingData.employeeStageOrdering ?? 999;
  const blocks = empOrdering < 999
    ? eBlocks.filter(b => b.stageOrdering <= empOrdering)
    : eBlocks;

  currentBlocks = blocks;

  // Stats (based on visible filtered blocks)
  const done = blocks.filter(b => isBlockCompleted(b.id)).length;
  const pct  = blocks.length ? Math.round(done / blocks.length * 100) : 0;

  const roleLabel = currentRoleId
    ? (trainingData.roles.find(r => r.id === currentRoleId)?.name || 'Training')
    : currentUser.name + "'s Training";
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
  function addModuleItem(block, globalIndex, cls, statusText, clickable) {
    const item = document.createElement('div');
    const typeStr = (block.types || []).join(', ') || 'General';
    item.className = 'module-item ' + cls;
    const numLabel = cls.includes('completed') ? '✓'
                   : cls.includes('overdue')   ? '!'
                   : globalIndex + 1;
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
    const key = block.stageName || 'Other';
    if (!stageIndex.has(key)) {
      const group = { stageName: key, stageOrdering: block.stageOrdering, blocks: [] };
      stageIndex.set(key, group);
      stageGroups.push(group);
    }
    stageIndex.get(key).blocks.push(block);
  }

  // Access rule: per-stage sequential unlocking.
  // A block is open if it is the first in its stage OR the previous block
  // in the same stage is completed. Completed blocks are always accessible.
  function isAccessible(block) {
    const group = stageIndex.get(block.stageName || 'Other');
    if (!group) return true;
    const pos = group.blocks.indexOf(block);
    if (pos === 0) return true;
    return isBlockCompleted(group.blocks[pos - 1].id);
  }

  // ── Status priority for sort: completed(0) → overdue(1) → open(2) → locked(3) ──
  function blockPriority(block) {
    const completed = isBlockCompleted(block.id);
    const overdue   = isBlockOverdue(block.id);
    const open      = completed || isAccessible(block);
    if (completed) return 0;
    if (overdue)   return 1;
    if (open)      return 2;
    return 3;
  }

  // ── Render one section per stage ──────────────────────────────
  stageGroups.forEach((group, idx) => {
    addStageHeader(group.stageName, idx, group.blocks);

    const sorted = [...group.blocks].sort((a, b) => blockPriority(a) - blockPriority(b));

    for (const block of sorted) {
      const gi        = blocks.indexOf(block);
      const completed = isBlockCompleted(block.id);
      const overdue   = isBlockOverdue(block.id);
      const open      = completed || isAccessible(block);

      if (completed) {
        const dateStr    = completedMap[block.id]?.date || '';
        const statusText = `✓ Done${dateStr ? ' (' + dateStr + ')' : ''}`;
        addModuleItem(block, gi, 'completed', statusText, true);
      } else if (overdue) {
        addModuleItem(block, gi,
          open ? 'overdue current' : 'locked',
          open ? '⚠️ Overdue — Open' : '🔒 Locked',
          open);
      } else {
        addModuleItem(block, gi,
          open ? 'current' : 'locked',
          open ? '▶ Start' : '🔒 Locked',
          open);
      }
    }
  });

  // Check completion
  if (done === blocks.length && blocks.length > 0) {
    renderCompletion();
    showScreen('screenComplete');
  } else {
    showScreen('screenCourse');
  }
}

// ============================================================
// TRAINING BLOCK
// ============================================================
function openBlock(index) {
  currentBlockIndex = index;
  const block   = currentBlocks[index];
  const passed  = isBlockCompleted(block.id);

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

  // Training link
  const linkBox   = document.getElementById('linkBox');
  const noLinkBox = document.getElementById('noLinkBox');
  if (block.trainingLink) {
    linkBox.style.display   = 'flex';
    noLinkBox.style.display = 'none';
    const anchor = document.getElementById('trainingLink');
    anchor.href        = block.trainingLink;
    anchor.textContent = block.trainingLink;
  } else {
    linkBox.style.display   = 'none';
    noLinkBox.style.display = 'block';
  }

  const viewedConfirm = document.getElementById('viewedConfirm');
  const btnViewed     = document.getElementById('btnViewed');
  const quizSection   = document.getElementById('quizSection');
  const quizResult    = document.getElementById('quizResult');

  if (passed) {
    viewedConfirm.classList.add('show');
    btnViewed.style.display = 'none';
    renderQuiz(block, true);
    quizSection.classList.add('show');
    quizResult.className   = 'quiz-result pass show';
    const dateStr = trainingData.completedMap[block.id]?.date || '';
    quizResult.innerHTML   = `
      <div class="quiz-result-title">✅ Already Completed${dateStr ? ' — ' + dateStr : ''}</div>
      <div class="quiz-result-msg">You've already completed this module.</div>
      <button class="btn btn-outline" onclick="goBack()">← Back to Course</button>
    `;
  } else {
    viewedConfirm.classList.remove('show');
    btnViewed.style.display = 'inline-flex';
    quizSection.classList.remove('show');
    quizResult.className    = 'quiz-result';
    quizResult.style.display = 'none';
    resetQuiz();
  }

  // Show materials section — fetch fresh signed URLs and auto-refresh every 55 min
  const materialsDiv = document.getElementById('blockMaterials');
  if (materialsDiv) {
    loadMaterials(block.id, materialsDiv, true);
    // Clear any previous timer, start a new one for this block
    if (materialsTimer) clearInterval(materialsTimer);
    materialsTimer = setInterval(() => loadMaterials(block.id, materialsDiv, false), 55 * 60 * 1000);
  }

  showScreen('screenBlock');
  document.getElementById('headerBack').style.display = 'inline-flex';
}

// Fetch (or silently refresh) signed file URLs for a training block.
// showSpinner=true on first load; false on background refresh so links don't flash.
function loadMaterials(blockId, materialsDiv, showSpinner) {
  if (showSpinner) materialsDiv.innerHTML = '<p class="materials-loading">Loading materials…</p>';
  apiFetch(`/api/block/${blockId}/files`).then(files => {
    const allFiles = [
      ...(files.associatedForms || []).map(f => ({ ...f, group: 'Associated Forms' })),
      ...(files.guidance        || []).map(f => ({ ...f, group: 'Guidance' })),
      ...(files.media           || []).map(f => ({ ...f, group: 'Files & Media' })),
    ];
    if (!allFiles.length) { materialsDiv.innerHTML = ''; return; }
    const groups = {};
    allFiles.forEach(f => {
      if (!groups[f.group]) groups[f.group] = [];
      groups[f.group].push(f);
    });
    materialsDiv.innerHTML = `
      <div class="materials-section">
        <div class="materials-title">📎 Training Materials</div>
        ${Object.entries(groups).map(([label, flist]) => `
          <div class="material-group">
            <div class="material-group-label">${escHtml(label)}</div>
            ${flist.map(f => `
              <a class="material-link" href="${escHtml(f.url)}" target="_blank" rel="noopener">
                <span class="material-link-icon">📄</span>
                <span>${escHtml(f.name)}</span>
              </a>
            `).join('')}
          </div>
        `).join('')}
      </div>
    `;
  }).catch(err => {
    if (err.message === 'session_expired') return; // handled globally
    console.error('loadMaterials error for block', blockId, err);
    if (showSpinner) materialsDiv.innerHTML = `<p class="materials-loading" style="color:var(--danger)">⚠ Could not load materials (${escHtml(err.message)})</p>`;
  });
}

function markViewed() {
  document.getElementById('viewedConfirm').classList.add('show');
  document.getElementById('btnViewed').style.display = 'none';
  const block = currentBlocks[currentBlockIndex];
  renderQuiz(block, false);
  document.getElementById('quizSection').classList.add('show');
  document.getElementById('quizResult').style.display = 'none';
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

function getQuiz(block) {
  const key = block.id.replace(/-/g, '');
  // Dynamic (AI-generated) quizzes take priority over the static QUIZ_MAP,
  // with genericQuiz as the final fallback.
  return dynamicQuizzes[key] || QUIZ_MAP[key] || genericQuiz(block.name);
}

async function loadDynamicQuizzes() {
  try {
    const data = await apiFetch('/api/quizzes');
    if (data && typeof data === 'object') {
      dynamicQuizzes = data;
      console.log(`[Quizzes] Loaded ${Object.keys(dynamicQuizzes).length} AI-generated quiz(zes)`);
    }
  } catch (e) {
    // Non-fatal — static quizzes still work
    console.warn('[Quizzes] Could not load dynamic quizzes:', e.message);
  }
}

function renderQuiz(block, readonly) {
  const questions = getQuiz(block);
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

  if (passed) {
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
    trainingData.completedMap[block.id] = { date: today, recordId: null, status: 'OK' };
    saveCache(trainingData);

    try {
      const result = await apiFetch('/api/complete', 'POST', { blockId: block.id, blockName: block.name });
      trainingData.completedMap[block.id] = { date: today, recordId: result.recordId, status: 'OK' };
      saveCache(trainingData);

      resultDiv.innerHTML = `
        <div class="quiz-result-title">🎉 Passed! ${correct}/${questions.length} correct ✅</div>
        <div class="quiz-result-msg">Great work — this module is complete and recorded in Notion.</div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;">
          ${isLast
            ? `<button class="btn btn-primary" onclick="finishCourse()">🏆 Complete Training</button>`
            : `<button class="btn btn-primary" onclick="nextBlock()">Next Module →</button>`}
          <button class="btn btn-outline" onclick="goBack()">← Back to Overview</button>
        </div>
      `;
      // Re-render the course with current blocks to update progress
      renderCourse(currentBlocks);
    } catch (err) {
      // Local pass saved even if Notion sync fails — user can sync later
      resultDiv.innerHTML = `
        <div class="quiz-result-title">🎉 Passed! ${correct}/${questions.length} correct ⚠️</div>
        <div class="quiz-result-msg">Module complete locally, but Notion sync failed: ${escHtml(err.message)}. Use the Sync button to retry.</div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;">
          ${isLast
            ? `<button class="btn btn-primary" onclick="finishCourse()">🏆 Complete Training</button>`
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
      <div class="quiz-result-msg">Review the training material and try again. You must answer all questions correctly to advance.</div>
      <button class="btn btn-danger" onclick="retryQuiz()">↩ Retry Quiz</button>
    `;
  }

  resultDiv.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function retryQuiz() {
  const block = currentBlocks[currentBlockIndex];
  renderQuiz(block, false);
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
    `You've completed all ${currentBlocks.length} training modules. Well done, ${currentUser.name}!`;
  const list = document.getElementById('completionList');
  list.innerHTML = currentBlocks.map(b => {
    const dateStr = trainingData.completedMap[b.id]?.date || '';
    return `<div class="completion-item"><span>✅</span><span>${escHtml(b.name)}${dateStr ? ' <span style="font-size:11px;color:#64748b">(' + dateStr + ')</span>' : ''}</span></div>`;
  }).join('');
}

// ============================================================
// NAVIGATION
// ============================================================
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function goBack() {
  // Always stop the materials refresh timer when navigating away from a block
  if (materialsTimer) { clearInterval(materialsTimer); materialsTimer = null; }

  if (currentRoleId) {
    const active = document.querySelector('.screen.active')?.id;
    if (active === 'screenBlock') {
      // Back from block → role course list
      renderCourse(currentBlocks);
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
// LOGOUT
// ============================================================
async function logout() {
  try { await apiFetch('/api/logout', 'POST'); } catch {}
  if (materialsTimer) { clearInterval(materialsTimer); materialsTimer = null; }
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

  if (employeeId) {
    // Show loading state (hide login screen)
    document.getElementById('loginScreen').style.display = 'none';
    document.getElementById('appHeader').style.display   = 'flex';
    showScreen('screenLoading');
    document.getElementById('loadingText').textContent = 'Signing you in…';

    try {
      const res  = await fetch(`/api/token-by-employee-id?employee_id=${encodeURIComponent(employeeId)}`);
      const data = await res.json();

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
      currentUser = { name: data.name, email: data.email, onboardingStage: data.onboardingStage || null };
      localStorage.setItem(SESSION_KEY, authToken);

      // Update header immediately
      document.getElementById('headerUser').style.display  = 'inline-flex';
      document.getElementById('btnLogout').style.display   = 'inline-flex';
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
      errEl.textContent = 'Could not connect to server. Is the server running?';
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
  document.getElementById('btnLogout').style.display   = 'inline-flex';
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
      trainingData = { ...data, userEmail: currentUser?.email, name: currentUser?.name, roles: data.roles || [] };
      if (data.onboardingStage) {
        currentUser.onboardingStage = data.onboardingStage;
        showStageBadge(data.onboardingStage);
      }
      saveCache(trainingData);
    }
    renderRoles();
    showScreen('screenRoles');
    updateSyncBar();
  } catch (err) {
    // Token expired or invalid — go back to login
    authToken = null;
    localStorage.removeItem(SESSION_KEY);
    document.getElementById('appHeader').style.display   = 'none';
    document.getElementById('loginScreen').style.display = 'flex';
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  }
})();
