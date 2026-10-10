import { createGame, type Player, type Session, trysteroTransport } from '../dist/index.js';

type State = { positions: Record<string, { x: number; y: number }> };
type Input = { x: number; y: number };
const game = createGame<State, Input>({
  appId: 'type-example', initialState: { positions: {} },
  transport: trysteroTransport({ turnConfig: [{ urls: 'turn:example.invalid', username: 'u', credential: 'c' }] }),
  validateInput: (v): v is Input => typeof v === 'object' && v !== null && 'x' in v && 'y' in v,
  update(state, { inputs, players, dt, tick }) {
    const input: Input | undefined = inputs.get(players[0]?.id ?? '');
    void input; void dt; void tick;
    return state;
  },
});
const session: Session<State, Input> = await game.host({ public: true, name: 'Public game' });
const lobby = await game.lobby();
lobby.onRooms(rooms => { const invitation: string | undefined = rooms[0]?.invite; void invitation; });
await lobby.close();
const players: readonly Player[] = session.players;
void players;
await session.sendInput({ x: 1, y: 0 });
// @ts-expect-error Invalid input shape must be caught in the consuming game.
await session.sendInput({ direction: 'left' });
session.onState(state => { const x: number | undefined = state.positions[session.id]?.x; void x; });
await session.leave();
