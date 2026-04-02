/**
 * Solve Energy Training Portal — Server
 * Node.js >=18 required (uses native fetch)
 *
 * Setup:
 *   1. cp .env.example .env  → add NOTION_TOKEN
 *   2. npm install
 *   3. npm start
 *   4. Open http://localhost:3001
 */

'use strict';

const express    = require('express');
const crypto     = require('crypto');
const path       = require('path');
const nodemailer = require('nodemailer');
require('dotenv').config();

// ─── Validate env ────────────────────────────────────────────
const NOTION_TOKEN = process.env.NOTION_TOKEN;
if (!NOTION_TOKEN) {
  console.error('\n❌  NOTION_TOKEN not set. Copy .env.example → .env and add your token.\n');
  process.exit(1);
}
const PORT = parseInt(process.env.PORT || '3001', 10);

// ─── SMTP transporter (optional — only used for password recovery) ─
let mailer = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  mailer = nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   parseInt(process.env.SMTP_PORT || '587', 10),
    secure: parseInt(process.env.SMTP_PORT || '587', 10) === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
  console.log(`📧  SMTP configured via ${process.env.SMTP_HOST}`);
} else {
  console.warn('⚠️   SMTP_HOST / SMTP_USER / SMTP_PASS not set — password-recovery emails disabled.');
}

// ─── Notion Database IDs ──────────────────────────────────────
const DB = {
  companyDirectory: '583517ad-9eb7-4c1c-b563-47ef14c9f9d3',
  trainingRecords:  '2a0b73d8-b43a-8022-843f-cd9712081cbc',
  trainingBlocks:   '2a8b73d8-b43a-8081-b8dd-c8d6d3f90d75',
  trainingProfiles: '2a8b73d8-b43a-809b-a218-d333d4f2a2f3',
  roles:            '2b1b73d8-b43a-8013-ad34-f824f122013f',
  pipelineStages:   '26fb73d8-b43a-8062-ab48-cb65735c1eb2',
};

