import { describe, expect, it } from 'vitest';
import {
  Grid,
  PlayerFogMap,
  PlayerId,
  WorldState,
  armyCap,
  beginPlayerTurn,
  checkStep,
  findPath,
  forecastAttack,
  isBesieged,
  planAttack,
  truthKnowledge,
} from '../src/index.js';

const P1 = PlayerId('p1');
const P2 = PlayerId('p2');

describe('stacking', () => {
  it('fits 2 land units on an open tile and 4 in a city; ships and aircraft are not limited', () => {
    const w = new WorldState(Grid.filled(10, 3, 'plains'));
    const city = w.foundCity('A', { x: 5, y: 1 });
    city.capture(P1);
    w.spawnUnit('infantry', P1, { x: 2, y: 1 });
    w.spawnUnit('infantry', P1, { x: 2, y: 1 });
    const mover = w.spawnUnit('infantry', P1, { x: 1, y: 1 });
    const k = truthKnowledge(w);
    expect(checkStep(k, mover, mover.position, { x: 2, y: 1 })).toMatchObject({ ok: false, error: { code: 'STACK_FULL' } });
    const drone = w.spawnUnit('recon_drone', P1, { x: 1, y: 1 });
    expect(checkStep(k, drone, drone.position, { x: 2, y: 1 }).ok).toBe(true);

    for (let i = 0; i < 4; i++) w.spawnUnit('infantry', P1, city.position);
    const next = w.spawnUnit('infantry', P1, { x: 4, y: 1 });
    expect(checkStep(truthKnowledge(w), next, next.position, city.position)).toMatchObject({ ok: false, error: { code: 'STACK_FULL' } });
  });

  it('routes around full tiles', () => {
    const w = new WorldState(Grid.filled(6, 3, 'plains'));
    w.spawnUnit('infantry', P1, { x: 2, y: 1 });
    w.spawnUnit('infantry', P1, { x: 2, y: 1 });
    const u = w.spawnUnit('infantry', P1, { x: 1, y: 1 });
    const path = findPath(truthKnowledge(w), u, { x: 3, y: 1 });
    expect(path).not.toBeNull();
    expect(path!.steps.some((s) => s.coord.x === 2 && s.coord.y === 1)).toBe(false);
  });

  it('holds a finished land unit while the city is full, keeping progress', () => {
    const w = new WorldState(Grid.filled(10, 3, 'plains'));
    const city = w.foundCity('A', { x: 5, y: 1 });
    city.capture(P1);
    city.setProduction('infantry');
    for (let i = 0; i < 4; i++) w.spawnUnit('infantry', P1, city.position);
    for (let i = 0; i < 3; i++) beginPlayerTurn(w, P1);
    const events = beginPlayerTurn(w, P1);
    expect(events).toContainEqual({ type: 'production_blocked', audience: P1, city: city.id, reason: 'city_full' });
    expect(w.unitsAt(city.position).length).toBe(4);
    const out = w.unitsAt(city.position)[0]!;
    w.removeUnit(out.id);
    const after = beginPlayerTurn(w, P1);
    expect(after.some((e) => e.type === 'unit_produced')).toBe(true);
  });
});

describe('desertion over the army cap', () => {
  it('a third of the excess leaves each turn, cheapest and weakest first', () => {
    const w = new WorldState(Grid.filled(40, 3, 'plains'));
    const city = w.foundCity('A', { x: 0, y: 0 });
    city.capture(P1);
    const cap = armyCap(w, P1); // 11
    for (let i = 0; i < cap; i++) w.spawnUnit('heavy_tank', P1, { x: 1 + i, y: 1 });
    for (let i = 0; i < 9; i++) w.spawnUnit('infantry', P1, { x: 1 + i, y: 2 });
    const events = beginPlayerTurn(w, P1);
    const deserted = events.find((e) => e.type === 'units_deserted');
    expect(deserted).toMatchObject({ over: 9, unitTypes: ['infantry', 'infantry', 'infantry'] });
    expect(w.unitsOf(P1).length).toBe(cap + 6);
    for (let i = 0; i < 10; i++) beginPlayerTurn(w, P1);
    expect(w.unitsOf(P1).length).toBe(cap);
  });

  it('never at or under the cap', () => {
    const w = new WorldState(Grid.filled(40, 1, 'plains'));
    w.foundCity('A', { x: 0, y: 0 }).capture(P1);
    for (let i = 0; i < armyCap(w, P1); i++) w.spawnUnit('infantry', P1, { x: 1 + i, y: 0 });
    expect(beginPlayerTurn(w, P1).some((e) => e.type === 'units_deserted')).toBe(false);
  });
});

describe('siege', () => {
  function besiege(enemies: number, ownOutside = false) {
    const w = new WorldState(Grid.filled(9, 9, 'plains'));
    const city = w.foundCity('A', { x: 4, y: 4 });
    city.capture(P1);
    const around = w.grid.neighbors(city.position);
    for (let i = 0; i < enemies; i++) w.spawnUnit('infantry', P2, around[i]!);
    if (ownOutside) w.spawnUnit('infantry', P1, around[7]!);
    return { w, city, around };
  }

  it('needs enemies on half the tiles around and no own unit outside', () => {
    expect(isBesieged(besiege(3).w, besiege(3).city)).toBe(false);
    const { w, city } = besiege(4);
    expect(isBesieged(w, city)).toBe(true);
    const relieved = besiege(4, true);
    expect(isBesieged(relieved.w, relieved.city)).toBe(false);
  });

  it('stops production and repair', () => {
    const { w, city } = besiege(4);
    city.setProduction('infantry');
    const defender = w.spawnUnit('infantry', P1, city.position);
    defender.takeDamage(4);
    const hp = defender.hp;
    const events = beginPlayerTurn(w, P1);
    expect(events).toContainEqual({ type: 'production_blocked', audience: P1, city: city.id, reason: 'besieged' });
    expect(city.production?.progress).toBe(0);
    expect(defender.hp).toBe(hp);
  });

  it('defenders lose their entrenchment', () => {
    const make = (enemies: number) => {
      const s = besiege(enemies);
      const def = s.w.spawnUnit('infantry', P1, s.city.position);
      for (let i = 0; i < 3; i++) def.startTurn(); // dig in
      const tank = s.w.spawnUnit('heavy_tank', P2, s.around[0]!);
      return { s, def, tank };
    };
    const open = make(3);
    const sieged = make(4);
    expect(open.def.entrenchment).toBeGreaterThan(0);
    const dmg = (x: ReturnType<typeof make>) => {
      const f = new PlayerFogMap(P2, x.s.w.grid.width, x.s.w.grid.height);
      f.update(x.s.w, new Set([P2]));
      const r = planAttack(x.s.w, f, P2, x.tank.id, x.s.city.position);
      if (!r.ok) throw new Error(r.error.message);
      return forecastAttack(x.s.w, r.value).damageToDefender;
    };
    expect(dmg(sieged)).toBeGreaterThan(dmg(open));
  });
});
