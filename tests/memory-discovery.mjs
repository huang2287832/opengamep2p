export function memoryDiscovery() {
  const clients = new Set(), history = new Map(); let counter = 0;
  const factory = async ({ appId }) => {
    const client = { appId, id: `publisher-${++counter}`, handler: () => {}, closed: false };
    clients.add(client);
    return {
      publisherId: client.id,
      onMessage: callback => {
        client.handler = callback;
        for (const entry of history.values()) if (entry.appId === appId) queueMicrotask(() => {
          if (!client.closed) callback(structuredClone(entry.message), entry.publisher);
        });
      },
      publish: async message => {
        if (client.closed) throw new Error('discovery disconnected');
        const entry = { appId, publisher: client.id, message: structuredClone(message) };
        history.set(`${appId}:${client.id}:${message.roomId}`, entry);
        for (const other of clients) if (other.appId === appId) queueMicrotask(() => {
          if (!other.closed) other.handler(structuredClone(message), client.id);
        });
      },
      close: async () => { client.closed = true; clients.delete(client); },
    };
  };
  return { factory, history, clients,
    inject: (appId, publisher, message) => { for (const client of clients) if (client.appId === appId) client.handler(structuredClone(message), publisher); },
    crash: () => { for (const client of clients) client.closed = true; clients.clear(); },
  };
}
