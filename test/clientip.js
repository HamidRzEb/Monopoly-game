// Visitor-address detection behind a CDN: headers are only believed from trusted proxies, and
// forged X-Forwarded-For entries on the left can't be used to dodge the rate limits.
'use strict';
const assert = require('assert');
const { makeClientIpResolver } = require('../server.js');
const req = (peer, headers = {}) => ({ socket: { remoteAddress: peer }, headers });

// 1. not behind a proxy: headers are ignored entirely
{
  const f = makeClientIpResolver({});
  assert.strictEqual(f(req('203.0.113.5', { 'x-forwarded-for': '6.6.6.6', 'ar-real-ip': '7.7.7.7' })), '203.0.113.5');
  assert.strictEqual(f(req('::ffff:10.0.0.9')), '10.0.0.9', 'IPv4-mapped addresses are normalised');
}
// 2. X-Forwarded-For with one trusted hop: take the RIGHTMOST entry (what our proxy saw)
{
  const f = makeClientIpResolver({ hops: 1 });
  assert.strictEqual(f(req('185.1.1.1', { 'x-forwarded-for': '1.1.1.1, 2.2.2.2, 9.9.9.9' })), '9.9.9.9', 'forged left entries are ignored');
  assert.strictEqual(f(req('185.1.1.1', { 'x-forwarded-for': '9.9.9.9' })), '9.9.9.9');
  assert.strictEqual(f(req('185.1.1.1', {})), '185.1.1.1', 'no header -> connecting address');
  assert.strictEqual(f(req('185.1.1.1', { 'x-forwarded-for': 'garbage' })), '185.1.1.1', 'invalid value -> connecting address');
  assert.strictEqual(makeClientIpResolver({ hops: 2 })(req('10.0.0.1', { 'x-forwarded-for': '1.1.1.1, 5.5.5.5, 10.0.0.2' })), '5.5.5.5', 'two proxies -> second from the right');
}
// 3. a dedicated header the proxy overwrites (Arvan: ar-real-ip) wins over X-Forwarded-For
{
  const f = makeClientIpResolver({ hops: 1, header: 'Ar-Real-IP' });
  assert.strictEqual(f(req('185.215.232.195', { 'ar-real-ip': '128.14.84.134', 'x-forwarded-for': '9.9.9.9, 128.14.84.134' })), '128.14.84.134');
  assert.strictEqual(f(req('185.215.232.195', { 'ar-real-ip': 'nope', 'x-forwarded-for': '9.9.9.9, 128.14.84.134' })), '128.14.84.134', 'bad header falls back to XFF');
  assert.strictEqual(f(req('185.215.232.195', { 'ar-real-ip': '2001:db8::1' })), '2001:db8::1', 'IPv6 visitors work');
}
// 4. only believe the proxy's headers when the connection really comes from the proxy's ranges
{
  const f = makeClientIpResolver({ hops: 1, header: 'ar-real-ip', cidrs: ['185.143.232.0/22', '94.101.182.0/27', '2001:db8:aaaa::/48'] });
  assert.strictEqual(f(req('::ffff:185.143.234.132', { 'ar-real-ip': '128.14.84.134' })), '128.14.84.134', 'inside a range (IPv4-mapped peer)');
  assert.strictEqual(f(req('94.101.182.10', { 'ar-real-ip': '1.2.3.4' })), '1.2.3.4');
  assert.strictEqual(f(req('94.101.182.40', { 'ar-real-ip': '1.2.3.4' })), '94.101.182.40', 'just outside a /27');
  assert.strictEqual(f(req('203.0.113.77', { 'ar-real-ip': '1.2.3.4', 'x-forwarded-for': '1.2.3.4' })), '203.0.113.77', 'direct-to-origin attacker cannot fake it');
  assert.strictEqual(f(req('2001:db8:aaaa::5', { 'ar-real-ip': '8.8.4.4' })), '8.8.4.4', 'IPv6 ranges work');
  assert.strictEqual(f(req('2001:db8:bbbb::5', { 'ar-real-ip': '8.8.4.4' })), '2001:db8:bbbb::5');
}
assert.throws(() => makeClientIpResolver({ hops: 1, cidrs: ['not-an-ip/24'] }), /Bad TRUSTED_PROXY_CIDRS/);
console.log('clientip OK');
process.exit(0);
