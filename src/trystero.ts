import type { TransportFactory } from './types.js';
import type { JoinRoomConfig } from 'trystero';

export type TrysteroOptions = Pick<JoinRoomConfig, 'relayConfig' | 'rtcConfig' | 'turnConfig'>;

/** Resolve defaults without modifying the caller's configuration.
 * Explicit iceServers is a complete override, including [] for local-only tests.
 * Explicit turnConfig (including []) replaces the public fallback.
 */
export function resolveTrysteroOptions(options: TrysteroOptions = {}, defaultRelayUrls?: readonly string[]): TrysteroOptions {
  // Discovery uses the first five defaults. Pin signaling to the same pool rather
  // than letting Trystero choose a different, appId-shuffled set of relays.
  const relayOptions = defaultRelayUrls && !options.relayConfig?.urls
    ? { relayConfig: { ...options.relayConfig, urls: defaultRelayUrls.slice(0, options.relayConfig?.redundancy ?? 5) } }
    : {};
  if (options.rtcConfig?.iceServers !== undefined) return { ...options, ...relayOptions };
  return {
    ...options,
    ...relayOptions,
    turnConfig: options.turnConfig ?? [{
      urls: 'turn:freestun.net:3478',
      username: 'free',
      credential: 'free',
    }],
  };
}

/** Default: public Nostr signaling + WebRTC with a best-effort public TURN fallback. */
export function trysteroTransport(options: TrysteroOptions = {}): TransportFactory {
  const resolvedOptions = resolveTrysteroOptions(options);
  return async ({ appId, roomId, password, onError }) => {
    // Lazy import keeps pure game logic usable in Node and during SSR.
    const { joinRoom, selfId, defaultRelayUrls } = await import('trystero');
    const room = joinRoom({ ...resolveTrysteroOptions(resolvedOptions, defaultRelayUrls), appId, password }, roomId, {
      onJoinError: details => onError(new Error(details.error)),
    });
    const action = room.makeAction('ogp-v1');
    return {
      selfId,
      peers: () => Object.keys(room.getPeers()),
      send: (data, target) => action.send(data, { target }),
      onMessage: callback => { action.onMessage = (data, { peerId }) => callback(data, peerId); },
      onJoin: callback => { room.onPeerJoin = callback; },
      onLeave: callback => { room.onPeerLeave = callback; },
      close: async () => {
        action.onMessage = null;
        room.onPeerJoin = null;
        room.onPeerLeave = null;
        await room.leave();
      },
    };
  };
}
