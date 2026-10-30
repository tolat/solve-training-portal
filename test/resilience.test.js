'use strict';
const test   = require('node:test');
const assert = require('node:assert');
const http   = require('node:http');
const express = require('express');
const R = require('../resilience');

const FAST = { baseDelayMs: 5, maxDelayMs: 20, timeoutMs: 400, deadlineMs: 5000 };

function startMock(handler) {
  const hits = [];
  const server = http.createServer((req, res) => { hits.push(req.method + ' ' + req.url); handler(req, res, hits.length); });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () =>
    resolve({ url: `http://127.0.0.1:${server.address().port}`, hits, close: () => { server.closeAllConnections?.(); server.close(); } })));
}
function fakeMailer() {
  const sent = [];
  return { sent, sendMail: async (m) => { sent.push(m); } };
}
const json = (res, code, body, headers = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };

test('GET retries a 503 and succeeds without alerting', async () => {
  const m = fakeMailer(); R.init({ mailer: m, from: 'x@y.z' });
  const mock = await startMock((req, res, n) => n < 3 ? json(res, 503, { message: 'down' }) : json(res, 200, { ok: true }));
  const res = await R.fetchWithRetry(mock.url + '/v1/pages/abc', {}, { service: 'Notion', ...FAST });
  assert.equal(res.status, 200);
  assert.equal(mock.hits.length, 3);
  assert.equal(m.sent.length, 0);
  mock.close();
});

test('POST create is NOT re-sent after an ambiguous 500, and alerts once', async () => {
  const m = fakeMailer(); R.init({ mailer: m, from: 'x@y.z' });
  const mock = await startMock((req, res) => json(res, 500, { message: 'boom' }));
  const res = await R.fetchWithRetry(mock.url + '/v1/pages', { method: 'POST', body: '{}' }, { service: 'Notion', ...FAST });
  assert.equal(res.status, 500);
  assert.equal(mock.hits.length, 1, 'a page-creating POST must not be retried on a 500');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(m.sent.length, 1);
  assert.match(m.sent[0].subject, /Notion HTTP 500/);
  assert.equal(m.sent[0].to, 'torin@solveenergy.ca');
  mock.close();
});

test('POST is retried on 429 and honours Retry-After', async () => {
  const m = fakeMailer(); R.init({ mailer: m, from: 'x@y.z' });
  const mock = await startMock((req, res, n) => n === 1 ? json(res, 429, { message: 'slow down' }, { 'retry-after': '0' }) : json(res, 200, { id: 1 }));
  const res = await R.fetchWithRetry(mock.url + '/v1/pages', { method: 'POST', body: '{}' }, { service: 'Notion', ...FAST });
  assert.equal(res.status, 200);
  assert.equal(mock.hits.length, 2);
  mock.close();
});

test('a database query (POST but idempotent) is retried on 502', async () => {
  const m = fakeMailer(); R.init({ mailer: m, from: 'x@y.z' });
  const mock = await startMock((req, res, n) => n === 1 ? json(res, 502, {}) : json(res, 200, { results: [] }));
  const res = await R.fetchWithRetry(mock.url + '/v1/databases/x/query', { method: 'POST', body: '{}' }, { service: 'Notion', idempotent: true, ...FAST });
  assert.equal(res.status, 200);
  assert.equal(mock.hits.length, 2);
  mock.close();
});

test('a hanging server times out, retries, then throws a transient error and alerts', async () => {
  const m = fakeMailer(); R.init({ mailer: m, from: 'x@y.z' });
  const mock = await startMock(() => { /* never answer */ });
  await assert.rejects(
    R.fetchWithRetry(mock.url + '/v1/pages/hang', {}, { service: 'Notion', attempts: 2, ...FAST, timeoutMs: 80 }),
    (e) => e.transient === true && /timed out/.test(e.message));
  assert.equal(mock.hits.length, 2);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(m.sent.length, 1);
  assert.match(m.sent[0].subject, /timeout/);
  mock.close();
});

test('connection refused is retried even for a creating POST (request never sent)', async () => {
  const m = fakeMailer(); R.init({ mailer: m, from: 'x@y.z' });
  const dead = http.createServer(); await new Promise((r) => dead.listen(0, '127.0.0.1', r));
  const port = dead.address().port; await new Promise((r) => dead.close(r));
  let threw = null;
  const t0 = Date.now();
  try { await R.fetchWithRetry(`http://127.0.0.1:${port}/v1/pages`, { method: 'POST', body: '{}' }, { service: 'Notion', attempts: 3, ...FAST }); } catch (e) { threw = e; }
  assert.ok(threw && threw.transient);
  assert.ok(Date.now() - t0 >= 5, 'should have waited between attempts');
});

