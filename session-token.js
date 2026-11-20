'use strict';
/**
 * Signed sign-in tokens, so a person stays signed in across server restarts and deploys.
 *
 * Until now a token was a random string looked up in an in-memory table, so every deploy emptied the table and
 * signed everyone out. A token is now `v1.<payload>.<signature>`: the payload says who it is (Notion page id, e-mail)
 * and when it expires; the signature is an HMAC-SHA256 of the payload under SESSION_SECRET. After a restart the
 * server verifies the signature, then re-reads the person's record from Notion (see getSessionAsync in server.js),
 * so nothing sensitive lives in the token and a person removed from the directory stops working.
 *
 * Changing SESSION_SECRET signs everybody out (the emergency switch).
 */
const crypto = require('crypto');

const mac = (body, secret) => crypto.createHmac('sha256', secret).update('v1.' + body).digest();

function signToken(payload, secret) {
  if (!secret) throw new Error('SESSION_SECRET is required to sign a token');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `v1.${body}.${mac(body, secret).toString('base64url')}`;
}

/** The payload if the token is genuine and not expired, else null. */
function verifyToken(token, secret, now = Date.now()) {
  if (!token || !secret || typeof token !== 'string' || token.length > 2000) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  const expected = mac(parts[1], secret);
  let given;
  try { given = Buffer.from(parts[2], 'base64url'); } catch { return null; }
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { return null; }
  if (!payload || typeof payload !== 'object' || !payload.exp || payload.exp < now || !payload.p) return null;
  return payload;
}

module.exports = { signToken, verifyToken };
