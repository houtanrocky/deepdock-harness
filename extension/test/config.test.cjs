const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_LOOP_LIMIT, DEFAULT_TOOL_RESULT_DELAY_SECONDS, normalizeBridgeUrl, normalizeToolResultDelaySeconds } = require('../src/contracts.ts');
const { startBackground } = require('../src/background.js');

test('pacing defaults and stored values preserve explicit zero and reject corrupt settings', () => {
  assert.equal(DEFAULT_LOOP_LIMIT, 30);
  assert.equal(DEFAULT_TOOL_RESULT_DELAY_SECONDS, 2);
  for (const value of [undefined, null, '', '5', true, {}, NaN, Infinity, -1]) assert.equal(normalizeToolResultDelaySeconds(value), 2);
  assert.equal(normalizeToolResultDelaySeconds(0), 0);
  assert.equal(normalizeToolResultDelaySeconds(4.5), 4.5);
  assert.equal(normalizeToolResultDelaySeconds(400), 300);
});

test('bridge addresses are canonical loopback HTTP origins', () => {
  assert.equal(normalizeBridgeUrl('http://127.0.0.1:8765/'), 'http://127.0.0.1:8765');
  assert.equal(normalizeBridgeUrl('http://127.0.0.1:80'), 'http://127.0.0.1');
  for (const address of ['https://example.com', 'http://localhost:8765', 'http://192.168.1.2:8765', 'http://127.0.0.1.evil.example', 'http://token@127.0.0.1', 'http://127.0.0.1/path', 'http://127.0.0.1?token=secret', 'http://127.0.0.1#fragment', 'file:///bridge', 'not-a-url']) {
    assert.throws(() => normalizeBridgeUrl(address), undefined, address);
  }
});

test('background registration is synchronous and disposal removes its own listeners', async () => {
  const messages = new Set();
  const alarms = new Set();
  let requests = 0;
  const event = (listeners) => ({ addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn) });
  const browser = {
    runtime: { onMessage: event(messages) },
    alarms: { onAlarm: event(alarms) },
    storage: { local: { async get() { return { token: 'secret', baseUrl: 'https://example.com' }; } } },
  };
  const background = startBackground(browser, { fetch: async () => { requests++; } });
  assert.equal(messages.size, 1);
  assert.equal(alarms.size, 1);
  await assert.rejects(background.bridgeFetch({ path: '/health' }), /127\.0\.0\.1/);
  assert.equal(requests, 0, 'A corrupted saved address must not send credentials off device');
  background.dispose();
  background.dispose();
  assert.equal(messages.size, 0);
  assert.equal(alarms.size, 0);
});
