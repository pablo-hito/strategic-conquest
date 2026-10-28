import { describe, expect, it } from 'vitest';
import { City, CityId, Grid, PlayerId, Unit, UnitId, WorldState } from '../src/index.js';

const P1 = PlayerId('p1');
const P2 = PlayerId('p2');

describe('Unit', () => {
  it('lets a fresh unit take one expensive step, then stops it', () => {
    const inf = Unit.create(UnitId('u1'), 'infantry', P1, { x: 0, y: 0 });
    expect(inf.canAfford(2)).toBe(true); // hills cost 2, infantry has 1 MP
    expect(inf.stepTo({ x: 1, y: 0 }, 2).ok).toBe(true);
    expect(inf.movesLeft).toBe(0);
    expect(inf.stepTo({ x: 2, y: 0 }, 1)).toMatchObject({ ok: false, error: { code: 'NO_MOVES_LEFT' } });
    expect(inf.canAfford(Infinity)).toBe(false);
  });

  it('entrenches while idle, up to the cap, and loses it on moving', () => {
    const inf = Unit.create(UnitId('u1'), 'infantry', P1, { x: 0, y: 0 });
    for (let i = 0; i < 5; i++) inf.startTurn();
    expect(inf.entrenchment).toBe(3);
    expect(inf.defenseModifier).toBeCloseTo(1.6);
    inf.stepTo({ x: 1, y: 0 }, 1);
    expect(inf.entrenchment).toBe(0);
    inf.startTurn();
    expect(inf.entrenchment).toBe(0); // moved last turn
  });

  it('burns fuel per tile flown', () => {
    const f = Unit.create(UnitId('u1'), 'fighter', P1, { x: 0, y: 0 });
    for (let i = 1; i <= 10; i++) f.stepTo({ x: i, y: 0 }, 1);
    expect(f.fuel).toBe(10);
    f.startTurn();
    for (let i = 11; i <= 20; i++) f.stepTo({ x: i, y: 0 }, 1);
    expect(f.isOutOfFuel).toBe(true);
    f.refuel();
    expect(f.fuel).toBe(20);
  });

  it('halves moves on silent running and only for stealth hulls', () => {
    const sub = Unit.create(UnitId('u1'), 'submarine', P1, { x: 0, y: 0 });
    expect(sub.setSilentRunning(true).ok).toBe(true);
    expect(sub.maxMoves).toBe(1);
    expect(sub.movesLeft).toBe(1);
    expect(sub.isStealthed).toBe(true);
    const dd = Unit.create(UnitId('u2'), 'destroyer', P1, { x: 0, y: 0 });
    expect(dd.setSilentRunning(true).ok).toBe(false);
  });

  it('applies the out-of-supply penalty after the grace period', () => {
    const tank = Unit.create(UnitId('u1'), 'heavy_tank', P1, { x: 0, y: 0 });
    for (let i = 0; i < 3; i++) tank.setSupplied(false);
    expect(tank.isOutOfSupply).toBe(false);
    tank.setSupplied(false);
    expect(tank.defenseModifier).toBeCloseTo(0.75);
    tank.setSupplied(true);
    expect(tank.isOutOfSupply).toBe(false);
  });
});

