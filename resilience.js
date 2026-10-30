'use strict';
/**
 * Resilience helpers for the Solve-U training portal back end.
 *
 *  - fetchWithRetry(): wraps fetch() for calls to Notion / Anthropic / file storage.
 *    Waits and retries timeouts, dropped connections, 429s and 5xx responses with
 *    exponential backoff (honouring Retry-After), but never blindly re-sends a
 *    write that might already have been applied (see "Safe to retry" below).
 *  - reportFailure() / reportError(): once retries are exhausted, e-mail the failure
 *    to ALERT_EMAIL (default torin@solveenergy.ca). Alerts are throttled so an
 *    outage produces a handful of e-mails, not hundreds.
 *  - requestContext middleware: remembers which request / user a failure belongs to,
 *    and turns a handler's generic 500 into a retryable 503 when the cause was a
 *    transient integration failure, so the browser knows it can wait and retry.
 *
 * Safe to retry
 *   - "safe" failures mean the request was definitely NOT processed (429, 503, 409
 *     conflict, connection refused / DNS): retried for every method.
 *   - "ambiguous" failures (timeouts, resets, 500/502/504) may have been processed:
 *     retried only for idempotent calls (GET, PATCH, database queries, uploads of
 *     the same bytes). A page-creating POST is not blindly re-sent.
 */
const { AsyncLocalStorage } = require('async_hooks');

const als = new AsyncLocalStorage();

let mailer   = null;
let mailFrom = null;
function init({ mailer: m, from } = {}) { mailer = m || null; mailFrom = from || null; }

const alertTo = () => process.env.ALERT_EMAIL || 'torin@solveenergy.ca';
const sleep   = (ms) => new Promise((r) => setTimeout(r, ms));

const SAFE_STATUS      = new Set([409, 425, 429, 503]);
const AMBIGUOUS_STATUS = new Set([408, 500, 502, 504, 520, 521, 522, 523, 524, 529]);
const CONNECT_CODES    = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT']);

const FRIENDLY_MESSAGE =
  'The training system is having trouble reaching its database right now. ' +
  'Our team has been notified. Please try again in a few minutes.';

// ─── request context ──────────────────────────────────────────
function getContext() { return als.getStore() || null; }

/** Run fn with a context label (used for background jobs so alerts say what was running). */
function runWithContext(ctx, fn) { return als.run({ failure: null, ...ctx }, fn); }

function setContextUser(user) {
  const ctx = getContext();
  if (ctx && user) ctx.user = { name: user.name || null, email: user.email || null };
}

/** Express middleware — must run after express.json(). */
function requestContext(req, res, next) {
  const ctx = {
    method:  req.method,
    path:    String(req.originalUrl || req.url || '').split('?')[0],
    user:    null,
    failure: null,
  };
  if (/^\/api\/(login|forgot-password)\b/.test(ctx.path) && req.body && req.body.email) {
    ctx.user = { name: null, email: String(req.body.email).slice(0, 120) };
  }

  // A handler that hit a transient integration failure ends up in its catch block and
  // answers 500. Tell the browser that is retryable (503) instead, so it waits and retries.
  const origJson = res.json.bind(res);
  res.json = (body) => {
    if (ctx.failure && ctx.failure.transient && res.statusCode >= 500 && res.statusCode !== 503 && !res.headersSent) {
      res.status(503);
      res.set('Retry-After', '10');
      const original = body && typeof body === 'object' ? body : {};
      body = { ...original, error: FRIENDLY_MESSAGE, detail: original.error, retryable: true, notified: true };
    }
    return origJson(body);
  };

  als.run(ctx, next);
}

// ─── classification & backoff ─────────────────────────────────
function errorCode(err) {
  const c = (err && err.cause && err.cause.code) || (err && err.code) || null;
  return typeof c === 'string' ? c : null; // a timeout DOMException has a numeric code (23) — not useful
}
function isTimeout(err) {
  return !!err && (err.name === 'TimeoutError' || err.name === 'AbortError');
}

/** → { retry, transient } for a response or a thrown network error. */
function classify(res, err, idempotent) {
  if (err) {
    const safe = CONNECT_CODES.has(errorCode(err));
    return { retry: safe || idempotent, transient: true };
  }
  const s = res.status;
  if (SAFE_STATUS.has(s))      return { retry: true,       transient: true };
  if (AMBIGUOUS_STATUS.has(s)) return { retry: idempotent, transient: true };
  return { retry: false, transient: false };
}

