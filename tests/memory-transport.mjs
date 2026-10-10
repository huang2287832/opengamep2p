/** Deterministic test transport. Never used by the shipped library or demo. */
export function memoryNetwork() {
  const rooms = new Map();
  const clients = new Map();
  let counter = 0;
  const factory = async ({ appId, roomId, password }) => {
    const key = JSON.stringify([appId, roomId, password]);
    const room = rooms.get(key) ?? new Map(); rooms.set(key, room);
    const id = `peer-${++counter}`;
    const client = { message: () => {}, join: () => {}, leave: () => {}, closed: false };
    clients.set(id, client);
    const prior = [...room.keys()];
    room.set(id, client);
    queueMicrotask(() => { for (const peer of prior) room.get(peer)?.join(id); });
    return {
      selfId: id,
      peers: () => [...room.keys()].filter(peer => peer !== id),
      send: async (packet, targets) => {
        for (const peer of typeof targets === 'string' ? [targets] : targets) {
          const copy = structuredClone(packet);
          queueMicrotask(() => { if (!client.closed) room.get(peer)?.message(copy, id); });
        }
      },
      onMessage: callback => { client.message = callback; },
      onJoin: callback => { client.join = callback; },
      onLeave: callback => { client.leave = callback; },
      close: async () => {
        if (client.closed) return;
        client.closed = true; room.delete(id);
        for (const other of room.values()) other.leave(id);
        if (!room.size) rooms.delete(key);
      },
    };
  };
  return {
    factory,
    inject: (target, sender, packet) => clients.get(target).message(structuredClone(packet), sender),
    connections: () => [...rooms.values()].reduce((n, room) => n + room.size, 0),
  };
}
