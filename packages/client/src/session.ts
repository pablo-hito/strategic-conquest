import {
  Match,
  PlayerId,
  buildPlayerView,
  findPath,
  fogKnowledge,
  generateMap,
  reachableThisTurn,
  type CityId,
  type CitySpecialization,
  type Coord,
  type IslandDensity,
  type MapSize,
  type MatchSnapshot,
  type MoveOutcome,
  type PlannedPath,
  type PlayerView,
  type ReachableTile,
  type TileIndex,
  type TurnEvent,
  type Unit,
  type UnitId,
  type UnitTypeId,
} from '@sc/core';
import { STOP_TEXT, UNIT_NAME, playerName } from './labels.js';

export interface NewGameOptions {
  readonly size: MapSize;
  readonly density: IslandDensity;
  readonly players: number;
  readonly seed: string;
}

export type Tone = 'info' | 'good' | 'warn' | 'bad';

export interface LogEntry {
  readonly round: number;
  readonly audience: PlayerId | 'all';
  readonly text: string;
  readonly tone: Tone;
}

export interface SavedSession {
  readonly version: 1;
  readonly options: NewGameOptions;
  readonly match: MatchSnapshot;
  readonly log: LogEntry[];
  readonly orders: [UnitId, Coord][];
  readonly awaitingHandoff: boolean;
}

/**
 * Local hot-seat game: several humans share one screen. Wraps the authoritative
 * Match exactly like the server will, and only ever shows the active player their
 * own PlayerView, so the fog of war holds even on a shared screen (the handoff
 * screen hides the map between turns).
 */
export class GameSession {
  readonly log: LogEntry[] = [];
  /** Standing go-to orders, resumed at the start of the owner's turn. */
  readonly orders = new Map<UnitId, Coord>();
  /** Units the player chose to leave alone this turn (skipped by "next unit"). */
  readonly skipped = new Set<UnitId>();
  awaitingHandoff = false;
  private cachedView: PlayerView | null = null;

  private constructor(
    readonly options: NewGameOptions,
    readonly match: Match,
  ) {}

  static create(options: NewGameOptions): GameSession {
    const players = Array.from({ length: options.players }, (_, i) => PlayerId(`p${i + 1}`));
    const map = generateMap({ size: options.size, density: options.density, seed: options.seed }, players);
    const { match, report } = Match.start(map.world, players);
    const s = new GameSession(options, match);
    s.push('all', `Mapa "${options.seed}": ${map.report.cities} ciudades en ${map.report.islands} islas.`, 'info');
    s.pushEvents(report.events);
    return s;
  }

  static restore(saved: SavedSession): GameSession {
    const s = new GameSession(saved.options, Match.fromSnapshot(saved.match));
    s.log.push(...saved.log);
    for (const [id, c] of saved.orders) s.orders.set(id, c);
    s.awaitingHandoff = saved.awaitingHandoff;
    return s;
  }

  save(): SavedSession {
    return {
      version: 1,
      options: this.options,
      match: this.match.toSnapshot(),
      log: this.log.slice(-200),
      orders: [...this.orders],
      awaitingHandoff: this.awaitingHandoff,
    };
  }

  // ─── Read model ─────────────────────────────────────────────────────────────

  get world() { return this.match.world; }
  get players(): readonly PlayerId[] { return this.match.order; }
  get viewer(): PlayerId { return this.match.activePlayer ?? this.match.winner ?? this.players[0]!; }

  playerIndex(p: PlayerId): number {
    return this.players.indexOf(p);
  }

  /** What the active player is allowed to see, rebuilt only when state changes. */
  view(): PlayerView {
    if (!this.cachedView) this.cachedView = buildPlayerView(this.world, this.match.fogs.get(this.viewer)!);
    return this.cachedView;
  }

  invalidate(): void {
    this.cachedView = null;
  }

  ownUnit(id: UnitId): Unit | undefined {
    const u = this.world.unit(id);
    return u && u.owner === this.viewer ? u : undefined;
  }

  /** Own units on a tile: top-level first, then cargo. */
  ownUnitsAt(c: Coord): Unit[] {
    return this.world
      .unitsAt(c)
      .filter((u) => u.owner === this.viewer)
      .sort((a, b) => Number(a.carriedBy !== null) - Number(b.carriedBy !== null));
  }

  reachable(id: UnitId): Map<TileIndex, ReachableTile> {
    const unit = this.ownUnit(id);
    if (!unit) return new Map();
    return reachableThisTurn(fogKnowledge(this.world, this.match.fogs.get(this.viewer)!), unit);
  }

  plan(id: UnitId, goal: Coord): PlannedPath | null {
    const unit = this.ownUnit(id);
    if (!unit) return null;
    return findPath(fogKnowledge(this.world, this.match.fogs.get(this.viewer)!), unit, goal);
  }

  /** Next own unit that can still act this turn, cycling after `after`. */
  nextIdleUnit(after?: UnitId): Unit | undefined {
    const units = this.world
      .unitsOf(this.viewer)
      .filter((u) => u.movesLeft > 0 && !this.skipped.has(u.id) && !this.orders.has(u.id));
    if (units.length === 0) return undefined;
    const i = after ? units.findIndex((u) => u.id === after) : -1;
    return units[(i + 1) % units.length];
  }

  // ─── Commands ───────────────────────────────────────────────────────────────

