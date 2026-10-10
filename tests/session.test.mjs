import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createGame } from '../dist/index.js';
import { memoryNetwork } from './memory-transport.mjs';

function setup(overrides = {}) {
  const network = memoryNetwork();
  const options = {
    appId: 'test-game', initialState: { count: 0 }, manualTick: true,
    tickRate: 60, snapshotRate: 60,
    validateInput: v => typeof v === 'number' && Math.abs(v) <= 10,
    update: (state, { inputs }) => ({ count: state.count + [...inputs.values()].reduce((a, b) => a + b, 0) }),
    transport: network.factory, ...overrides,
  };
  return { network, game: () => createGame(options) };
}
const settle = () => delay(0);

test('host + two guests: admission, inputs, authoritative simulation, late join and cleanup', async () => {
  const { game, network } = setup();
  const host = await game().host();
  const guest = await game().join(host.invite);
  await host.sendInput(2); await guest.sendInput(3); await settle();
  host.step(); await settle();
  assert.equal(host.state.count, 5); assert.deepEqual(guest.state, host.state);
  const late = await game().join(host.invite);
  assert.deepEqual(late.state, host.state); assert.equal(late.tick, 1);
  await settle(); assert.equal(guest.players.length, 3);
  await late.sendInput(1); await settle(); host.step(); await settle();
  assert.equal(guest.state.count, 11);
  await late.leave(); await settle(); assert.equal(host.players.length, 2);
  host.step(); await settle(); assert.equal(host.state.count, 16);
  const reasons = []; guest.onDisconnect(reason => reasons.push(reason));
  await host.leave(); await settle();
  assert.equal(guest.connected, false); assert.deepEqual(reasons, ['host-left']);
  assert.equal(network.connections(), 0);
});

test('guest cannot forge authoritative state, roster or termination', async () => {
  const { game, network } = setup(); const host = await game().host();
  const a = await game().join(host.invite); const b = await game().join(host.invite);
  network.inject(a.id, b.id, { type: 'snapshot', tick: 999, state: { count: 999 }, players: a.players });
  network.inject(a.id, b.id, { type: 'end' });
  assert.equal(a.state.count, 0); assert.equal(a.connected, true);
  network.inject(host.id, b.id, { type: 'snapshot', tick: 999, state: { count: 999 }, players: host.players });
  assert.equal(host.state.count, 0); await host.leave();
});

test('reject stale, invalid and unadmitted inputs; stale and malformed snapshots', async () => {
  const { game, network } = setup(); const host = await game().host(); const guest = await game().join(host.invite);
  network.inject(host.id, guest.id, { type: 'input', sequence: 10, input: 2 });
  network.inject(host.id, guest.id, { type: 'input', sequence: 9, input: 8 });
  network.inject(host.id, guest.id, { type: 'input', sequence: 11, input: 999 });
  network.inject(host.id, 'intruder', { type: 'input', sequence: 1, input: 10 });
  host.step(); await settle(); assert.equal(host.state.count, 2);
  network.inject(guest.id, host.id, { type: 'snapshot', tick: 0, state: { count: 88 }, players: guest.players });
  network.inject(guest.id, host.id, { type: 'snapshot', tick: 3, state: { count: 88 }, players: [] });
  assert.equal(guest.state.count, 2);
  await assert.rejects(guest.sendInput(99), /Invalid input/);
  await host.leave();
});

test('capacity and version rejection clean up pending connections', async () => {
  const { game, network } = setup({ maxPlayers: 2 }); const host = await game().host();
  await game().join(host.invite);
  await assert.rejects(game().join(host.invite), /Room is full/);
  const incompatible = createGame({ appId: 'test-game', gameVersion: '2', initialState: {}, update: s => s,
    validateInput: () => true, transport: network.factory });
  await assert.rejects(incompatible.join(host.invite), /Incompatible/);
  assert.equal(network.connections(), 2); await host.leave(); assert.equal(network.connections(), 0);
});

