// Integration test: real Trystero signaling and real WebRTC between isolated browsers.
// The local Nostr relay is a test fixture, never a runtime dependency of opengamep2p.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { WebSocketServer } from 'ws';
import { createServer } from 'vite';

const relay = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await new Promise(resolve => relay.once('listening', resolve));
const relayUrl = `ws://127.0.0.1:${relay.address().port}`;
const events = [];
const subscriptions = new Map();
function matches(event, filters) {
  return filters.some(f => (!f.kinds || f.kinds.includes(event.kind)) &&
    (!f.since || event.created_at >= f.since) &&
    (!f['#x'] || event.tags.some(t => t[0] === 'x' && f['#x'].includes(t[1]))));
}
relay.on('connection', socket => {
  subscriptions.set(socket, new Map());
  socket.on('message', raw => {
    const [type, value, ...rest] = JSON.parse(raw.toString());
    if (type === 'REQ') {
      subscriptions.get(socket).set(value, rest);
      for (const event of events) if (matches(event, rest)) socket.send(JSON.stringify(['EVENT', value, event]));
      socket.send(JSON.stringify(['EOSE', value]));
    } else if (type === 'CLOSE') subscriptions.get(socket).delete(value);
    else if (type === 'EVENT') {
      events.push(value); if (events.length > 512) events.shift();
      socket.send(JSON.stringify(['OK', value.id, true, '']));
      for (const [peer, subs] of subscriptions) for (const [id, filters] of subs) {
        if (peer.readyState === 1 && matches(value, filters)) peer.send(JSON.stringify(['EVENT', id, value]));
      }
    }
  });
  socket.on('close', () => subscriptions.delete(socket));
});
const server = await createServer({ server: { host: '127.0.0.1', port: 0 },
  define: { 'import.meta.env.VITE_RELAY_URL': JSON.stringify(relayUrl), 'import.meta.env.VITE_TEST_LOCAL_ICE': 'true' } });
let browser;
try {
  await server.listen();
  const url = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } :
      process.platform === 'darwin' ? { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' } : {}),
    headless: true,
    // Opt in to normal browser mDNS behavior when checking LAN candidate handling.
    args: process.env.TEST_BROWSER_DEFAULT_NETWORK === '1' ? [] :
      ['--disable-features=WebRtcHideLocalIpsWithMdns', '--force-webrtc-ip-handling-policy=default_public_and_private_interfaces'],
  });
  const pages = [];
  for (let index = 0; index < 3; index++) {
    const context = await browser.newContext(); const page = await context.newPage(); pages.push(page);
    await page.goto(url);
    await page.evaluate(async relayUrl => {
      const { createGame, trysteroTransport, nostrDiscovery } = await import('/src/index.ts');
      window.errors = [];
      window.game = createGame({ appId: 'ogp-browser-test', initialState: { count: 0, marker: 'ONLY_DATA_CHANNEL_STATE' },
        tickRate: 30, snapshotRate: 30, joinTimeoutMs: 20000,
        validateInput: v => typeof v === 'number' && Math.abs(v) <= 10,
        update: (state, { inputs }) => ({ ...state, count: state.count + [...inputs.values()].reduce((a, b) => a + b, 0) }),
        transport: trysteroTransport({ relayConfig: { urls: [relayUrl], redundancy: 1 }, rtcConfig: { iceServers: [] } }),
        lobby: { transport: nostrDiscovery({ relayUrls: [relayUrl] }) },
        onError: error => window.errors.push(error.message),
      });
    }, relayUrl);
  }
  const [host, guest, late] = pages;
  await guest.evaluate(async () => { window.lobby = await window.game.lobby(); window.lobby.onRooms(rooms => { window.rooms = rooms; }); });
  await host.evaluate(async () => { window.session = await window.game.host({ public: true, name: 'Browser test room' }); });
  await guest.waitForFunction(() => window.rooms?.length === 1);
  await guest.evaluate(async () => { window.session = await window.game.join(window.rooms[0].invite); });
  await host.waitForFunction(() => window.session.players.length === 2);
  await guest.waitForFunction(() => window.rooms[0]?.playerCount === 2);
  await guest.evaluate(() => window.session.sendInput(2));
  await guest.waitForFunction(() => window.session.state.count > 0);
  await guest.evaluate(() => window.session.sendInput(0));
  await late.evaluate(async () => { window.lobby = await window.game.lobby(); window.lobby.onRooms(rooms => { window.rooms = rooms; }); });
  await late.waitForFunction(() => window.rooms?.length === 1 && window.rooms[0].playerCount === 2);
  await late.evaluate(async () => { window.session = await window.game.join(window.rooms[0].invite); });
  await late.waitForFunction(() => window.session.players.length === 3 && window.session.state.count > 0);
  const counts = await Promise.all(pages.map(p => p.evaluate(() => window.session.state.count)));
  assert.equal(new Set(counts).size, 1, `State mismatch: ${counts}`);
  assert.ok(events.length > 0, 'Expected real Nostr discovery');
  assert.equal(JSON.stringify(events).includes('ONLY_DATA_CHANNEL_STATE'), false, 'Game state leaked into signaling');
  await late.evaluate(() => window.session.leave());
  await host.waitForFunction(() => window.session.players.length === 2);
  await guest.waitForFunction(() => window.session.players.length === 2);
  await host.evaluate(() => window.session.leave());
  await guest.waitForFunction(() => !window.session.connected);
  await guest.waitForFunction(() => window.rooms.length === 0);
  await late.waitForFunction(() => window.rooms.length === 0);
  for (const page of pages) await page.evaluate(async () => { await (await window.game.lobby()).close(); });
  for (const page of pages) assert.deepEqual(await page.evaluate(() => window.errors), []);
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await mobile.goto(url);
  const uiHost = await browser.newPage(); await uiHost.goto(url);
  await uiHost.locator('#room-name').fill('公开测试房间');
  await uiHost.locator('#host').click();
  await mobile.locator('.room-card h3').filter({ hasText: '公开测试房间' }).waitFor();
  await mobile.locator('.room-card button').click();
  await mobile.waitForFunction(() => document.getElementById('status').textContent.includes('客机'));
  await uiHost.waitForFunction(() => document.getElementById('players').textContent.startsWith('2'));
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Mobile layout overflows');
  await mobile.locator('#leave').click(); await uiHost.locator('#leave').click();
  await mobile.waitForFunction(() => document.querySelectorAll('.room-card').length === 0);
  console.log('PASS: signed public lobby, real Trystero + WebRTC, 3 peers, late join, counts, unpublish, one-click demo joins, signaling privacy, mobile layout');
} finally {
  await browser?.close(); await server.close();
  for (const socket of relay.clients) socket.terminate();
  await new Promise(resolve => relay.close(resolve));
}
