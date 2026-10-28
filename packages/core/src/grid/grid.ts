import { invariant } from '../shared/result.js';
import type { Coord, TileIndex } from './coords.js';
import {
  TERRAINS,
  TERRAIN_BY_GLYPH,
  TERRAIN_DEFS,
  type Terrain,
  type TerrainDef,
} from './terrain.js';
import { Square8Topology, type GridTopology } from './topology.js';

const TERRAIN_CODE: ReadonlyMap<Terrain, number> = new Map(TERRAINS.map((t, i) => [t, i]));

export interface GridSnapshot {
  readonly width: number;
  readonly height: number;
  readonly topology: GridTopology['kind'];
  /** One byte per tile, row-major, values index into TERRAINS. */
  readonly terrain: number[];
}

/**
 * The static board. Terrain is stored in a Uint8Array (a 200x120 "Huge" map is 24 KB)
 * and everything else that is per-tile (fog, unit index) uses the same flat index.
 * Units and cities are NOT stored here: the grid is immutable during a match and is
 * sent to clients once; dynamic state lives in WorldState.
 */
export class Grid {
  private readonly terrain: Uint8Array;

  constructor(
    readonly width: number,
    readonly height: number,
    readonly topology: GridTopology = Square8Topology,
    terrain?: Uint8Array,
  ) {
    invariant(Number.isInteger(width) && width > 0, 'grid width must be a positive integer');
    invariant(Number.isInteger(height) && height > 0, 'grid height must be a positive integer');
    this.terrain = terrain ?? new Uint8Array(width * height);
    invariant(this.terrain.length === width * height, 'terrain buffer size mismatch');
  }

  static filled(width: number, height: number, t: Terrain): Grid {
    const g = new Grid(width, height);
    g.terrain.fill(TERRAIN_CODE.get(t)!);
    return g;
  }

  /** Build a grid from glyph rows ('~' deep, '-' shallow, '.' plains, 'f', 'h', 'M'). */
  static fromAscii(rows: readonly string[]): Grid {
    invariant(rows.length > 0, 'ascii map is empty');
    const width = rows[0]!.length;
    const g = new Grid(width, rows.length);
    rows.forEach((row, y) => {
      invariant(row.length === width, `ascii row ${y} has length ${row.length}, expected ${width}`);
      for (let x = 0; x < width; x++) {
        const t = TERRAIN_BY_GLYPH.get(row[x]!);
        invariant(t !== undefined, `unknown terrain glyph '${row[x]}' at ${x},${y}`);
        g.setTerrain({ x, y }, t);
      }
    });
    return g;
  }

  static fromSnapshot(s: GridSnapshot): Grid {
    invariant(s.topology === Square8Topology.kind, `unsupported topology ${s.topology}`);
    return new Grid(s.width, s.height, Square8Topology, Uint8Array.from(s.terrain));
  }

  toSnapshot(): GridSnapshot {
    return {
      width: this.width,
      height: this.height,
      topology: this.topology.kind,
      terrain: Array.from(this.terrain),
    };
  }

  get size(): number {
    return this.width * this.height;
  }

  inBounds(c: Coord): boolean {
    return c.x >= 0 && c.y >= 0 && c.x < this.width && c.y < this.height;
  }

  index(c: Coord): TileIndex {
    invariant(this.inBounds(c), `coord ${c.x},${c.y} out of bounds`);
    return c.y * this.width + c.x;
  }

  coordOf(i: TileIndex): Coord {
    return { x: i % this.width, y: Math.floor(i / this.width) };
  }

  terrainAt(c: Coord): Terrain {
    return TERRAINS[this.terrain[this.index(c)]!]!;
  }

  defAt(c: Coord): TerrainDef {
    return TERRAIN_DEFS[this.terrainAt(c)];
  }

  setTerrain(c: Coord, t: Terrain): void {
    this.terrain[this.index(c)] = TERRAIN_CODE.get(t)!;
  }

  isLand(c: Coord): boolean {
    return this.defAt(c).domain === 'land';
  }

  isWater(c: Coord): boolean {
    return this.defAt(c).domain === 'water';
  }

  /** In-bounds neighbors only. */
  neighbors(c: Coord): Coord[] {
    return this.topology.neighbors(c).filter((n) => this.inBounds(n));
  }

  /** A land tile touching water: can host a port, receive landings, build ships. */
  isCoastal(c: Coord): boolean {
    return this.isLand(c) && this.neighbors(c).some((n) => this.isWater(n));
  }

  distance(a: Coord, b: Coord): number {
    return this.topology.distance(a, b);
  }

  /** In-bounds tiles inside a vision disc. */
  disc(center: Coord, radius: number): Coord[] {
    return this.topology.disc(center, radius).filter((c) => this.inBounds(c));
  }

  /** Height that blocks a sight line passing over this tile. */
  obstructionHeight(c: Coord): number {
    const d = this.defAt(c);
    return d.elevation + d.canopy;
  }

  toAscii(): string[] {
    const rows: string[] = [];
    for (let y = 0; y < this.height; y++) {
      let row = '';
      for (let x = 0; x < this.width; x++) row += this.defAt({ x, y }).glyph;
      rows.push(row);
    }
    return rows;
  }
}
