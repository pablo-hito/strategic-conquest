import type { CitySpecialization } from '../cities/specialization.js';
import type { Coord } from '../grid/coords.js';
import { moveUnit, mergeFogUpdates, type MoveError, type MoveOutcome } from '../movement/movement-service.js';
import type { CityId, PlayerId, UnitId } from '../shared/ids.js';
import { err, invariant, ok, type Result } from '../shared/result.js';
import type { UnitTypeId } from '../units/unit-types.js';
import { PlayerFogMap, type FogMapSnapshot, type FogUpdate } from '../visibility/fog-of-war.js';
import { WorldState, type WorldSnapshot } from '../world/world-state.js';
import { beginPlayerTurn, endPlayerTurn, type TurnEvent } from './turn-rules.js';
import { DEFAULT_VICTORY_RULES, evaluateVictory, type VictoryRules } from './victory.js';

export type MatchStatus = 'playing' | 'finished';

export type CommandError =
  | 'MATCH_FINISHED'
  | 'NOT_A_PLAYER'
  | 'NOT_YOUR_TURN'
  | 'UNKNOWN_CITY'
  | 'NOT_YOUR_CITY';

export interface MatchSnapshot {
  readonly world: WorldSnapshot;
  readonly order: PlayerId[];
  readonly alive: PlayerId[];
  readonly activeIndex: number;
  readonly status: MatchStatus;
  readonly winner: PlayerId | null;
  readonly rules: VictoryRules;
  readonly fogs: FogMapSnapshot[];
}

/** Everything a turn change produced, for the server to fan out. */
export interface TurnReport {
  readonly events: TurnEvent[];
  readonly fogUpdates: ReadonlyMap<PlayerId, FogUpdate>;
  readonly activePlayer: PlayerId | null;
  readonly round: number;
}

/**
 * Match aggregate for the classic sequential mode (P1 -> P2 -> ... -> P1, round + 1).
 * It is the single entry point for player commands: it checks whose turn it is,
 * delegates to the domain rules, keeps every fog map current and re-evaluates victory
 * after anything that can change it. Timers, sockets and persistence stay outside.
 *
 * Simultaneous (WEGO) mode will be a second orchestrator over the same rules.
 */
export class Match {
  private activeIndex = 0;
  private alive: PlayerId[];
  private _status: MatchStatus = 'playing';
  private _winner: PlayerId | null = null;
  readonly fogs = new Map<PlayerId, PlayerFogMap>();

  private constructor(
    readonly world: WorldState,
    readonly order: readonly PlayerId[],
    readonly rules: VictoryRules,
  ) {
    invariant(order.length >= 2 && order.length <= 6, 'a match needs 2 to 6 players');
    invariant(new Set(order).size === order.length, 'duplicate player in turn order');
    this.alive = [...order];
  }

  /** Start a match on a prepared world (map generated, starting cities assigned). */
  static start(world: WorldState, order: readonly PlayerId[], rules = DEFAULT_VICTORY_RULES): { match: Match; report: TurnReport } {
    const m = new Match(world, order, rules);
    for (const p of order) m.fogs.set(p, new PlayerFogMap(p, world.grid.width, world.grid.height));
    const events = beginPlayerTurn(world, order[0]!);
    return { match: m, report: m.report(events, m.refreshAllFog()) };
  }

  get status(): MatchStatus { return this._status; }
  get winner(): PlayerId | null { return this._winner; }
  get round(): number { return this.world.turn; }
  get alivePlayers(): readonly PlayerId[] { return this.alive; }
  get activePlayer(): PlayerId | null {
    return this._status === 'playing' ? this.order[this.activeIndex]! : null;
  }

  // ─── Commands ───────────────────────────────────────────────────────────────

  move(player: PlayerId, unitId: UnitId, path: readonly Coord[]): Result<MoveOutcome & { events: TurnEvent[] }, CommandError | MoveError> {
    const turn = this.checkTurn(player);
    if (!turn.ok) return turn;
    const r = moveUnit({ world: this.world, fogs: this.fogs }, player, unitId, path);
    if (!r.ok) return r;
    // Captures and crashes can end the game (or knock the mover out) mid-turn.
    const events = r.value.captured || r.value.stoppedBy === 'CRASHED' ? this.checkVictory() : [];
    if (this._status === 'playing' && !this.alive.includes(player)) {
      this.advance();
      events.push(...beginPlayerTurn(this.world, this.activePlayer!));
    }
    // Eliminations remove units and new turns spawn them: fold that into the deltas.
    const fogUpdates = events.length > 0 ? mergeMaps(new Map(r.value.fogUpdates), this.refreshAllFog()) : r.value.fogUpdates;
    return ok({ ...r.value, fogUpdates, events });
  }

  setProduction(player: PlayerId, cityId: CityId, unit: UnitTypeId): Result<void, string> {
    const city = this.ownCity(player, cityId);
    if (!city.ok) return city;
    return city.value.setProduction(unit);
  }

