import type { Coord } from '../grid/coords.js';
import type { CityId, PlayerId, UnitId } from '../shared/ids.js';
import { err, ok, type Result } from '../shared/result.js';
import type { FogUpdate, PlayerFogMap } from '../visibility/fog-of-war.js';
import type { WorldState } from '../world/world-state.js';
import { truthKnowledge } from './map-knowledge.js';
import { checkStep, isRefuelPoint, type StepError } from './step-rules.js';

export type StopReason =
  /** Every step was executed. */
  | 'COMPLETED'
  /** An enemy came into view: the player gets to react before continuing. */
  | 'CONTACT'
  /** The unit boarded a transport. */
  | 'BOARDED'
  /** The unit took a city (ends its turn). */
  | 'CAPTURED'
  | 'NO_MOVES_LEFT'
  /** A step became illegal (usually something hidden in the fog was in the way). */
  | 'BLOCKED'
  /** Aircraft ran out of fuel away from a city or carrier and was lost. */
  | 'CRASHED';

export type MoveError = StepError | 'UNKNOWN_UNIT' | 'NOT_YOUR_UNIT' | 'EMPTY_PATH' | 'NO_MOVES_LEFT';

export interface MoveOutcome {
  readonly unitId: UnitId;
  readonly stepsTaken: number;
  readonly position: Coord;
  readonly stoppedBy: StopReason;
  /** Why the next step was refused, when stoppedBy is BLOCKED. */
  readonly blockedBy?: StepError;
  /** City taken by this move, if any. */
  readonly captured?: CityId;
  /** Fog deltas to push to each player (only players whose view changed). */
  readonly fogUpdates: ReadonlyMap<PlayerId, FogUpdate>;
}

export interface MoveContext {
  readonly world: WorldState;
  /** Every player's fog map: a move changes what the mover AND its enemies see. */
  readonly fogs: ReadonlyMap<PlayerId, PlayerFogMap>;
  /** Vision-sharing group of a player (defaults to just the player). */
  readonly alliesOf?: (p: PlayerId) => ReadonlySet<PlayerId>;
}

/**
 * Executes a move command server-side. The client sends a path planned with its own
 * knowledge; every step is re-validated against the true state, fog is recomputed
 * after each step, and the move stops early on contact, so a unit never "teleports"
 * through an enemy it would have spotted halfway.
 *
 * Only the first step can fail the whole command (it's malformed or illegal with what
 * the player already knew). Later failures stop the unit where it is.
 */
