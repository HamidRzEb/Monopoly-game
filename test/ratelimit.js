// Public-internet protection: room creation is rate limited per IP, and X-Forwarded-For is only
// trusted when TRUST_PROXY is set.
'use strict';
process.env.LIMIT_CREATE = '3';
process.env.LIMIT_JOIN = '4';
const assert = require('assert');
const http = require('http');
const { server } = require('../server.js');

const post = (port, path, body, headers = {}) => new Promise((resolve, reject) => {
  const data = JSON.stringify(body || {});
  const req = http.request({ port, method: 'POST', path, headers: { 'Content-Type': 'application/json', ...headers } }, (res) => {
    let buf = ''; res.on('data', (c) => (buf += c)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(buf), headers: res.headers }));
  });
  req.on('error', reject); req.end(data);
});

(async () => {
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await post(port, '/api/create', { name: 'P' + i })).status);
  assert.deepStrictEqual(codes, [200, 200, 200, 429, 429], 'only 3 rooms per IP, then 429: ' + codes);
  const j = [];
  for (let i = 0; i < 6; i++) j.push((await post(port, '/api/join', { room: 'ZZZZ', name: 'x' })).status);
  assert.deepStrictEqual(j.slice(0, 4), [404, 404, 404, 404]);
  assert.strictEqual(j[4], 429, 'join attempts are limited too (stops room-code guessing)');
  // a spoofed X-Forwarded-For must NOT dodge the limit when we are not behind a trusted proxy
  const spoof = await post(port, '/api/create', { name: 'sneaky' }, { 'X-Forwarded-For': '203.0.113.9' });
  assert.strictEqual(spoof.status, 429);
  assert.strictEqual(spoof.headers['x-content-type-options'], 'nosniff');
  console.log('ratelimit OK');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
