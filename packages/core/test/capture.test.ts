import { describe, expect, it } from 'vitest';
import {
  Grid,
  PlayerFogMap,
  PlayerId,
  WorldState,
  evaluateVictory,
  findPath,
  fogKnowledge,
  moveUnit,
  reachableThisTurn,
  truthKnowledge,
  type MoveContext,
} from '../src/index.js';

const P1 = PlayerId('p1');
const P2 = PlayerId('p2');
const P3 = PlayerId('p3');

function ctxFor(world: WorldState, players = [P1, P2]): MoveContext {
  const fogs = new Map(players.map((p) => [p, new PlayerFogMap(p, world.grid.width, world.grid.height)]));
  for (const f of fogs.values()) f.update(world);
  return { world, fogs };
}

describe('city capture', () => {
  it('infantry takes an empty neutral city by walking in, ending its turn', () => {
    const w = new WorldState(Grid.filled(6, 1, 'plains'));
    const city = w.foundCity('Alpha', { x: 2, y: 0 });
    const inf = w.spawnUnit('mech_infantry', P1, { x: 1, y: 0 });
    const r = moveUnit(ctxFor(w), P1, inf.id, [{ x: 2, y: 0 }, { x: 3, y: 0 }]);
    expect(r).toMatchObject({
      ok: true,
      value: { stoppedBy: 'CAPTURED', captured: city.id, capturedFrom: null, stepsTaken: 1 },
    });
    expect(city.owner).toBe(P1);
    expect(city.production).toEqual({ unit: 'infantry', progress: 0 });
    expect(inf.position).toEqual({ x: 2, y: 0 });
    expect(inf.movesLeft).toBe(0);
  });

  it('only capture-capable units can take cities', () => {
    const w = new WorldState(Grid.filled(6, 1, 'plains'));
    w.foundCity('Alpha', { x: 2, y: 0 });
    const tank = w.spawnUnit('heavy_tank', P1, { x: 1, y: 0 });
    expect(moveUnit(ctxFor(w), P1, tank.id, [{ x: 2, y: 0 }])).toMatchObject({
      ok: false,
      error: { code: 'CITY_NOT_OWNED' },
    });
  });

  it('a defended city must be cleared first', () => {
    const w = new WorldState(Grid.filled(6, 1, 'plains'));
    const city = w.foundCity('Alpha', { x: 2, y: 0 });
    city.capture(P2);
    w.spawnUnit('infantry', P2, { x: 2, y: 0 });
    const inf = w.spawnUnit('infantry', P1, { x: 1, y: 0 });
    expect(moveUnit(ctxFor(w), P1, inf.id, [{ x: 2, y: 0 }])).toMatchObject({ error: { code: 'ENEMY_PRESENT' } });
    expect(city.owner).toBe(P2);
  });

  it('flips vision: the new owner gains the city view, the old owner loses it', () => {
    const w = new WorldState(Grid.filled(12, 1, 'plains'));
    const city = w.foundCity('Alpha', { x: 6, y: 0 });
    city.capture(P2);
    const inf = w.spawnUnit('infantry', P1, { x: 5, y: 0 });
    const ctx = ctxFor(w);
    const r = moveUnit(ctx, P1, inf.id, [{ x: 6, y: 0 }]);
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value.fogUpdates.get(P1)?.revealed).toContain(w.grid.index({ x: 8, y: 0 })); // city radius 2
    expect(r.value.fogUpdates.get(P2)?.hidden.length).toBeGreaterThan(0);
    expect(ctx.fogs.get(P2)!.knownCities.get(city.id)?.owner).toBe(P2); // they didn't see it fall
  });

  it('amphibious assault: infantry captures straight off a transport', () => {
    const w = new WorldState(Grid.fromAscii(['~~.']));
    const city = w.foundCity('Beach', { x: 2, y: 0 });
    city.capture(P2);
    const tr = w.spawnUnit('transport', P1, { x: 1, y: 0 });
    const inf = w.spawnUnit('infantry', P1, { x: 1, y: 0 });
    w.load(tr.id, inf.id);
    const r = moveUnit(ctxFor(w), P1, inf.id, [{ x: 2, y: 0 }]);
    expect(r).toMatchObject({ value: { stoppedBy: 'CAPTURED' } });
    expect(inf.carriedBy).toBeNull();
    expect(tr.cargo).toEqual([]);
    expect(city.owner).toBe(P1);
  });

  it('planning treats known foreign cities as capture targets that end the path', () => {
    const w = new WorldState(Grid.filled(8, 1, 'plains'));
    w.foundCity('Alpha', { x: 3, y: 0 });
    const inf = w.spawnUnit('infantry', P1, { x: 0, y: 0 });
    const tank = w.spawnUnit('heavy_tank', P1, { x: 2, y: 0 });
    const k = truthKnowledge(w);
    expect(findPath(k, inf, { x: 3, y: 0 })?.steps.at(-1)?.kind).toBe('capture');
    expect(findPath(k, inf, { x: 5, y: 0 })).toBeNull(); // 1-tall map: the city is a dead end
    expect([...reachableThisTurn(k, tank).values()].some((r) => r.coord.x === 3)).toBe(false);

    // Seen as neutral: still a capture target in the fog-based plan.
    const fog = new PlayerFogMap(P1, 8, 1);
    fog.update(w);
    expect(findPath(fogKnowledge(w, fog), inf, { x: 3, y: 0 })?.steps.at(-1)?.kind).toBe('capture');
  });
});

describe('evaluateVictory', () => {
  const world = (cities: number) => {
    const w = new WorldState(Grid.filled(cities, 2, 'plains'));
    for (let x = 0; x < cities; x++) w.foundCity(`C${x}`, { x, y: 0 });
    return w;
  };
  const cities = (w: WorldState) => [...w.allCities()];

  it('declares a winner at the city-share threshold, counting neutral cities', () => {
    const w = world(4);
    const [a, b, c] = cities(w);
    a!.capture(P1);
    b!.capture(P1);
    w.spawnUnit('infantry', P2, { x: 0, y: 1 });
    expect(evaluateVictory(w, [P1, P2]).winner).toBeNull(); // 2/4
    c!.capture(P1);
    expect(evaluateVictory(w, [P1, P2])).toMatchObject({ winner: P1, reason: 'city_share' });
    expect(evaluateVictory(w, [P1, P2], { cityShareToWin: 1 }).winner).toBeNull();
  });

  it('eliminates a player with no cities and no unit able to capture', () => {
    const w = world(4);
    cities(w)[0]!.capture(P1);
    cities(w)[1]!.capture(P3);
    const tr = w.spawnUnit('transport', P2, { x: 0, y: 1 });
    const inf = w.spawnUnit('infantry', P2, { x: 0, y: 1 });
    w.load(tr.id, inf.id);

    // P2 has no city but a boat with infantry: still in the game.
    expect(evaluateVictory(w, [P1, P2, P3]).newlyEliminated).toEqual([]);

    w.removeUnit(tr.id); // the infantry drowns with it
    const r = evaluateVictory(w, [P1, P2, P3]);
    expect(r.newlyEliminated).toEqual([P2]);
    expect(r.winner).toBeNull(); // P1 and P3 remain
  });

  it('the last player standing wins', () => {
    const w = world(4);
    cities(w)[0]!.capture(P1);
    w.spawnUnit('battleship', P2, { x: 3, y: 1 }); // can't capture anything
    expect(evaluateVictory(w, [P1, P2])).toMatchObject({
      winner: P1,
      reason: 'last_standing',
      newlyEliminated: [P2],
    });
  });
});