describe('City', () => {
  const coastal = () => {
    const c = City.create(CityId('c1'), 'Port', { x: 0, y: 0 }, true);
    c.capture(P1);
    return c;
  };

  it('starts producing infantry when captured and completes on schedule', () => {
    const c = coastal();
    expect(c.production).toEqual({ unit: 'infantry', progress: 0 });
    const done = [1, 2, 3, 4].map(() => c.tickProduction());
    expect(done).toEqual([null, null, null, 'infantry']);
    expect(c.production?.progress).toBe(0); // repeats
  });

  it('does not produce while neutral', () => {
    const c = City.create(CityId('c1'), 'X', { x: 0, y: 0 }, false);
    expect(c.setProduction('infantry')).toMatchObject({ ok: false, error: { code: 'NEUTRAL_CITY' } });
    expect(c.tickProduction()).toBeNull();
  });

  it('requires coast for ships and a naval yard for capital ships', () => {
    const inland = City.create(CityId('c2'), 'In', { x: 0, y: 0 }, false);
    inland.capture(P1);
    expect(inland.setProduction('destroyer')).toMatchObject({ ok: false, error: { code: 'REQUIRES_COAST' } });
    expect(inland.setSpecialization('naval_yard')).toMatchObject({ ok: false, error: { code: 'REQUIRES_COAST' } });

    const port = coastal();
    expect(port.setProduction('battleship')).toMatchObject({ error: { code: 'REQUIRES_SPECIALIZATION' } });
    expect(port.setSpecialization('naval_yard').ok).toBe(true);
    expect(port.setProduction('battleship').ok).toBe(true);
    expect(port.setSpecialization('air_base')).toMatchObject({ error: { code: 'ALREADY_SPECIALIZED' } });
  });

  it('builds armor faster in an industrial hub', () => {
    const c = coastal();
    expect(c.buildTurnsFor('heavy_tank')).toBe(8);
    c.setSpecialization('industrial_hub');
    expect(c.buildTurnsFor('heavy_tank')).toBe(6);
    expect(c.buildTurnsFor('infantry')).toBe(4);
  });

  it('keeps progress when re-selecting the same unit, loses it when switching', () => {
    const c = coastal();
    c.tickProduction();
    c.tickProduction();
    c.setProduction('infantry');
    expect(c.production?.progress).toBe(2);
    c.setProduction('recon');
    expect(c.production?.progress).toBe(0);
  });

  it('strategic bombing halves progress and closes the port for two turns', () => {
    const c = coastal();
    c.setProduction('destroyer');
    for (let i = 0; i < 7; i++) c.tickProduction();
    c.applyStrategicBombing();
    expect(c.production?.progress).toBe(3);
    expect(c.isPortOperational).toBe(false);
    c.tickProduction();
    c.tickProduction();
    expect(c.production?.progress).toBe(3); // stalled
    expect(c.isPortOperational).toBe(true);
    c.tickProduction();
    expect(c.production?.progress).toBe(4);
  });

  it('capture resets production but keeps the specialization', () => {
    const c = coastal();
    c.setSpecialization('naval_yard');
    c.setProduction('carrier');
    c.tickProduction();
    c.capture(P2);
    expect(c.owner).toBe(P2);
    expect(c.specialization).toBe('naval_yard');
    expect(c.production).toEqual({ unit: 'infantry', progress: 0 });
  });
});

describe('WorldState', () => {
  const grid = Grid.fromAscii([
    '.....',
    '..~~~',
    '..~~~',
  ]);

  it('moves cargo with its transport and drowns it when the transport sinks', () => {
    const w = new WorldState(grid);
    const tr = w.spawnUnit('transport', P1, { x: 2, y: 1 });
    const inf = w.spawnUnit('infantry', P1, { x: 1, y: 1 });
    expect(w.load(tr.id, inf.id).ok).toBe(true);
    expect(inf.position).toEqual({ x: 2, y: 1 });

    w.stepUnit(tr.id, { x: 3, y: 1 }, 1);
    expect(inf.position).toEqual({ x: 3, y: 1 });
    expect(w.unitsAt({ x: 3, y: 1 }).map((u) => u.id).sort()).toEqual([inf.id, tr.id].sort());
    expect(inf.movesLeft).toBe(1); // riding is free

    expect(w.removeUnit(tr.id).sort()).toEqual([inf.id, tr.id].sort());
    expect(w.unitsAt({ x: 3, y: 1 })).toEqual([]);
  });

  it('enforces cargo rules', () => {
    const w = new WorldState(grid);
    const tr = w.spawnUnit('transport', P1, { x: 2, y: 1 });
    const fighter = w.spawnUnit('fighter', P1, { x: 2, y: 1 });
    expect(w.load(tr.id, fighter.id)).toMatchObject({ error: { code: 'CARGO_NOT_ACCEPTED' } });
    for (let i = 0; i < 3; i++) w.load(tr.id, w.spawnUnit('infantry', P1, { x: 2, y: 1 }).id);
    const extra = w.spawnUnit('infantry', P1, { x: 2, y: 1 });
    expect(w.load(tr.id, extra.id)).toMatchObject({ error: { code: 'CARGO_FULL' } });
  });

  it('round-trips through a snapshot with indexes rebuilt', () => {
    const w = new WorldState(grid);
    w.foundCity('Alpha', { x: 0, y: 0 }).capture(P1);
    const tr = w.spawnUnit('transport', P1, { x: 2, y: 1 });
    w.load(tr.id, w.spawnUnit('infantry', P1, { x: 2, y: 1 }).id);
    w.turn = 7;

    const copy = WorldState.fromSnapshot(JSON.parse(JSON.stringify(w.toSnapshot())));
    expect(copy.toSnapshot()).toEqual(w.toSnapshot());
    expect(copy.cityAt({ x: 0, y: 0 })?.owner).toBe(P1);
    expect(copy.unitsAt({ x: 2, y: 1 })).toHaveLength(2);
    // id sequence continues instead of colliding
    expect(copy.spawnUnit('recon', P1, { x: 0, y: 0 }).id).not.toBe(tr.id);
  });

  it('marks coastal cities at founding', () => {
    const w = new WorldState(grid);
    expect(w.foundCity('Inland', { x: 0, y: 2 }).isCoastal).toBe(false);
    expect(w.foundCity('Harbor', { x: 1, y: 1 }).isCoastal).toBe(true);
    expect(() => w.foundCity('Atlantis', { x: 3, y: 2 })).toThrow(/land/);
  });
});
