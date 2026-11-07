// Unit tests for src/lib/parse.js (the proxy line reader): node extension/test/parse.mjs
import assert from 'node:assert/strict';
import { lineOf, parseList, parseProxy } from '../src/lib/parse.js';

const cases = [
  ['1.2.3.4:8080', { scheme: 'http', host: '1.2.3.4', port: 8080, username: '', password: '' }],
  ['gate.aeonproxy.com:7000:ap_u81f2-cc-de-sid-ab12cd34-time-600:rT4vQ9zLm2Xk', { host: 'gate.aeonproxy.com', port: 7000, username: 'ap_u81f2-cc-de-sid-ab12cd34-time-600', password: 'rT4vQ9zLm2Xk' }],
  ['gate.aeonproxy.com:7000@ap_u1:pw', { host: 'gate.aeonproxy.com', port: 7000, username: 'ap_u1', password: 'pw' }],
  ['ap_u1:pw:gate.aeonproxy.com:7000', { host: 'gate.aeonproxy.com', port: 7000, username: 'ap_u1', password: 'pw' }],
  ['ap_u1:pw@gate.aeonproxy.com:7000', { host: 'gate.aeonproxy.com', port: 7000, username: 'ap_u1', password: 'pw' }],
  ['http://ap_u1:pw@gate.aeonproxy.com:7000', { scheme: 'http', host: 'gate.aeonproxy.com', username: 'ap_u1' }],
  ['socks5://user:pass@10.0.0.1:1080', { scheme: 'socks5', host: '10.0.0.1', port: 1080, username: 'user', password: 'pass' }],
  ['socks5h://10.0.0.1:1080', { scheme: 'socks5', username: '' }],
  ['socks://10.0.0.1:1080', { scheme: 'socks5' }],
  ['https://u:p@proxy.example.net:443/', { scheme: 'https', port: 443 }],
  ['1.2.3.4:8080:user:pa:ss:word', { username: 'user', password: 'pa:ss:word' }],
  ['user:p@ss@1.2.3.4:8080', { username: 'user', password: 'p@ss' }],
  ['us.proxy.io:9000:customer-bob-cc-us:x', { host: 'us.proxy.io', port: 9000, username: 'customer-bob-cc-us' }],
  ['user1:12345:proxy.example.com:3128', { host: 'proxy.example.com', port: 3128, username: 'user1', password: '12345' }],
  ['[2001:db8::1]:8080', { host: '[2001:db8::1]', port: 8080 }],
  ['[2001:db8::1]:8080:u:p', { host: '[2001:db8::1]', username: 'u', password: 'p' }],
  ['  1.2.3.4:80 ', { host: '1.2.3.4', port: 80 }],
  ['u%40mail:p%3Ass@1.2.3.4:80', { username: 'u@mail', password: 'p:ss' }],
  ['GATE.AeonProxy.com:7000', { host: 'gate.aeonproxy.com' }],
];
for (const [line, want] of cases) {
  const got = parseProxy(line);
  for (const [k, v] of Object.entries(want)) assert.equal(got[k], v, `${line} → ${k}: ${got[k]} (want ${v})`);
}
for (const bad of ['', 'hello', '1.2.3.4', '1.2.3.4:99999', 'ftp://1.2.3.4:21', 'host:port', 'a b:c']) {
  assert.throws(() => parseProxy(bad), `should refuse "${bad}"`);
}
assert.equal(parseProxy('1.2.3.4:80', 'socks5').scheme, 'socks5', 'fallback scheme');
assert.equal(parseProxy('http://1.2.3.4:80', 'socks5').scheme, 'http', 'explicit scheme wins');
const l = parseList('1.2.3.4:80\n# comment\n\nnope\n5.6.7.8:81:a:b');
assert.equal(l.ok.length, 2); assert.equal(l.bad.length, 1); assert.equal(l.bad[0].line, 4);
assert.equal(lineOf({ host: 'h.io', port: 1, username: 'u', password: 'p' }), 'h.io:1:u:p');
console.log(`parse: ${cases.length + 13} checks passed`);
