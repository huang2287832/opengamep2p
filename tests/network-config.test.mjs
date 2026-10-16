import test from 'node:test';
import assert from 'node:assert/strict';
import { networkConfig, networkErrorMessage } from '../examples/network-config.mjs';

test('custom signaling relay keeps default STUN enabled', () => {
  const { options } = networkConfig({ VITE_RELAY_URL: 'wss://relay.example' });
  assert.deepEqual(options.relayConfig.urls, ['wss://relay.example']);
  assert.equal(options.rtcConfig, undefined);
});

test('TURN supports provider UDP/TCP/TLS URLs and optional forced relay diagnosis', () => {
  const { options } = networkConfig({ VITE_TURN_URLS: 'turn:relay.example:3478?transport=udp, turns:relay.example:443?transport=tcp',
    VITE_TURN_USERNAME: 'temporary-user', VITE_TURN_CREDENTIAL: 'temporary-credential', VITE_ICE_TRANSPORT_POLICY: 'relay' });
  assert.equal(options.turnConfig[0].urls.length, 2);
  assert.deepEqual(options.rtcConfig, { iceTransportPolicy: 'relay' });
  const local = networkConfig({ VITE_TEST_LOCAL_ICE: true, VITE_TURN_URLS: 'turn:relay.example',
    VITE_TURN_USERNAME: 'u', VITE_TURN_CREDENTIAL: 'c' }).options;
  assert.deepEqual(local.rtcConfig.iceServers, local.turnConfig);
});

test('invalid or incomplete TURN settings fail without exposing credentials', () => {
  for (const env of [{ VITE_TURN_URLS: 'https://relay.example' },
    { VITE_TURN_URLS: 'turn:relay.example' }, { VITE_TURN_CREDENTIAL: 'secret-value' }, { VITE_ICE_TRANSPORT_POLICY: 'unknown' }]) {
    assert.throws(() => networkConfig(env), error => !error.message.includes('secret-value'));
  }
  assert.deepEqual(networkConfig({}).options, {});
});

test('SDP failure distinguishes missing TURN from configured but unreachable TURN', () => {
  assert.match(networkErrorMessage(new Error('could not connect to peer X after exchanging SDP; configure TURN servers with turnConfig')), /公共 TURN 可能不可达/);
  assert.match(networkErrorMessage(new Error('could not connect to peer X after exchanging SDP; check that your TURN server URLs and credentials are reachable')), /凭据是否有效/);
  assert.match(networkErrorMessage(new Error('Join timed out')), /加入超时/);
  assert.equal(networkErrorMessage(new Error('Room is full')), 'Room is full');
});

test('forced relay can diagnose the default public TURN without developer credentials', () => {
  assert.deepEqual(networkConfig({ VITE_ICE_TRANSPORT_POLICY: 'relay' }).options,
    { rtcConfig: { iceTransportPolicy: 'relay' } });
});


test('timeout UI distinguishes transport connection from game admission', () => {
  assert.match(networkErrorMessage(new Error('Join timed out after 45000ms: host-not-connected')), /尚未与主机建立数据连接/);
  assert.match(networkErrorMessage(new Error('Join timed out after 45000ms: host-admission-timeout')), /已与主机建立数据连接/);
});
