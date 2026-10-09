// With the CDN settings on, limits are counted per VISITOR (from ar-real-ip), not per CDN address,
// and the real ArvanCloud range file parses.
'use strict';
const fs = require('fs');
process.env.TRUST_PROXY = '1';
process.env.CLIENT_IP_HEADER = 'ar-real-ip';
process.env.LIMIT_CREATE = '2';
// pretend the test connection (127.0.0.1) is the CDN
process.env.TRUSTED_PROXY_CIDRS = '127.0.0.0/8,::1/128';
const assert = require('assert');
const http = require('http');
const { server, makeClientIpResolver } = require('../server.js');

const ranges = fs.readFileSync(__dirname + '/../deploy/arvancloud-ips.txt', 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
assert(ranges.length >= 5, 'arvan range file should have entries');
const f = makeClientIpResolver({ hops: 1, header: 'ar-real-ip', cidrs: ranges }); // must not throw
assert.strictEqual(f({ socket: { remoteAddress: '::ffff:185.215.232.195' }, headers: { 'ar-real-ip': '128.14.84.134' } }), '128.14.84.134', 'the address seen in production is covered');

const create = (port, ip, extra = {}) => new Promise((resolve, reject) => {
  const data = JSON.stringify({ name: 'p' });
  const req = http.request({ port, method: 'POST', path: '/api/create', headers: { 'Content-Type': 'application/json', 'ar-real-ip': ip, ...extra } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
  req.on('error', reject); req.end(data);
});
(async () => {
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const a = [await create(port, '198.51.100.1'), await create(port, '198.51.100.1'), await create(port, '198.51.100.1')];
  assert.deepStrictEqual(a, [200, 200, 429], 'visitor A is limited after 2 rooms: ' + a);
  assert.strictEqual(await create(port, '198.51.100.2'), 200, 'visitor B is NOT affected by visitor A');
  assert.strictEqual(await create(port, '198.51.100.1', { 'x-forwarded-for': '203.0.113.99' }), 429, 'a forged X-Forwarded-For does not reset the limit');
  console.log('ratelimit-proxy OK');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
