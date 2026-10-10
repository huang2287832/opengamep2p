import type { Json } from './types.js';

/** Public, untrusted metadata. Joining still requires host admission. */
export type PublicRoom = {
  id: string; name: string; hostId: string; invite: string;
  playerCount: number; maxPlayers: number; gameVersion: string;
};
export interface DiscoveryTransport {
  readonly publisherId: string;
  publish(message: Json): Promise<void>;
  onMessage(callback: (message: unknown, publisherId: string) => void): void;
  close(): Promise<void>;
}
export type DiscoveryFactory = (options: {
  appId: string; onError: (error: Error) => void;
}) => Promise<DiscoveryTransport>;
export interface LobbyOptions {
  transport?: DiscoveryFactory;
  heartbeatMs?: number;
  ttlMs?: number;
  maxRooms?: number;
}
export interface HostOptions { public?: boolean; name?: string }
