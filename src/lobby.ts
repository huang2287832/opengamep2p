import { decodeInvite } from './invite.js';
import { nostrDiscovery } from './nostr-discovery.js';
import type { DiscoveryTransport, LobbyOptions, PublicRoom } from './discovery-types.js';
import type { Json, Player } from './types.js';

type Listing = { revision: number; expiresAt: number; room?: PublicRoom };
type HostedSession = {
  readonly isHost: boolean; readonly connected: boolean; readonly invite: string;
  readonly players: readonly Player[];
  onPlayers(listener: (players: readonly Player[]) => void): () => void;
  onDisconnect(listener: (reason: string) => void): () => void;
};

export class Lobby {
  private listings = new Map<string, Listing>();
  private listeners = new Set<(rooms: readonly PublicRoom[]) => void>();
  private advertisements = new Map<string, () => Promise<void>>();
  private timer: ReturnType<typeof setInterval>;
  private closePromise?: Promise<void>;
  private stopped = false;
  private revision = 0;
  private heartbeatMs: number;
  private ttlMs: number;
  private maxRooms: number;
  private constructor(private appId: string, private version: string, private transport: DiscoveryTransport,
    options: LobbyOptions, private onError: (error: Error) => void) {
    this.heartbeatMs = options.heartbeatMs ?? 10000; this.ttlMs = options.ttlMs ?? 35000; this.maxRooms = options.maxRooms ?? 200;
    transport.onMessage((message, publisher) => this.receive(message, publisher));
    this.timer = setInterval(() => { if (this.prune()) this.emit(); }, Math.min(this.heartbeatMs, 1000));
  }
  static async open(appId: string, version: string, options: LobbyOptions = {}, onError: (error: Error) => void = () => {}): Promise<Lobby> {
    const heartbeat = options.heartbeatMs ?? 10000, ttl = options.ttlMs ?? 35000, max = options.maxRooms ?? 200;
    if (![heartbeat, ttl, max].every(Number.isSafeInteger) || heartbeat < 10 || ttl < heartbeat * 3 || ttl > 120000 || max < 1 || max > 1000) throw new Error('Invalid lobby heartbeat, TTL or room limit');
    const transport = await (options.transport ?? nostrDiscovery())({ appId, onError });
    return new Lobby(appId, version, transport, options, onError);
  }
  get closed(): boolean { return this.stopped; }
  get rooms(): readonly PublicRoom[] {
    const now = Date.now();
    return [...this.listings.values()].flatMap(entry => entry.room && entry.expiresAt > now ? [{ ...entry.room }] : [])
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }
  onRooms(listener: (rooms: readonly PublicRoom[]) => void): () => void {
    if (this.stopped) throw new Error('Lobby closed');
    this.listeners.add(listener); this.call(listener, this.rooms);
    return () => { this.listeners.delete(listener); };
  }
  /** @internal Public hosting is exposed through game.host({ public: true, name }). */
  async advertise(session: HostedSession, name: string, maxPlayers: number): Promise<void> {
    if (this.stopped || !session.isHost || !session.connected) throw new Error('Only a connected host can publish a room');
    if (!name.trim() || name.length > 80) throw new Error('Public room name must contain 1–80 characters');
    const invite = decodeInvite(session.invite, this.appId);
    let ended = false, timer: ReturnType<typeof setInterval> | undefined;
    let unPlayers = () => {}, unDisconnect = () => {};
    let queue = Promise.resolve();
    let updateQueued = false;
    const send = (remove = false) => {
      // Coalesce changes while a relay ACK is pending; publish the latest occupancy.
      if (!remove && updateQueued) return queue;
      if (!remove) updateQueued = true;
      queue = queue.catch(() => {}).then(async () => {
        if (!remove) updateQueued = false;
        if (!remove && (ended || this.stopped || !session.connected)) return;
        const issuedAt = Date.now();
        const packet: Json = { type: remove ? 'remove' : 'room', protocol: 1, appId: this.appId,
          roomId: invite.room, revision: ++this.revision, issuedAt, expiresAt: issuedAt + this.ttlMs,
          ...(remove ? {} : { name: name.trim(), hostId: invite.host, invite: session.invite,
            playerCount: session.players.length, maxPlayers, gameVersion: this.version }) };
        await this.transport.publish(packet);
        // Relay echo is optional; the hosting browser should see its own room too.
        this.receive(packet, this.transport.publisherId);
      });
      return queue;
    };
    const stop = async () => {
      if (ended) return queue.catch(() => {});
      ended = true; clearInterval(timer); unPlayers(); unDisconnect();
      this.advertisements.delete(invite.room);
      try { await send(true); } catch (error) { this.report(error); }
    };
    this.advertisements.set(invite.room, stop);
    try {
      await send();
      if (!session.connected || this.stopped) { await stop(); throw new Error('Room ended while publishing'); }
      let first = true;
      unPlayers = session.onPlayers(() => { if (first) { first = false; return; } void send().catch(error => this.report(error)); });
      unDisconnect = session.onDisconnect(() => { void stop(); });
      timer = setInterval(() => { void send().catch(error => this.report(error)); }, this.heartbeatMs);
    } catch (error) { await stop(); throw error; }
  }
  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.stopped = true; clearInterval(this.timer);
    this.closePromise = (async () => {
      await Promise.all([...this.advertisements.values()].map(stop => stop()));
      try { await this.transport.close(); }
      finally { this.listings.clear(); this.emit(); this.listeners.clear(); }
    })();
    return this.closePromise;
  }
  private receive(value: unknown, publisher: string): void {
    if (this.stopped) return;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const v = value as Record<string, unknown>, now = Date.now();
    if (v.protocol !== 1 || v.appId !== this.appId || typeof v.roomId !== 'string' || v.roomId.length > 128 || !v.roomId ||
      typeof publisher !== 'string' || !publisher || publisher.length > 128 || !Number.isSafeInteger(v.revision) || (v.revision as number) < 1 ||
      typeof v.issuedAt !== 'number' || !Number.isSafeInteger(v.issuedAt) || v.issuedAt > now + 5000 ||
      typeof v.expiresAt !== 'number' || !Number.isSafeInteger(v.expiresAt) || v.expiresAt <= now || v.expiresAt <= v.issuedAt || v.expiresAt > v.issuedAt + 120000) return;
    const id = `${publisher}:${v.roomId}`;
    if (this.prune()) this.emit();
    const previous = this.listings.get(id);
    if (previous && previous.revision >= (v.revision as number)) return;
    if (!previous && this.listings.size >= this.maxRooms) return;
    let room: PublicRoom | undefined;
    if (v.type === 'room') {
      if (v.gameVersion !== this.version || typeof v.name !== 'string' || !v.name.trim() || v.name.length > 80 ||
        typeof v.invite !== 'string' || typeof v.hostId !== 'string' || !Number.isSafeInteger(v.playerCount) || !Number.isSafeInteger(v.maxPlayers) ||
        (v.playerCount as number) < 1 || (v.maxPlayers as number) < 1 || (v.maxPlayers as number) > 64 || (v.playerCount as number) > (v.maxPlayers as number)) return;
      try {
        const invite = decodeInvite(v.invite, this.appId);
        if (invite.room !== v.roomId || invite.host !== v.hostId) return;
      } catch { return; }
      room = { id, name: v.name.trim(), invite: v.invite, hostId: v.hostId, gameVersion: this.version,
        playerCount: v.playerCount as number, maxPlayers: v.maxPlayers as number };
    } else if (v.type !== 'remove') return;
    this.listings.set(id, { revision: v.revision as number, expiresAt: v.expiresAt, room });
    if (JSON.stringify(previous?.room) !== JSON.stringify(room)) this.emit();
  }
  private prune(): boolean {
    let changed = false;
    for (const [id, entry] of this.listings) if (entry.expiresAt <= Date.now()) { changed ||= !!entry.room; this.listings.delete(id); }
    return changed;
  }
  private emit(): void { for (const listener of this.listeners) this.call(listener, this.rooms); }
  private call(listener: (rooms: readonly PublicRoom[]) => void, rooms: readonly PublicRoom[]): void {
    try { listener(rooms); } catch (error) { this.report(error); }
  }
  private report(error: unknown): void { try { this.onError(error instanceof Error ? error : new Error(String(error))); } catch { /* observer */ } }
}
