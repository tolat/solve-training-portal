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
    // Determine if ANY linked stage is an Employee stage (starts with 'E')
    const isEStage = n => (n || '').trimStart().toUpperCase().startsWith('E');
    const hasEmployeeStage = stageIds.some(id => isEStage(stageMap[id]?.name));

    if (stageIds.length) {
      // For ordering/display: prefer the minimum E-stage if one exists,
      // otherwise fall back to the global minimum. This prevents a contractor
      // stage (e.g. C1) from masking an employee stage at the same ordering.
      const eStageIds = stageIds.filter(id => isEStage(stageMap[id]?.name));
      const candidateIds = eStageIds.length ? eStageIds : stageIds;
      stageOrdering = Math.min(...candidateIds.map(id => stageOrderMap[id] ?? 999));
      const minStageId = candidateIds.find(id => (stageOrderMap[id] ?? 999) === stageOrdering);
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
      hasEmployeeStage,
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

// ─── Generated quiz store ─────────────────────────────────────
// Persisted to disk so quizzes survive server restarts.
// Shape: { [blockIdNoDashes]: [ { q, options, correct }, … ] }
const QUIZ_FILE = path.join(__dirname, 'quizzes-generated.json');

let generatedQuizzes = {};

function loadGeneratedQuizzes() {
  try {
    const raw = require('fs').readFileSync(QUIZ_FILE, 'utf8');
    generatedQuizzes = JSON.parse(raw);
    console.log(`📚  Loaded generated quizzes for ${Object.keys(generatedQuizzes).length} block(s)`);
  } catch {
    generatedQuizzes = {};
  }
}

function saveGeneratedQuizzes() {
  try {
    require('fs').writeFileSync(QUIZ_FILE, JSON.stringify(generatedQuizzes, null, 2));
  } catch (e) {
    console.error('⚠️   Could not save quizzes-generated.json:', e.message);
  }
}

loadGeneratedQuizzes();

// ─── AI quiz generation ───────────────────────────────────────
async function fetchBlockPageText(blockId) {
  // Pull the Notion page children (text blocks) to give the AI real content
  try {
    const data = await notionFetch(`/blocks/${blockId}/children?page_size=100`);
    const texts = (data.results || [])
      .map(b => {
        const rt = b[b.type]?.rich_text || [];
        return rt.map(t => t.plain_text).join('');
      })
      .filter(Boolean);
    return texts.join('\n');
  } catch {
    return '';
  }
}

async function generateQuizForBlock(block) {
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) {
    console.warn('⚠️   ANTHROPIC_API_KEY not set — skipping quiz generation');
    return null;
  }

  const pageText = await fetchBlockPageText(block.id);

  const prompt = `You are writing quiz questions for an employee training portal at Solve Energy, a solar energy company in British Columbia, Canada.

Training Module: ${block.name}${block.policyNo ? `\nPolicy Number: ${block.policyNo}` : ''}${block.notes ? `\nNotes: ${block.notes}` : ''}${pageText ? `\nTraining Content:\n${pageText}` : ''}

Generate 5 multiple-choice quiz questions that test real understanding of this training material. Make them practical and scenario-based where possible — not just definition recall.

Return ONLY a valid JSON array, no markdown fences, no explanation:
[
  {
    "q": "Question text?",
    "options": ["Option A", "Option B", "Option C", "Option D"],
    "correct": 2
  }
]

Rules:
- Exactly 4 options per question
- "correct" is the 0-based index of the correct answer
- Vary which index is correct across questions — don't always use 0 or 1
- Questions should be challenging but unambiguous
- Incorrect options should be plausible, not obviously wrong`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${err}`);
  }

  const data = await res.json();
  const text = data.content?.[0]?.text || '';

  // Strip any accidental markdown fences then parse
  const clean = text.replace(/^```[a-z]*\n?/i, '').replace(/```$/m, '').trim();
  const questions = JSON.parse(clean);

  if (!Array.isArray(questions) || !questions.length) throw new Error('Empty quiz returned');
  return questions;
}

async function regenerateQuizForBlock(blockId) {
  // Normalise to no-dashes for both cache lookup and storage key
  const key   = blockId.replace(/-/g, '');
  const dashId = blockId.includes('-') ? blockId
    : `${blockId.slice(0,8)}-${blockId.slice(8,12)}-${blockId.slice(12,16)}-${blockId.slice(16,20)}-${blockId.slice(20)}`;

  const block = cache.blocks[dashId] || cache.blocks[blockId] || null;
  if (!block) {
    console.warn(`⚠️   regenerateQuizForBlock: block ${blockId} not in cache`);
    return;
  }

  console.log(`🤖  Generating quiz for: ${block.name}`);
  try {
    const questions = await generateQuizForBlock(block);
    if (questions) {
      generatedQuizzes[key] = questions;
      saveGeneratedQuizzes();
      console.log(`✅  Quiz generated for "${block.name}" (${questions.length} questions)`);
    }
  } catch (e) {
    console.error(`❌  Quiz generation failed for "${block.name}":`, e.message);
  }
}

// ─── Express app ──────────────────────────────────────────────
const app = express();
app.use(express.json());

// Service worker and manifest must never be cached by the browser
// (SW scope + update detection depends on a fresh response each time)
app.get('/sw.js', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Content-Type', 'application/javascript');
  res.sendFile(path.join(__dirname, 'sw.js'));
});
app.get('/manifest.json', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'manifest.json'));
});

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
    const storedPw = richText(prop(user, 'Training Portal Password')) || 'solveenergy';

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

// ─── POST /api/change-password ───────────────────────────────
app.post('/api/change-password', requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current and new password are required.' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters.' });
    }

    const { email, pageId } = req.session;

    // Look up the user's current stored password
    const results = await queryAll(DB.companyDirectory, {
      property: 'Email',
      email: { equals: email },
    });
    if (!results.length) return res.status(404).json({ error: 'User not found.' });

    const user     = results[0];
    const storedPw = richText(prop(user, 'Training Portal Password')) || 'solveenergy';

    if (storedPw !== currentPassword) {
      return res.status(401).json({ error: 'Current password is incorrect.' });
    }

    // Update the password in Notion
    await notionFetch(`/pages/${user.id}`, 'PATCH', {
      properties: {
        'Training Portal Password': {
          rich_text: [{ text: { content: newPassword } }],
        },
      },
    });

    console.log(`🔑  Password changed for ${email}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('Change-password error:', err.message);
    res.status(500).json({ error: 'Failed to change password: ' + err.message });
  }
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
    const password = richText(prop(user, 'Training Portal Password')) || 'solveenergy';

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
    const allRoleBlockIds = new Set(); // track every block already in a real role
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
            allRoleBlockIds.add(blockId);
          }
        }
      }
      roles.push({
        id: role.id,
        name: role.name,
        blockIds: Array.from(blockIds),
      });
    }

    // Any blocks that exist in training records but aren't in any role's chain
    // get surfaced as a virtual "Other Assigned Trainings" role so the
    // frontend renders them without needing any changes.
    const supplementBlockIds = blocks
      .filter(b => !allRoleBlockIds.has(b.id))
      .map(b => b.id);
    if (supplementBlockIds.length) {
      roles.push({
        id: '__supplement__',
        name: 'Other Assigned Trainings',
        blockIds: supplementBlockIds,
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
// Refreshes both the shared training-data cache AND the current user's
// employee record (name, roles, onboarding stage) from Notion.
app.post('/api/sync', requireAuth, async (req, res) => {
  try {
    console.log(`🔄  Sync triggered by: ${req.session?.email || 'unknown'}`);

    // 1. Refresh shared training content cache
    await refreshCache();

    // 2. Re-query the employee's Company Directory entry — same code path as
    //    login so property parsing is guaranteed identical.
    const { email } = req.session;
    console.log(`🔄  Looking up employee in Notion for email: ${email}`);
    const results = await queryAll(DB.companyDirectory, {
      property: 'Email',
      email: { equals: email },
    });

    if (results.length) {
      const user            = results[0];
      const name            = titleTxt(prop(user, 'Name'));
      const roleIds         = relIds(prop(user, 'Roles'));
      const onboardingStage = prop(user, 'Ordered Onboarding Stage')?.select?.name || null;

      // req.session is the live session object — mutating it is enough.
      req.session.name            = name;
      req.session.roleIds         = roleIds;
      req.session.onboardingStage = onboardingStage;

      console.log(`🔄  Sync: employee data refreshed for ${name} — Stage: ${onboardingStage || 'none'}`);
      res.json({ ok: true, syncedAt: cache.ts, name, onboardingStage });
    } else {
      // User not found in directory — still succeed with training cache refresh
      console.warn(`🔄  Sync: training cache refreshed but employee not found for email ${email}`);
      res.json({ ok: true, syncedAt: cache.ts });
    }

  } catch (err) {
    console.error('Sync error:', err.message);
    res.status(500).json({ error: 'Sync failed: ' + err.message });
  }
});

// ─── GET /api/debug/user?email= ──────────────────────────────
// Diagnostic endpoint — call this to understand why a user's block
// count differs between Notion and the portal.
// e.g. GET /api/debug/user?email=steven@solveenergy.ca
app.get('/api/debug/user', async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: 'email query param required' });

    if (Date.now() - cache.ts > CACHE_TTL) await refreshCache();

    // Look up the user
    const results = await queryAll(DB.companyDirectory, {
      property: 'Email',
      email: { equals: email.toLowerCase().trim() },
    });
    if (!results.length) return res.status(404).json({ error: 'User not found in Company Directory' });

    const user            = results[0];
    const name            = titleTxt(prop(user, 'Name'));
    const roleIds         = relIds(prop(user, 'Roles'));
    const onboardingStage = prop(user, 'Ordered Onboarding Stage')?.select?.name || null;
    const userPageId      = user.id;

    // 1. Blocks from role chain
    const seen = new Set();
    const roleChainBlocks = [];
    const roleDetail = [];
    for (const roleId of roleIds) {
      const role = cache.roles[roleId];
      if (!role) { roleDetail.push({ roleId, found: false }); continue; }
      const profileDetail = [];
      for (const profileId of role.profileIds) {
        const profile = cache.profiles[profileId];
        if (!profile) { profileDetail.push({ profileId, found: false }); continue; }
        const blocksMapped = [], blocksMissing = [];
        for (const blockId of profile.blockIds) {
          if (seen.has(blockId)) continue;
          seen.add(blockId);
          if (cache.blocks[blockId]) {
            roleChainBlocks.push(blockId);
            const b = cache.blocks[blockId];
            blocksMapped.push({ id: blockId, name: b.name, stageName: b.stageName, stageOrdering: b.stageOrdering });
          }
          else blocksMissing.push(blockId);
        }
        profileDetail.push({ profileId, name: profile.name, blocksMapped, blocksMissing });
      }
      roleDetail.push({ roleId, name: role.name, profiles: profileDetail });
    }

    // 2. Training records
    const recordPages = await queryAll(DB.trainingRecords, {
      property: 'Employee',
      relation: { contains: userPageId },
    });

    const recordsInCache = [], recordsNotInCache = [], recordsNoBlock = [];
    for (const r of recordPages) {
      const blockRel = relIds(prop(r, 'Training Block'));
      if (!blockRel.length) { recordsNoBlock.push(r.id); continue; }
      const blockId = blockRel[0];
      if (cache.blocks[blockId]) recordsInCache.push({ recordId: r.id, blockId, blockName: cache.blocks[blockId].name });
      else recordsNotInCache.push({ recordId: r.id, blockId });
    }

    // 3. Supplement blocks (in records but not in role chain)
    const supplementBlocks = recordsInCache.filter(r => !seen.has(r.blockId));

    res.json({
      user: { name, email, onboardingStage, roleCount: roleIds.length },
      summary: {
        cacheBlocksTotal:      Object.keys(cache.blocks).length,
        roleChainBlocks:       roleChainBlocks.length,
        trainingRecordsTotal:  recordPages.length,
        recordsWithNoBlock:    recordsNoBlock.length,
        recordsBlockInCache:   recordsInCache.length,
        recordsBlockNotInCache: recordsNotInCache.length,
        supplementBlocks:      supplementBlocks.length,
        portalTotalWouldShow:  roleChainBlocks.length + supplementBlocks.length,
      },
      // These are the records whose blocks exist in Notion but aren't loaded
      // in the cache — root cause of most discrepancies
      recordsBlockNotInCache: recordsNotInCache,
      roles: roleDetail,
    });
  } catch (err) {
    console.error('Debug user error:', err.message);
    res.status(500).json({ error: err.message });
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

// ─── GET /api/quizzes ─────────────────────────────────────────
// Returns all AI-generated quizzes so the frontend can merge them
// with the static quiz-data.js fallbacks.
app.get('/api/quizzes', requireAuth, (req, res) => {
  res.json(generatedQuizzes);
});

// ─── POST /api/webhook/notion ─────────────────────────────────
// Called by a Notion Automation whenever a Training Block page changes.
//
// Setup in Notion:
//   Trigger : "Page updated" on the Training Blocks database
//   Action  : Send HTTP request → POST https://<your-domain>/api/webhook/notion?secret=<WEBHOOK_SECRET>
//   Body    : { "blockId": "{{Page ID}}" }
//
// The endpoint immediately returns 200 and processes in the background
// so Notion's 10-second webhook timeout is never hit.
app.post('/api/webhook/notion', async (req, res) => {
  // Acknowledge immediately — Notion has a short timeout
  res.json({ ok: true, message: 'Received — processing in background' });

  // ── Background processing ──
  const blockId = req.body?.id || req.body?.blockId || req.body?.data?.id || null;
  console.log(`🔔  Notion webhook received${blockId ? ` — block: ${blockId}` : ' (no blockId)'}`);

  try {
    await refreshCache();

    if (blockId) {
      await regenerateQuizForBlock(blockId);
    } else {
      // No specific block — regenerate quizzes for ALL blocks that have
      // content (notes or page children), up to a reasonable limit
      console.log('🤖  No specific blockId — regenerating quizzes for all blocks...');
      const blockIds = Object.keys(cache.blocks);
      for (const id of blockIds) {
        await regenerateQuizForBlock(id);
      }
    }
  } catch (err) {
    console.error('❌  Webhook processing error:', err.message);
  }
});

// ─── POST /api/regenerate-quiz/:blockId ───────────────────────
// Manual trigger — useful when setting up or testing quiz generation.
// Protected by the same WEBHOOK_SECRET.
app.post('/api/regenerate-quiz/:blockId', async (req, res) => {
  const { blockId } = req.params;

  // Ensure cache is fresh
  if (Date.now() - cache.ts > CACHE_TTL) await refreshCache();

  res.json({ ok: true, message: `Regenerating quiz for ${blockId} in background` });

  regenerateQuizForBlock(blockId).catch(e =>
    console.error(`❌  Manual regenerate failed for ${blockId}:`, e.message)
  );
});

// ─── POST /api/webhook/notion/role ───────────────────────────
// Called by a Notion Automation when a Role is created or updated.
// Just refreshes the cache so the new role is available immediately.
//
// Setup in Notion:
//   Trigger : "Page added" (or "Page updated") on the Roles database
//   Action  : Send HTTP request → POST https://<your-domain>/api/webhook/notion/role
app.post('/api/webhook/notion/role', async (req, res) => {
  res.json({ ok: true, message: 'Received — refreshing cache in background' });
  console.log('🔔  Notion webhook: new/updated Role — refreshing cache');
  try {
    await refreshCache();
    console.log('✅  Cache refreshed after Role change');
  } catch (err) {
    console.error('❌  Cache refresh failed (role webhook):', err.message);
  }
});

// ─── POST /api/webhook/notion/profile ────────────────────────
// Called by a Notion Automation when a Training Profile is created or updated.
// Refreshes the cache so the new profile and its blocks are picked up.
//
// Setup in Notion:
//   Trigger : "Page added" (or "Page updated") on the Training Profiles database
//   Action  : Send HTTP request → POST https://<your-domain>/api/webhook/notion/profile
app.post('/api/webhook/notion/profile', async (req, res) => {
  res.json({ ok: true, message: 'Received — refreshing cache in background' });
  console.log('🔔  Notion webhook: new/updated Training Profile — refreshing cache');
  try {
    await refreshCache();
    console.log('✅  Cache refreshed after Training Profile change');
  } catch (err) {
    console.error('❌  Cache refresh failed (profile webhook):', err.message);
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
