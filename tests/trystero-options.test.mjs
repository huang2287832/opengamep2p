import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveTrysteroOptions } from '../dist/trystero.js';
import { networkConfig } from '../examples/network-config.mjs';

const publicTurn = [{ urls: 'turn:freestun.net:3478', username: 'free', credential: 'free' }];

test('signaling pins the same default relay pool as lobby discovery, preserving overrides and ICE', () => {
  const defaults = Array.from({ length: 8 }, (_, i) => `wss://relay-${i}.example`);
  assert.deepEqual(resolveTrysteroOptions({}, defaults).relayConfig.urls, defaults.slice(0, 5));
  const options = Object.freeze({ relayConfig: Object.freeze({ redundancy: 2, warnOnRelayFailure: false }), rtcConfig: { iceServers: [] } });
  assert.deepEqual(resolveTrysteroOptions(options, defaults), {
    relayConfig: { redundancy: 2, warnOnRelayFailure: false, urls: defaults.slice(0, 2) },
    rtcConfig: { iceServers: [] },
  });
  assert.equal(options.relayConfig.urls, undefined);
  const custom = { relayConfig: { urls: ['wss://custom.example'], redundancy: 1 } };
  assert.deepEqual(resolveTrysteroOptions(custom, defaults).relayConfig, custom.relayConfig);
  const first = resolveTrysteroOptions({}, defaults);
  first.relayConfig.urls.pop();
  assert.equal(defaults.length, 8);
});

test('default and demo configurations enable public TURN and preserve default STUN/direct ICE', () => {
  for (const options of [{}, networkConfig({}).options, { relayConfig: { urls: ['wss://relay.example'] } }]) {
    const resolved = resolveTrysteroOptions(options);
    assert.deepEqual(resolved.turnConfig, publicTurn);
    assert.equal(resolved.rtcConfig, undefined);
    assert.equal(options.turnConfig, undefined);
  }
});

test('developer TURN replaces public fallback without forcing relay or changing caller options', () => {
  const turnConfig = [{ urls: ['turn:developer.example', 'turns:developer.example:443'], username: 'u', credential: 'c' }];
  const options = Object.freeze({ turnConfig, rtcConfig: Object.freeze({ iceTransportPolicy: 'all' }) });
  const resolved = resolveTrysteroOptions(options);
  assert.deepEqual(resolved.turnConfig, turnConfig);
  assert.deepEqual(resolved.rtcConfig, { iceTransportPolicy: 'all' });
  assert.equal(resolved.turnConfig.some(server => String(server.urls).includes('freestun.net')), false);
});

test('explicit ICE list fully overrides defaults, including developer TURN and local-only mode', () => {
  for (const iceServers of [[], [{ urls: 'stun:developer.example' }], [{ urls: 'turn:developer.example', username: 'u', credential: 'c' }]]) {
    const options = { rtcConfig: { iceServers } };
    assert.deepEqual(resolveTrysteroOptions(options), options);
  }
  assert.deepEqual(resolveTrysteroOptions({ turnConfig: [] }).turnConfig, []);
});

test('relay-only diagnostics use public fallback while default resolution has no shared mutable list', () => {
  const options = networkConfig({ VITE_ICE_TRANSPORT_POLICY: 'relay' }).options;
  assert.deepEqual(resolveTrysteroOptions(options), { turnConfig: publicTurn, rtcConfig: { iceTransportPolicy: 'relay' } });
  const first = resolveTrysteroOptions();
  first.turnConfig[0].credential = 'modified';
  assert.deepEqual(resolveTrysteroOptions().turnConfig, publicTurn);
});
