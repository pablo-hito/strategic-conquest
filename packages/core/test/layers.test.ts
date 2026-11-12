import { describe, expect, it } from 'vitest';
import { Grid, Match, PlayerId, WorldState, checkStep, findPath, suppliedLand, truthKnowledge } from '../src/index.js';

const P1 = PlayerId('p1');
const P2 = PlayerId('p2');

describe('air and ground are separate layers', () => {
  it('an enemy aircraft does not block ground units, and ground units do not block aircraft', () => {
    const w = new WorldState(Grid.filled(6, 3, 'plains'));
    w.spawnUnit('fighter', P2, { x: 2, y: 1 });
    const tank = w.spawnUnit('heavy_tank', P1, { x: 1, y: 1 });
    expect(checkStep(truthKnowledge(w), tank, tank.position, { x: 2, y: 1 }).ok).toBe(true);
    w.spawnUnit('infantry', P2, { x: 4, y: 1 });
    const drone = w.spawnUnit('recon_drone', P1, { x: 3, y: 1 });
    expect(checkStep(truthKnowledge(w), drone, drone.position, { x: 4, y: 1 }).ok).toBe(true);
    // ... but aircraft still block aircraft, and ground still blocks ground.
    const fighter = w.spawnUnit('fighter', P1, { x: 1, y: 0 });
    expect(checkStep(truthKnowledge(w), fighter, fighter.position, { x: 2, y: 1 })).toMatchObject({ ok: false, error: { code: 'ENEMY_PRESENT' } });
    const inf = w.spawnUnit('infantry', P1, { x: 5, y: 1 });
    expect(checkStep(truthKnowledge(w), inf, inf.position, { x: 4, y: 1 })).toMatchObject({ ok: false, error: { code: 'ENEMY_PRESENT' } });
  });

  it('enemy aircraft do not cut supply lines', () => {
    const w = new WorldState(Grid.filled(6, 1, 'plains'));
    w.foundCity('A', { x: 0, y: 0 }).capture(P1);
    w.spawnUnit('fighter', P2, { x: 2, y: 0 });
    expect(suppliedLand(w, P1).has(w.grid.index({ x: 5, y: 0 }))).toBe(true);
  });

  it('a city held only by aircraft can be captured, and the parked aircraft are lost', () => {
    const w = new WorldState(Grid.filled(6, 3, 'plains'));
    w.foundCity('Home', { x: 0, y: 1 }).capture(P1);
    const city = w.foundCity('Base', { x: 3, y: 1 });
    city.capture(P2);
    w.foundCity('Far', { x: 5, y: 2 }).capture(P2);
    w.spawnUnit('fighter', P2, city.position);
    w.spawnUnit('recon_drone', P2, city.position);
    const inf = w.spawnUnit('infantry', P1, { x: 2, y: 1 });
    const { match } = Match.start(w, [P1, P2]);
    expect(findPath(truthKnowledge(w), inf, city.position)).not.toBeNull();
    const r = match.move(P1, inf.id, [city.position]);
    expect(r.ok && r.value.captured).toBe(city.id);
    expect(w.unitsAt(city.position).every((u) => u.owner === P1)).toBe(true);
    expect(r.ok && r.value.events).toContainEqual(expect.objectContaining({ type: 'city_captured', audience: P2, aircraftLost: 2 }));
  });
});
