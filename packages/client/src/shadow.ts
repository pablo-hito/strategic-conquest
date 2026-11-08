import {
  DEFAULT_VICTORY_RULES,
  Match,
  TERRAINS,
  UNIT_TYPES,
  UNKNOWN_TERRAIN,
  type CityState,
  type MatchSnapshot,
  type PlayerId,
  type UnitState,
} from '@sc/core';
import type { OnlineView, SeatInfo } from '@sc/protocol/client';

/**
 * A local Match rebuilt from what one player is allowed to see. Unknown tiles are
 * filled with ocean, but the fog map marks them unexplored, so pathfinding treats
 * them as unknown exactly like in a local game; foreign units carry only what is
 * visible (type, owner, position, health). Rules run on it for planning and
 * forecasts; the server re-validates every command against the real game.
 */
export function buildShadowMatch(state: OnlineView, seats: readonly SeatInfo[]): Match {
  const v = state.view;
  const water = TERRAINS.indexOf('deep_ocean');
  const terrain = v.terrain.map((t) => (t === UNKNOWN_TERRAIN ? water : t));
  const isWater = (x: number, y: number) => {
    const t = terrain[y * v.width + x];
    return t === undefined || TERRAINS[t] === 'deep_ocean' || TERRAINS[t] === 'shallow_water';
  };
  const coastal = (x: number, y: number) =>
    [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]].some(([dx, dy]) => isWater(x + dx!, y + dy!));

  const foreign: UnitState[] = v.foreignUnits.map((u) => ({
    id: u.id,
    type: u.type,
    owner: u.owner,
    position: u.position,
    hp: u.hp,
    movesLeft: UNIT_TYPES[u.type].moves,
    fuel: UNIT_TYPES[u.type].fuel ?? null,
    entrenchment: 0,
    movedThisTurn: false,
    attackedThisTurn: false,
    carriedBy: null,
    cargo: [],
    cargoLoad: 0,
    silentRunning: false,
    turnsOutOfSupply: 0,
  }));
  const ownCityIds = new Set(v.ownCities.map((c) => c.id));
  const known: CityState[] = v.knownCities
    .filter((k) => !ownCityIds.has(k.id))
    .map((k) => ({
      id: k.id,
      name: k.name,
      position: k.position,
      isCoastal: coastal(k.position.x, k.position.y),
      owner: k.owner,
      specialization: 'none',
      production: null,
      portDisabledTurns: 0,
    }));

  const order = seats.map((s) => s.player);
  const alive = seats.filter((s) => s.alive).map((s) => s.player);
  const active = state.meta.active;
  const snapshot: MatchSnapshot = {
    world: {
      turn: state.meta.round,
      idCursor: 1_000_000,
      grid: { width: v.width, height: v.height, topology: 'square8', terrain },
      units: [...v.ownUnits, ...foreign],
      cities: [...v.ownCities, ...known],
    },
    order,
    alive: alive.length ? alive : order,
    activeIndex: Math.max(0, active ? order.indexOf(active) : 0),
    status: state.meta.status,
    winner: state.meta.winner,
    rules: DEFAULT_VICTORY_RULES,
    fogs: [
      {
        viewer: state.you,
        width: v.width,
        height: v.height,
        state: v.visibility,
        lastSeenTurn: v.visibility.map(() => state.meta.round),
        knownCities: v.knownCities,
        sightings: v.ghosts,
        detectedUnits: [...v.ownUnits.map((u) => u.id), ...foreign.map((u) => u.id)],
      },
    ],
    rng: [1, 2, 3, 4],
  };
  return Match.fromSnapshot(snapshot);
}

export const seatName = (seats: readonly SeatInfo[], p: PlayerId) => {
  const s = seats.find((x) => x.player === p);
  if (!s) return String(p);
  return s.kind === 'bot' ? `${s.name} (bot)` : s.name;
};