  /**
   * Move toward `goal`: executes this turn's part of the planned path and keeps a
   * go-to order for the rest. Returns a short status for the UI.
   */
  moveTo(id: UnitId, goal: Coord): string | null {
    const unit = this.ownUnit(id);
    if (!unit) return null;
    const plan = this.plan(id, goal);
    if (!plan || plan.steps.length === 0) return 'No hay camino conocido hasta ahí.';
    this.orders.delete(id);
    this.skipped.delete(id);
    const now = plan.steps.filter((s) => s.turn === 0).map((s) => s.coord);
    if (now.length === 0) {
      this.orders.set(id, goal);
      return `Orden guardada: llega en ${plan.turns - 1} turno(s).`;
    }
    const previousOwners = new Map(now.map((c) => [`${c.x},${c.y}`, this.world.cityAt(c)?.owner ?? null]));
    const r = this.match.move(this.viewer, id, now);
    this.invalidate();
    if (!r.ok) return `Movimiento rechazado: ${r.error.message}`;
    this.reportMove(unit, r.value, previousOwners);
    const arrived = r.value.position.x === goal.x && r.value.position.y === goal.y;
    if (!arrived && r.value.stoppedBy === 'COMPLETED' && this.world.unit(id)) this.orders.set(id, goal);
    if (!arrived && r.value.stoppedBy === 'NO_MOVES_LEFT' && this.world.unit(id)) this.orders.set(id, goal);
    return null;
  }

  setProduction(city: CityId, unit: UnitTypeId): string | null {
    const r = this.match.setProduction(this.viewer, city, unit);
    return r.ok ? null : r.error.message;
  }

  setSpecialization(city: CityId, spec: CitySpecialization): string | null {
    const r = this.match.setSpecialization(this.viewer, city, spec);
    this.invalidate();
    return r.ok ? null : r.error.message;
  }

  setSilentRunning(id: UnitId, on: boolean): string | null {
    const r = this.match.setSilentRunning(this.viewer, id, on);
    this.invalidate();
    return r.ok ? null : r.error.message;
  }

  skip(id: UnitId): void {
    this.skipped.add(id);
  }

  cancelOrder(id: UnitId): void {
    this.orders.delete(id);
  }

  endTurn(): void {
    const r = this.match.endTurn(this.viewer);
    if (!r.ok) return;
    this.skipped.clear();
    this.pushEvents(r.value.events);
    this.invalidate();
    if (this.match.status === 'playing') this.awaitingHandoff = true;
  }

  /** The next player took the seat: resume their standing orders. */
  beginTurn(): void {
    this.awaitingHandoff = false;
    for (const [id, goal] of [...this.orders]) {
      const unit = this.world.unit(id);
      if (!unit) {
        this.orders.delete(id);
        continue;
      }
      if (unit.owner !== this.viewer) continue;
      this.moveTo(id, goal);
      if (this.match.status !== 'playing') break;
    }
    this.invalidate();
  }

  // ─── Log ────────────────────────────────────────────────────────────────────

  visibleLog(): LogEntry[] {
    return this.log.filter((e) => e.audience === 'all' || e.audience === this.viewer);
  }

  private push(audience: PlayerId | 'all', text: string, tone: Tone): void {
    this.log.push({ round: this.match.round, audience, text, tone });
  }

  private unitLabel(type: UnitTypeId, id: UnitId): string {
    return `${UNIT_NAME[type]} ${id.replace(/^u/, '#')}`;
  }

  private reportMove(
    unit: Unit,
    out: MoveOutcome & { events: TurnEvent[] },
    previousOwners: ReadonlyMap<string, PlayerId | null>,
  ): void {
    const me = this.viewer;
    if (out.captured) {
      const city = this.world.city(out.captured)!;
      this.push(me, `Capturaste ${city.name}.`, 'good');
      // An owner always learns it lost a city, even without eyes on it.
      const before = previousOwners.get(`${city.position.x},${city.position.y}`);
      if (before) this.push(before, `Perdiste ${city.name}.`, 'bad');
    }
    if (out.stoppedBy === 'CRASHED') {
      this.orders.delete(unit.id);
      this.push(me, `${this.unitLabel(unit.type, unit.id)} ${STOP_TEXT.CRASHED}`, 'bad');
    } else if (out.stoppedBy === 'CONTACT' || out.stoppedBy === 'BLOCKED') {
      this.orders.delete(unit.id);
      this.push(me, STOP_TEXT[out.stoppedBy]!, 'warn');
    }
    this.pushEvents(out.events);
  }

  private pushEvents(events: readonly TurnEvent[]): void {
    for (const e of events) {
      switch (e.type) {
        case 'unit_produced': {
          const city = this.world.city(e.city);
          this.push(e.audience, `${city?.name ?? 'Una ciudad'} completó ${UNIT_NAME[e.unitType]}.`, 'info');
          break;
        }
        case 'aircraft_crashed':
          this.push(e.audience, `${this.unitLabel(e.unitType, e.unit)} ${STOP_TEXT.CRASHED}`, 'bad');
          break;
        case 'aircraft_landed':
          this.push(e.audience, `Un avión aterrizó en su portaaviones.`, 'info');
          break;
        case 'out_of_supply':
          this.push(e.audience, `Una unidad está sin suministro (${e.turns} turno${e.turns === 1 ? '' : 's'}).`, 'warn');
          break;
        case 'player_eliminated':
          this.push('all', `${playerName(this.playerIndex(e.player))} fue eliminado.`, 'bad');
          break;
        case 'match_won':
          this.push(
            'all',
            `${playerName(this.playerIndex(e.player))} gana la partida ${e.reason === 'city_share' ? 'por control de ciudades' : 'por ser el último en pie'}.`,
            'good',
          );
          break;
      }
    }
  }
}
