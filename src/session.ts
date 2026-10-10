import { decodeInvite, encodeInvite, randomToken } from './invite.js';
import { trysteroTransport } from './trystero.js';
import { Lobby } from './lobby.js';
import type { HostOptions } from './discovery-types.js';
import type { GameOptions, Json, Player, Transport } from './types.js';

type Listener<T> = (value: T) => void;
type Resolved<S extends Json, I extends Json> = GameOptions<S, I> & {
  gameVersion: string; tickRate: number; snapshotRate: number; maxPlayers: number;
  joinTimeoutMs: number; maxMessageBytes: number; inputTimeoutMs: number;
};
function integer(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function json(value: unknown, depth = 0): value is Json {
  if (depth > 64) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) if (!json(value[index], depth + 1)) return false;
    return true;
  }
  return record(value) && Object.getPrototypeOf(value) === Object.prototype && Object.values(value).every(v => json(v, depth + 1));
}
function clone<T>(value: T): T { return structuredClone(value); }

/** A single room. The original host remains authoritative for its lifetime. */
export class Session<S extends Json, I extends Json> {
  readonly id: string;
  readonly isHost: boolean;
  readonly invite: string;
  private hostId: string;
  private options: Resolved<S, I>;
  private transport: Transport;
  private currentState: S;
  private members = new Map<string, Player>();
  private inputs = new Map<string, { value: I; sequence: number; received: number }>();
  private stateListeners = new Set<Listener<S>>();
  private playerListeners = new Set<Listener<readonly Player[]>>();
  private disconnectListeners = new Set<Listener<string>>();
  private timer?: ReturnType<typeof setInterval>;
  private timeout?: ReturnType<typeof setTimeout>;
  private helloTimer?: ReturnType<typeof setInterval>;
  private resolveReady?: () => void;
  private rejectReady?: (error: Error) => void;
  private active = false;
  private closed = false;
  private sequence = 0;
  private frame = 0;
  private snapshotBusy = false;
  private snapshotBudget = 0;
  private closePromise?: Promise<void>;

  /** @internal Use createGame().host()/join(). */
  constructor(options: Resolved<S, I>, transport: Transport, hostId: string, invite: string, isHost: boolean) {
    this.options = options; this.transport = transport; this.id = transport.selfId;
    this.hostId = hostId; this.invite = invite; this.isHost = isHost;
    this.currentState = clone(options.initialState);
    if (isHost) { this.active = true; this.members.set(this.id, { id: this.id, isHost: true }); }
    this.assertSize(this.snapshot('welcome'));
    transport.onMessage((message, peer) => {
      try { this.receive(message, peer); } catch (error) { this.report(error); }
    });
    transport.onJoin(peer => {
      if (!isHost && peer === hostId) this.hello();
    });
    transport.onLeave(peer => {
      if (this.closed) return;
      if (!isHost && peer === hostId) { void this.finish('host-left'); return; }
      if (isHost && this.members.delete(peer)) {
        this.inputs.delete(peer); this.emitPlayers(); this.broadcastSnapshot();
      }
    });
    if (isHost && !options.manualTick) this.timer = setInterval(() => this.step(), 1000 / options.tickRate);
  }

  get state(): S { return clone(this.currentState); }
  get players(): readonly Player[] { return Array.from(this.members.values(), p => ({ ...p })); }
  get tick(): number { return this.frame; }
  get connected(): boolean { return this.active && !this.closed; }

  /** Immediately calls listener with the current state, then every authoritative update. */
  onState(listener: Listener<S>): () => void {
    this.stateListeners.add(listener); this.safeCall(listener, this.state);
    return () => { this.stateListeners.delete(listener); };
  }
  onPlayers(listener: Listener<readonly Player[]>): () => void {
    this.playerListeners.add(listener); this.safeCall(listener, this.players);
    return () => { this.playerListeners.delete(listener); };
  }
  onDisconnect(listener: Listener<string>): () => void {
    this.disconnectListeners.add(listener); return () => { this.disconnectListeners.delete(listener); };
  }

