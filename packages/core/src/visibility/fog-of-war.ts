import type { Coord, TileIndex } from '../grid/coords.js';
import type { CityId, PlayerId, UnitId } from '../shared/ids.js';
import { invariant } from '../shared/result.js';
import type { Unit } from '../units/unit.js';
import type { UnitTypeId } from '../units/unit-types.js';
import type { WorldState } from '../world/world-state.js';
import { cityVisionSource, unitVisionSource, visibleTilesFrom, type VisionSource } from './vision.js';

export const TileVisibility = {
  /** Never seen: terrain unknown (black). */
  Unexplored: 0,
  /** Seen before: terrain and last-known city owner shown, no live units (grey). */
  Fogged: 1,
  /** In sight right now. */
  Visible: 2,
} as const;
export type TileVisibility = (typeof TileVisibility)[keyof typeof TileVisibility];

/** Per-tile bits in a VisibilityResult. */
const SEEN_FROM_SURFACE = 1; // land unit, ship or city
const SEEN_FROM_AIR = 2;

export interface VisibilityResult {
  /** Per tile: 0 = not visible, otherwise SEEN_FROM_* bits. */
  readonly tiles: Uint8Array;
  /** Units the viewers know about right now (their own + detected enemies). */
  readonly units: ReadonlySet<UnitId>;
}

/**
 * Pure snapshot of what a set of allied viewers can see right now.
 *
 * Detection rules on top of tile visibility:
 *  - Cargo is never visible on its own (you see the transport, not what's inside).
 *  - Stealthed units (submarine on silent running) are only detected by a viewer
 *    source within 1 tile, or inside the sonar radius of a sonar-equipped unit.
 *  - Land units in terrain that conceals from air (forest/jungle) are invisible to
 *    aircraft unless the aircraft is adjacent; ground observers see them normally.
 */
export function computeVisibility(world: WorldState, viewers: ReadonlySet<PlayerId>): VisibilityResult {
  const { grid } = world;
  const tiles = new Uint8Array(grid.size);
  const units = new Set<UnitId>();
  const sources: VisionSource[] = [];

  for (const u of world.allUnits()) {
    if (!viewers.has(u.owner)) continue;
    units.add(u.id); // always know your own (and allies') units, cargo included
    if (u.carriedBy === null) sources.push(unitVisionSource(grid, u));
  }
  for (const c of world.allCities()) {
    if (c.owner !== null && viewers.has(c.owner)) sources.push(cityVisionSource(c));
  }

  for (const src of sources) {
    const bit = src.domain === 'air' ? SEEN_FROM_AIR : SEEN_FROM_SURFACE;
    for (const i of visibleTilesFrom(grid, src)) tiles[i]! |= bit;
  }

  const sonars = sources.filter((s) => s.sonarRange > 0);

  for (const u of world.allUnits()) {
    if (viewers.has(u.owner) || u.carriedBy !== null) continue;
    if (isDetected(world, u, tiles, sources, sonars)) units.add(u.id);
  }

  return { tiles, units };
}

function isDetected(
  world: WorldState,
  u: Unit,
  tiles: Uint8Array,
  sources: readonly VisionSource[],
  sonars: readonly VisionSource[],
): boolean {
  const { grid } = world;
  const seen = tiles[grid.index(u.position)]!;

  if (u.isStealthed) {
    if (sources.some((s) => grid.distance(s.position, u.position) <= 1)) return true;
    // Sonar works underwater, without line of sight and even through fog.
    return grid.isWater(u.position) &&
      sonars.some((s) => grid.distance(s.position, u.position) <= s.sonarRange);
  }

  if (seen === 0) return false;
  if (u.def.domain === 'land' && grid.defAt(u.position).concealsFromAir && !(seen & SEEN_FROM_SURFACE)) {
    return sources.some((s) => s.domain === 'air' && grid.distance(s.position, u.position) <= 1);
  }
  return true;
}

// ─── Persistent per-player memory ─────────────────────────────────────────────

export interface KnownCity {
  readonly id: CityId;
  readonly name: string;
  readonly position: Coord;
  /** Owner as of the last time the tile was in sight. */
  readonly owner: PlayerId | null;
  readonly lastSeenTurn: number;
}

/** "Ghost" of an enemy unit at its last known position. */
export interface UnitSighting {
  readonly id: UnitId;
  readonly type: UnitTypeId;
  readonly owner: PlayerId;
  readonly position: Coord;
  readonly lastSeenTurn: number;
}

/** What changed since the previous update: exactly what the server pushes as a delta. */
export interface FogUpdate {
  readonly turn: number;
  readonly revealed: TileIndex[];
  readonly hidden: TileIndex[];
  readonly unitsSpotted: UnitId[];
  readonly unitsLost: UnitId[];
  readonly citiesUpdated: CityId[];
}

