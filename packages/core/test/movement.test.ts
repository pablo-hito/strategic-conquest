import { describe, expect, it } from 'vitest';
import {
  Grid,
  PlayerFogMap,
  PlayerId,
  WorldState,
  checkStep,
  findPath,
  fogKnowledge,
  moveUnit,
  reachableThisTurn,
  truthKnowledge,
  type MoveContext,
  type Unit,
} from '../src/index.js';

const P1 = PlayerId('p1');
const P2 = PlayerId('p2');

function ctxFor(world: WorldState, players = [P1, P2]): MoveContext {
  const fogs = new Map(players.map((p) => [p, new PlayerFogMap(p, world.grid.width, world.grid.height)]));
  for (const f of fogs.values()) f.update(world);
  return { world, fogs };
}

const coords = (s: { coord: { x: number; y: number } }[]) => s.map((x) => `${x.coord.x},${x.coord.y}`);
const reachSet = (w: WorldState, u: Unit) =>
  [...reachableThisTurn(truthKnowledge(w), u).values()].map((r) => `${r.coord.x},${r.coord.y}`).sort();

describe('checkStep', () => {
  const world = () =>
    new WorldState(
      Grid.fromAscii([
        '..M~~',
        '..f~~',
        '.....',
      ]),
    );

  it('applies terrain costs per movement class', () => {
    const w = world();
    const k = truthKnowledge(w);
    const inf = w.spawnUnit('infantry', P1, { x: 1, y: 1 });
    const tank = w.spawnUnit('heavy_tank', P1, { x: 1, y: 1 });
    const recon = w.spawnUnit('recon', P1, { x: 1, y: 1 });
    expect(checkStep(k, inf, inf.position, { x: 2, y: 1 })).toMatchObject({ ok: true, value: { cost: 1 } });
    expect(checkStep(k, tank, tank.position, { x: 2, y: 1 })).toMatchObject({ ok: true, value: { cost: 2 } });
    expect(checkStep(k, recon, recon.position, { x: 2, y: 1 })).toMatchObject({ ok: true, value: { cost: 3 } });
    expect(checkStep(k, inf, inf.position, { x: 2, y: 0 })).toMatchObject({ ok: true, value: { cost: 3 } });
    expect(checkStep(k, tank, tank.position, { x: 2, y: 0 })).toMatchObject({ error: { code: 'IMPASSABLE' } });
  });

  it('rejects non-adjacent, off-map, water for land units and enemy tiles', () => {
    const w = world();
    const k = truthKnowledge(w);
    const inf = w.spawnUnit('infantry', P1, { x: 2, y: 2 });
    w.spawnUnit('infantry', P2, { x: 1, y: 2 });
    expect(checkStep(k, inf, inf.position, { x: 4, y: 2 })).toMatchObject({ error: { code: 'NOT_ADJACENT' } });
    expect(checkStep(k, inf, inf.position, { x: 2, y: 3 })).toMatchObject({ error: { code: 'OUT_OF_BOUNDS' } });
    expect(checkStep(k, inf, inf.position, { x: 3, y: 1 })).toMatchObject({ error: { code: 'IMPASSABLE' } });
    expect(checkStep(k, inf, inf.position, { x: 1, y: 2 })).toMatchObject({ error: { code: 'ENEMY_PRESENT' } });
  });

  it('lets ships dock in own coastal cities only', () => {
    const w = world();
    const k = truthKnowledge(w);
    const port = w.foundCity('Port', { x: 2, y: 2 });
    const dd = w.spawnUnit('destroyer', P1, { x: 3, y: 1 });
    expect(checkStep(k, dd, dd.position, { x: 2, y: 2 })).toMatchObject({ error: { code: 'CITY_NOT_OWNED' } });
    port.capture(P1);
    expect(checkStep(k, dd, dd.position, { x: 2, y: 2 })).toMatchObject({ ok: true, value: { cost: 1 } });
    expect(checkStep(k, dd, dd.position, { x: 2, y: 1 })).toMatchObject({ error: { code: 'IMPASSABLE' } });
  });

  it('boards an own transport with room, not a full one', () => {
    const w = world();
    const k = truthKnowledge(w);
    const tr = w.spawnUnit('transport', P1, { x: 3, y: 1 });
    const inf = w.spawnUnit('infantry', P1, { x: 2, y: 2 });
    expect(checkStep(k, inf, inf.position, { x: 3, y: 1 })).toMatchObject({
      ok: true,
      value: { kind: 'board', carrierId: tr.id },
    });
    // 5 of 6 taken: still room for infantry (size 1), not for a tank (size 3).
    w.load(tr.id, w.spawnUnit('heavy_tank', P1, { x: 3, y: 1 }).id);
    w.load(tr.id, w.spawnUnit('recon', P1, { x: 3, y: 1 }).id);
    const tank = w.spawnUnit('heavy_tank', P1, { x: 2, y: 2 });
    expect(checkStep(k, inf, inf.position, { x: 3, y: 1 })).toMatchObject({ ok: true, value: { kind: 'board' } });
    expect(checkStep(k, tank, tank.position, { x: 3, y: 1 })).toMatchObject({ error: { code: 'NO_TRANSPORT_SPACE' } });
    w.load(tr.id, w.spawnUnit('infantry', P1, { x: 3, y: 1 }).id);
    expect(checkStep(k, inf, inf.position, { x: 3, y: 1 })).toMatchObject({ error: { code: 'NO_TRANSPORT_SPACE' } });
  });

  it('turns entering a foreign city into a capture, only for capture-capable units', () => {
    const w = world();
    w.foundCity('Neutral', { x: 0, y: 2 });
    const k = truthKnowledge(w);
    const inf = w.spawnUnit('infantry', P1, { x: 1, y: 2 });
    const recon = w.spawnUnit('recon', P1, { x: 1, y: 2 });
    expect(checkStep(k, inf, inf.position, { x: 0, y: 2 })).toMatchObject({ ok: true, value: { kind: 'capture' } });
    expect(checkStep(k, recon, recon.position, { x: 0, y: 2 })).toMatchObject({
      error: { code: 'CITY_NOT_OWNED' },
    });
  });
});

