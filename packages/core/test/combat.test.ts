import { describe, expect, it } from 'vitest';
import {
  Grid,
  Match,
  PlayerFogMap,
  PlayerId,
  Rng,
  WorldState,
  forecastAttack,
  planAttack,
  resolveAttack,
  type Coord,
  type UnitId,
} from '../src/index.js';

const P1 = PlayerId('p1');
const P2 = PlayerId('p2');

function fogFor(w: WorldState, p = P1): PlayerFogMap {
  const f = new PlayerFogMap(p, w.grid.width, w.grid.height);
  f.update(w);
  return f;
}

function plan(w: WorldState, id: UnitId, target: Coord, p = P1) {
  return planAttack(w, fogFor(w, p), p, id, target);
}

function forecast(w: WorldState, id: UnitId, target: Coord) {
  const r = plan(w, id, target);
  if (!r.ok) throw new Error(r.error.code);
  return forecastAttack(w, r.value);
}

describe('planAttack', () => {
  it('requires a known enemy in range and a weapon that can engage it', () => {
    const w = new WorldState(Grid.fromAscii(['....~~~']));
    const inf = w.spawnUnit('infantry', P1, { x: 2, y: 0 });
    const tr = w.spawnUnit('transport', P1, { x: 4, y: 0 });
    w.spawnUnit('infantry', P2, { x: 3, y: 0 });
    w.spawnUnit('submarine', P2, { x: 5, y: 0 });

    expect(plan(w, inf.id, { x: 3, y: 0 }).ok).toBe(true);
    expect(plan(w, inf.id, { x: 1, y: 0 })).toMatchObject({ error: { code: 'NO_TARGET' } });
    expect(plan(w, inf.id, { x: 5, y: 0 })).toMatchObject({ error: { code: 'OUT_OF_RANGE' } });
    expect(plan(w, tr.id, { x: 5, y: 0 })).toMatchObject({ error: { code: 'NO_WEAPONS' } });
    expect(plan(w, inf.id, { x: 3, y: 0 }, P2)).toMatchObject({ error: { code: 'NOT_YOUR_UNIT' } });
  });

  it('cannot target what it cannot see (silent submarine)', () => {
    const w = new WorldState(Grid.filled(8, 1, 'deep_ocean'));
    const bb = w.spawnUnit('battleship', P1, { x: 0, y: 0 });
    const sub = w.spawnUnit('submarine', P2, { x: 2, y: 0 });
    sub.setSilentRunning(true);
    expect(plan(w, bb.id, { x: 2, y: 0 })).toMatchObject({ error: { code: 'NO_TARGET' } });
    const dd = w.spawnUnit('destroyer', P1, { x: 0, y: 0 }); // sonar 2
    expect(plan(w, dd.id, { x: 2, y: 0 })).toMatchObject({ error: { code: 'OUT_OF_RANGE' } });
    w.stepUnit(dd.id, { x: 1, y: 0 }, 1);
    expect(plan(w, dd.id, { x: 2, y: 0 }).ok).toBe(true);
    // Battleship sees it now too (destroyer's sonar shares the contact), but its guns can't hit subs.
    expect(plan(w, bb.id, { x: 2, y: 0 })).toMatchObject({ error: { code: 'CANNOT_ENGAGE' } });
  });

  it('artillery fires at range 2-3 only, and not after moving', () => {
    const w = new WorldState(Grid.filled(8, 1, 'plains'));
    const art = w.spawnUnit('artillery', P1, { x: 0, y: 0 });
    w.spawnUnit('recon', P1, { x: 2, y: 0 }); // spotter
    w.spawnUnit('infantry', P2, { x: 1, y: 0 });
    w.spawnUnit('infantry', P2, { x: 3, y: 0 });
    expect(plan(w, art.id, { x: 1, y: 0 })).toMatchObject({ error: { code: 'OUT_OF_RANGE' } });
    expect(plan(w, art.id, { x: 3, y: 0 }).ok).toBe(true);
    art.startTurn();
    w.stepUnit(art.id, { x: 0, y: 0 }, 0); // any move counts
    expect(plan(w, art.id, { x: 3, y: 0 })).toMatchObject({ error: { code: 'MOVED_BEFORE_FIRING' } });
  });

  it('picks the defender that holds best against this attacker', () => {
    const w = new WorldState(Grid.filled(4, 1, 'plains'));
    const tank = w.spawnUnit('heavy_tank', P1, { x: 0, y: 0 });
    const cas = w.spawnUnit('cas', P1, { x: 0, y: 0 });
    const recon = w.spawnUnit('recon', P2, { x: 1, y: 0 });
    const inf = w.spawnUnit('infantry', P2, { x: 1, y: 0 });
    const r = plan(w, tank.id, { x: 1, y: 0 });
    expect(r.ok && r.value.defender?.id).toBe(inf.id);
    void recon;
    void cas;
  });
});