export interface FogMapSnapshot {
  readonly viewer: PlayerId;
  readonly width: number;
  readonly height: number;
  readonly state: number[];
  readonly lastSeenTurn: number[];
  readonly knownCities: KnownCity[];
  readonly sightings: UnitSighting[];
  readonly detectedUnits: UnitId[];
}

/**
 * A player's memory of the map. Tiles go Unexplored -> Visible <-> Fogged and never
 * return to Unexplored. Lives on the server; the client only ever receives
 * projections of it (see player-view.ts), so a modified client can't lift the fog.
 */
export class PlayerFogMap {
  readonly state: Uint8Array;
  readonly lastSeenTurn: Int32Array;
  readonly knownCities = new Map<CityId, KnownCity>();
  readonly sightings = new Map<UnitId, UnitSighting>();
  private detected = new Set<UnitId>();

  constructor(
    readonly viewer: PlayerId,
    readonly width: number,
    readonly height: number,
  ) {
    this.state = new Uint8Array(width * height);
    this.lastSeenTurn = new Int32Array(width * height).fill(-1);
  }

  get detectedUnits(): ReadonlySet<UnitId> {
    return this.detected;
  }

  visibilityAt(i: TileIndex): TileVisibility {
    return this.state[i] as TileVisibility;
  }

  isExplored(i: TileIndex): boolean {
    return this.state[i] !== TileVisibility.Unexplored;
  }

  /**
   * Recompute sight and fold it into memory. Call after every action that can change
   * sight (move, spawn, death, capture, silent-running toggle), not just at turn end:
   * fog must lift as a unit advances so the server can stop a move on contact.
   */
  update(world: WorldState, allies: ReadonlySet<PlayerId> = new Set([this.viewer])): FogUpdate {
    const { grid } = world;
    invariant(grid.width === this.width && grid.height === this.height, 'fog map size mismatch');
    invariant(allies.has(this.viewer), 'allies must include the viewer');
    const vis = computeVisibility(world, allies);
    const turn = world.turn;
    const revealed: TileIndex[] = [];
    const hidden: TileIndex[] = [];

    for (let i = 0; i < grid.size; i++) {
      if (vis.tiles[i]) {
        if (this.state[i] !== TileVisibility.Visible) revealed.push(i);
        this.state[i] = TileVisibility.Visible;
        this.lastSeenTurn[i] = turn;
      } else if (this.state[i] === TileVisibility.Visible) {
        this.state[i] = TileVisibility.Fogged;
        hidden.push(i);
      }
    }

    const citiesUpdated: CityId[] = [];
    for (const c of world.allCities()) {
      if (!vis.tiles[grid.index(c.position)]) continue;
      const prev = this.knownCities.get(c.id);
      if (!prev || prev.owner !== c.owner) citiesUpdated.push(c.id);
      this.knownCities.set(c.id, {
        id: c.id,
        name: c.name,
        position: c.position,
        owner: c.owner,
        lastSeenTurn: turn,
      });
    }

    // Ghosts: refresh what we see; drop ghosts whose tile is in sight but empty of them.
    for (const id of vis.units) {
      const u = world.unit(id)!;
      if (allies.has(u.owner)) continue;
      this.sightings.set(id, { id, type: u.type, owner: u.owner, position: u.position, lastSeenTurn: turn });
    }
    for (const [id, s] of this.sightings) {
      if (!vis.units.has(id) && vis.tiles[grid.index(s.position)]) this.sightings.delete(id);
    }

    const unitsSpotted = [...vis.units].filter((id) => !this.detected.has(id));
    const unitsLost = [...this.detected].filter((id) => !vis.units.has(id));
    this.detected = new Set(vis.units);

    return { turn, revealed, hidden, unitsSpotted, unitsLost, citiesUpdated };
  }

  toSnapshot(): FogMapSnapshot {
    return {
      viewer: this.viewer,
      width: this.width,
      height: this.height,
      state: Array.from(this.state),
      lastSeenTurn: Array.from(this.lastSeenTurn),
      knownCities: [...this.knownCities.values()],
      sightings: [...this.sightings.values()],
      detectedUnits: [...this.detected],
    };
  }

  static fromSnapshot(s: FogMapSnapshot): PlayerFogMap {
    const f = new PlayerFogMap(s.viewer, s.width, s.height);
    f.state.set(s.state);
    f.lastSeenTurn.set(s.lastSeenTurn);
    for (const c of s.knownCities) f.knownCities.set(c.id, c);
    for (const g of s.sightings) f.sightings.set(g.id, g);
    f.detected = new Set(s.detectedUnits);
    return f;
  }
}
