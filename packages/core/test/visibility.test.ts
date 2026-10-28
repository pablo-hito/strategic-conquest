import { describe, expect, it } from 'vitest';
import {
  Grid,
  PlayerFogMap,
  PlayerId,
  TileVisibility,
  UNKNOWN_TERRAIN,
  WorldState,
  buildPlayerView,
  computeVisibility,
  hasLineOfSight,
} from '../src/index.js';

const P1 = PlayerId('p1');
const P2 = PlayerId('p2');
const only = (p: PlayerId) => new Set([p]);

describe('line of sight', () => {
  const g = Grid.fromAscii([
    '.......',
    '...f...',
    '.......',
    'h..f..M',
  ]);
  const GROUND = 0.5;

  it('adjacent tiles are always visible', () => {
    expect(hasLineOfSight(g, { x: 2, y: 1 }, GROUND, { x: 3, y: 1 })).toBe(true);
  });

  it('a forest blocks ground sight behind it but is itself visible', () => {
    expect(hasLineOfSight(g, { x: 1, y: 1 }, GROUND, { x: 5, y: 1 })).toBe(false);
    expect(hasLineOfSight(g, { x: 1, y: 1 }, GROUND, { x: 3, y: 1 })).toBe(true);
  });

  it('open ground does not block', () => {
    expect(hasLineOfSight(g, { x: 0, y: 0 }, GROUND, { x: 6, y: 0 })).toBe(true);
  });

  it('aircraft see over forests', () => {
    expect(hasLineOfSight(g, { x: 1, y: 1 }, 6, { x: 5, y: 1 })).toBe(true);
  });

  it('a mountain top is visible over a forest; LOS is symmetric', () => {
    expect(hasLineOfSight(g, { x: 1, y: 3 }, GROUND, { x: 6, y: 3 })).toBe(true);
    for (const [a, b] of [
      [{ x: 0, y: 0 }, { x: 5, y: 3 }],
      [{ x: 0, y: 3 }, { x: 6, y: 1 }],
      [{ x: 1, y: 1 }, { x: 5, y: 2 }],
    ] as const) {
      expect(hasLineOfSight(g, a, GROUND, b)).toBe(hasLineOfSight(g, b, GROUND, a));
    }
  });

  it('elevation lets an observer look over a forest', () => {
    const hill = Grid.fromAscii(['M.f..']);
    const plain = Grid.fromAscii(['..f..']);
    expect(hasLineOfSight(hill, { x: 0, y: 0 }, GROUND, { x: 4, y: 0 })).toBe(true);
    expect(hasLineOfSight(plain, { x: 0, y: 0 }, GROUND, { x: 4, y: 0 })).toBe(false);
  });
});

