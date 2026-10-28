import { describe, expect, it } from 'vitest';
import { Grid, Square8Topology } from '../src/index.js';

describe('Grid', () => {
  const g = Grid.fromAscii([
    '~~~~~',
    '~-..~',
    '~.fh~',
    '~~~M~',
  ]);

  it('parses terrain and round-trips through ascii and snapshots', () => {
    expect(g.terrainAt({ x: 2, y: 2 })).toBe('forest');
    expect(g.terrainAt({ x: 1, y: 1 })).toBe('shallow_water');
    expect(Grid.fromSnapshot(g.toSnapshot()).toAscii()).toEqual(g.toAscii());
  });

  it('detects coastal land', () => {
    expect(g.isCoastal({ x: 2, y: 1 })).toBe(true);
    expect(g.isCoastal({ x: 1, y: 1 })).toBe(false); // water itself is not "coastal land"
  });

  it('clips neighbors at the edge', () => {
    expect(g.neighbors({ x: 0, y: 0 })).toHaveLength(3);
    expect(g.neighbors({ x: 2, y: 2 })).toHaveLength(8);
  });

  it('rejects bad input', () => {
    expect(() => Grid.fromAscii(['..', '.'])).toThrow(/length/);
    expect(() => Grid.fromAscii(['.?'])).toThrow(/glyph/);
  });
});

describe('Square8Topology', () => {
  it('uses Chebyshev distance for movement', () => {
    expect(Square8Topology.distance({ x: 0, y: 0 }, { x: 3, y: 2 })).toBe(3);
  });

  it('draws gap-free lines including both ends', () => {
    const line = Square8Topology.line({ x: 0, y: 0 }, { x: 4, y: 2 });
    expect(line[0]).toEqual({ x: 0, y: 0 });
    expect(line.at(-1)).toEqual({ x: 4, y: 2 });
    for (let i = 1; i < line.length; i++) {
      expect(Square8Topology.distance(line[i - 1]!, line[i]!)).toBe(1);
    }
  });

  it('builds a rounded vision disc', () => {
    const d = Square8Topology.disc({ x: 0, y: 0 }, 2);
    expect(d).toContainEqual({ x: 2, y: 1 });
    expect(d).not.toContainEqual({ x: 2, y: 2 });
  });
});
