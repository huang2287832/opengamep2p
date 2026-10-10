# Changelog

## 0.2.0

- Added `game.lobby()`, `lobby.onRooms()`, and `game.host({ public: true, name })`.
- Added signed Nostr room discovery over WebSockets, without WebRTC connections between lobby browsers.
- Added current occupancy, late discovery, version filtering, room expiry, owner-scoped removal and relay reconnection.
- Kept `game.host()` private by default. Public rooms deliberately publish their invitation.
- Updated the demo with public/private hosting, a room list and click-to-join buttons.
- Added discovery protocol, cryptographic relay tests and browser integration coverage.

## 0.1.0

- Initial Trystero transport, host-authoritative game simulation, invitations and state synchronization.
