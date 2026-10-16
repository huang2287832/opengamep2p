# Changelog

## Unreleased

- Aligned default game signaling relays with lobby discovery instead of using a different appId-shuffled pool; custom relay URLs and redundancy remain supported.
- Preserved original demo connection errors in the browser console and added a browser integration mode using default network/mDNS behavior.

- Increased the default join deadline to 45 seconds to allow discovery and ICE negotiation; distinguished missing host connectivity from missing game admission in timeout diagnostics.

- Added best-effort public freeSTUN TURN fallback; developer TURN replaces it and explicit ICE lists retain full control.

- Added demo TURN configuration through `.env.local` with UDP/TCP/TLS URLs and relay-only diagnosis.
- Added actionable Chinese messages for failed SDP connectivity and join timeouts.
- Preserved default STUN when selecting a custom signaling relay.

## 0.2.0

- Added `game.lobby()`, `lobby.onRooms()`, and `game.host({ public: true, name })`.
- Added signed Nostr room discovery over WebSockets, without WebRTC connections between lobby browsers.
- Added current occupancy, late discovery, version filtering, room expiry, owner-scoped removal and relay reconnection.
- Kept `game.host()` private by default. Public rooms deliberately publish their invitation.
- Updated the demo with public/private hosting, a room list and click-to-join buttons.
- Added discovery protocol, cryptographic relay tests and browser integration coverage.

## 0.1.0

- Initial Trystero transport, host-authoritative game simulation, invitations and state synchronization.
