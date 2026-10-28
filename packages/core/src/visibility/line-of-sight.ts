import type { Coord } from '../grid/coords.js';
import type { Grid } from '../grid/grid.js';

/**
 * Height-field line of sight.
 *
 * The sight line runs from the observer's eye (ground elevation + eyeHeight) to the
 * top of the target tile (elevation + canopy, so you "see" a forest or a peak by its
 * top). Every tile strictly between them blocks if its obstruction height reaches
 * the sight line at that point.
 *
 * Consequences of the terrain table:
 *  - Ground units cannot see past forests or hills that stand between them and the target.
 *  - Units on hills/mountains look over forests (and get extra range on top).
 *  - Aircraft (eye 6+) are only blocked by mountains right in front of a low target.
 *  - Adjacent tiles are always visible.
 *
 * Grid lines are ambiguous when they pass exactly between two cells, which would make
 * LOS asymmetric (A sees B but B doesn't see A). We trace both directions and accept
 * if either is clear: permissive and symmetric, which players perceive as fair.
 */
export function hasLineOfSight(grid: Grid, from: Coord, eyeHeight: number, to: Coord): boolean {
  if (grid.distance(from, to) <= 1) return true;
  const h0 = grid.defAt(from).elevation + eyeHeight;
  const h1 = grid.obstructionHeight(to);
  const forward = grid.topology.line(from, to);
  if (isClear(grid, forward, h0, h1)) return true;
  const backward = grid.topology.line(to, from).reverse();
  return isClear(grid, backward, h0, h1);
}

function isClear(grid: Grid, cells: readonly Coord[], h0: number, h1: number): boolean {
  const n = cells.length - 1;
  for (let i = 1; i < n; i++) {
    const sightHeight = h0 + ((h1 - h0) * i) / n;
    if (grid.obstructionHeight(cells[i]!) >= sightHeight) return false;
  }
  return true;
}