describe('vision and detection', () => {
  it('hills extend land vision range', () => {
    const w = new WorldState(Grid.fromAscii(['h.....', '......']));
    w.spawnUnit('infantry', P1, { x: 0, y: 0 }); // vision 1 + hills 1
    const vis = computeVisibility(w, only(P1));
    expect(vis.tiles[w.grid.index({ x: 2, y: 0 })]).toBeTruthy();
    expect(vis.tiles[w.grid.index({ x: 3, y: 0 })]).toBeFalsy();
  });

  it('owned cities provide vision; neutral ones do not', () => {
    const w = new WorldState(Grid.filled(9, 1, 'plains'));
    w.foundCity('Mine', { x: 0, y: 0 }).capture(P1);
    w.foundCity('Neutral', { x: 8, y: 0 });
    const vis = computeVisibility(w, only(P1));
    expect(vis.tiles[2]).toBeTruthy();
    expect(vis.tiles[3]).toBeFalsy();
    expect(vis.tiles[7]).toBeFalsy();
  });

  it('a submarine on silent running is only found by adjacency or sonar', () => {
    const w = new WorldState(Grid.filled(10, 1, 'deep_ocean'));
    const sub = w.spawnUnit('submarine', P2, { x: 5, y: 0 });
    sub.setSilentRunning(true);
    const corvette = w.spawnUnit('corvette', P1, { x: 3, y: 0 }); // vision 2 -> tile visible

    expect(computeVisibility(w, only(P1)).tiles[5]).toBeTruthy();
    expect(computeVisibility(w, only(P1)).units.has(sub.id)).toBe(false);

    w.stepUnit(corvette.id, { x: 4, y: 0 }, 1); // adjacent
    expect(computeVisibility(w, only(P1)).units.has(sub.id)).toBe(true);

    w.removeUnit(corvette.id);
    w.spawnUnit('destroyer', P1, { x: 3, y: 0 }); // sonar range 2
    expect(computeVisibility(w, only(P1)).units.has(sub.id)).toBe(true);

    sub.setSilentRunning(false);
    w.spawnUnit('corvette', P1, { x: 0, y: 0 });
    expect(computeVisibility(w, only(P1)).units.has(sub.id)).toBe(true);
  });

  it('forest hides ground units from non-adjacent aircraft only', () => {
    const w = new WorldState(Grid.fromAscii(['......f']));
    const hidden = w.spawnUnit('infantry', P2, { x: 6, y: 0 });
    const drone = w.spawnUnit('recon_drone', P1, { x: 3, y: 0 });
    expect(computeVisibility(w, only(P1)).tiles[6]).toBeTruthy();
    expect(computeVisibility(w, only(P1)).units.has(hidden.id)).toBe(false);

    w.stepUnit(drone.id, { x: 5, y: 0 }, 1);
    expect(computeVisibility(w, only(P1)).units.has(hidden.id)).toBe(true);

    w.removeUnit(drone.id);
    w.spawnUnit('recon', P1, { x: 4, y: 0 }); // ground, vision 3
    expect(computeVisibility(w, only(P1)).units.has(hidden.id)).toBe(true);
  });

  it('cargo is invisible to the enemy and does not see', () => {
    const w = new WorldState(Grid.filled(12, 1, 'deep_ocean'));
    const tr = w.spawnUnit('transport', P2, { x: 3, y: 0 });
    const inf = w.spawnUnit('infantry', P2, { x: 3, y: 0 });
    w.load(tr.id, inf.id);
    const recon = w.spawnUnit('recon', P2, { x: 3, y: 0 });
    w.load(tr.id, recon.id);
    w.spawnUnit('corvette', P1, { x: 1, y: 0 });

    const p1 = computeVisibility(w, only(P1));
    expect(p1.units.has(tr.id)).toBe(true);
    expect(p1.units.has(inf.id)).toBe(false);

    const p2 = computeVisibility(w, only(P2));
    expect(p2.units.has(inf.id)).toBe(true); // you always know your own
    expect(p2.tiles[w.grid.index({ x: 6, y: 0 })]).toBeFalsy(); // recon aboard sees nothing
  });

  it('allies share vision', () => {
    const P3 = PlayerId('p3');
    const w = new WorldState(Grid.filled(10, 1, 'plains'));
    w.spawnUnit('recon', P1, { x: 0, y: 0 });
    w.spawnUnit('recon', P3, { x: 9, y: 0 });
    const enemy = w.spawnUnit('infantry', P2, { x: 8, y: 0 });
    expect(computeVisibility(w, only(P1)).units.has(enemy.id)).toBe(false);
    expect(computeVisibility(w, new Set([P1, P3])).units.has(enemy.id)).toBe(true);
  });
});

