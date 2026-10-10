import { schnorr } from '@noble/secp256k1';
import type { DiscoveryFactory } from './discovery-types.js';

export interface NostrDiscoveryOptions {
  relayUrls?: string[];
  connectTimeoutMs?: number;
  publishTimeoutMs?: number;
  /** Injectable for environments providing a WebSocket implementation. */
  webSocket?: typeof WebSocket;
}
type Event = { id: string; pubkey: string; sig: string; created_at: number; kind: number; tags: string[][]; content: string };
const hex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
const bytes = (value: string) => Uint8Array.from(value.match(/../g) ?? [], pair => parseInt(pair, 16));
async function hash(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}
async function eventHash(event: Omit<Event, 'id' | 'sig'>): Promise<Uint8Array> {
  return hash(JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]));
}

/** Signed, addressable Nostr metadata. Browsing opens WebSockets, never a WebRTC mesh. */
export function nostrDiscovery(options: NostrDiscoveryOptions = {}): DiscoveryFactory {
  return async ({ appId, onError }) => {
    const defaults = options.relayUrls ? [] : (await import('trystero')).defaultRelayUrls.slice(0, 5);
    const urls = [...new Set(options.relayUrls ?? defaults)];
    if (!urls.length || urls.length > 10 || urls.some(url => !/^wss?:\/\//.test(url))) throw new Error('Provide 1–10 ws/wss discovery relay URLs');
    const Socket = options.webSocket ?? globalThis.WebSocket;
    if (!Socket) throw new Error('WebSocket is unavailable');
    const topic = hex(await hash(`opengamep2p:lobby:v1:${appId}`));
    const { secretKey, publicKey } = schnorr.keygen();
    const publisherId = hex(publicKey);
    const subscription = `ogp-${publisherId.slice(0, 16)}`;
    const sockets = new Map<string, WebSocket>();
    const retries = new Map<string, ReturnType<typeof setTimeout>>();
    const retryDelays = new Map<string, number>();
    const pending = new Map<string, { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; outstanding: Set<WebSocket> }>();
    let closed = false, queued = 0;
    let handler: (message: unknown, publisher: string) => void = () => {};
    let processing = Promise.resolve();
    const report = (error: Error) => { try { onError(error); } catch { /* observer */ } };
    let resolveOpen: () => void = () => {};
    const opened = new Promise<void>(resolve => { resolveOpen = resolve; });

    async function receive(raw: unknown, socket: WebSocket): Promise<void> {
      if (closed || typeof raw !== 'string' || raw.length > 16384) return;
      let message: unknown;
      try { message = JSON.parse(raw); } catch { return; }
      if (!Array.isArray(message)) return;
      if (message[0] === 'OK' && typeof message[1] === 'string') {
        const ack = pending.get(message[1]);
        if (!ack || !ack.outstanding.has(socket)) return;
        if (message[2] === true) {
          clearTimeout(ack.timer); pending.delete(message[1]); ack.resolve();
        } else if (message[2] === false) {
          ack.outstanding.delete(socket);
          if (!ack.outstanding.size) { clearTimeout(ack.timer); pending.delete(message[1]); ack.reject(new Error('Discovery relay rejected room publication')); }
        }
        return;
      }
      if (message[0] === 'CLOSED' && message[1] === subscription) {
        report(new Error('Discovery relay rejected lobby subscription')); socket.close(); return;
      }
      if (message[0] !== 'EVENT' || message[1] !== subscription) return;
      const event = message[2] as Event | undefined;
      const now = Date.now();
      if (!event || event.kind !== 30078 || !Number.isSafeInteger(event.created_at) || event.created_at * 1000 > now + 5000 || event.created_at * 1000 < now - 125000 ||
        typeof event.id !== 'string' || !/^[a-f0-9]{64}$/.test(event.id) || typeof event.pubkey !== 'string' || !/^[a-f0-9]{64}$/.test(event.pubkey) ||
        typeof event.sig !== 'string' || !/^[a-f0-9]{128}$/.test(event.sig) || typeof event.content !== 'string' ||
        !Array.isArray(event.tags) || event.tags.length > 16 || !event.tags.every(t => Array.isArray(t) && t.length <= 4 && t.every(v => typeof v === 'string' && v.length <= 512)) ||
        !event.tags.some(t => t[0] === 'x' && t[1] === topic)) return;
      const digest = await eventHash(event);
      if (hex(digest) !== event.id || !await schnorr.verifyAsync(bytes(event.sig), digest, bytes(event.pubkey))) return;
      if (closed) return;
      try { handler(JSON.parse(event.content), event.pubkey); } catch { /* malformed or untrusted message */ }
    }
    function connect(url: string): void {
      if (closed) return;
      let socket: WebSocket;
      try { socket = new Socket(url); } catch (error) { report(new Error(String(error))); schedule(url); return; }
      sockets.set(url, socket);
      socket.onopen = () => {
        if (closed) { socket.close(); return; }
        retryDelays.set(url, 1000);
        socket.send(JSON.stringify(['REQ', subscription, { kinds: [30078], '#x': [topic], since: Math.floor(Date.now() / 1000) - 125, limit: 200 }]));
        resolveOpen();
      };
      socket.onmessage = event => {
        // Bound expensive signature verification and preserve arrival order.
        if (queued >= 256 || closed || typeof event.data !== 'string' || event.data.length > 16384) return;
        queued++;
        processing = processing.then(() => receive(event.data, socket)).catch(() => {}).finally(() => { queued--; });
      };
      socket.onerror = () => { if (!closed) report(new Error(`Discovery relay connection failed: ${url}`)); };
      socket.onclose = () => { if (sockets.get(url) === socket) sockets.delete(url); schedule(url); };
    }
    function schedule(url: string): void {
      if (closed || retries.has(url)) return;
      const delay = retryDelays.get(url) ?? 1000; retryDelays.set(url, Math.min(delay * 2, 30000));
      retries.set(url, setTimeout(() => { retries.delete(url); connect(url); }, delay));
    }
    async function close(): Promise<void> {
      if (closed) return;
      closed = true;
      for (const timer of retries.values()) clearTimeout(timer);
      retries.clear();
      for (const ack of pending.values()) { clearTimeout(ack.timer); ack.reject(new Error('Discovery closed')); }
      pending.clear();
      for (const socket of sockets.values()) {
        if (socket.readyState === 1) socket.send(JSON.stringify(['CLOSE', subscription]));
        socket.close();
      }
      sockets.clear(); handler = () => {};
    }
    urls.forEach(connect);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([opened, new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Public lobby unavailable: no discovery relay connected')), options.connectTimeoutMs ?? 10000);
      })]);
    } catch (error) { await close(); throw error; }
    finally { clearTimeout(timeout); }

    return {
      publisherId,
      onMessage: callback => { handler = callback; },
      publish: async message => {
        if (closed) throw new Error('Discovery closed');
        const payload = message as { roomId?: unknown; expiresAt?: unknown };
        if (typeof payload.roomId !== 'string' || typeof payload.expiresAt !== 'number') throw new Error('Invalid room publication');
        const event = { pubkey: publisherId, created_at: Math.floor(Date.now() / 1000), kind: 30078,
          // Separate revisions avoid replaceable-event timestamp ties (Nostr timestamps use seconds).
          tags: [['d', `${topic}:${payload.roomId}:${(message as { revision?: unknown }).revision}`], ['x', topic], ['expiration', String(Math.ceil(payload.expiresAt / 1000))]], content: JSON.stringify(message) };
        if (new TextEncoder().encode(event.content).length > 8192) throw new Error('Room publication too large');
        const digest = await eventHash(event);
        const signed = { ...event, id: hex(digest), sig: hex(await schnorr.signAsync(digest, secretKey)) };
        if (closed) throw new Error('Discovery closed');
        const available = [...sockets.values()].filter(socket => socket.readyState === 1);
        if (!available.length) throw new Error('Public lobby unavailable: discovery relays disconnected');
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => { pending.delete(signed.id); reject(new Error('Room publication acknowledgement timed out')); }, options.publishTimeoutMs ?? 5000);
          pending.set(signed.id, { resolve, reject, timer, outstanding: new Set(available) });
          for (const socket of available) {
            try { socket.send(JSON.stringify(['EVENT', signed])); } catch { /* other relays or ACK timeout settle the publication */ }
          }
        });
      },
      close,
    };
  };
}
