'use strict';
const test   = require('node:test');
const assert = require('node:assert');
const { signToken, verifyToken } = require('../session-token');

const KEY = 'k'.repeat(48);
const P = { p: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', e: 'a@b.ca', exp: Date.now() + 60000 };

test('a signed token verifies and returns its payload', () => {
  const t = signToken(P, KEY);
  assert.match(t, /^v1\.[\w-]+\.[\w-]+$/);
  assert.deepEqual(verifyToken(t, KEY), P);
});
test('wrong key, no key and no token are all rejected', () => {
  const t = signToken(P, KEY);
  assert.equal(verifyToken(t, 'x'.repeat(48)), null);
  assert.equal(verifyToken(t, ''), null);
  assert.equal(verifyToken('', KEY), null);
  assert.equal(verifyToken(undefined, KEY), null);
});
test('an expired token is rejected', () => {
  const t = signToken({ ...P, exp: Date.now() - 1 }, KEY);
  assert.equal(verifyToken(t, KEY), null);
});
test('editing the payload (a different person, a later expiry) breaks the signature', () => {
  const [v, , sig] = signToken(P, KEY).split('.');
  const forged = Buffer.from(JSON.stringify({ ...P, p: 'ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee', exp: Date.now() + 1e12 })).toString('base64url');
  assert.equal(verifyToken(`${v}.${forged}.${sig}`, KEY), null);
});
test('a flipped signature, truncation, junk and an old random-style token are rejected', () => {
  const t = signToken(P, KEY);
  const [v, b, s] = t.split('.');
  assert.equal(verifyToken(`${v}.${b}.${s.slice(0, -2)}AA`, KEY), null);
  assert.equal(verifyToken(`${v}.${b}`, KEY), null);
  assert.equal(verifyToken('not a token', KEY), null);
  assert.equal(verifyToken('a'.repeat(64), KEY), null);
  assert.equal(verifyToken('v1.' + 'x'.repeat(3000) + '.y', KEY), null);
});
test('a token with no person in it is rejected even if validly signed', () => {
  assert.equal(verifyToken(signToken({ exp: Date.now() + 1000 }, KEY), KEY), null);
});
test('signing without a key throws rather than producing an unsigned token', () => {
  assert.throws(() => signToken(P, ''));
});
