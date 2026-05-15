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
  document.getElementById('btnLogout').style.display = currentUser?.autoLogin ? 'none' : 'inline-flex';
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

  // Show inline profile button when header-main is hidden
  if (window._hideHeader) {
    const btn    = document.getElementById('inlineProfileBtn');
    const nameEl = document.getElementById('inlineProfileName');
    if (btn)    btn.style.display    = 'inline-flex';
    if (nameEl) nameEl.textContent   = currentUser.name;
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
      if (b.stageOrdering === 999 && b.hasEmployeeStage) return true;
      if (!b.hasEmployeeStage) return false;
      if (empOrdering < 999 && b.stageOrdering > empOrdering) return false;
      return true;
    }
  }

  // Global count across all roles (deduplicated)
  const seenIds   = new Set();
  let totalVisible = 0, totalDone = 0;
  (roles || []).forEach(role => {
    role.blockIds.map(id => blocks.find(b => b.id === id)).filter(Boolean)
      .filter(b => isVisibleForRole(b, role))
      .forEach(b => {
        if (seenIds.has(b.id)) return;
        seenIds.add(b.id);
        totalVisible++;
        if (completedMap[b.id]?.status === 'OK') totalDone++;
      });
  });
  document.getElementById('rolesSubtitle').textContent = `${totalDone} of ${totalVisible} modules completed across all roles`;

  const grid = document.getElementById('rolesGrid');
  grid.innerHTML = '';

  (roles || []).forEach(role => {
    const roleBlocks    = role.blockIds.map(id => blocks.find(b => b.id === id)).filter(Boolean);
    const visibleBlocks = roleBlocks.filter(b => isVisibleForRole(b, role));
    if (!visibleBlocks.length) return; // skip roles with nothing visible at this stage
    const done    = visibleBlocks.filter(b => completedMap[b.id]?.status === 'OK').length;
    const overdue = visibleBlocks.filter(b => completedMap[b.id]?.status === 'Overdue').length;
    const total   = visibleBlocks.length;
    const pct = total ? Math.round(done / total * 100) : 0;

    const card = document.createElement('div');
    card.className = 'role-card';
    card.innerHTML = `
      <div class="role-card-name">${escHtml(role.name)}${role.contractorName ? `<span style="font-size:12px;font-weight:400;color:var(--gray);margin-left:8px;">${escHtml(role.contractorName)}</span>` : ''}</div>
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

  if (!grid.children.length) {
    grid.innerHTML = `
      <div style="text-align:center;padding:48px 24px;color:var(--gray);">
        <div style="font-size:36px;margin-bottom:12px;">🎓</div>
        <div style="font-size:16px;font-weight:600;color:var(--text);margin-bottom:6px;">No trainings available</div>
        <div style="font-size:13px;">You have no training modules assigned at your current stage.</div>
      </div>`;
  }

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

  // Access rule: per-stage sequential unlocking.
  // A block is open if it is the first in its stage OR the previous block
  // in the same stage is completed. Completed blocks are always accessible.
  function isAccessible(block) {
    const key   = importing ? (block.contractorStageName || block.stageName || 'Other')
                : isDealer  ? (block.dealerStageName     || block.stageName || 'Other')
                            : (block.stageName || 'Other');
    const group = stageIndex.get(key);
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
  const uploadSection = document.getElementById('uploadSection');
  const isDocUpload   = isDocumentUploadBlock(block);

  // Document Upload blocks skip the acknowledge step entirely
  if (isDocUpload) {
    btnViewed.style.display = 'none';
    viewedConfirm.classList.remove('show');
  } else {
    btnViewed.textContent   = '✓ I\'ve reviewed this training — start quiz';
    btnViewed.style.display = passed ? 'none' : 'inline-flex';
  }

  if (passed) {
    if (!isDocUpload) viewedConfirm.classList.add('show');
    const dateStr = trainingData.completedMap[block.id]?.date || '';
    const completedHTML = `
      <div class="quiz-result-title">✅ Already Completed${dateStr ? ' — ' + dateStr : ''}</div>
      <div class="quiz-result-msg">You've already completed this module.</div>
      <button class="btn btn-outline" onclick="goBack()">← Back to Course</button>
    `;
    if (isDocUpload) {
      uploadSection.classList.add('show');
      quizSection.classList.remove('show');
      document.getElementById('uploadResult').className = 'quiz-result pass show';
      document.getElementById('uploadResult').innerHTML = completedHTML;
    } else {
      renderQuiz(block, true);
      quizSection.classList.add('show');
      uploadSection.classList.remove('show');
      quizResult.className = 'quiz-result pass show';
      quizResult.innerHTML = completedHTML;
    }
  } else {
    if (!isDocUpload) viewedConfirm.classList.remove('show');
    quizSection.classList.remove('show');
    quizResult.className    = 'quiz-result';
    quizResult.style.display = 'none';
    resetQuiz();
    if (isDocUpload) {
      // Show upload panel immediately — no acknowledge step needed
      resetUpload();
      uploadSection.classList.add('show');
    } else {
      uploadSection.classList.remove('show');
      resetUpload();
    }
  }

  // Show materials section — but not for Document Upload blocks
  // (those use the upload UI instead; showing files there would be confusing)
  const materialsDiv = document.getElementById('blockMaterials');
  if (materialsDiv) {
    if (isDocumentUploadBlock(block)) {
      if (materialsTimer) { clearInterval(materialsTimer); materialsTimer = null; }
      loadCertificates(block.id, materialsDiv);
    } else {
      loadMaterials(block.id, materialsDiv, true);
      if (materialsTimer) clearInterval(materialsTimer);
      materialsTimer = setInterval(() => loadMaterials(block.id, materialsDiv, false), 55 * 60 * 1000);
    }
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

function isDocumentUploadBlock(block) {
  return (block?.types || []).some(t => t.toLowerCase().replace(/[\s_-]/g, '') === 'documentupload');
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
    renderQuiz(block, false);
    document.getElementById('quizSection').classList.add('show');
    document.getElementById('uploadSection').classList.remove('show');
    document.getElementById('quizResult').style.display = 'none';
  }
}

// Fetch and display uploaded certificates for a Document Upload block.
function loadCertificates(blockId, materialsDiv) {
  materialsDiv.innerHTML = '<p class="materials-loading">Loading certificates…</p>';
  apiFetch(`/api/block/${blockId}/certificates`).then(({ certificates }) => {
    if (!certificates?.length) {
      materialsDiv.innerHTML = '';
      return;
    }
    materialsDiv.innerHTML = `
      <div class="materials-section">
        <div class="materials-title">📎 Uploaded Certificates</div>
        <div class="material-group">
          ${certificates.map(f => `
            <a class="material-link" href="${escHtml(f.url)}" target="_blank" rel="noopener">
              <span class="material-link-icon">📄</span>
              <span>${escHtml(f.name)}</span>
            </a>
          `).join('')}
        </div>
      </div>
    `;
  }).catch(err => {
    if (err.message === 'session_expired') return;
    console.error('loadCertificates error:', err);
    materialsDiv.innerHTML = '';
  });
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
  const block   = currentBlocks[currentBlockIndex];
  const resultEl = document.getElementById('uploadResult');
  const btnEl    = document.getElementById('btnSubmitUpload');

  if (!uploadFiles.length) {
    resultEl.className   = 'quiz-result fail show';
    resultEl.innerHTML   = '<div class="quiz-result-title">⚠️ Please select at least one file to upload.</div>';
    return;
  }

  btnEl.disabled    = true;
  btnEl.textContent = 'Uploading…';
  resultEl.className = 'quiz-result';
  resultEl.innerHTML = '';

  try {
    const formData = new FormData();
    formData.append('blockId', block.id);
    uploadFiles.forEach(f => formData.append('files', f));

    const res  = await fetch('/api/upload-certificate', {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${authToken}` },
      body:    formData,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Server error ${res.status}`);

    // Mark locally as complete
    if (!trainingData.completedMap) trainingData.completedMap = {};
    trainingData.completedMap[block.id] = { date: data.date, recordId: data.recordId, status: 'OK' };
    saveCache(trainingData);

    resultEl.className = 'quiz-result pass show';
    resultEl.innerHTML = `
      <div class="quiz-result-title">🎉 Certificate uploaded — training complete!</div>
      <div class="quiz-result-msg">Your document has been saved. This module is now marked complete.</div>
      <button class="btn btn-outline" onclick="goBack()">← Back to Course</button>
    `;
    document.getElementById('btnSubmitUpload').style.display = 'none';
    showToast('Certificate uploaded successfully ✅');
    // Refresh the certificates panel to show the newly uploaded file
    const mDiv = document.getElementById('blockMaterials');
    if (mDiv) loadCertificates(block.id, mDiv);

  } catch (err) {
    resultEl.className = 'quiz-result fail show';
    resultEl.innerHTML = `<div class="quiz-result-title">❌ Upload failed: ${escHtml(err.message)}</div>`;
    btnEl.disabled    = false;
    btnEl.textContent = 'Submit Certificate';
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

  // Profile screen always goes back to roles
  const active = document.querySelector('.screen.active')?.id;
  if (active === 'screenProfile') {
    document.getElementById('headerBack').style.display = 'none';
    showScreen('screenRoles');
    return;
  }

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
// PROFILE
// ============================================================
function showProfile() {
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
  ['pwCurrent', 'pwNew', 'pwConfirm'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('profileError').className   = 'login-error';
  document.getElementById('profileSuccess').className = 'forgot-success';

  document.getElementById('headerBack').style.display = 'inline-flex';
  showScreen('screenProfile');
}

async function doChangePassword() {
  const errEl  = document.getElementById('profileError');
  const okEl   = document.getElementById('profileSuccess');
  const btnEl  = document.getElementById('btnChangePassword');
  errEl.className  = 'login-error';
  okEl.className   = 'forgot-success';

  const current  = document.getElementById('pwCurrent').value;
  const newPw    = document.getElementById('pwNew').value;
  const confirm  = document.getElementById('pwConfirm').value;

  if (!current || !newPw || !confirm) {
    errEl.textContent = 'Please fill in all three fields.';
    errEl.className   = 'login-error show'; return;
  }
  if (newPw !== confirm) {
    errEl.textContent = 'New passwords do not match.';
    errEl.className   = 'login-error show'; return;
  }
  if (newPw.length < 6) {
    errEl.textContent = 'New password must be at least 6 characters.';
    errEl.className   = 'login-error show'; return;
  }

  btnEl.disabled    = true;
  btnEl.textContent = 'Updating…';
  try {
    await apiFetch('/api/change-password', 'POST', { currentPassword: current, newPassword: newPw });
    okEl.textContent = '✅ Password updated successfully.';
    okEl.className   = 'forgot-success show';
    ['pwCurrent', 'pwNew', 'pwConfirm'].forEach(id => document.getElementById(id).value = '');
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

  // Hide the header-main bar if hideHeader=true is in the URL,
  // and show the inline profile button on the roles page instead.
  if (urlParams.get('hideHeader') === 'true') {
    const hm = document.querySelector('.header-main');
    if (hm) hm.style.display = 'none';
    window._hideHeader = true;
  }

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