// ─── Notion API helpers ───────────────────────────────────────
async function notionFetch(endpoint, method = 'GET', body = null) {
  const res = await fetch(`https://api.notion.com/v1${endpoint}`, {
    method,
    headers: {
      'Authorization': `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Notion API ${res.status} on ${method} ${endpoint}: ${JSON.stringify(data?.message || data)}`);
  }
  return data;
}

/** Query an entire database, following pagination cursors */
async function queryAll(dbId, filter = null) {
  const pages = [];
  let cursor;
  do {
    const body = { page_size: 100 };
    if (filter)  body.filter       = filter;
    if (cursor)  body.start_cursor = cursor;
    const res = await notionFetch(`/databases/${dbId}/query`, 'POST', body);
    pages.push(...(res.results || []));
    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor);
  return pages;
}

// Property accessors
const prop     = (page, name) => page?.properties?.[name];
const relIds   = (p) => (p?.relation || []).map(r => r.id);
const richText = (p) => (p?.rich_text || []).map(t => t.plain_text).join('');
const titleTxt = (p) => (p?.title     || []).map(t => t.plain_text).join('');
const emailVal = (p) => p?.email || null;

// ─── Training data cache ──────────────────────────────────────
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

let cache = {
  blocks:             {},  // blockId → { id, name, trainingLink, notes, policyNo, types, stageOrdering, stageName }
  profiles:           {},  // profileId → { id, name, blockIds: [] }
  roles:              {},  // roleId → { id, name, profileIds: [] }
  stageOrderMap:      {},  // stageId → ordering number
  stageNameToOrdering: {}, // stageName → ordering number
  stages:             [],  // [{name, ordering}] sorted ascending
  ts: 0,
};

async function refreshCache() {
  console.log('🔄  Refreshing training data from Notion...');
  const [rolePages, profilePages, blockPages, stagePages] = await Promise.all([
    queryAll(DB.roles),
    queryAll(DB.trainingProfiles),
    queryAll(DB.trainingBlocks),
    queryAll(DB.pipelineStages),
  ]);

  // Build stage map: stageId → { name, ordering }
  // NOTE: the title property on Pipeline Stage pages is called 'Stage', not 'Name'.
  const stageMap = {};
  for (const s of stagePages) {
    const ordering = prop(s, 'Ordering')?.number ?? 999;
    // Primary: page title ('Stage'). Fallback: 'Ordered Pipeline Stage' select label.
    const name = titleTxt(prop(s, 'Stage'))
              || prop(s, 'Ordered Pipeline Stage')?.select?.name
              || `Stage ${ordering}`;
    stageMap[s.id] = { name, ordering };
  }

  // Derived lookups
  const stageOrderMap       = {};  // stageId → ordering number
  const stageNameToOrdering = {};  // stageName → ordering number (for fallback matching)
  for (const [id, info] of Object.entries(stageMap)) {
    stageOrderMap[id] = info.ordering;
    if (info.ordering !== 999 && info.name) stageNameToOrdering[info.name] = info.ordering;
  }

  // Sorted stages array for the client
  const stages = Object.values(stageMap)
    .filter(s => s.ordering !== 999)
    .sort((a, b) => a.ordering - b.ordering);

  const blocks = {};
  for (const p of blockPages) {
    // Find the minimum ordering value across all associated pipeline stages
    const stageIds      = relIds(prop(p, 'Pipeline Stages'));
    let stageOrdering   = 999;
    let stageName       = 'Other';
    if (stageIds.length) {
      stageOrdering = Math.min(...stageIds.map(id => stageOrderMap[id] ?? 999));
      // Look up the name via the specific stage ID that has the minimum ordering.
      // DO NOT search by ordering number — multiple pipeline stages (Employee, Solar,
      // Roofing, Contractor) share the same ordering value, so we'd get the wrong one.
      const minStageId = stageIds.find(id => (stageOrderMap[id] ?? 999) === stageOrdering);
      stageName = (minStageId && stageMap[minStageId]?.name) || 'Other';
    }

    blocks[p.id] = {
      id: p.id,
      name:         titleTxt(prop(p, 'Name')),
      trainingLink: prop(p, 'Training link')?.url || null,
      notes:        richText(prop(p, 'Notes')),
      policyNo:     prop(p, 'Policy No.')?.select?.name || null,
      types:        prop(p, 'Type')?.multi_select?.map(s => s.name) || [],
      stageOrdering,
      stageName,
      stageIds, // keep for debugging
    };
  }

  const profiles = {};
  for (const p of profilePages) {
    profiles[p.id] = {
      id:       p.id,
      name:     titleTxt(prop(p, 'Name')),
      blockIds: relIds(prop(p, 'Training Blocks')),
    };
  }

  const roles = {};
  for (const p of rolePages) {
    roles[p.id] = {
      id:         p.id,
      name:       titleTxt(prop(p, 'Name')),
      profileIds: relIds(prop(p, 'Training Profiles')),
    };
  }

  cache = { blocks, profiles, roles, stageOrderMap, stageNameToOrdering, stages, ts: Date.now() };
  console.log(`✅  Cache ready — ${Object.keys(blocks).length} blocks · ${Object.keys(profiles).length} profiles · ${Object.keys(roles).length} roles · ${stages.length} named pipeline stages`);
}

// ─── Session store (in-memory) ────────────────────────────────
const sessions = new Map();
const SESSION_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days

function createSession(data) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { ...data, expiresAt: Date.now() + SESSION_TTL });
  // Cleanup old sessions occasionally
  if (sessions.size > 500) {
    for (const [k, v] of sessions) if (v.expiresAt < Date.now()) sessions.delete(k);
  }
  return token;
}

function getSession(token) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s || s.expiresAt < Date.now()) { sessions.delete(token); return null; }
  return s;
}

// ─── Express app ──────────────────────────────────────────────
const app = express();
app.use(express.json());

// Serve frontend
app.use(express.static(__dirname));

// Auth middleware
function requireAuth(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const session = getSession(token);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  req.session = session;
  next();
}