function retryAfterMs(res) {
  const h = res && res.headers && res.headers.get && res.headers.get('retry-after');
  if (!h) return null;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(h);
  return Number.isFinite(when) ? Math.max(0, when - Date.now()) : null;
}

function backoffMs(attempt, base, max) {
  const exp = Math.min(max, base * 2 ** (attempt - 1));
  return Math.round(exp * (0.5 + Math.random() * 0.5)); // jitter: 50–100% of the step
}

function normalizeEndpoint(url) {
  let s = String(url || '');
  try { const u = new URL(s); s = u.pathname; } catch { s = s.split('?')[0]; }
  return s
    .replace(/[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}/gi, ':id')
    .replace(/^\/v1/, '');
}

// ─── fetchWithRetry ───────────────────────────────────────────
/**
 * @param {string} url
 * @param {RequestInit} options
 * @param {object} cfg
 *   service      label for logs / e-mails ("Notion", "Anthropic"...)
 *   idempotent   safe to re-send after an ambiguous failure (default: everything but POST)
 *   attempts     max tries (default 5)
 *   baseDelayMs / maxDelayMs   backoff (default 1s → 20s)
 *   timeoutMs    per-attempt timeout (default 25s)
 *   deadlineMs   stop retrying once this much time has passed overall (default 60s)
 *   report       e-mail when finally failing (default true)
 * Returns the final Response (the caller still checks res.ok). Throws only for a network
 * error / timeout that survived every attempt.
 */
async function fetchWithRetry(url, options = {}, cfg = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const {
    service     = 'External service',
    idempotent  = method !== 'POST',
    attempts    = 5,
    baseDelayMs = 1000,
    maxDelayMs  = 20000,
    timeoutMs   = 25000,
    deadlineMs  = 60000,
    report      = true,
  } = cfg;

  const started  = Date.now();
  const endpoint = normalizeEndpoint(url);
  let res = null, err = null, decision = { retry: false, transient: false }, attempt = 0;

  for (attempt = 1; attempt <= attempts; attempt++) {
    res = null; err = null;
    try {
      res = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) { err = e; }

    if (res && res.ok) {
      if (attempt > 1) console.log(`✅  ${service} ${method} ${endpoint} recovered on attempt ${attempt}`);
      return res;
    }

    decision = classify(res, err, idempotent);
    if (!decision.retry || attempt === attempts) break;

    const wait = Math.min(maxDelayMs * 2, retryAfterMs(res) ?? backoffMs(attempt, baseDelayMs, maxDelayMs));
    if (Date.now() - started + wait > deadlineMs) break;

    const what = err ? (isTimeout(err) ? 'timed out' : `network error ${errorCode(err) || err.message}`) : `HTTP ${res.status}`;
    console.warn(`⚠️   ${service} ${method} ${endpoint} ${what} — retry ${attempt}/${attempts - 1} in ${(wait / 1000).toFixed(1)}s`);
    if (res) { try { await res.arrayBuffer(); } catch { /* free the connection */ } }
    await sleep(wait);
  }

  // ── Out of retries ──
  const failure = {
    service, method, endpoint,
    status:    res ? res.status : null,
    code:      err ? (isTimeout(err) ? 'TIMEOUT' : (errorCode(err) || err.name)) : null,
    attempts:  Math.min(attempt, attempts),
    transient: decision.transient,
    message:   err ? err.message : null,
  };
  if (res) {
    try { failure.message = (await res.clone().text()).slice(0, 600); } catch { /* ignore */ }
  }
  const ctx = getContext();
  if (ctx) ctx.failure = failure;
  console.error(`❌  ${service} ${method} ${endpoint} failed after ${failure.attempts} attempt(s): ${failure.status || failure.code}`);
  if (report) reportFailure(failure).catch(() => {});

  if (err) {
    const e = new Error(`${service} ${isTimeout(err) ? 'request timed out' : 'request failed'} (${method} ${endpoint}): ${err.message}`);
    e.cause = err;
    e.transient = true;
    throw e;
  }
  return res;
}

// ─── failure e-mails (throttled) ──────────────────────────────
const COOLDOWN_MS  = () => (Number(process.env.ALERT_COOLDOWN_MIN) || 15) * 60 * 1000;
const MAX_PER_HOUR = 12;
const lastSent     = new Map();   // key -> { at, suppressed }
let   sentLog      = [];          // timestamps of e-mails sent in the last hour
let   globalSuppressed = 0;