  /** Send held controls regularly; input is expired after inputTimeoutMs. */
  async sendInput(input: I): Promise<void> {
    this.assertActive();
    if (!this.validInput(input)) throw new Error('Invalid input');
    const packet: Json = { type: 'input', sequence: ++this.sequence, input };
    this.assertSize(packet);
    if (this.isHost) this.inputs.set(this.id, { value: clone(input), sequence: this.sequence, received: performance.now() });
    else await this.transport.send(packet, this.hostId);
  }

  /** Advance one fixed step; only the host simulates. Used with manualTick. */
  step(): void {
    if (!this.isHost || !this.connected) return;
    try {
      const inputs = new Map<string, I>();
      const now = performance.now();
      for (const [id, entry] of this.inputs) {
        if (now - entry.received <= this.options.inputTimeoutMs) inputs.set(id, clone(entry.value));
      }
      const next = this.options.update(this.currentState, {
        inputs, players: this.players, tick: this.frame + 1, dt: 1 / this.options.tickRate,
      });
      if (!json(next)) throw new Error('update() must return JSON-compatible state');
      this.assertSize({ type: 'snapshot', tick: this.frame + 1, state: next, players: this.players as Player[] });
      this.currentState = next; this.frame++;
      this.emitState();
      this.snapshotBudget += this.options.snapshotRate;
      if (this.snapshotBudget >= this.options.tickRate) {
        this.snapshotBudget -= this.options.tickRate; this.broadcastSnapshot();
      }
    } catch (error) { this.report(error); void this.finish('simulation-error'); }
  }

