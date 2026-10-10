import type { TransportFactory } from './types.js';
import type { JoinRoomConfig } from 'trystero';

export type TrysteroOptions = Pick<JoinRoomConfig, 'relayConfig' | 'rtcConfig' | 'turnConfig'>;

/** Default: public Nostr discovery + WebRTC. No app backend or account required. */
export function trysteroTransport(options: TrysteroOptions = {}): TransportFactory {
  return async ({ appId, roomId, password, onError }) => {
    // Lazy import keeps pure game logic usable in Node and during SSR.
    const { joinRoom, selfId } = await import('trystero');
    const room = joinRoom({ ...options, appId, password }, roomId, {
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
