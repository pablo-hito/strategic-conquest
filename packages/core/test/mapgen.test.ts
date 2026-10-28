import { describe, expect, it } from 'vitest';
import { LAND_RATIO, MAP_SIZES, Match, PlayerId, Rng, generateMap, type MapSettings } from '../src/index.js';

const players = (n: number) => Array.from({ length: n }, (_, i) => PlayerId(`p${i + 1}`));

describe('Rng', () => {
  it('is deterministic per seed and stays in range', () => {
    const a = new Rng('x');
    const b = new Rng('x');
    const c = new Rng('y');
    const seqA = Array.from({ length: 5 }, () => a.next());
    expect(Array.from({ length: 5 }, () => b.next())).toEqual(seqA);
    expect(Array.from({ length: 5 }, () => c.next())).not.toEqual(seqA);
    for (let i = 0; i < 1000; i++) {
      const v = a.int(2, 4);
      expect(v).toBeGreaterThanOrEqual(2);
      expect(v).toBeLessThanOrEqual(4);
    }
  });
});

describe('generateMap', () => {
  const settings: MapSettings = { size: 'small', density: 'normal', seed: 'test-seed' };

  it('is fully reproducible from the seed', () => {
    const a = generateMap(settings, players(2));
    const b = generateMap(settings, players(2));
    expect(a.world.toSnapshot()).toEqual(b.world.toSnapshot());
    const c = generateMap({ ...settings, seed: 'other' }, players(2));
    expect(c.world.grid.toAscii()).not.toEqual(a.world.grid.toAscii());
  });

  it('hits the requested size and land ratio with an ocean border', () => {
    for (const density of ['sparse', 'normal', 'dense'] as const) {
      const { world, report } = generateMap({ ...settings, density }, players(2));
      const { grid } = world;
      expect(grid.width).toBe(MAP_SIZES.small.width);
      expect(report.landRatio).toBeGreaterThan(LAND_RATIO[density] - 0.03);
      expect(report.landRatio).toBeLessThan(LAND_RATIO[density] + 0.01);
      for (let x = 0; x < grid.width; x++) {
        expect(grid.isWater({ x, y: 0 })).toBe(true);
        expect(grid.isWater({ x, y: grid.height - 1 })).toBe(true);
      }
    }
  });

  it('builds an archipelago with relief, forests and coastal shallows', () => {
    const { world, report } = generateMap({ ...settings, size: 'medium' }, players(4));
    expect(report.islands).toBeGreaterThan(3);
    const counts = new Map<string, number>();
    for (let i = 0; i < world.grid.size; i++) {
      const c = world.grid.coordOf(i);
      const t = world.grid.terrainAt(c);
      counts.set(t, (counts.get(t) ?? 0) + 1);
      // deep ocean never touches land directly
      if (t === 'deep_ocean') expect(world.grid.neighbors(c).some((n) => world.grid.isLand(n))).toBe(false);
    }
    for (const t of ['deep_ocean', 'shallow_water', 'plains', 'forest', 'hills', 'mountains']) {
      expect(counts.get(t) ?? 0).toBeGreaterThan(0);
    }
  });

  it('places spaced cities on habitable land', () => {
    const { world } = generateMap(settings, players(2));
    const cities = [...world.allCities()];
    expect(cities.length).toBeGreaterThan(20);
    for (const c of cities) {
      expect(world.grid.isLand(c.position)).toBe(true);
      expect(world.grid.terrainAt(c.position)).not.toBe('mountains');
    }
    for (let i = 0; i < cities.length; i++) {
      for (let j = i + 1; j < cities.length; j++) {
        expect(world.grid.distance(cities[i]!.position, cities[j]!.position)).toBeGreaterThanOrEqual(3);
      }
    }
    expect(new Set(cities.map((c) => c.name)).size).toBe(cities.length);
  });

  it('gives each player one coastal capital with starting units, far apart and balanced', () => {
    for (const [size, n] of [['small', 2], ['medium', 4], ['huge', 6]] as const) {
      const ps = players(n);
      const { world, capitals, report } = generateMap({ size, density: 'normal', seed: `cap-${size}` }, ps);
      expect(capitals.size).toBe(n);
      for (const p of ps) {
        const city = world.city(capitals.get(p)!)!;
        expect(city.owner).toBe(p);
        expect(city.isCoastal).toBe(true);
        expect(world.citiesOf(p)).toHaveLength(1);
        expect(world.unitsAt(city.position).map((u) => u.type)).toEqual(['infantry']);
      }
      expect(report.balance).toBeGreaterThan(0.75);
      expect(report.minCapitalDistance).toBeGreaterThan(15);
    }
  });

  it('honors custom starting units and plugs straight into a Match', () => {
    const ps = players(3);
    const { world, capitals } = generateMap({ ...settings, size: 'medium', startingUnits: ['infantry', 'recon'] }, ps);
    expect(world.unitsOf(ps[0]!).map((u) => u.type).sort()).toEqual(['infantry', 'recon']);
    const { match, report } = Match.start(world, ps);
    expect(report.activePlayer).toBe(ps[0]);
    // Each player sees around their own capital and nothing of the others'.
    const fog = match.fogs.get(ps[0]!)!;
    const other = world.city(capitals.get(ps[1]!)!)!;
    expect(fog.isExplored(world.grid.index(other.position))).toBe(false);
  });

  it('rejects unsupported player counts', () => {
    expect(() => generateMap(settings, players(1))).toThrow(/2 to 6/);
    expect(() => generateMap(settings, players(7))).toThrow(/2 to 6/);
  });
});
