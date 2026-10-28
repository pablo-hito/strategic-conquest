import type { Coord } from './coords.js';

/**
 * Everything that depends on the shape of a cell lives behind this interface, so a
 * hex topology can be added later without touching visibility, movement or AI code.
 */
export interface GridTopology {
  readonly kind: 'square8' | 'hex';
  /** Adjacent cells (unbounded; the Grid filters out-of-map results). */
  neighbors(c: Coord): Coord[];
  /** Movement / adjacency distance in steps. */
  distance(a: Coord, b: Coord): number;
  /** Cells inside a vision radius (unbounded, includes the center). */
  disc(center: Coord, radius: number): Coord[];
  /** Cells crossed by a straight line from a to b, both ends included. */
  line(a: Coord, b: Coord): Coord[];
}

const DIRS8: readonly Coord[] = [
  { x: 0, y: -1 },
  { x: 1, y: -1 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
  { x: -1, y: 1 },
  { x: -1, y: 0 },
  { x: -1, y: -1 },
];

/**
 * Classic Strategic Conquest board: square cells, 8-way movement, so the movement
 * metric is Chebyshev. Vision uses a rounded Euclidean disc (r² + r) instead of
 * Chebyshev, which would give square "binocular" vision that looks wrong on screen.
 */
export const Square8Topology: GridTopology = {
  kind: 'square8',

  neighbors(c) {
    return DIRS8.map((d) => ({ x: c.x + d.x, y: c.y + d.y }));
  },

  distance(a, b) {
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
  },

  disc(center, radius) {
    const out: Coord[] = [];
    const limit = radius * radius + radius;
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (dx * dx + dy * dy <= limit) out.push({ x: center.x + dx, y: center.y + dy });
      }
    }
    return out;
  },

  /** Grid-lerp line: one cell per Chebyshev step, so it never skips a cell. */
  line(a, b) {
    const n = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    if (n === 0) return [{ x: a.x, y: a.y }];
    const out: Coord[] = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      out.push({
        x: Math.round(a.x + (b.x - a.x) * t),
        y: Math.round(a.y + (b.y - a.y) * t),
      });
    }
    return out;
  },
};
