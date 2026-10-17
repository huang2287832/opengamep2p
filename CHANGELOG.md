# Changelog

## Unreleased

- Upgraded Trystero, its Nostr adapter and core from 0.25.4 to 0.26.0 to fix expired-offer candidate loss and stale rejoin handshakes (upstream #204 and #203). All communicating clients must update together because the dependency's action wire format changed.
- Added a real Chrome regression that forces the older/lower-ID initiator past the previous offer TTL; it failed with candidate-free SDP on 0.25.4 and passes on 0.26.0. Added six quick rejoins with other players still connected.

- Fixed room-wide snapshot stalls caused by a single congested guest: snapshot backpressure is now independent per recipient.
- Bounded held-input sending to one active and one latest pending update; superseded pending calls resolve without sending obsolete input, and leaving rejects unfinished calls.
- Smoothed guest positions in the demo without changing authoritative simulation, and added slow-peer and rotating-host regression coverage.

- Added opt-in candidate/ICE/selected-path diagnostics without addresses or secrets, including failed negotiations and reused live connections.
- Added automatic, host-candidate-only and TURN-only demo modes; switching modes after a connection attempt reloads the page to avoid reusing connections with old ICE settings.
- Verified real host-to-host selected candidate pairs with default browser networking in the integration test.

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