export function moveUnit(
  ctx: MoveContext,
  player: PlayerId,
  unitId: UnitId,
  path: readonly Coord[],
): Result<MoveOutcome, MoveError> {
  const { world } = ctx;
  const unit = world.unit(unitId);
  if (!unit) return err('UNKNOWN_UNIT', `no unit ${unitId}`);
  if (unit.owner !== player) return err('NOT_YOUR_UNIT', 'you can only move your own units');
  if (path.length === 0) return err('EMPTY_PATH', 'path has no steps');
  if (unit.movesLeft <= 0) return err('NO_MOVES_LEFT', 'unit has already moved this turn');

  const truth = truthKnowledge(world);
  const allies = ctx.alliesOf ?? ((p: PlayerId) => new Set([p]));
  const fogUpdates = new Map<PlayerId, FogUpdate>();
  let steps = 0;
  let stoppedBy: StopReason = 'COMPLETED';
  let blockedBy: StepError | undefined;
  let captured: CityId | undefined;

  for (const next of path) {
    const r = checkStep(truth, unit, unit.position, next);
    if (!r.ok) {
      if (steps === 0) return r;
      stoppedBy = 'BLOCKED';
      blockedBy = r.error.code;
      break;
    }
    const plan = r.value;
    if (!unit.canAfford(plan.cost)) {
      if (steps === 0) return err('NO_MOVES_LEFT', 'not enough movement points');
      stoppedBy = 'NO_MOVES_LEFT';
      break;
    }

    if (unit.carriedBy !== null) world.unload(unit.carriedBy, unit.id);
    world.stepUnit(unit.id, next, plan.cost);
    if (plan.kind === 'board') {
      world.load(plan.carrierId!, unit.id);
      unit.exhaustMoves();
    }
    if (plan.kind === 'capture') {
      const city = world.cityAt(next)!;
      world.captureCity(city.id, player);
      unit.exhaustMoves();
      captured = city.id;
    }
    steps++;

    if (unit.fuel !== null && isRefuelPoint(truth, unit, unit.position)) unit.refuel();

    const contact = refreshFog(ctx, allies, fogUpdates, player);

    if (unit.isOutOfFuel) {
      world.removeUnit(unit.id);
      refreshFog(ctx, allies, fogUpdates, player);
      stoppedBy = 'CRASHED';
      break;
    }
    if (plan.kind === 'board' || plan.kind === 'capture') {
      stoppedBy = plan.kind === 'board' ? 'BOARDED' : 'CAPTURED';
      break;
    }
    if (contact) {
      stoppedBy = steps < path.length ? 'CONTACT' : 'COMPLETED';
      break;
    }
    if (unit.movesLeft <= 0 && steps < path.length) {
      stoppedBy = 'NO_MOVES_LEFT';
      break;
    }
  }

  return ok({
    unitId,
    stepsTaken: steps,
    position: unit.position,
    stoppedBy,
    ...(blockedBy ? { blockedBy } : {}),
    ...(captured ? { captured } : {}),
    fogUpdates,
  });
}

/**
 * Update every fog map and merge the deltas. Returns true if the mover's side
 * spotted a new enemy unit.
 */
function refreshFog(
  ctx: MoveContext,
  allies: (p: PlayerId) => ReadonlySet<PlayerId>,
  acc: Map<PlayerId, FogUpdate>,
  mover: PlayerId,
): boolean {
  let contact = false;
  for (const [player, fog] of ctx.fogs) {
    const group = allies(player);
    const u = fog.update(ctx.world, group);
    if (player === mover) {
      contact = u.unitsSpotted.some((id) => {
        const spotted = ctx.world.unit(id);
        return spotted !== undefined && !group.has(spotted.owner);
      });
    }
    acc.set(player, mergeFogUpdates(acc.get(player), u));
  }
  for (const [p, u] of acc) if (isEmptyUpdate(u)) acc.delete(p);
  return contact;
}

/** Combine two consecutive deltas into one, cancelling out reveal-then-hide pairs. */
export function mergeFogUpdates(a: FogUpdate | undefined, b: FogUpdate): FogUpdate {
  if (!a) return b;
  const revealed = new Set(a.revealed);
  const hidden = new Set(a.hidden);
  for (const i of b.revealed) hidden.has(i) ? hidden.delete(i) : revealed.add(i);
  for (const i of b.hidden) revealed.has(i) ? revealed.delete(i) : hidden.add(i);
  const spotted = new Set(a.unitsSpotted);
  const lost = new Set(a.unitsLost);
  for (const id of b.unitsSpotted) lost.has(id) ? lost.delete(id) : spotted.add(id);
  for (const id of b.unitsLost) spotted.has(id) ? spotted.delete(id) : lost.add(id);
  return {
    turn: b.turn,
    revealed: [...revealed],
    hidden: [...hidden],
    unitsSpotted: [...spotted],
    unitsLost: [...lost],
    citiesUpdated: [...new Set([...a.citiesUpdated, ...b.citiesUpdated])],
  };
}

function isEmptyUpdate(u: FogUpdate): boolean {
  return (
    u.revealed.length === 0 &&
    u.hidden.length === 0 &&
    u.unitsSpotted.length === 0 &&
    u.unitsLost.length === 0 &&
    u.citiesUpdated.length === 0
  );
}