  async leave(): Promise<void> {
    if (this.closed) return this.closePromise;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const target = this.isHost ? this.remotePlayers() : this.hostId;
      if (!Array.isArray(target) || target.length) await Promise.race([
        this.transport.send({ type: this.isHost ? 'end' : 'leave' }, target),
        new Promise<void>(resolve => { deadline = setTimeout(resolve, 250); }),
      ]);
    } catch (error) { this.report(error); }
    finally { clearTimeout(deadline); }
    await this.finish('left');
  }

  /** @internal */
  waitForHost(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.resolveReady = resolve; this.rejectReady = reject;
      this.timeout = setTimeout(() => {
        this.rejectReady?.(new Error('Join timed out: host unavailable or P2P connection blocked; check signaling/STUN/TURN'));
        void this.finish('join-timeout');
      }, this.options.joinTimeoutMs);
      this.helloTimer = setInterval(() => this.hello(), 500);
      this.hello();
    });
  }

  private hello(): void {
    if (!this.closed && !this.active && this.transport.peers().includes(this.hostId)) {
      this.send({ type: 'hello', version: this.options.gameVersion }, this.hostId);
    }
  }
  private receive(packet: unknown, peer: string): void {
    if (this.closed || !record(packet) || !json(packet)) return;
    try { this.assertSize(packet); } catch { return; }
    if (this.isHost) {
      if (packet.type === 'hello') {
        if (packet.version !== this.options.gameVersion) { this.send({ type: 'reject', reason: 'Incompatible game version' }, peer); return; }
        if (!this.members.has(peer)) {
          if (this.members.size >= this.options.maxPlayers) { this.send({ type: 'reject', reason: 'Room is full' }, peer); return; }
          this.members.set(peer, { id: peer, isHost: false }); this.emitPlayers();
        }
        this.send(this.snapshot('welcome'), peer); this.broadcastSnapshot();
      } else if (packet.type === 'input' && this.members.has(peer) && integer(packet.sequence) && this.validInput(packet.input)) {
        const prior = this.inputs.get(peer);
        if (!prior || packet.sequence > prior.sequence) this.inputs.set(peer, {
          value: clone(packet.input), sequence: packet.sequence, received: performance.now(),
        });
      } else if (packet.type === 'leave' && this.members.delete(peer)) {
        this.inputs.delete(peer); this.emitPlayers(); this.broadcastSnapshot();
      }
      return;
    }
    // Never accept state, roster, rejection or termination from a guest.
    if (peer !== this.hostId) return;
    if (packet.type === 'reject' && !this.active && typeof packet.reason === 'string') {
      this.rejectReady?.(new Error(packet.reason)); void this.finish('rejected'); return;
    }
    if (packet.type === 'end') { void this.finish('host-left'); return; }
    if ((packet.type !== 'welcome' && packet.type !== 'snapshot') || !integer(packet.tick) || !json(packet.state) || !this.validPlayers(packet.players)) return;
    if (!this.active && packet.type !== 'welcome') return;
    if (this.active && packet.tick < this.frame) return;
    this.currentState = clone(packet.state) as S; this.frame = packet.tick;
    const oldRoster = JSON.stringify(this.players);
    this.members = new Map(packet.players.map(p => [p.id, p]));
    this.active = true;
    clearTimeout(this.timeout); clearInterval(this.helloTimer);
    this.resolveReady?.(); this.resolveReady = undefined; this.rejectReady = undefined;
    if (JSON.stringify(this.players) !== oldRoster) this.emitPlayers();
    this.emitState();
  }
  private validPlayers(value: unknown): value is Player[] {
    if (!Array.isArray(value) || value.length < 1 || value.length > this.options.maxPlayers) return false;
    const ids = new Set<string>();
    for (const player of value) {
      if (!record(player) || typeof player.id !== 'string' || typeof player.isHost !== 'boolean' || ids.has(player.id) || player.isHost !== (player.id === this.hostId)) return false;
      ids.add(player.id);
    }
    return ids.has(this.id) && ids.has(this.hostId);
  }
  private validInput(value: unknown): value is I {
    return json(value) && this.options.validateInput(value);
  }
  private snapshot(type: string = 'snapshot'): Json {
    return { type, tick: this.frame, state: clone(this.currentState), players: this.players as Player[] };
  }
  private remotePlayers(): string[] { return Array.from(this.members.keys()).filter(id => id !== this.id); }
  private broadcastSnapshot(): void {
    const peers = this.remotePlayers();
    if (this.snapshotBusy || !peers.length || this.closed) return;
    this.snapshotBusy = true;
    // One outstanding snapshot: skip frames under congestion rather than build an unbounded queue.
    void this.transport.send(this.snapshot(), peers).catch(error => this.report(error)).finally(() => { this.snapshotBusy = false; });
  }
  private send(packet: Json, target: string | string[]): void {
    if (Array.isArray(target) && !target.length) return;
    void this.transport.send(packet, target).catch(error => this.report(error));
  }
  private assertSize(value: Json): void {
    if (new TextEncoder().encode(JSON.stringify(value)).length > this.options.maxMessageBytes) throw new Error('Message exceeds maxMessageBytes');
  }
  private assertActive(): void { if (!this.connected) throw new Error('Session is not connected'); }
  private safeCall<T>(listener: Listener<T>, value: T): void {
    try { listener(value); } catch (error) { this.report(error); }
  }
  private emitState(): void { for (const listener of this.stateListeners) this.safeCall(listener, this.state); }
  private emitPlayers(): void { for (const listener of this.playerListeners) this.safeCall(listener, this.players); }
  private report(error: unknown): void {
    try { this.options.onError?.(error instanceof Error ? error : new Error(String(error))); } catch { /* Error observers cannot break cleanup. */ }
  }
  private finish(reason: string): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true; this.active = false;
    clearInterval(this.timer); clearInterval(this.helloTimer); clearTimeout(this.timeout);
    this.rejectReady?.(new Error(reason)); this.rejectReady = undefined; this.resolveReady = undefined;
    this.inputs.clear(); this.members.clear();
    this.closePromise = Promise.resolve().then(() => this.transport.close()).catch(error => this.report(error));
    this.emitPlayers();
    for (const listener of this.disconnectListeners) this.safeCall(listener, reason);
    this.stateListeners.clear(); this.playerListeners.clear(); this.disconnectListeners.clear();
    return this.closePromise;
  }
}