describe('reachableThisTurn', () => {
  it('respects MP and the minimum-move rule', () => {
    const w = new WorldState(Grid.fromAscii(['.M...', '.h...']));
    const inf = w.spawnUnit('infantry', P1, { x: 0, y: 0 });
    // Mountains cost 3 and infantry has 2 MP, but a fresh unit may always take one step.
    // Both tiles of the second column eat all its MP, so it gets no further.
    expect(reachSet(w, inf)).toEqual(['0,1', '1,0', '1,1']);

    const tank = w.spawnUnit('heavy_tank', P1, { x: 0, y: 1 });
    // 3 MP, mountains impassable: the hill (2) leaves 1 MP for one more plain.
    expect(reachSet(w, tank)).toEqual(['0,0', '1,1', '2,0', '2,1']);
  });

  it('is empty after the unit spent its moves and halves with silent running', () => {
    const w = new WorldState(Grid.filled(8, 1, 'deep_ocean'));
    const sub = w.spawnUnit('submarine', P1, { x: 0, y: 0 }); // 5 MP
    expect(reachSet(w, sub)).toEqual(['1,0', '2,0', '3,0', '4,0', '5,0']);
    sub.setSilentRunning(true); // 2 MP
    expect(reachSet(w, sub)).toEqual(['1,0', '2,0']);
    w.stepUnit(sub.id, { x: 1, y: 0 }, 1);
    w.stepUnit(sub.id, { x: 2, y: 0 }, 1);
    expect(reachSet(w, sub)).toEqual([]);
  });

  it('caps aircraft by remaining fuel', () => {
    const w = new WorldState(Grid.filled(30, 1, 'plains'));
    const f = w.spawnUnit('fighter', P1, { x: 0, y: 0 }); // 12 MP, 24 fuel
    for (let x = 1; x <= 12; x++) w.stepUnit(f.id, { x, y: 0 }, 1);
    f.startTurn();
    for (let x = 13; x <= 21; x++) w.stepUnit(f.id, { x, y: 0 }, 1);
    // 3 fuel left, 3 MP left
    expect(f.fuel).toBe(3);
    expect(reachSet(w, f)).toEqual(['18,0', '19,0', '20,0', '22,0', '23,0', '24,0'].sort());
  });
});

