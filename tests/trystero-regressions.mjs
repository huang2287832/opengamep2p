import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

// Upstream #204: an aged initiator led by the lower peer ID must still gather
// candidates and connect. Advancing only Date.now exercises offer expiry without
// a minute-long sleep; real browser ICE and all real-time timers remain intact.
export async function testIdleOffer({ browser, url, relayUrl, hasSubscription }) {
  const contexts = [await browser.newContext(), await browser.newContext()];
  try {
    const endpoints = [];
    for (const context of contexts) {
      const page = await context.newPage(); await page.goto(url);
      const id = await page.evaluate(async relayUrl => {
        const NativePeer = RTCPeerConnection;
        window.testConnections = [];
        window.RTCPeerConnection = class extends NativePeer {
          constructor(config) { super(config); window.testConnections.push(this); }
        };
        const { createGame, trysteroTransport } = await import('/src/index.ts');
        window.testGame = createGame({ appId: 'ogp-idle-offer-regression', initialState: { value: 42 },
          manualTick: true, update: state => state, validateInput: () => true, joinTimeoutMs: 7000,
          transport: trysteroTransport({ relayConfig: { urls: [relayUrl], redundancy: 1 }, rtcConfig: { iceServers: [] } }),
        });
        const probe = await window.testGame.host();
        const id = probe.id; await probe.leave();
        window.testConnections = [];
        return id;
      }, relayUrl);
      endpoints.push({ page, id });
    }
    endpoints.sort((a, b) => a.id < b.id ? -1 : 1);
    const [owner, visitor] = endpoints;
    const { invitation, topic, prewarmed } = await owner.page.evaluate(async () => {
      window.testSession = await window.testGame.host();
      const { decodeInvite } = await import('/src/invite.ts');
      const invite = decodeInvite(window.testSession.invite, 'ogp-idle-offer-regression');
      const bytes = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(`Trystero@ogp-idle-offer-regression@${invite.room}`));
      return { invitation: window.testSession.invite, topic: Array.from(new Uint8Array(bytes), b => b.toString(36)).join(''),
        prewarmed: window.testConnections.length };
    });
    const deadline = Date.now() + 5000;
    while (!hasSubscription(topic)) {
      assert.ok(Date.now() < deadline, 'Host must subscribe before advancing its offer clock');
      await delay(20);
    }
    if (prewarmed) await owner.page.waitForFunction(() => window.testConnections.some(pc => pc.iceGatheringState === 'complete'));
    await owner.page.evaluate(() => { const originalNow = Date.now; Date.now = () => originalNow() + 65000; });
    const result = await visitor.page.evaluate(async invite => {
      try { window.testSession = await window.testGame.join(invite); return { connected: true }; }
      catch (error) { return { connected: false, error: error.message }; }
    }, invitation);
    const evidence = await owner.page.evaluate(() => window.testConnections.filter(pc => pc.localDescription).slice(0, 4).map(pc => ({
      mediaSections: (pc.localDescription.sdp.match(/^m=/gm) ?? []).length,
      candidates: (pc.localDescription.sdp.match(/^a=candidate:/gm) ?? []).length,
      iceState: pc.iceConnectionState,
    })));
    assert.equal(result.connected, true, `Aged lower-ID offer failed: ${result.error}; SDP summaries: ${JSON.stringify(evidence)}`);
    assert.deepEqual(await visitor.page.evaluate(() => window.testSession.state), { value: 42 });
    await owner.page.waitForFunction(() => window.testSession.players.length === 2);
    console.log('PASS: aged lower-ID initiator retains data-channel SDP and connects (Trystero #204)');
  } finally { await Promise.all(contexts.map(context => context.close())); }
}
