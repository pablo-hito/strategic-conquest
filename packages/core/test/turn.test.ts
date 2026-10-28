import { describe, expect, it } from 'vitest';
import {
  Grid,
  Match,
  PlayerId,
  WorldState,
  beginPlayerTurn,
  endPlayerTurn,
  suppliedLand,
} from '../src/index.js';

const P1 = PlayerId('p1');
const P2 = PlayerId('p2');
const P3 = PlayerId('p3');

const unwrap = <T>(r: { ok: true; value: T } | { ok: false; error: { message: string } }): T => {
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};

describe('beginPlayerTurn', () => {
  it('produces units that can move right away', () => {
    const w = new WorldState(Grid.filled(5, 1, 'plains'));
    const city = w.foundCity('A', { x: 0, y: 0 });
    city.capture(P1);
    city.setProduction('recon'); // 3 turns
    beginPlayerTurn(w, P1);
    beginPlayerTurn(w, P1);
    const events = beginPlayerTurn(w, P1);
    expect(events).toMatchObject([{ type: 'unit_produced', unitType: 'recon', audience: P1 }]);
    const recon = w.unitsAt({ x: 0, y: 0 })[0]!;
    expect(recon.movesLeft).toBe(3);
  });

  it('repairs and refuels units resting in an own city, only for that player', () => {
    const w = new WorldState(Grid.filled(5, 1, 'plains'));
    w.foundCity('A', { x: 0, y: 0 }).capture(P1);
    const tank = w.spawnUnit('heavy_tank', P1, { x: 0, y: 0 });
    const outside = w.spawnUnit('heavy_tank', P1, { x: 2, y: 0 });
    tank.takeDamage(5);
    outside.takeDamage(5);
    beginPlayerTurn(w, P2);
    expect(tank.hp).toBe(7);
    beginPlayerTurn(w, P1);
    expect(tank.hp).toBe(9);
    expect(outside.hp).toBe(7);
  });
});

describe('endPlayerTurn', () => {
  it('airborne aircraft burn unused moves and crash when dry', () => {
    const w = new WorldState(Grid.filled(5, 1, 'plains'));
    const f = w.spawnUnit('fighter', P1, { x: 2, y: 0 }); // fuel 20, moves 10
    expect(endPlayerTurn(w, P1)).toEqual([]);
    expect(f.fuel).toBe(10);
    f.startTurn();
    const events = endPlayerTurn(w, P1);
    expect(events).toMatchObject([{ type: 'aircraft_crashed', unit: f.id }]);
    expect(w.unit(f.id)).toBeUndefined();
  });

  it('aircraft in an own city do not burn fuel', () => {
    const w = new WorldState(Grid.filled(5, 1, 'plains'));
    w.foundCity('A', { x: 2, y: 0 }).capture(P1);
    const f = w.spawnUnit('fighter', P1, { x: 2, y: 0 });
    for (let i = 0; i < 5; i++) endPlayerTurn(w, P1);
    expect(f.fuel).toBe(20);
  });

  it('aircraft over an own carrier land on it; a full carrier does not save them', () => {
    const w = new WorldState(Grid.filled(5, 1, 'deep_ocean'));
    const cv = w.spawnUnit('carrier', P1, { x: 2, y: 0 });
    const planes = [0, 1, 2, 3].map(() => w.spawnUnit('fighter', P1, { x: 2, y: 0 }));
    for (const p of planes) p.burnLoiterFuel(); // fuel 10, as if they had flown
    const events = endPlayerTurn(w, P1);
    expect(events.filter((e) => e.type === 'aircraft_landed')).toHaveLength(3);
    expect(cv.cargo).toHaveLength(3);
    expect(planes[3]!.carriedBy).toBeNull();
    expect(planes.slice(0, 3).every((p) => p.fuel === 20)).toBe(true);
  });

  it('cuts supply for land units isolated from own cities, but not those at sea', () => {
    const w = new WorldState(Grid.fromAscii(['....~....']));
    w.foundCity('Home', { x: 0, y: 0 }).capture(P1);
    const home = w.spawnUnit('infantry', P1, { x: 3, y: 0 });
    const cutOff = w.spawnUnit('infantry', P1, { x: 6, y: 0 });
    const tr = w.spawnUnit('transport', P1, { x: 4, y: 0 });
    const aboard = w.spawnUnit('infantry', P1, { x: 4, y: 0 });
    w.load(tr.id, aboard.id);

    for (let i = 0; i < 4; i++) endPlayerTurn(w, P1);
    expect(home.isOutOfSupply).toBe(false);
    expect(aboard.isOutOfSupply).toBe(false);
    expect(cutOff.turnsOutOfSupply).toBe(4);
    expect(cutOff.isOutOfSupply).toBe(true);
  });

  it('enemy units and foreign cities break the supply line', () => {
    const w = new WorldState(Grid.filled(7, 1, 'plains'));
    w.foundCity('Home', { x: 0, y: 0 }).capture(P1);
    w.foundCity('Neutral', { x: 4, y: 0 });
    expect(suppliedLand(w, P1).has(3)).toBe(true);
    expect(suppliedLand(w, P1).has(5)).toBe(false);
    w.spawnUnit('infantry', P2, { x: 2, y: 0 });
    expect(suppliedLand(w, P1).has(3)).toBe(false);
  });
});