// ─── POST /api/login ──────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    // Look up user in Company Directory by email
    const results = await queryAll(DB.companyDirectory, {
      property: 'Email',
      email: { equals: email.toLowerCase().trim() },
    });

    if (!results.length) {
      return res.status(401).json({ error: 'No account found for that email address.' });
    }

    const user  = results[0];
    const name  = titleTxt(prop(user, 'Name'));
    const storedPw = richText(prop(user, 'Training Portal Password'));

    if (!storedPw) {
      return res.status(401).json({
        error: 'No Training Portal Password set for your account. Ask your manager to add one to your Company Directory entry.',
      });
    }

    if (storedPw !== password) {
      return res.status(401).json({ error: 'Incorrect password.' });
    }

    const roleIds        = relIds(prop(user, 'Roles'));
    const onboardingStage = prop(user, 'Ordered Onboarding Stage')?.select?.name || null;
    const token          = createSession({ pageId: user.id, name, email: email.toLowerCase().trim(), roleIds, onboardingStage });

    console.log(`✔  Login: ${name} (${email}) — Stage: ${onboardingStage || 'none'}`);
    res.json({ token, name, email: email.toLowerCase().trim(), onboardingStage });

  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: 'Server error during login. Check server logs.' });
  }
});

// ─── POST /api/logout ─────────────────────────────────────────
app.post('/api/logout', requireAuth, (req, res) => {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  sessions.delete(token);
  res.json({ ok: true });
});

// ─── POST /api/forgot-password ───────────────────────────────
// Looks up the user by email in Company Directory and sends their
// Training Portal Password to that address.  Always returns 200 so
// we don't leak whether an address exists.
app.post('/api/forgot-password', async (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Email is required.' });

  if (!mailer) {
    return res.status(503).json({ error: 'Password recovery is not configured on this server. Please contact your administrator.' });
  }

  try {
    const results = await queryAll(DB.companyDirectory, {
      property: 'Email',
      email: { equals: email.toLowerCase().trim() },
    });

    // Always respond with the same message to avoid email enumeration
    const generic = 'If that email is registered, your password has been sent to it.';

    if (!results.length) {
      console.log(`🔑  Forgot-password: no record for ${email}`);
      return res.json({ message: generic });
    }

    const user     = results[0];
    const name     = titleTxt(prop(user, 'Name'));
    const password = richText(prop(user, 'Training Portal Password'));

    if (!password) {
      console.log(`🔑  Forgot-password: no password set for ${email}`);
      return res.json({ message: generic });
    }

    const from = process.env.SMTP_FROM || process.env.SMTP_USER;
    await mailer.sendMail({
      from,
      to:      email.toLowerCase().trim(),
      subject: 'Solve Energy Training Portal — Your Password',
      text: [
        `Hi ${name},`,
        '',
        'Here is your Solve Energy Training Portal password:',
        '',
        `    ${password}`,
        '',
        'You can sign in at: http://localhost:${PORT}',
        '',
        'If you did not request this email, please ignore it.',
        '',
        '— Solve Energy',
      ].join('\n'),
      html: `
        <p>Hi ${name},</p>
        <p>Here is your Solve Energy Training Portal password:</p>
        <p style="font-size:18px;font-weight:bold;letter-spacing:1px;padding:12px 20px;background:#f4f7f4;border-radius:6px;display:inline-block">${password}</p>
        <p>You can sign in at your training portal link.</p>
        <p style="color:#888;font-size:12px">If you did not request this email, please ignore it.</p>
        <p>— Solve Energy</p>
      `,
    });

    console.log(`📧  Sent password recovery email to ${email} (${name})`);
    res.json({ message: generic });

  } catch (err) {
    console.error('Forgot-password error:', err.message);
    res.status(500).json({ error: 'Failed to send recovery email. Please try again or contact your administrator.' });
  }
});