describe('forecast and resolution', () => {
  it('terrain, entrenchment and cities make defenders much harder to dislodge', () => {
    const w = new WorldState(Grid.fromAscii(['.....', '.f...']));
    const tank = w.spawnUnit('heavy_tank', P1, { x: 1, y: 0 });
    const open = w.spawnUnit('infantry', P2, { x: 2, y: 0 });
    const dug = w.spawnUnit('infantry', P2, { x: 1, y: 1 });
    for (let i = 0; i < 3; i++) dug.startTurn();
    const vsOpen = forecast(w, tank.id, open.position).damageToDefender;
    const vsDug = forecast(w, tank.id, dug.position).damageToDefender;
    expect(vsOpen).toBeGreaterThan(8); // nearly wiped out
    expect(vsDug).toBeLessThan(vsOpen * 0.75);
  });

  it('counter-fire hurts melee attackers, not artillery firing from range', () => {
    const w = new WorldState(Grid.filled(6, 1, 'plains'));
    const a = w.spawnUnit('infantry', P1, { x: 0, y: 0 });
    const art = w.spawnUnit('artillery', P1, { x: 0, y: 0 });
    w.spawnUnit('recon', P1, { x: 0, y: 0 }); // spotter: artillery can't see 2 tiles out
    const target = w.spawnUnit('infantry', P2, { x: 1, y: 0 });
    w.spawnUnit('infantry', P2, { x: 2, y: 0 });
    const melee = forecast(w, a.id, target.position);
    expect(melee.defenderCanCounter).toBe(true);
    expect(melee.damageToAttacker).toBeGreaterThan(0);
    const ranged = forecast(w, art.id, { x: 2, y: 0 });
    expect(ranged.defenderCanCounter).toBe(false);
    expect(ranged.damageToAttacker).toBe(0);
  });

  it('torpedoes wreck capital ships and firing surfaces the sub', () => {
    const w = new WorldState(Grid.filled(4, 1, 'deep_ocean'));
    const sub = w.spawnUnit('submarine', P1, { x: 0, y: 0 });
    sub.setSilentRunning(true);
    const bb = w.spawnUnit('battleship', P2, { x: 1, y: 0 });
    const p = plan(w, sub.id, bb.position);
    if (!p.ok) throw new Error(p.error.code);
    const f = forecastAttack(w, p.value);
    const dd = w.spawnUnit('destroyer', P1, { x: 0, y: 0 });
    expect(f.damageToDefender).toBeGreaterThan(2 * forecast(w, dd.id, bb.position).damageToDefender);
    expect(f.defenderCanCounter).toBe(false); // battleship guns can't hit subs
    w.removeUnit(dd.id);
    resolveAttack(w, p.value, new Rng(1));
    expect(sub.silentRunning).toBe(false);
    expect(sub.attackedThisTurn).toBe(true);
  });

  it('aircraft do not shoot back at ground fire, but fighters dogfight', () => {
    const w = new WorldState(Grid.filled(4, 1, 'plains'));
    const aa = w.spawnUnit('anti_air', P1, { x: 0, y: 0 });
    const ftr = w.spawnUnit('fighter', P1, { x: 0, y: 0 });
    w.spawnUnit('cas', P2, { x: 1, y: 0 });
    expect(forecast(w, aa.id, { x: 1, y: 0 }).defenderCanCounter).toBe(false);
    expect(forecast(w, ftr.id, { x: 1, y: 0 }).defenderCanCounter).toBe(true);
  });

  it('anti-air fire hits aircraft attacking inside its umbrella', () => {
    const w = new WorldState(Grid.filled(6, 1, 'plains'));
    const cas = w.spawnUnit('cas', P1, { x: 1, y: 0 });
    const tank = w.spawnUnit('heavy_tank', P2, { x: 2, y: 0 });
    w.spawnUnit('anti_air', P2, { x: 4, y: 0 });
    const p = plan(w, cas.id, tank.position);
    if (!p.ok) throw new Error(p.error.code);
    expect(forecastAttack(w, p.value).interceptionDamage).toBeGreaterThan(3);
    const r = resolveAttack(w, p.value, new Rng(7));
    expect(r.interceptionDamage).toBeGreaterThan(0);
  });

  it('strategic bombers cripple enemy cities even when empty', () => {
    const w = new WorldState(Grid.fromAscii(['..~']));
    const city = w.foundCity('Target', { x: 1, y: 0 });
    city.capture(P2);
    city.setProduction('destroyer');
    for (let i = 0; i < 6; i++) city.tickProduction();
    const bomber = w.spawnUnit('strategic_bomber', P1, { x: 0, y: 0 });
    const p = plan(w, bomber.id, city.position);
    if (!p.ok) throw new Error(p.error.code);
    expect(p.value.defender).toBeNull();
    const r = resolveAttack(w, p.value, new Rng(1));
    expect(r.cityBombed).toBe(city.id);
    expect(city.production?.progress).toBe(3);
    expect(city.isPortOperational).toBe(false);
  });

  it('a sunk transport takes its cargo down with it', () => {
    const w = new WorldState(Grid.filled(3, 1, 'deep_ocean'));
    const sub = w.spawnUnit('submarine', P1, { x: 0, y: 0 });
    const tr = w.spawnUnit('transport', P2, { x: 1, y: 0 });
    const inf = w.spawnUnit('infantry', P2, { x: 1, y: 0 });
    w.load(tr.id, inf.id);
    const p = plan(w, sub.id, tr.position);
    if (!p.ok) throw new Error(p.error.code);
    const r = resolveAttack(w, p.value, new Rng(3));
    expect(r.defenderDestroyed).toBe(true);
    expect(r.lost.sort()).toEqual([inf.id, tr.id].sort());
    expect(w.unit(inf.id)).toBeUndefined();
  });

  it('amphibious assaults hit softer than attacks from dry land', () => {
    const w = new WorldState(Grid.fromAscii(['~...']));
    const tr = w.spawnUnit('transport', P1, { x: 0, y: 0 });
    const boat = w.spawnUnit('infantry', P1, { x: 0, y: 0 });
    w.load(tr.id, boat.id);
    const shore = w.spawnUnit('infantry', P1, { x: 2, y: 0 });
    w.spawnUnit('infantry', P2, { x: 1, y: 0 });
    const fromBoat = forecast(w, boat.id, { x: 1, y: 0 }).damageToDefender;
    const fromLand = forecast(w, shore.id, { x: 1, y: 0 }).damageToDefender;
    // 25% less strength; damage follows strength^0.6.
    expect(fromBoat).toBeCloseTo(fromLand * 0.75 ** 0.6);
  });
});

