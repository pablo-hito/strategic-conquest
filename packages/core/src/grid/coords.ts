export interface Coord {
  readonly x: number;
  readonly y: number;
}

export const coord = (x: number, y: number): Coord => ({ x, y });
export const coordEquals = (a: Coord, b: Coord) => a.x === b.x && a.y === b.y;
export const coordKey = (c: Coord) => `${c.x},${c.y}`;

/** Flat tile index used by every typed-array layer (terrain, fog, unit index). */
export type TileIndex = number;
