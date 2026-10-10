import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createGame } from '../dist/index.js';
import { memoryNetwork } from './memory-transport.mjs';
import { memoryDiscovery } from './memory-discovery.mjs';

function setup(overrides = {}) {
  const network = memoryNetwork(), discovery = memoryDiscovery(), games = [], lobbies = [], sessions = [];
  const game = (extra = {}) => {
    const g = createGame({ appId: 'lobby-test', initialState: {}, update: s => s, validateInput: () => true,
      manualTick: true, transport: network.factory,
      lobby: { transport: discovery.factory, heartbeatMs: 10, ttlMs: 40 }, ...overrides, ...extra });
    games.push(g); return g;
  };
  return { game, network, discovery,
    lobby: async g => { const lobby = await g.lobby(); lobbies.push(lobby); return lobby; },
    host: async (g, options) => { const session = await g.host(options); sessions.push(session); return session; },
    cleanup: async () => { await Promise.all(sessions.map(s => s.leave())); await Promise.all(games.map(async g => (await g.lobby()).close())); },
  };
}
const settle = () => delay(0);

test('public rooms discovered, one-click invite joins, counts update and hosts unpublish', async t => {
  const s = setup(); t.after(s.cleanup); const hostGame = s.game(), browserGame = s.game();
  const lobby = await s.lobby(browserGame); const updates = []; lobby.onRooms(rooms => updates.push(rooms));
  const host = await s.host(hostGame, { public: true, name: '一起玩' }); await settle();
  assert.equal(lobby.rooms.length, 1); assert.equal(lobby.rooms[0].name, '一起玩'); assert.equal(lobby.rooms[0].playerCount, 1);
  const guest = await browserGame.join(lobby.rooms[0].invite); await settle();
  assert.equal(lobby.rooms[0].playerCount, 2); assert.equal(guest.players.length, 2);
  await guest.leave(); await settle(); assert.equal(lobby.rooms[0].playerCount, 1);
  await host.leave(); await settle(); assert.equal(lobby.rooms.length, 0); assert.ok(updates.length >= 4);
});

test('private rooms never initialize discovery or publish invitation', async () => {
  const s = setup(); const g = s.game(); const host = await g.host();
  assert.equal(s.discovery.clients.size, 0); assert.equal(s.discovery.history.size, 0);
  await host.leave();
});

test('late browser sees current room and separate games/versions stay isolated', async t => {
  const s = setup(); t.after(s.cleanup); await s.host(s.game(), { public: true, name: '房间' });
  const lobby = await s.lobby(s.game()); await settle(); assert.equal(lobby.rooms.length, 1);
  const otherApp = await s.lobby(s.game({ appId: 'another-app' }));
  const otherVersion = await s.lobby(s.game({ gameVersion: '2' }));
  await settle(); assert.equal(otherApp.rooms.length, 0); assert.equal(otherVersion.rooms.length, 0);
});

test('abrupt host disappearance expires, stale updates cannot undo removal, other authors cannot remove', async t => {
  const s = setup(); t.after(s.cleanup); const hostGame = s.game();
  const host = await s.host(hostGame, { public: true, name: '短暂房间' });
  const lobby = await s.lobby(s.game()); await settle();
  const entry = [...s.discovery.history.values()][0];
  s.discovery.inject('lobby-test', 'different-publisher', { ...entry.message, type: 'remove', revision: 99 });
  assert.equal(lobby.rooms.length, 1);
  await host.leave(); await settle(); assert.equal(lobby.rooms.length, 0);
  s.discovery.inject('lobby-test', entry.publisher, entry.message); assert.equal(lobby.rooms.length, 0);
  // Simulate a cached announcement from a host that stopped heartbeating.
  s.discovery.inject('lobby-test', 'offline-publisher', { ...entry.message, issuedAt: Date.now(), expiresAt: Date.now() + 30, revision: 1 });
  assert.equal(lobby.rooms.length, 1); await delay(60); assert.equal(lobby.rooms.length, 0);
});

test('heartbeat retains active hosts and listener state is copied', async t => {
  const s = setup(); t.after(s.cleanup); await s.host(s.game(), { public: true, name: '持续房间' });
  const lobby = await s.lobby(s.game()); await settle();
  lobby.onRooms(rooms => { if (rooms[0]) rooms[0].name = 'modified'; });
  await delay(90); assert.equal(lobby.rooms.length, 1); assert.equal(lobby.rooms[0].name, '持续房间');
});