describe('Match.attack', () => {
  function duel(seed: string) {
    const w = new WorldState(Grid.filled(10, 2, 'plains'));
    w.foundCity('A', { x: 0, y: 0 }).capture(P1);
    w.foundCity('B', { x: 9, y: 0 }).capture(P2);
    const a = w.spawnUnit('infantry', P1, { x: 4, y: 1 });
    const d = w.spawnUnit('infantry', P2, { x: 5, y: 1 });
    w.spawnUnit('infantry', P2, { x: 9, y: 1 });
    return { ...Match.start(w, [P1, P2], undefined, seed), a, d };
  }

  it('tells both sides, consumes the attack and rolls deterministically from the seed', () => {
    const one = duel('s1');
    const r = one.match.attack(P1, one.a.id, { x: 5, y: 1 });
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value.events.map((e) => e.audience).sort()).toEqual([P1, P2]);
    expect(one.match.attack(P1, one.a.id, { x: 5, y: 1 })).toMatchObject({ error: { code: 'ALREADY_ATTACKED' } });

    const two = duel('s1');
    const r2 = two.match.attack(P1, two.a.id, { x: 5, y: 1 });
    expect(r2.ok && r2.value.result.damageToDefender).toBe(r.value.result.damageToDefender);
  });

  it('resumes the dice sequence after a save', () => {
    const { match, a } = duel('s2');
    const copy = Match.fromSnapshot(JSON.parse(JSON.stringify(match.toSnapshot())));
    const r1 = match.attack(P1, a.id, { x: 5, y: 1 });
    const r2 = copy.attack(P1, a.id, { x: 5, y: 1 });
    expect(r1.ok && r2.ok && r1.value.result).toEqual(r2.ok && r2.value.result);
  });

  it('can eliminate a player through combat', () => {
    const w = new WorldState(Grid.filled(6, 1, 'plains'));
    w.foundCity('A', { x: 0, y: 0 }).capture(P1);
    const tank = w.spawnUnit('heavy_tank', P1, { x: 2, y: 0 });
    const last = w.spawnUnit('infantry', P2, { x: 3, y: 0 }); // P2's only hope: no cities
    last.takeDamage(8);
    const { match } = Match.start(w, [P1, P2]);
    const r = match.attack(P1, tank.id, { x: 3, y: 0 });
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value.result.defenderDestroyed).toBe(true);
    expect(r.value.events).toContainEqual({ type: 'player_eliminated', audience: 'all', player: P2 });
    expect(match.winner).toBe(P1);
  });
});