  setSpecialization(player: PlayerId, cityId: CityId, spec: CitySpecialization): Result<void, string> {
    const city = this.ownCity(player, cityId);
    if (!city.ok) return city;
    return city.value.setSpecialization(spec);
  }

  /** Toggle silent running; refreshes fog because stealth changes what enemies see. */
  setSilentRunning(player: PlayerId, unitId: UnitId, on: boolean): Result<ReadonlyMap<PlayerId, FogUpdate>, string> {
    const turn = this.checkTurn(player);
    if (!turn.ok) return turn;
    const unit = this.world.unit(unitId);
    if (!unit) return err('UNKNOWN_UNIT', `no unit ${unitId}`);
    if (unit.owner !== player) return err('NOT_YOUR_UNIT', 'you can only command your own units');
    const r = unit.setSilentRunning(on);
    if (!r.ok) return r;
    return ok(this.refreshAllFog());
  }

  /** Close the active player's turn and open the next living player's. */
  endTurn(player: PlayerId): Result<TurnReport, CommandError> {
    const turn = this.checkTurn(player);
    if (!turn.ok) return turn;

    const events = endPlayerTurn(this.world, player);
    events.push(...this.checkVictory());
    let fog = this.refreshAllFog();

    if (this._status === 'playing') {
      this.advance();
      events.push(...beginPlayerTurn(this.world, this.activePlayer!));
      fog = mergeMaps(fog, this.refreshAllFog());
    }
    return ok(this.report(events, fog));
  }

  // ─── Persistence ────────────────────────────────────────────────────────────

  toSnapshot(): MatchSnapshot {
    return {
      world: this.world.toSnapshot(),
      order: [...this.order],
      alive: [...this.alive],
      activeIndex: this.activeIndex,
      status: this._status,
      winner: this._winner,
      rules: this.rules,
      fogs: [...this.fogs.values()].map((f) => f.toSnapshot()),
    };
  }

  static fromSnapshot(s: MatchSnapshot): Match {
    const m = new Match(WorldState.fromSnapshot(s.world), s.order, s.rules);
    m.alive = [...s.alive];
    m.activeIndex = s.activeIndex;
    m._status = s.status;
    m._winner = s.winner;
    for (const f of s.fogs) m.fogs.set(f.viewer, PlayerFogMap.fromSnapshot(f));
    return m;
  }

  // ─── Internals ──────────────────────────────────────────────────────────────

  private checkTurn(player: PlayerId): Result<void, CommandError> {
    if (this._status !== 'playing') return err('MATCH_FINISHED', 'the match is over');
    if (!this.alive.includes(player)) return err('NOT_A_PLAYER', 'you are not in this match');
    if (this.activePlayer !== player) return err('NOT_YOUR_TURN', 'wait for your turn');
    return ok(undefined);
  }

  private ownCity(player: PlayerId, cityId: CityId) {
    const turn = this.checkTurn(player);
    if (!turn.ok) return turn;
    const city = this.world.city(cityId);
    if (!city) return err('UNKNOWN_CITY', `no city ${cityId}`);
    if (city.owner !== player) return err('NOT_YOUR_CITY', 'you do not own this city');
    return ok(city);
  }

  /** Next living player; wrapping past the end of the order starts a new round. */
  private advance(): void {
    do {
      this.activeIndex++;
      if (this.activeIndex >= this.order.length) {
        this.activeIndex = 0;
        this.world.turn++;
      }
    } while (!this.alive.includes(this.order[this.activeIndex]!));
  }

  /** Remove eliminated players (their leftover forces surrender) and detect a winner. */
  private checkVictory(): TurnEvent[] {
    const events: TurnEvent[] = [];
    const v = evaluateVictory(this.world, this.alive, this.rules);
    for (const p of v.newlyEliminated) {
      for (const u of this.world.unitsOf(p)) if (u.carriedBy === null) this.world.removeUnit(u.id);
      events.push({ type: 'player_eliminated', audience: 'all', player: p });
    }
    this.alive = this.alive.filter((p) => !v.newlyEliminated.includes(p));
    if (v.winner && v.reason) {
      this._status = 'finished';
      this._winner = v.winner;
      events.push({ type: 'match_won', audience: 'all', player: v.winner, reason: v.reason });
    } else if (this.alive.length === 0) {
      this._status = 'finished'; // mutual destruction: draw
    }
    return events;
  }

  private refreshAllFog(): Map<PlayerId, FogUpdate> {
    const out = new Map<PlayerId, FogUpdate>();
    for (const [p, fog] of this.fogs) out.set(p, fog.update(this.world));
    return out;
  }

  private report(events: TurnEvent[], fogUpdates: Map<PlayerId, FogUpdate>): TurnReport {
    return { events, fogUpdates, activePlayer: this.activePlayer, round: this.world.turn };
  }
}

function mergeMaps(a: Map<PlayerId, FogUpdate>, b: Map<PlayerId, FogUpdate>): Map<PlayerId, FogUpdate> {
  const out = new Map(a);
  for (const [p, u] of b) out.set(p, mergeFogUpdates(out.get(p), u));
  return out;
}
