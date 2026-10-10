import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { nostrDiscovery } from '../dist/index.js';

// In-process relay sockets: real event hashing/signing/verification, no listening ports.
function relayNetwork({ accept = true, acknowledge = true, open = true } = {}) {
  const sockets = new Set(), stored = [], publications = [];
  class Socket {
    readyState = 0; subscriptions = new Map();
    constructor(url) {
      this.url = url; sockets.add(this);
      if (open) queueMicrotask(() => { if (this.readyState !== 3) { this.readyState = 1; this.onopen?.(); } });
    }
    deliver(message) { queueMicrotask(() => { if (this.readyState === 1) this.onmessage?.({ data: JSON.stringify(message) }); }); }
    matches(event, filters) { return filters.some(f => f.kinds.includes(event.kind) && event.tags.some(t => t[0] === 'x' && f['#x'].includes(t[1]))); }
    send(raw) {
      const [type, value, ...rest] = JSON.parse(raw);
      if (type === 'REQ') {
        this.subscriptions.set(value, rest);
        for (const event of stored) if (this.matches(event, rest)) this.deliver(['EVENT', value, event]);
      } else if (type === 'CLOSE') this.subscriptions.delete(value);
      else if (type === 'EVENT') {
        publications.push(value);
        if (acknowledge) this.deliver(['OK', value.id, accept, accept ? '' : 'blocked']);
        if (accept) {
          stored.push(value);
          for (const peer of sockets) for (const [id, filters] of peer.subscriptions) if (peer.matches(value, filters)) peer.deliver(['EVENT', id, value]);
        }
      }
    }
    close() { this.readyState = 3; sockets.delete(this); queueMicrotask(() => this.onclose?.()); }
  }
  return { Socket, sockets, publications, inject: event => {
    for (const socket of sockets) for (const id of socket.subscriptions.keys()) socket.deliver(['EVENT', id, event]);
  } };
}
const packet = (revision = 1) => ({ type: 'room', protocol: 1, roomId: 'room-1', revision, issuedAt: Date.now(), expiresAt: Date.now() + 35000 });
const waitFor = async predicate => { for (let i = 0; i < 100; i++) { if (predicate()) return; await delay(5); } assert.fail('Expected discovery message'); };

test('signed Nostr publications acknowledged, verified, replayed for late browser and isolated by app', async t => {
  const relay = relayNetwork(), factory = nostrDiscovery({ relayUrls: ['ws://test'], webSocket: relay.Socket });
  const publisher = await factory({ appId: 'game', onError: () => {} }); t.after(() => publisher.close());
  const message = packet(); await publisher.publish(message);
  const viewer = await factory({ appId: 'game', onError: () => {} }); t.after(() => viewer.close());
  const received = []; viewer.onMessage((message, author) => received.push({ message, author }));
  await waitFor(() => received.length === 1); assert.deepEqual(received[0], { message, author: publisher.publisherId });
  const other = await factory({ appId: 'another-game', onError: () => {} }); t.after(() => other.close());
  const otherMessages = []; other.onMessage(message => otherMessages.push(message));
  await publisher.publish(packet(2)); await waitFor(() => received.length === 2);
  assert.equal(otherMessages.length, 0);
  const event = relay.publications[0];
  assert.equal(event.kind, 30078); assert.ok(event.tags.some(t => t[0] === 'expiration'));
  assert.notEqual(relay.publications[0].tags[0][1], relay.publications[1].tags[0][1], 'Revisions must avoid timestamp replacement ties');
});

test('forged hashes/signatures, wrong topics and stale signed events are rejected', async t => {
  const relay = relayNetwork(), factory = nostrDiscovery({ relayUrls: ['ws://test'], webSocket: relay.Socket });
  const publisher = await factory({ appId: 'game', onError: () => {} }); t.after(() => publisher.close());
  const viewer = await factory({ appId: 'game', onError: () => {} }); t.after(() => viewer.close());
  const received = []; viewer.onMessage(message => received.push(message));
  await publisher.publish(packet()); await waitFor(() => received.length === 1);
  const event = relay.publications[0];
  for (const forged of [{ ...event, content: 'modified' }, { ...event, sig: '0'.repeat(128) },
    { ...event, tags: [['x', 'wrong-topic']] }, { ...event, created_at: 1 }, { ...event, tags: [['x', null]] }]) relay.inject(forged);
  await delay(60); assert.equal(received.length, 1);
});

test('relay rejection, absent acknowledgements, connect timeout and close release sockets', async () => {
  for (const options of [{ accept: false }, { acknowledge: false }]) {
    const relay = relayNetwork(options);
    const transport = await nostrDiscovery({ relayUrls: ['ws://test'], webSocket: relay.Socket, publishTimeoutMs: 20 })({ appId: 'game', onError: () => {} });
    await assert.rejects(transport.publish(packet()), options.accept === false ? /rejected/ : /timed out/);
    await transport.close(); assert.equal(relay.sockets.size, 0);
    await assert.rejects(transport.publish(packet()), /closed/);
  }
  const relay = relayNetwork({ open: false });
  await assert.rejects(nostrDiscovery({ relayUrls: ['ws://test'], webSocket: relay.Socket, connectTimeoutMs: 20 })({ appId: 'game', onError: () => {} }), /unavailable/);
  assert.equal(relay.sockets.size, 0);
});

test('closed relay reconnects and resumes discovery subscription', async t => {
  const relay = relayNetwork(), errors = [];
  const transport = await nostrDiscovery({ relayUrls: ['ws://test'], webSocket: relay.Socket })({ appId: 'game', onError: error => errors.push(error) });
  t.after(() => transport.close());
  const first = [...relay.sockets][0]; first.close(); await delay(1100);
  assert.equal(relay.sockets.size, 1); assert.notEqual([...relay.sockets][0], first);
  await transport.publish(packet()); assert.equal(errors.length, 0);
});