// ─── GET /api/token-by-employee-id ───────────────────────────
// Bypass login by passing ?employee_id=<notion_page_id> in the URL.
// The page ID must belong to a Company Directory entry.
app.get('/api/token-by-employee-id', async (req, res) => {
  try {
    const { employee_id } = req.query;
    if (!employee_id) return res.status(400).json({ error: 'employee_id is required' });

    let user;
    try {
      user = await notionFetch(`/pages/${employee_id}`);
    } catch (e) {
      return res.status(404).json({ error: 'Employee not found. Check the employee_id value.' });
    }

    const name            = titleTxt(prop(user, 'Name'));
    const email           = emailVal(prop(user, 'Email')) || '';
    const roleIds         = relIds(prop(user, 'Roles'));
    const onboardingStage = prop(user, 'Ordered Onboarding Stage')?.select?.name || null;
    const token           = createSession({ pageId: user.id, name, email, roleIds, onboardingStage });

    console.log(`✔  Token-by-ID: ${name} (${employee_id}) — Stage: ${onboardingStage || 'none'}`);
    res.json({ token, name, email, onboardingStage });
  } catch (err) {
    console.error('token-by-employee-id error:', err.message);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

// ─── GET /api/training-data ───────────────────────────────────
app.get('/api/training-data', requireAuth, async (req, res) => {
  try {
    // Auto-refresh cache if stale
    if (Date.now() - cache.ts > CACHE_TTL) await refreshCache();

    const { roleIds, pageId: userPageId, onboardingStage } = req.session;

    // Resolve the employee's current stage to a numeric ordering for client-side filtering.
    // 'Ordered Onboarding Stage' uses "NN - Label" format (e.g. "04 - Technical Training").
    // Parsing the numeric prefix is more reliable than exact string matching since labels
    // can differ slightly between the Company Directory and Pipeline Stages databases.
    let employeeStageOrdering = 999;
    if (onboardingStage) {
      const parsed = parseFloat(onboardingStage); // "04 - Technical Training" → 4
      if (!isNaN(parsed)) {
        employeeStageOrdering = parsed;
      } else if (cache.stageNameToOrdering[onboardingStage] !== undefined) {
        employeeStageOrdering = cache.stageNameToOrdering[onboardingStage];
      }
    }

    // Build deduplicated block list for user's roles
    const seen   = new Set();
    const blocks = [];

    for (const roleId of roleIds) {
      const role = cache.roles[roleId];
      if (!role) continue;
      for (const profileId of role.profileIds) {
        const profile = cache.profiles[profileId];
        if (!profile) continue;
        for (const blockId of profile.blockIds) {
          if (seen.has(blockId)) continue;
          seen.add(blockId);
          const b = cache.blocks[blockId];
          if (b) blocks.push(b);
        }
      }
    }

    // Sort by pipeline stage ordering (ascending), then by name as tiebreaker
    blocks.sort((a, b) => {
      if (a.stageOrdering !== b.stageOrdering) return a.stageOrdering - b.stageOrdering;
      return a.name.localeCompare(b.name);
    });

    // Fetch ALL training records for this user
    const recordPages = await queryAll(DB.trainingRecords, {
      property: 'Employee',
      relation: { contains: userPageId },
    });

    const completedMap = {};
    for (const r of recordPages) {
      const blockRel = relIds(prop(r, 'Training Block'));
      if (!blockRel.length) continue;
      const dateCompleted = prop(r, 'Date Completed')?.date?.start || null;

      // The Status formula may return emoji-prefixed strings like "✅ OK" or
      // "‼ Overdue", or may return null when it references rollup fields.
      // Normalise using includes() so we always store a clean 'OK'/'Overdue'.
      const rawStatus = prop(r, 'Status')?.formula?.string || null;
      let status;
      if (rawStatus?.includes('OK'))      status = 'OK';
      else if (rawStatus?.includes('Overdue')) status = 'Overdue';
      else status = dateCompleted ? 'OK' : 'Overdue';

      completedMap[blockRel[0]] = { date: dateCompleted, recordId: r.id, status };
    }

    // Supplement the role-based block list with any blocks that appear in the
    // user's training records but weren't captured through role → profile chains.
    // This covers blocks directly assigned via a training record.
    for (const blockId of Object.keys(completedMap)) {
      if (!seen.has(blockId) && cache.blocks[blockId]) {
        seen.add(blockId);
        blocks.push(cache.blocks[blockId]);
      }
    }

    // Re-sort after potential additions
    blocks.sort((a, b) => {
      if (a.stageOrdering !== b.stageOrdering) return a.stageOrdering - b.stageOrdering;
      return a.name.localeCompare(b.name);
    });

    // Build roles array with their deduplicated block IDs
    const roles = [];
    for (const roleId of roleIds) {
      const role = cache.roles[roleId];
      if (!role) continue;
      const blockIds = new Set();
      for (const profileId of role.profileIds) {
        const profile = cache.profiles[profileId];
        if (!profile) continue;
        for (const blockId of profile.blockIds) {
          if (cache.blocks[blockId]) {
            blockIds.add(blockId);
          }
        }
      }
      roles.push({
        id: role.id,
        name: role.name,
        blockIds: Array.from(blockIds),
      });
    }

    res.json({
      blocks,
      completedMap,
      syncedAt: cache.ts,
      userPageId,
      onboardingStage,
      roles,
      stages: cache.stages,              // [{name, ordering}] sorted ascending
      employeeStageOrdering,             // numeric ordering of employee's current stage
    });

  } catch (err) {
    console.error('Training data error:', err.message);
    res.status(500).json({ error: 'Failed to load training data: ' + err.message });
  }
});

// ─── POST /api/complete ───────────────────────────────────────
app.post('/api/complete', requireAuth, async (req, res) => {
  try {
    const { blockId, blockName } = req.body || {};
    if (!blockId) return res.status(400).json({ error: 'blockId is required' });

    const { pageId: userPageId } = req.session;
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

    // Check if a Training Record already exists for this employee + block
    const existing = await queryAll(DB.trainingRecords, {
      and: [
        { property: 'Employee',       relation: { contains: userPageId } },
        { property: 'Training Block', relation: { contains: blockId    } },
      ],
    });

    if (existing.length) {
      // Update Date Completed on the existing record
      await notionFetch(`/pages/${existing[0].id}`, 'PATCH', {
        properties: {
          'Date Completed': { date: { start: today } },
        },
      });
      console.log(`✔  Updated Training Record ${existing[0].id} → ${today} (${req.session.name})`);
      res.json({ status: 'updated', recordId: existing[0].id, date: today });

    } else {
      // Create a new Training Record
      const newPage = await notionFetch('/pages', 'POST', {
        parent: { database_id: DB.trainingRecords },
        properties: {
          'Name':           { title:    [{ text: { content: blockName || 'Training Completion' } }] },
          'Employee':       { relation: [{ id: userPageId }] },
          'Training Block': { relation: [{ id: blockId    }] },
          'Date Completed': { date:     { start: today }     },
        },
      });
      console.log(`✔  Created Training Record ${newPage.id} → ${today} (${req.session.name})`);
      res.json({ status: 'created', recordId: newPage.id, date: today });
    }

  } catch (err) {
    console.error('Complete block error:', err.message);
    res.status(500).json({ error: 'Failed to record completion: ' + err.message });
  }
});

// ─── POST /api/sync ───────────────────────────────────────────
app.post('/api/sync', requireAuth, async (req, res) => {
  try {
    await refreshCache();
    res.json({ ok: true, syncedAt: cache.ts });
  } catch (err) {
    res.status(500).json({ error: 'Sync failed: ' + err.message });
  }
});

// ─── GET /api/block/:blockId/files ────────────────────────
app.get('/api/block/:blockId/files', requireAuth, async (req, res) => {
  try {
    const blockId = req.params.blockId;
    const page = await notionFetch(`/pages/${blockId}`);

    const getFiles = (p) => {
      if (!p) return [];
      const arr = p.files || [];
      return arr.map(f => ({
        name: f.name || 'File',
        url: f.type === 'file' ? f.file?.url : (f.type === 'external' ? f.external?.url : null),
      })).filter(f => f.url);
    };

    // Debug: log raw property structure so we can see exactly what Notion returns
    const rawForms   = prop(page, 'Associated forms ');
    const rawGuidance = prop(page, 'Guidance');
    const rawMedia   = prop(page, 'Files & media');
    console.log(`📎 Block ${blockId} raw props — forms:`, JSON.stringify(rawForms)?.slice(0, 200));
    console.log(`📎 Block ${blockId} raw props — guidance:`, JSON.stringify(rawGuidance)?.slice(0, 200));
    console.log(`📎 Block ${blockId} raw props — media:`, JSON.stringify(rawMedia)?.slice(0, 200));

    const associatedForms = getFiles(rawForms);
    const guidance        = getFiles(rawGuidance);
    const media           = getFiles(rawMedia);

    console.log(`📎 Block ${blockId} parsed — forms:${associatedForms.length} guidance:${guidance.length} media:${media.length}`);

    res.json({ associatedForms, guidance, media });
  } catch (err) {
    console.error(`❌ /api/block/${req.params.blockId}/files error:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Catch-all: serve frontend ────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ─── Start ────────────────────────────────────────────────────
refreshCache()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`\n⚡  Solve Training Portal → http://localhost:${PORT}\n`);
    });
    // Re-cache every 24 hours automatically
    setInterval(refreshCache, CACHE_TTL);
  })
  .catch(err => {
    console.error('\n❌  Startup failed:', err.message);
    console.error('    Check your NOTION_TOKEN and that the integration has access to the databases.\n');
    process.exit(1);
  });
