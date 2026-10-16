export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Transport implementations must preserve sender identity and message order per peer. */
export interface Transport {
  readonly selfId: string;
  peers(): string[];
  send(message: Json, target: string | string[]): Promise<void>;
  onMessage(callback: (message: unknown, peerId: string) => void): void;
  onJoin(callback: (peerId: string) => void): void;
  onLeave(callback: (peerId: string) => void): void;
  close(): Promise<void>;
}

export interface ConnectionOptions {
  appId: string;
  roomId: string;
  password: string;
  onError: (error: Error) => void;
}
export type TransportFactory = (options: ConnectionOptions) => Promise<Transport>;

export type Player = { id: string; isHost: boolean };
export interface TickContext<I> {
  /** Latest validated input per connected player; a player may not have sent input yet. */
  inputs: ReadonlyMap<string, I>;
  players: readonly Player[];
  tick: number;
  /** Fixed simulation step in seconds. */
  dt: number;
}

export interface GameOptions<S extends Json, I extends Json> {
  /** Unique namespace shared by all instances of this game. */
  appId: string;
  /** Change when game rules or state/input schemas become incompatible. */
  gameVersion?: string;
  initialState: S;
  /** Runs only on the host. Return the next state (mutating state is also supported). */
  update: (state: S, context: TickContext<I>) => S;
  /** Validate untrusted input on the host. Return false to discard it. */
  validateInput: (input: unknown) => input is I;
  tickRate?: number;
  snapshotRate?: number;
  maxPlayers?: number;
  /** Total wait for host connectivity and admission. Default: 45000 ms. */
  joinTimeoutMs?: number;
  maxMessageBytes?: number;
  /** Expire held input when a client stops sending it. */
  inputTimeoutMs?: number;
  onError?: (error: Error) => void;
  /** Replace Trystero for tests or an alternative signaling strategy. */
  transport?: TransportFactory;
  /** Public room discovery settings; discovery is opened only when requested. */
  lobby?: import('./discovery-types.js').LobbyOptions;
  /** Disable the automatic clock and call session.step() from your own fixed clock. */
  manualTick?: boolean;
}
