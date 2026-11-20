'use strict';
/**
 * Shared-secret check for the endpoints that Notion automations and Make call (not people):
 * /api/webhook/*, /api/regenerate-quiz/:id, /api/regenerate-missing-quizzes.
 *
 * The secret is WEBHOOK_SECRET (Railway). A caller sends it as the `x-webhook-secret` header (preferred),
 * `Authorization: Bearer <secret>`, or a `?secret=` query parameter (for tools that can only set a URL).
 *
 *   mode 'enforce'  wrong or missing secret → 401. If WEBHOOK_SECRET is not set at all the route is
 *                   open (so a deploy can never lock out the existing callers), and a warning is logged.
 *   mode 'strict'   same, but with no WEBHOOK_SECRET configured the route is switched off (503). For
 *                   routes nothing legitimate calls without a secret.
 *   mode 'log'      never blocks; logs whether the call carried a valid secret. Used while callers are
 *                   being updated, so the logs show who still needs it before enforcement is turned on.
 *
 * Compared in constant time. The secret is never logged.
 */
const crypto = require('crypto');

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();

function providedSecret(req) {
  const h = req.headers || {};
  if (h['x-webhook-secret']) return String(h['x-webhook-secret']);
  const auth = String(h.authorization || '');
  if (/^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '');
  if (req.query && req.query.secret) return String(req.query.secret);
  return '';
}

function secretMatches(req, secret) {
  const got = providedSecret(req);
  return !!got && crypto.timingSafeEqual(sha(got), sha(secret));
}

let warnedOpen = false;

/** @param {'enforce'|'strict'|'log'|(() => string)} mode  a function lets the mode follow an env var at request time */
function webhookGuard(mode = 'enforce', getSecret = () => process.env.WEBHOOK_SECRET) {
  return (req, res, next) => {
    const m = typeof mode === 'function' ? mode() : mode;
    const secret = getSecret();
    const where = `${req.method} ${String(req.path || req.url).split('?')[0]}`;

    if (!secret) {
      if (m === 'strict') return res.status(503).json({ error: 'This endpoint is switched off: WEBHOOK_SECRET is not set.' });
      if (!warnedOpen) { warnedOpen = true; console.warn('⚠️   WEBHOOK_SECRET is not set — webhook endpoints are open to anyone who knows the address.'); }
      return next();
    }
    const ok = secretMatches(req, secret);
    if (ok) return next();
    if (m === 'log') {
      console.warn(`⚠️   ${where} arrived without a valid webhook secret (allowed for now — update the caller)`);
      return next();
    }
    console.warn(`🚫  ${where} rejected: ${providedSecret(req) ? 'wrong' : 'missing'} webhook secret`);
    return res.status(401).json({ error: 'Unauthorized' });
  };
}

module.exports = { webhookGuard, providedSecret, secretMatches };
