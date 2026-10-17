import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeCandidates, selectedPath, createConnectionDiagnostics } from '../dist/connection-diagnostics.js';

const host = 'a=candidate:1 1 udp 2122260223 private-name.local 1234 typ host';
const reflexive = 'a=candidate:2 1 udp 1686052607 203.0.113.1 5678 typ srflx raddr 192.168.1.2 rport 1234';
test('candidate diagnostics count mDNS and NAT candidates without exposing addresses or SDP', () => {
  const summary = summarizeCandidates(`${host}\r\n${host}\r\n${reflexive}\r\na=ice-pwd:secret`);
  assert.deepEqual(summary, { host: 1, srflx: 1, prflx: 0, relay: 0, mdns: 1 });
  assert.doesNotMatch(JSON.stringify(summary), /private-name|203\.0\.113|192\.168|secret/);
});

function stats(localType, remoteType, transport = true) {
  return new Map([
    ['l', { id: 'l', type: 'local-candidate', candidateType: localType, protocol: 'udp', address: '192.168.1.2' }],
    ['r', { id: 'r', type: 'remote-candidate', candidateType: remoteType, address: '192.168.1.3' }],
    ['pair', { id: 'pair', type: 'candidate-pair', state: 'succeeded', nominated: true,
      localCandidateId: 'l', remoteCandidateId: 'r', currentRoundTripTime: .004 }],
    ...(transport ? [['t', { id: 't', type: 'transport', selectedCandidatePairId: 'pair' }]] : []),
  ]);
}
test('actual selected pair distinguishes host, NAT and either-side TURN, with nominated-pair fallback', () => {
  for (const [local, remote, expected] of [
    ['host', 'host', 'host-direct'], ['srflx', 'host', 'nat-direct'],
    ['host', 'prflx', 'nat-direct'], ['host', 'relay', 'relay'], ['relay', 'host', 'relay'],
  ]) for (const transport of [true, false]) {
    const result = selectedPath(stats(local, remote, transport));
    assert.equal(result.path, expected);
    assert.equal(result.roundTripTimeMs, 4);
    assert.doesNotMatch(JSON.stringify(result), /192\.168/);
  }
  assert.deepEqual(selectedPath(new Map()), {});
});

test('observation preserves RTC config and closed-attempt evidence, stops on cleanup, and tolerates observers', async t => {
  const original = globalThis.RTCPeerConnection;
  class FakePeer extends EventTarget {
    connectionState = 'new'; iceConnectionState = 'new'; iceGatheringState = 'complete';
    localDescription = { sdp: host }; remoteDescription = null;
    constructor(config) { super(); this.config = config; }
    async getStats() { return stats('host', 'host'); }
  }
  globalThis.RTCPeerConnection = FakePeer;
  t.after(() => { if (original) globalThis.RTCPeerConnection = original; else delete globalThis.RTCPeerConnection; });
  t.mock.timers.enable({ apis: ['setInterval'] });
  const reports = [];
  const monitor = createConnectionDiagnostics(report => { reports.push(report); throw new Error('observer'); });
  t.after(() => monitor.close());
  const config = { iceServers: [], iceTransportPolicy: 'all' };
  const peer = new monitor.rtcPolyfill(config);
  assert.equal(peer.config, config);
  peer.remoteDescription = { sdp: host };
  peer.connectionState = 'connected'; peer.iceConnectionState = 'connected';
  t.mock.timers.tick(1000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reports.at(-1).connections[0].path, 'host-direct');
  peer.connectionState = 'closed'; peer.iceConnectionState = 'closed';
  peer.remoteDescription = null; peer.localDescription = null;
  peer.dispatchEvent(new Event('connectionstatechange'));
  await monitor.close();
  assert.equal(reports.at(-1).connections[0].connectionState, 'closed');
  assert.equal(reports.at(-1).connections[0].remote.mdns, 1);
  const length = reports.length;
  t.mock.timers.tick(5000);
  assert.equal(reports.length, length);
  // A connection reused by Trystero was not constructed by the new monitor.
  const reused = new FakePeer(config);
  reused.remoteDescription = { sdp: host };
  reused.connectionState = 'connected'; reused.iceConnectionState = 'connected';
  const nextReports = [];
  const nextMonitor = createConnectionDiagnostics(report => nextReports.push(report), () => [reused]);
  await nextMonitor.close();
  assert.equal(nextReports[0].connections[0].path, 'host-direct');
});