describe('PlayerFogMap', () => {
  it('goes unexplored -> visible -> fogged and reports deltas', () => {
    const w = new WorldState(Grid.filled(12, 1, 'plains'));
    const recon = w.spawnUnit('recon', P1, { x: 0, y: 0 });
    const fog = new PlayerFogMap(P1, 12, 1);

    const first = fog.update(w);
    expect(first.revealed).toEqual([0, 1, 2, 3]);
    expect(fog.visibilityAt(4)).toBe(TileVisibility.Unexplored);

    for (let x = 1; x <= 3; x++) w.stepUnit(recon.id, { x, y: 0 }, 1);
    const second = fog.update(w);
    expect(second.revealed).toEqual([4, 5, 6]);
    expect(second.hidden).toEqual([]);

    w.turn = 2;
    recon.startTurn();
    for (let x = 4; x <= 6; x++) w.stepUnit(recon.id, { x, y: 0 }, 1);
    const third = fog.update(w);
    expect(third.hidden).toEqual([0, 1, 2]);
    expect(fog.visibilityAt(0)).toBe(TileVisibility.Fogged);
    expect(fog.lastSeenTurn[0]).toBe(1);
    expect(fog.lastSeenTurn[9]).toBe(2);
  });

  it('remembers city owners as last seen, not as they are now', () => {
    const w = new WorldState(Grid.filled(10, 1, 'plains'));
    const city = w.foundCity('Bravo', { x: 2, y: 0 });
    const recon = w.spawnUnit('recon', P1, { x: 0, y: 0 });
    const fog = new PlayerFogMap(P1, 10, 1);

    expect(fog.update(w).citiesUpdated).toEqual([city.id]);
    expect(fog.knownCities.get(city.id)?.owner).toBeNull();

    w.removeUnit(recon.id);
    fog.update(w);
    w.captureCity(city.id, P2); // happens in the fog
    fog.update(w);
    expect(fog.knownCities.get(city.id)?.owner).toBeNull();

    w.spawnUnit('recon', P1, { x: 0, y: 0 });
    expect(fog.update(w).citiesUpdated).toEqual([city.id]);
    expect(fog.knownCities.get(city.id)?.owner).toBe(P2);
  });

  it('keeps ghosts of enemies that left sight and clears them when proven gone', () => {
    const w = new WorldState(Grid.filled(12, 1, 'plains'));
    w.spawnUnit('recon', P1, { x: 0, y: 0 });
    const enemy = w.spawnUnit('recon', P2, { x: 3, y: 0 });
    const fog = new PlayerFogMap(P1, 12, 1);

    expect(fog.update(w).unitsSpotted).toContain(enemy.id);

    for (let x = 4; x <= 6; x++) w.stepUnit(enemy.id, { x, y: 0 }, 1);
    const upd = fog.update(w);
    expect(upd.unitsLost).toEqual([enemy.id]);
    // Last seen at x=3, which is still in sight and empty -> ghost cleared.
    expect(fog.sightings.has(enemy.id)).toBe(false);

    // Spot it again at the edge, then lose it with its last tile out of sight.
    const scout = w.spawnUnit('recon', P1, { x: 4, y: 0 });
    fog.update(w);
    w.removeUnit(scout.id);
    fog.update(w);
    expect(fog.sightings.get(enemy.id)?.position).toEqual({ x: 6, y: 0 });
  });

  it('round-trips through a snapshot', () => {
    const w = new WorldState(Grid.filled(6, 1, 'plains'));
    w.foundCity('C', { x: 1, y: 0 });
    w.spawnUnit('recon', P1, { x: 0, y: 0 });
    const fog = new PlayerFogMap(P1, 6, 1);
    fog.update(w);
    const copy = PlayerFogMap.fromSnapshot(JSON.parse(JSON.stringify(fog.toSnapshot())));
    expect(copy.toSnapshot()).toEqual(fog.toSnapshot());
  });
});

describe('buildPlayerView (anti-cheat projection)', () => {
  it('leaks nothing outside the fog and hides enemy internals', () => {
    const w = new WorldState(Grid.filled(14, 1, 'deep_ocean'));
    w.spawnUnit('destroyer', P1, { x: 0, y: 0 });
    const tr = w.spawnUnit('transport', P2, { x: 2, y: 0 });
    w.load(tr.id, w.spawnUnit('infantry', P2, { x: 2, y: 0 }).id);
    const farAway = w.spawnUnit('battleship', P2, { x: 13, y: 0 });

    const fog = new PlayerFogMap(P1, 14, 1);
    fog.update(w);
    const view = buildPlayerView(w, fog);

    expect(view.terrain[13]).toBe(UNKNOWN_TERRAIN);
    expect(view.terrain[0]).not.toBe(UNKNOWN_TERRAIN);
    expect(view.foreignUnits.map((u) => u.id)).toEqual([tr.id]);
    expect(view.foreignUnits[0]).not.toHaveProperty('cargo');
    expect(view.foreignUnits.some((u) => u.id === farAway.id)).toBe(false);
    expect(view.ownUnits).toHaveLength(1);
  });
});
