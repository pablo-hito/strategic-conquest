import { describe, expect, it } from 'vitest';
import { Match, PlayerId, buildPlayerView, generateMap, type TurnEvent } from '@sc/core';
import type { Command, OnlineView, RoomInfo } from '@sc/protocol/client';
import type { Ack, ServerLink } from '../src/net.js';
import { OnlineSession } from '../src/online-session.js';

const P1 = PlayerId('p1'), P2 = PlayerId('p2');

/** Stands in for the server: applies commands to a real match and reports views. */
class FakeServer {
  readonly match: Match;
  session!: OnlineSession;
  constructor() {
    const map = generateMap({ size: 'small', density: 'normal', seed: 'fake-server' }, [P1, P2]);
    this.match = Match.start(map.world, [P1, P2]).match;
  }
  view(p = P1): OnlineView {
    const m = this.match;
    return {
      you: p,
      meta: { round: m.round, active: m.activePlayer, status: m.status, winner: m.winner, deadline: null, totalCities: [...m.world.allCities()].length },
      view: buildPlayerView(m.world, m.fogs.get(p)!),
    };
  }
  link(): ServerLink {
    return {
      command: async (cmd: Command): Promise<Ack> => {
        let events: TurnEvent[] = [];
        let r: { ok: boolean; error?: { code: string; message: string } } = { ok: true };
        if (cmd.c === 'move') {
          const res = this.match.move(P1, cmd.unit as never, cmd.path);
          r = res;
          if (res.ok) events = res.value.events;
        } else if (cmd.c === 'endTurn') {
          const res = this.match.endTurn(P1);
          r = res;
          // The other player passes straight away.
          if (res.ok) this.match.endTurn(P2);
        } else if (cmd.c === 'production') {
          r = this.match.setProduction(P1, cmd.city as never, cmd.unitType);
        }
        // Like the real server: ack first, then the new picture.
        queueMicrotask(() => this.session.applyServerState(this.view(), []));
        return r.ok ? { ok: true, events } : { ok: false, code: r.error!.code, message: r.error!.message };
      },
    } as unknown as ServerLink;
  }
}

const ROOM = (code = 'TEST01'): RoomInfo => ({
  code,
  settings: { players: 2, size: 'small', density: 'normal', difficulty: 'normal', turnSeconds: 0, fillWithBots: false },
  status: 'playing',
  host: 0,
  seats: [
    { index: 0, player: P1, name: 'Ana', kind: 'human', connected: true, ready: true, alive: true, botStandIn: false },
    { index: 1, player: P2, name: 'Beto', kind: 'human', connected: true, ready: true, alive: true, botStandIn: false },
  ],
});

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('OnlineSession', () => {
  it('plans on the shadow world and the server carries the move out', async () => {
    const server = new FakeServer();
    const s = OnlineSession.fromServer(server.link(), server.view(), ROOM());
    server.session = s;
    expect(s.viewer).toBe(P1);
    expect(s.isMyTurn).toBe(true);
    expect(s.totalCities()).toBeGreaterThan(20);

    const inf = s.world.unitsOf(P1)[0]!;
    const reach = [...s.reachable(inf.id).values()];
    expect(reach.length).toBeGreaterThan(0);
    const goal = reach.find((r) => r.kind === 'move')!.coord;
    let updates = 0;
    s.onUpdate = () => updates++;
    expect(s.moveTo(inf.id, goal)).toBeNull();
    await settle();
    await settle();
    expect(updates).toBeGreaterThan(0);
    expect(server.match.world.unit(inf.id)!.position).toEqual(goal); // real game
    expect(s.world.unit(inf.id)!.position).toEqual(goal); // shadow caught up
  });

  it('a rejected command reaches onError and changes nothing', async () => {
    const server = new FakeServer();
    const s = OnlineSession.fromServer(server.link(), server.view(), ROOM());
    server.session = s;
    let error = '';
    s.onError = (m) => (error = m);
    const city = s.world.citiesOf(P1)[0]!;
    s.setProduction(city.id, 'battleship'); // needs a naval yard
    await settle();
    expect(error).not.toBe('');
  });

  it('knows when its turn comes back', async () => {
    const server = new FakeServer();
    const s = OnlineSession.fromServer(server.link(), server.view(), ROOM());
    server.session = s;
    const kinds: string[] = [];
    s.onUpdate = (k) => kinds.push(k);
    // Pretend the server already moved on to the other player...
    server.match.endTurn(P1);
    s.applyServerState(server.view(), []);
    expect(s.isMyTurn).toBe(false);
    // ...and back.
    server.match.endTurn(P2);
    s.applyServerState(server.view(), []);
    expect(kinds).toContain('turn-started');
    expect(s.isMyTurn).toBe(true);
  });
});