test('401 is not retried but is reported', async () => {
  const m = fakeMailer(); R.init({ mailer: m, from: 'x@y.z' });
  const mock = await startMock((req, res) => json(res, 401, { message: 'API token is invalid.' }));
  const res = await R.fetchWithRetry(mock.url + '/v1/users/me', {}, { service: 'Notion', ...FAST });
  assert.equal(res.status, 401);
  assert.equal(mock.hits.length, 1);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(m.sent.length, 1);
  assert.match(m.sent[0].text, /API token is invalid/);
  mock.close();
});

test('identical failures are throttled to one e-mail; different endpoints still alert', async () => {
  const m = fakeMailer(); R.init({ mailer: m, from: 'x@y.z' });
  const mock = await startMock((req, res) => json(res, 401, { message: 'nope' }));
  for (let i = 0; i < 4; i++) await R.fetchWithRetry(mock.url + '/v1/pages/11111111-1111-1111-1111-11111111111' + i, {}, { service: 'Notion', ...FAST });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(m.sent.length, 1, 'same endpoint shape (ids normalised) → one alert');
  await R.fetchWithRetry(mock.url + '/v1/blocks/xyz', {}, { service: 'Notion', ...FAST });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(m.sent.length, 2);
  mock.close();
});

test('alert e-mail never contains the auth header or token', async () => {
  const m = fakeMailer(); R.init({ mailer: m, from: 'x@y.z' });
  const mock = await startMock((req, res) => json(res, 403, { message: 'restricted' }));
  await R.fetchWithRetry(mock.url + '/v1/databases/secret', { headers: { Authorization: 'Bearer SECRET-TOKEN-123' } }, { service: 'Notion', ...FAST });
  await new Promise((r) => setTimeout(r, 30));
  const all = JSON.stringify(m.sent);
  assert.ok(m.sent.length >= 1);
  assert.ok(!all.includes('SECRET-TOKEN-123'));
  mock.close();
});

test('with no SMTP configured it logs and does not throw', async () => {
  R.init({ mailer: null });
  const mock = await startMock((req, res) => json(res, 403, { message: 'restricted' }));
  const res = await R.fetchWithRetry(mock.url + '/v1/databases/nosmtp', {}, { service: 'Notion', ...FAST });
  assert.equal(res.status, 403);
  await new Promise((r) => setTimeout(r, 20));
  mock.close();
});

test('middleware turns a handler 500 into a retryable 503 after a transient integration failure', async () => {
  const m = fakeMailer(); R.init({ mailer: m, from: 'x@y.z' });
  const mock = await startMock((req, res) => json(res, 503, { message: 'unavailable' }));
  const app = express(); app.use(express.json()); app.use(R.requestContext);
  app.get('/api/thing', async (req, res) => {
    try {
      const r = await R.fetchWithRetry(mock.url + '/v1/pages/zzz', {}, { service: 'Notion', attempts: 2, ...FAST });
      if (!r.ok) throw new Error('Notion API ' + r.status);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: 'Failed: ' + e.message }); }
  });
  app.get('/api/bug', (req, res) => res.status(500).json({ error: 'real bug' }));
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;

  const a = await fetch(base + '/api/thing');
  const aj = await a.json();
  assert.equal(a.status, 503);
  assert.equal(aj.retryable, true);
  assert.equal(aj.notified, true);
  assert.match(aj.error, /try again in a few minutes/);

  const b = await fetch(base + '/api/bug');
  assert.equal(b.status, 500, 'an unrelated 500 stays a 500');
  assert.equal((await b.json()).retryable, undefined);
  srv.close(); mock.close();
});

test('normalizeEndpoint strips ids and query strings', () => {
  assert.equal(R.normalizeEndpoint('https://api.notion.com/v1/pages/3feb73d8-b43a-81d1-9a88-e81622adefb5?x=1'), '/pages/:id');
  assert.equal(R.normalizeEndpoint('https://api.notion.com/v1/databases/2a8b73d8b43a8081b8ddc8d6d3f90d75/query'), '/databases/:id/query');
});