describe('findPath', () => {
  it('routes around mountains for vehicles and counts turns', () => {
    const w = new WorldState(
      Grid.fromAscii([
        '.M...',
        '.M...',
        '.....',
      ]),
    );
    const tank = w.spawnUnit('heavy_tank', P1, { x: 0, y: 0 });
    const path = findPath(truthKnowledge(w), tank, { x: 2, y: 0 })!;
    expect(coords(path.steps)).toEqual(['0,1', '1,2', '2,1', '2,0']);
    expect(path.steps.map((s) => s.turn)).toEqual([0, 0, 0, 1]); // 3 MP per turn
    expect(path.turns).toBe(2);
  });

  it('prefers fewer turns over fewer MP when the minimum-move rule makes hills cheap', () => {
    const w = new WorldState(Grid.fromAscii(['.MMM.']));
    const inf = w.spawnUnit('infantry', P1, { x: 0, y: 0 });
    const path = findPath(truthKnowledge(w), inf, { x: 4, y: 0 })!;
    expect(path.turns).toBe(4); // one mountain per turn (cost 3 > 2 MP), not two turns each
  });

  it('starts the count on the next turn when no MP are left', () => {
    const w = new WorldState(Grid.filled(8, 1, 'plains'));
    const inf = w.spawnUnit('infantry', P1, { x: 0, y: 0 });
    w.stepUnit(inf.id, { x: 1, y: 0 }, 1);
    w.stepUnit(inf.id, { x: 2, y: 0 }, 1);
    const path = findPath(truthKnowledge(w), inf, { x: 5, y: 0 })!;
    expect(path.steps.map((s) => s.turn)).toEqual([1, 1, 2]);
  });

  it('gives up on routes longer than maxTurns', () => {
    const w = new WorldState(Grid.filled(14, 1, 'plains'));
    const inf = w.spawnUnit('infantry', P1, { x: 0, y: 0 }); // 2 tiles per turn
    const k = truthKnowledge(w);
    expect(findPath(k, inf, { x: 10, y: 0 }, { maxTurns: 5 })?.turns).toBe(5);
    expect(findPath(k, inf, { x: 11, y: 0 }, { maxTurns: 5 })).toBeNull();
  });

  it('returns null when unreachable and plans a boarding as the last step', () => {
    const w = new WorldState(Grid.fromAscii(['..~~..']));
    const inf = w.spawnUnit('infantry', P1, { x: 0, y: 0 });
    expect(findPath(truthKnowledge(w), inf, { x: 5, y: 0 })).toBeNull();
    w.spawnUnit('transport', P1, { x: 2, y: 0 });
    const path = findPath(truthKnowledge(w), inf, { x: 2, y: 0 })!;
    expect(path.steps.at(-1)?.kind).toBe('board');
    // Boarding ends the move, so it can't be used as a bridge.
    expect(findPath(truthKnowledge(w), inf, { x: 5, y: 0 })).toBeNull();
  });

  it('plans through unexplored tiles and ignores enemies the player cannot see', () => {
    const w = new WorldState(Grid.filled(12, 1, 'plains'));
    const inf = w.spawnUnit('infantry', P1, { x: 0, y: 0 });
    w.spawnUnit('infantry', P2, { x: 6, y: 0 });
    const fog = new PlayerFogMap(P1, 12, 1);
    fog.update(w);
    expect(findPath(fogKnowledge(w, fog), inf, { x: 11, y: 0 })?.steps).toHaveLength(11);
    expect(findPath(truthKnowledge(w), inf, { x: 11, y: 0 })).toBeNull(); // 1-tall map: enemy blocks
  });
});

