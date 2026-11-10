import { describe, expect, it } from 'vitest';
import { GameSession } from '../src/session.js';

describe('siege indicator', () => {
  it('marks an own city ringed by visible enemies, and lifts it when a defender steps out', () => {
    const s = GameSession.create({ size: 'small', density: 'normal', players: 2, seed: 'siege-ui', mode: 'bots', difficulty: 'normal' });
    const me = s.viewer;
    const enemy = s.players[1]!;
    const city = s.world.citiesOf(me)[0]!;
    const around = s.world.grid.neighbors(city.position).filter((c) => s.world.grid.isLand(c));
    const ring = s.world.grid.neighbors(city.position).length;
    // Enough enemy units (land on land tiles, ships on water) on half the tiles around.
    const tiles = s.world.grid.neighbors(city.position).slice(0, Math.ceil(ring / 2));
    for (const t of tiles) s.world.spawnUnit(s.world.grid.isLand(t) ? 'infantry' : 'destroyer', enemy, t);
    for (const u of s.world.unitsOf(me)) if (u.position.x !== city.position.x || u.position.y !== city.position.y) s.world.removeUnit(u.id);
    s.match.fogs.get(me)!.update(s.world, new Set([me]));
    s.invalidate();
    const i = s.world.grid.index(city.position);
    expect(s.besiegedTiles().has(i)).toBe(true);

    const free = around.find((c) => !tiles.some((t) => t.x === c.x && t.y === c.y));
    if (!free) return; // every land tile is taken: nothing to step out to
    s.world.spawnUnit('infantry', me, free);
    s.match.fogs.get(me)!.update(s.world, new Set([me]));
    s.invalidate();
    expect(s.besiegedTiles().has(i)).toBe(false);
  });
});