describe('Match (sequential mode)', () => {
  function setup(players = [P1, P2]) {
    const w = new WorldState(Grid.filled(12, 3, 'plains'));
    players.forEach((p, i) => {
      const c = w.foundCity(`Cap${i}`, { x: i * 10, y: 1 });
      c.capture(p);
      w.spawnUnit('infantry', p, { x: i * 10, y: 1 });
    });
    w.foundCity('Neutral', { x: 5, y: 1 });
    return Match.start(w, players);
  }

  it('rotates turns, advances the round and rejects out-of-turn commands', () => {
    const { match, report } = setup();
    expect(report.activePlayer).toBe(P1);
    expect(report.fogUpdates.get(P1)?.revealed.length).toBeGreaterThan(0);
    expect(match.endTurn(P2)).toMatchObject({ ok: false, error: { code: 'NOT_YOUR_TURN' } });

    const inf2 = match.world.unitsOf(P2)[0]!;
    expect(match.move(P2, inf2.id, [{ x: 9, y: 1 }])).toMatchObject({ error: { code: 'NOT_YOUR_TURN' } });

    expect(unwrap(match.endTurn(P1))).toMatchObject({ activePlayer: P2, round: 1 });
    expect(unwrap(match.endTurn(P2))).toMatchObject({ activePlayer: P1, round: 2 });
  });

  it('only lets a player manage their own cities', () => {
    const { match } = setup();
    const [mine, theirs] = match.world.allCities();
    expect(match.setProduction(P1, mine!.id, 'recon').ok).toBe(true);
    expect(match.setProduction(P1, theirs!.id, 'recon')).toMatchObject({ error: { code: 'NOT_YOUR_CITY' } });
  });

  it('ends the match when a capture crosses the city-share threshold', () => {
    const w = new WorldState(Grid.filled(6, 2, 'plains'));
    ['A', 'B'].forEach((n, x) => w.foundCity(n, { x, y: 0 }).capture(P1));
    w.foundCity('Neutral', { x: 2, y: 0 });
    w.foundCity('Last', { x: 4, y: 0 }).capture(P2);
    w.spawnUnit('infantry', P2, { x: 5, y: 1 }); // keeps P2 alive, but not in its city
    const inf = w.spawnUnit('infantry', P1, { x: 3, y: 0 });
    const { match } = Match.start(w, [P1, P2]);

    unwrap(match.endTurn(P1));
    unwrap(match.endTurn(P2));
    expect(match.status).toBe('playing'); // 2 of 4 cities
    const r = unwrap(match.move(P1, inf.id, [{ x: 4, y: 0 }]));
    expect(r.captured).toBeDefined();
    // 3 of 4 = 75%, and P2 survives thanks to its infantry: a city-share win.
    expect(r.events).toContainEqual({ type: 'match_won', audience: 'all', player: P1, reason: 'city_share' });
    expect(match.status).toBe('finished');
    expect(match.winner).toBe(P1);
    expect(match.activePlayer).toBeNull();
    expect(match.endTurn(P1)).toMatchObject({ error: { code: 'MATCH_FINISHED' } });
  });

  it('skips eliminated players in the rotation', () => {
    const w = new WorldState(Grid.filled(25, 1, 'plains'));
    [P1, P2, P3].forEach((p, i) => {
      w.foundCity(`Cap${i}`, { x: i * 10, y: 0 }).capture(p);
      w.spawnUnit('infantry', p, { x: i * 10 + 1, y: 0 });
    });
    const { match } = Match.start(w, [P1, P2, P3]);

    // P2 loses its capital and its only infantry (combat arrives in phase 3).
    w.cityAt({ x: 10, y: 0 })!.capture(P1);
    for (const u of w.unitsOf(P2)) w.removeUnit(u.id);

    const r = unwrap(match.endTurn(P1));
    expect(r.events).toContainEqual({ type: 'player_eliminated', audience: 'all', player: P2 });
    expect(r.activePlayer).toBe(P3);
    expect(match.alivePlayers).toEqual([P1, P3]);
    expect(unwrap(match.endTurn(P3))).toMatchObject({ activePlayer: P1, round: 2 });
  });

  it('round-trips through a snapshot mid-game', () => {
    const { match } = setup();
    const inf = match.world.unitsOf(P1)[0]!;
    unwrap(match.move(P1, inf.id, [{ x: 1, y: 1 }]));
    unwrap(match.endTurn(P1));
    const copy = Match.fromSnapshot(JSON.parse(JSON.stringify(match.toSnapshot())));
    expect(copy.toSnapshot()).toEqual(match.toSnapshot());
    expect(copy.activePlayer).toBe(P2);
    expect(unwrap(copy.endTurn(P2)).activePlayer).toBe(P1);
  });
});
