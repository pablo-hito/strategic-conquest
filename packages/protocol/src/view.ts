import type {
  CityState,
  ForeignUnitView,
  KnownCity,
  PlayerId,
  PlayerView,
  TurnEvent,
  UnitSighting,
  UnitState,
} from '@sc/core';
import type { RoomSettings } from './messages.js';

/** Bumped on any incompatible change; the server refuses other versions. */
export const PROTOCOL_VERSION = 1;

export type SeatKind = 'human' | 'bot' | 'open';

export interface SeatInfo {
  readonly index: number;
  readonly player: PlayerId;
  readonly name: string;
  readonly kind: SeatKind;
  readonly connected: boolean;
  readonly ready: boolean;
  readonly alive: boolean;
  /** A human seat temporarily played by the bot (disconnected or out of time). */
  readonly botStandIn: boolean;
}

export interface RoomInfo {
  readonly code: string;
  readonly settings: RoomSettings;
  readonly status: 'lobby' | 'playing' | 'finished';
  readonly seats: SeatInfo[];
  /** Seat index of the host (can start the game). */
  readonly host: number;
}

/** Game state around the map: whose turn, the clock, the result. */
export interface GameMeta {
  readonly round: number;
  readonly active: PlayerId | null;
  readonly status: 'playing' | 'finished';
  readonly winner: PlayerId | null;
  /** When the active player's clock runs out (epoch ms), or null without a clock. */
  readonly deadline: number | null;
  /** Cities on the whole map (public: it sets the victory goal). */
  readonly totalCities: number;
}

/** Everything one player is allowed to know, as sent by the server. */
export interface OnlineView {
  readonly you: PlayerId;
  readonly meta: GameMeta;
  readonly view: PlayerView;
}

/**
 * Difference between two views of the same player. Tile layers travel as sparse
 * [index, value] pairs; entity lists (small) are resent whole when they change.
 */
export interface ViewPatch {
  readonly terrain?: [number, number][];
  readonly visibility?: [number, number][];
  readonly ownUnits?: UnitState[];
  readonly foreignUnits?: ForeignUnitView[];
  readonly ghosts?: UnitSighting[];
  readonly ownCities?: CityState[];
  readonly knownCities?: KnownCity[];
  readonly turn?: number;
  readonly meta?: GameMeta;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function sparse(prev: readonly number[], next: readonly number[]): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < next.length; i++) if (prev[i] !== next[i]) out.push([i, next[i]!]);
  return out;
}

export function diffView(prev: OnlineView, next: OnlineView): ViewPatch {
  const p: { -readonly [K in keyof ViewPatch]: ViewPatch[K] } = {};
  const a = prev.view, b = next.view;
  const terrain = sparse(a.terrain, b.terrain);
  if (terrain.length) p.terrain = terrain;
  const visibility = sparse(a.visibility, b.visibility);
  if (visibility.length) p.visibility = visibility;
  if (!same(a.ownUnits, b.ownUnits)) p.ownUnits = b.ownUnits;
  if (!same(a.foreignUnits, b.foreignUnits)) p.foreignUnits = b.foreignUnits;
  if (!same(a.ghosts, b.ghosts)) p.ghosts = b.ghosts;
  if (!same(a.ownCities, b.ownCities)) p.ownCities = b.ownCities;
  if (!same(a.knownCities, b.knownCities)) p.knownCities = b.knownCities;
  if (a.turn !== b.turn) p.turn = b.turn;
  if (!same(prev.meta, next.meta)) p.meta = next.meta;
  return p;
}

export function isEmptyPatch(p: ViewPatch): boolean {
  return Object.keys(p).length === 0;
}

export function applyPatch(prev: OnlineView, p: ViewPatch): OnlineView {
  const v = prev.view;
  const terrain = p.terrain ? [...v.terrain] : v.terrain;
  for (const [i, t] of p.terrain ?? []) terrain[i] = t;
  const visibility = p.visibility ? [...v.visibility] : v.visibility;
  for (const [i, t] of p.visibility ?? []) visibility[i] = t;
  return {
    you: prev.you,
    meta: p.meta ?? prev.meta,
    view: {
      ...v,
      turn: p.turn ?? v.turn,
      terrain,
      visibility,
      ownUnits: p.ownUnits ?? v.ownUnits,
      foreignUnits: p.foreignUnits ?? v.foreignUnits,
      ghosts: p.ghosts ?? v.ghosts,
      ownCities: p.ownCities ?? v.ownCities,
      knownCities: p.knownCities ?? v.knownCities,
    },
  };
}

/** How a move command ended (so the client can drop a standing order on contact). */
export interface MoveSummary {
  readonly stoppedBy: 'COMPLETED' | 'CONTACT' | 'BOARDED' | 'CAPTURED' | 'NO_MOVES_LEFT' | 'BLOCKED' | 'CRASHED';
  readonly blockedBy?: string;
}

/** Server → client messages. */
export type ServerMessage =
  | { t: 'welcome'; token: string; name: string }
  | { t: 'room'; room: RoomInfo; you: number }
  | { t: 'state'; state: OnlineView }
  | { t: 'patch'; patch: ViewPatch; events: TurnEvent[] }
  | { t: 'ack'; id: number; ok: true; events: TurnEvent[]; outcome?: MoveSummary }
  | { t: 'ack'; id: number; ok: false; code: string; message: string }
  | { t: 'error'; code: string; message: string }
  | { t: 'pong' };
