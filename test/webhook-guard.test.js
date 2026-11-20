'use strict';
const test   = require('node:test');
const assert = require('node:assert');
const { webhookGuard } = require('../webhook-guard');

function run(guard, { headers = {}, query = {}, path = '/api/x', method = 'POST' } = {}) {
  const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  let nexted = false;
  guard({ headers, query, path, method }, res, () => { nexted = true; });
  return { nexted, status: res.statusCode, body: res.body };
}
const SECRET = 'correct-horse-battery-staple-0123456789abcdef';
const guard = (mode, secret = SECRET) => webhookGuard(mode, () => secret);

test('enforce: header, bearer and query secrets are accepted', () => {
  assert.ok(run(guard('enforce'), { headers: { 'x-webhook-secret': SECRET } }).nexted);
  assert.ok(run(guard('enforce'), { headers: { authorization: 'Bearer ' + SECRET } }).nexted);
  assert.ok(run(guard('enforce'), { query: { secret: SECRET } }).nexted);
});

test('enforce: missing or wrong secret → 401 and the handler never runs', () => {
  for (const req of [{}, { headers: { 'x-webhook-secret': 'nope' } }, { query: { secret: SECRET + 'x' } }, { headers: { authorization: 'Bearer ' } }, { query: { secret: '' } }]) {
    const r = run(guard('enforce'), req);
    assert.equal(r.nexted, false);
    assert.equal(r.status, 401);
    assert.deepEqual(r.body, { error: 'Unauthorized' });
  }
});

test('enforce with no WEBHOOK_SECRET configured stays open (a deploy must never lock callers out)', () => {
  assert.ok(run(guard('enforce', ''), {}).nexted);
  assert.ok(run(guard('enforce', null), {}).nexted);
});

test('strict with no WEBHOOK_SECRET is switched off (503); with one it enforces', () => {
  const off = run(guard('strict', ''), { headers: { 'x-webhook-secret': 'anything' } });
  assert.equal(off.nexted, false); assert.equal(off.status, 503);
  assert.equal(run(guard('strict'), {}).status, 401);
  assert.ok(run(guard('strict'), { headers: { 'x-webhook-secret': SECRET } }).nexted);
});

test('log mode never blocks, with or without a secret', () => {
  assert.ok(run(guard('log'), {}).nexted);
  assert.ok(run(guard('log'), { headers: { 'x-webhook-secret': 'wrong' } }).nexted);
  assert.ok(run(guard('log'), { headers: { 'x-webhook-secret': SECRET } }).nexted);
});

test('the mode can follow an env var at request time', () => {
  let mode = 'log';
  const g = webhookGuard(() => mode, () => SECRET);
  assert.ok(run(g, {}).nexted);
  mode = 'enforce';
  assert.equal(run(g, {}).status, 401);
});

test('the secret never appears in log output', () => {
  const lines = []; const orig = console.warn; console.warn = (...a) => lines.push(a.join(' '));
  try { run(guard('enforce'), { headers: { 'x-webhook-secret': 'WRONG-SECRET-VALUE-123' } }); run(guard('log'), { query: { secret: 'ANOTHER-WRONG-456' } }); }
  finally { console.warn = orig; }
  const all = lines.join('\n');
  assert.ok(lines.length >= 2);
  assert.ok(!all.includes('WRONG-SECRET-VALUE-123') && !all.includes('ANOTHER-WRONG-456') && !all.includes(SECRET));
});