/** Configure once, then host a new room or join using its invitation. */
export function createGame<S extends Json, I extends Json>(options: GameOptions<S, I>) {
  const config: Resolved<S, I> = {
    gameVersion: '1', tickRate: 60, snapshotRate: 20, maxPlayers: 8,
    joinTimeoutMs: 15000, maxMessageBytes: 64 * 1024, inputTimeoutMs: 1000,
    ...options,
  };
  if (!config.appId.trim() || config.appId.length > 200) throw new Error('appId must contain 1–200 characters');
  if (!config.gameVersion || config.gameVersion.length > 200) throw new Error('gameVersion must contain 1–200 characters');
  if (!json(config.initialState)) throw new Error('initialState must be JSON-compatible');
  for (const key of ['tickRate', 'snapshotRate', 'maxPlayers', 'joinTimeoutMs', 'maxMessageBytes', 'inputTimeoutMs'] as const) {
    if (!Number.isSafeInteger(config[key]) || config[key] < 1) throw new Error(`${key} must be a positive integer`);
  }
  if (config.tickRate > 240 || config.snapshotRate > config.tickRate || config.maxPlayers > 64) throw new Error('Invalid tick/snapshot rate or player limit');
  const factory = config.transport ?? trysteroTransport();
  let lobbyPromise: Promise<Lobby> | undefined;
  async function lobby(): Promise<Lobby> {
    if (lobbyPromise) {
      const existing = lobbyPromise;
      if (!(await existing).closed) return existing;
      if (lobbyPromise === existing) lobbyPromise = undefined;
    }
    if (!lobbyPromise) {
      lobbyPromise = Lobby.open(config.appId, config.gameVersion, config.lobby, config.onError)
        .catch(error => { lobbyPromise = undefined; throw error; });
    }
    return lobbyPromise;
  }
  let busy = false;
  async function connect(host: boolean, inviteCode?: string): Promise<Session<S, I>> {
    // Trystero caches room handles; two local sessions must not overwrite their callbacks.
    if (busy) throw new Error('This game already has an active session; leave it before connecting again');
    const invite = host ? { app: config.appId, room: randomToken(), secret: randomToken(), host: '' } : decodeInvite(inviteCode!, config.appId);
    busy = true;
    let transport: Transport | undefined;
    try {
      transport = await factory({ appId: config.appId, roomId: invite.room, password: invite.secret,
        onError: error => { try { config.onError?.(error); } catch { /* observer */ } },
      });
      if (host) invite.host = transport.selfId;
      if (!host && invite.host === transport.selfId) throw new Error('Cannot join your own room in the same browser context');
      const rawTransport = transport;
      const managedTransport: Transport = {
        selfId: rawTransport.selfId,
        peers: () => rawTransport.peers(),
        send: (message, target) => rawTransport.send(message, target),
        onMessage: callback => rawTransport.onMessage(callback),
        onJoin: callback => rawTransport.onJoin(callback),
        onLeave: callback => rawTransport.onLeave(callback),
        close: async () => { try { await rawTransport.close(); } finally { busy = false; } },
      };
      const session = new Session(config, managedTransport, invite.host, encodeInvite(invite), host);
      if (!host) await session.waitForHost();
      return session;
    } catch (error) {
      if (transport) await transport.close().catch(() => {});
      busy = false; throw error;
    }
  }
  return {
    host: async (options: HostOptions = {}) => {
      const name = options.name ?? '公开房间';
      if (options.public && (!name.trim() || name.length > 80)) throw new Error('Public room name must contain 1–80 characters');
      const session = await connect(true);
      if (options.public) {
        try { await (await lobby()).advertise(session, name, config.maxPlayers); }
        catch (error) { await session.leave(); throw error; }
      }
      return session;
    },
    join: (invite: string) => connect(false, invite.trim()),
    lobby,
  };
}