describe('moveUnit', () => {
  it('moves along a valid path and reports fog deltas', () => {
    const w = new WorldState(Grid.filled(10, 1, 'plains'));
    const recon = w.spawnUnit('recon', P1, { x: 0, y: 0 });
    const ctx = ctxFor(w);
    const r = moveUnit(ctx, P1, recon.id, [{ x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }]);
    expect(r).toMatchObject({ ok: true, value: { stepsTaken: 3, stoppedBy: 'COMPLETED', position: { x: 3, y: 0 } } });
    if (!r.ok) return;
    expect(r.value.fogUpdates.get(P1)?.revealed.sort((a, b) => a - b)).toEqual([4, 5, 6]);
    expect(r.value.fogUpdates.has(P2)).toBe(false); // P2 saw nothing change
    expect(recon.movesLeft).toBe(2); // 5 MP, 3 spent
  });

  it('validates ownership, emptiness and the first step', () => {
    const w = new WorldState(Grid.filled(5, 1, 'plains'));
    const inf = w.spawnUnit('infantry', P1, { x: 0, y: 0 });
    const ctx = ctxFor(w);
    expect(moveUnit(ctx, P2, inf.id, [{ x: 1, y: 0 }])).toMatchObject({ error: { code: 'NOT_YOUR_UNIT' } });
    expect(moveUnit(ctx, P1, inf.id, [])).toMatchObject({ error: { code: 'EMPTY_PATH' } });
    expect(moveUnit(ctx, P1, inf.id, [{ x: 3, y: 0 }])).toMatchObject({ error: { code: 'NOT_ADJACENT' } });
    expect(inf.position).toEqual({ x: 0, y: 0 });
  });

  it('stops on contact when an enemy comes into view', () => {
    const w = new WorldState(Grid.filled(12, 1, 'plains'));
    const recon = w.spawnUnit('recon', P1, { x: 0, y: 0 });
    const enemy = w.spawnUnit('infantry', P2, { x: 5, y: 0 });
    const ctx = ctxFor(w);
    const r = moveUnit(ctx, P1, recon.id, [{ x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }]);
    expect(r).toMatchObject({ ok: true, value: { stepsTaken: 2, stoppedBy: 'CONTACT' } });
    if (!r.ok) return;
    expect(r.value.fogUpdates.get(P1)?.unitsSpotted).toContain(enemy.id);
    // Vision is not symmetric in range: the infantry (vision 2) has not seen the recon.
    expect(r.value.fogUpdates.has(P2)).toBe(false);
    expect(recon.movesLeft).toBe(3); // can still act
  });

  it('stops when a hidden unit blocks the way', () => {
    const w = new WorldState(Grid.filled(6, 1, 'deep_ocean'));
    const tr = w.spawnUnit('transport', P1, { x: 0, y: 0 });
    const sub = w.spawnUnit('submarine', P2, { x: 2, y: 0 });
    sub.setSilentRunning(true);
    const ctx = ctxFor(w);
    expect(ctx.fogs.get(P1)!.detectedUnits.has(sub.id)).toBe(false);
    const r = moveUnit(ctx, P1, tr.id, [{ x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }]);
    // Adjacency reveals the sub after step 1, so this is contact, not a blind bump.
    expect(r).toMatchObject({ ok: true, value: { stepsTaken: 1, stoppedBy: 'CONTACT' } });
  });

  it('boards a transport, rides along and disembarks', () => {
    const w = new WorldState(Grid.fromAscii(['.~~~.']));
    const inf = w.spawnUnit('infantry', P1, { x: 0, y: 0 });
    const tr = w.spawnUnit('transport', P1, { x: 1, y: 0 });
    const ctx = ctxFor(w);

    expect(moveUnit(ctx, P1, inf.id, [{ x: 1, y: 0 }])).toMatchObject({ value: { stoppedBy: 'BOARDED' } });
    expect(inf.carriedBy).toBe(tr.id);

    moveUnit(ctx, P1, tr.id, [{ x: 2, y: 0 }, { x: 3, y: 0 }]);
    expect(inf.position).toEqual({ x: 3, y: 0 });

    inf.startTurn();
    expect(moveUnit(ctx, P1, inf.id, [{ x: 4, y: 0 }])).toMatchObject({ value: { stoppedBy: 'COMPLETED' } });
    expect(inf.carriedBy).toBeNull();
    expect(tr.cargo).toEqual([]);
    expect(w.unitsAt({ x: 4, y: 0 }).map((u) => u.id)).toEqual([inf.id]);
  });

  it('crashes aircraft that run dry away from a base, refuels them over own cities', () => {
    const w = new WorldState(Grid.filled(40, 1, 'plains'));
    const city = w.foundCity('Base', { x: 18, y: 0 });
    city.capture(P1);
    const ctx = ctxFor(w);
    const f = w.spawnUnit('fighter', P1, { x: 0, y: 0 }); // 12 MP, 24 fuel
    const leg = (from: number, to: number) =>
      Array.from({ length: to - from }, (_, i) => ({ x: from + i + 1, y: 0 }));

    moveUnit(ctx, P1, f.id, leg(0, 12));
    f.startTurn();
    moveUnit(ctx, P1, f.id, leg(12, 18)); // lands at the city on fuel 6 -> refueled
    expect(f.fuel).toBe(24);

    const open = new WorldState(Grid.filled(40, 1, 'plains'));
    const octx = ctxFor(open);
    const doomed = open.spawnUnit('fighter', P1, { x: 0, y: 0 });
    moveUnit(octx, P1, doomed.id, leg(0, 12));
    doomed.startTurn();
    const r = moveUnit(octx, P1, doomed.id, leg(12, 24));
    expect(r).toMatchObject({ value: { stoppedBy: 'CRASHED', stepsTaken: 12 } });
    expect(open.unit(doomed.id)).toBeUndefined();
  });

  it('stops with NO_MOVES_LEFT when the path is longer than this turn allows', () => {
    const w = new WorldState(Grid.filled(6, 1, 'plains'));
    const tank = w.spawnUnit('heavy_tank', P1, { x: 0, y: 0 });
    const r = moveUnit(ctxFor(w), P1, tank.id, [1, 2, 3, 4, 5].map((x) => ({ x, y: 0 })));
    expect(r).toMatchObject({ value: { stepsTaken: 3, stoppedBy: 'NO_MOVES_LEFT' } });
  });
});