test('join timeout, invitation validation, single session guard and reuse', async () => {
  const { game, network } = setup({ joinTimeoutMs: 25 }); const owner = game(); const host = await owner.host();
  await assert.rejects(owner.host(), /active session/);
  await assert.rejects(game().join('ogp1.bad'), /Invalid invitation/);
  const invite = host.invite; await host.leave();
  await assert.rejects(game().join(invite), /timed out/); assert.equal(network.connections(), 0);
  const next = await owner.host(); await next.leave();
  await assert.rejects(next.sendInput(1), /not connected/);
});

test('held input expires and consumer cannot mutate internal state', async () => {
  const { game } = setup({ inputTimeoutMs: 10 }); const host = await game().host();
  host.onState(state => { state.count = 999; });
  await host.sendInput(3); host.step(); assert.equal(host.state.count, 3);
  const state = host.state; state.count = 999; assert.equal(host.state.count, 3);
  await delay(20); host.step(); assert.equal(host.state.count, 3); await host.leave();
});

test('simulation failure ends session; error observer cannot break teardown', async () => {
  const { game, network } = setup({ update: () => { throw new Error('broken rule'); }, onError: () => { throw new Error('observer'); } });
  const host = await game().host(); const guest = await game().join(host.invite);
  host.step(); await settle(); assert.equal(host.connected, false); assert.equal(guest.connected, false);
  assert.equal(network.connections(), 0);
});

test('bounded message size, JSON state and configuration validation', async () => {
  assert.throws(() => setup({ tickRate: 0 }).game(), /positive integer/);
  assert.throws(() => setup({ snapshotRate: 70 }).game(), /Invalid/);
  assert.throws(() => setup({ initialState: { n: NaN } }).game(), /JSON/);
  const { game } = setup({ maxMessageBytes: 200, validateInput: () => true }); const host = await game().host();
  await assert.rejects(host.sendInput('x'.repeat(300)), /maxMessageBytes/); await host.leave();
});

test('automatic host clock sends snapshots without caller stepping', async () => {
  const { game } = setup({ manualTick: false, update: state => ({ count: state.count + 1 }) });
  const host = await game().host(); const guest = await game().join(host.invite);
  await delay(80); assert.ok(host.tick > 0); assert.ok(guest.state.count > 0); await host.leave();
});

test('backpressure keeps at most one broadcast snapshot outstanding', async () => {
  const network = memoryNetwork(); const pending = [];
  let broadcasts = 0;
  const options = { appId: 'backpressure', initialState: { count: 0 }, manualTick: true,
    snapshotRate: 60, validateInput: v => typeof v === 'number',
    update: state => ({ count: state.count + 1 }),
    transport: async config => {
      const transport = await network.factory(config);
      return { ...transport, send: async (packet, targets) => {
        if (packet.type === 'snapshot') {
          broadcasts++; await new Promise(resolve => pending.push(resolve));
        }
        await transport.send(packet, targets);
      } };
    },
  };
  const host = await createGame(options).host(); const guest = await createGame(options).join(host.invite);
  for (let i = 0; i < 100; i++) host.step();
  assert.equal(broadcasts, 1); assert.equal(host.tick, 100);
  pending.shift()(); await settle(); host.step();
  assert.equal(broadcasts, 2);
  pending.shift()(); await settle(); assert.equal(guest.state.count, 101);
  await host.leave();
});

test('protocol packets over the size budget are discarded and sparse JSON state is rejected', async () => {
  const { game, network } = setup({ maxMessageBytes: 200, validateInput: v => typeof v === 'number' });
  const host = await game().host(); const guest = await game().join(host.invite);
  network.inject(host.id, guest.id, { type: 'input', sequence: 1, input: 5, padding: 'x'.repeat(500) });
  host.step(); await settle(); assert.equal(host.state.count, 0);
  await host.leave();
  assert.throws(() => setup({ initialState: { sparse: Array(2) } }).game(), /JSON/);
});