test('bad metadata, mismatched invitations, oversized names and old revisions discarded', async t => {
  const s = setup(); t.after(s.cleanup); await s.host(s.game(), { public: true, name: '合法房间' });
  const lobby = await s.lobby(s.game()); await settle(); const entry = [...s.discovery.history.values()][0];
  for (const patch of [{ name: 'x'.repeat(81) }, { maxPlayers: 0 }, { playerCount: 100 }, { invite: 'bad' },
    { hostId: 'fake' }, { issuedAt: Date.now() + 10000 }, { expiresAt: Date.now() + 999999 }, { revision: 0 }]) {
    s.discovery.inject('lobby-test', entry.publisher, { ...entry.message, revision: 99, ...patch });
  }
  assert.equal(lobby.rooms[0].name, '合法房间'); assert.equal(lobby.rooms.length, 1);
});

test('lobby caching, close/unpublish, reopen and invalid options', async t => {
  const s = setup(); t.after(s.cleanup); const g = s.game();
  const [a, b] = await Promise.all([g.lobby(), g.lobby()]); assert.equal(a, b);
  const host = await s.host(g, { public: true, name: '测试' });
  const viewer = await s.lobby(s.game()); await settle(); assert.equal(viewer.rooms.length, 1);
  await a.close(); await settle(); assert.equal(viewer.rooms.length, 0); assert.equal(host.connected, true);
  assert.equal(a.closed, true);
  const [nextA, nextB] = await Promise.all([g.lobby(), g.lobby()]);
  assert.notEqual(nextA, a); assert.equal(nextA, nextB);
  const invalid = createGame({ appId: 'invalid', initialState: {}, update: s => s, validateInput: () => true, lobby: { heartbeatMs: 1 } });
  await assert.rejects(invalid.lobby(), /Invalid lobby/);
});

test('public discovery failure closes host, releases active-session guard and reports failure', async () => {
  const s = setup(); const g = s.game({ lobby: { transport: async () => { throw new Error('relay unavailable'); } } });
  await assert.rejects(g.host({ public: true }), /relay unavailable/); assert.equal(s.network.connections(), 0);
  const privateRoom = await g.host(); await privateRoom.leave();
  await assert.rejects(g.host({ public: true, name: ' ' }), /room name/); assert.equal(s.network.connections(), 0);
});

test('room cache capped and one full room remains visible with its occupancy', async t => {
  const s = setup({ maxPlayers: 1, lobby: { transport: undefined } });
  // Supply the shared discovery factory without opening real relay connections.
  const hostGame = s.game({ lobby: { transport: s.discovery.factory, heartbeatMs: 10, ttlMs: 40 } });
  const browser = s.game({ lobby: { transport: s.discovery.factory, maxRooms: 1, heartbeatMs: 10, ttlMs: 40 } });
  const lobby = await browser.lobby();
  const host = await hostGame.host({ public: true }); await settle();
  assert.equal(lobby.rooms[0].playerCount, lobby.rooms[0].maxPlayers);
  await assert.rejects(browser.join(lobby.rooms[0].invite), /full/);
  const entry = [...s.discovery.history.values()][0];
  s.discovery.inject('lobby-test', 'fake-extra', entry.message); assert.equal(lobby.rooms.length, 1);
  await host.leave(); await lobby.close(); await (await hostGame.lobby()).close();
});

test('slow publication coalesces member changes and eventually publishes latest occupancy', async t => {
  const s = setup(); t.after(s.cleanup);
  let blocked = false, publications = 0; const waiting = [];
  const transport = async options => {
    const raw = await s.discovery.factory(options);
    return { ...raw, publish: async message => {
      if (message.type === 'room') { publications++; if (blocked) await new Promise(resolve => waiting.push(resolve)); }
      await raw.publish(message);
    } };
  };
  const host = await s.host(s.game({ lobby: { transport, heartbeatMs: 100, ttlMs: 500 } }), { public: true });
  blocked = true;
  const guests = [];
  for (let i = 0; i < 5; i++) guests.push(await s.game().join(host.invite));
  assert.equal(publications, 2); assert.equal(waiting.length, 1);
  blocked = false; waiting.shift()(); await settle();
  assert.equal(publications, 3);
  assert.equal([...s.discovery.history.values()][0].message.playerCount, 6);
  await Promise.all(guests.map(guest => guest.leave()));
});