const escHtml = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function shouldSend(key) {
  const now = Date.now();
  sentLog = sentLog.filter((t) => now - t < 3600 * 1000);
  const entry = lastSent.get(key);
  if (entry && now - entry.at < COOLDOWN_MS()) { entry.suppressed++; return null; }
  if (sentLog.length >= MAX_PER_HOUR) { globalSuppressed++; if (entry) entry.suppressed++; return null; }
  const info = { repeats: entry ? entry.suppressed : 0, otherSuppressed: globalSuppressed };
  lastSent.set(key, { at: now, suppressed: 0 });
  sentLog.push(now);
  globalSuppressed = 0;
  return info;
}

async function sendAlert(subject, lines, key) {
  const info = shouldSend(key);
  if (!info) { console.warn(`🔕  Alert suppressed (cooldown): ${subject}`); return false; }

  const ctx  = getContext();
  const body = [...lines];
  if (ctx && ctx.path) {
    body.push(['Request', `${ctx.method || ''} ${ctx.path}`.trim()]);
    if (ctx.user && (ctx.user.email || ctx.user.name)) body.push(['User', [ctx.user.name, ctx.user.email].filter(Boolean).join(' · ')]);
  } else if (ctx && ctx.label) {
    body.push(['Running', ctx.label]);
  } else {
    body.push(['Running', 'background task']);
  }
  body.push(['Time', `${new Date().toISOString()} (${new Date().toLocaleString('en-CA', { timeZone: 'America/Vancouver' })} Pacific)`]);
  body.push(['Server', `${process.env.APP_URL || 'local'} · up ${Math.round(process.uptime() / 60)} min`]);
  if (info.repeats)         body.push(['Repeats', `${info.repeats} more occurrence(s) of this same failure since the last alert`]);
  if (info.otherSuppressed) body.push(['Other alerts held back', `${info.otherSuppressed} further alert(s) were held back by the hourly limit`]);

  const text = body.map(([k, v]) => `${k}: ${v}`).join('\n') +
    '\n\nThe portal retried automatically before giving up. People using it saw a "please try again" message.';
  const html = '<div style="font-family:system-ui,sans-serif;font-size:14px;color:#1a1a1a">' +
    `<h3 style="margin:0 0 12px">🚨 ${escHtml(subject)}</h3>` +
    '<table style="border-collapse:collapse">' +
    body.map(([k, v]) => `<tr><td style="padding:3px 14px 3px 0;color:#666;vertical-align:top;white-space:nowrap">${escHtml(k)}</td><td style="padding:3px 0;white-space:pre-wrap">${escHtml(v)}</td></tr>`).join('') +
    '</table><p style="color:#666;margin-top:14px">The portal retried automatically before giving up. People using it saw a "please try again" message.</p></div>';

  if (!mailer) {
    console.error(`🚨  ALERT (not e-mailed — SMTP_HOST / SMTP_USER / SMTP_PASS not set): ${subject}\n${text}`);
    return false;
  }
  try {
    await mailer.sendMail({ from: mailFrom, to: alertTo(), subject: `[Solve-U portal] ${subject}`, text, html });
    console.log(`📧  Failure alert e-mailed to ${alertTo()}: ${subject}`);
    return true;
  } catch (e) {
    console.error(`❌  Could not e-mail failure alert (${subject}): ${e.message}`);
    return false;
  }
}

/** An integration call that failed for good. */
async function reportFailure(f) {
  const what = f.status ? `HTTP ${f.status}` : (f.code === 'TIMEOUT' ? 'timeout' : `network error ${f.code || ''}`.trim());
  const subject = `${f.service} ${what} — ${f.method} ${f.endpoint}`;
  const key = `${f.service}|${f.method}|${f.endpoint}|${f.status || f.code}`;
  return sendAlert(subject, [
    ['Service', f.service],
    ['Call', `${f.method} ${f.endpoint}`],
    ['Result', f.status ? `HTTP ${f.status}` : (f.code || 'no response')],
    ['Attempts', String(f.attempts)],
    ['Detail', f.message || '(none)'],
  ], key);
}

/** Any other failure worth knowing about (startup, background refresh, crashes…). */
async function reportError(title, err, extra = []) {
  const message = err && err.stack ? String(err.stack).split('\n').slice(0, 6).join('\n') : String(err);
  const key = `err|${title}|${String(err && err.message || err).slice(0, 80)}`;
  return sendAlert(title, [['Error', message], ...extra], key);
}

module.exports = {
  init, fetchWithRetry, reportFailure, reportError,
  requestContext, runWithContext, setContextUser, getContext,
  normalizeEndpoint, classify, backoffMs, FRIENDLY_MESSAGE,
};
