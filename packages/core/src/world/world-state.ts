import { City, type CityState } from '../cities/city.js';
import type { Coord, TileIndex } from '../grid/coords.js';
import { Grid, type GridSnapshot } from '../grid/grid.js';
import { IdSequence, type CityId, type PlayerId, type UnitId } from '../shared/ids.js';
import { err, invariant, ok, type Result } from '../shared/result.js';
import { Unit, type UnitError, type UnitState } from '../units/unit.js';
import type { UnitTypeId } from '../units/unit-types.js';

export interface WorldSnapshot {
  readonly turn: number;
  readonly idCursor: number;
  readonly grid: GridSnapshot;
  readonly units: UnitState[];
  readonly cities: CityState[];
}

/**
 * Authoritative match state on the server. Owns the entities and keeps spatial
 * indexes (tile -> units, tile -> city) consistent with them. Nothing outside this
 * class moves a unit or changes its carrier, so the indexes can't drift.
 */
export class WorldState {
  turn = 1;
  private readonly units = new Map<UnitId, Unit>();
  private readonly cities = new Map<CityId, City>();
  private readonly unitsByTile = new Map<TileIndex, UnitId[]>();
  private readonly cityByTile = new Map<TileIndex, CityId>();

  constructor(
    readonly grid: Grid,
    private readonly ids = new IdSequence(),
  ) {}

  // ─── Queries ────────────────────────────────────────────────────────────────

  unit(id: UnitId): Unit | undefined {
    return this.units.get(id);
  }

  city(id: CityId): City | undefined {
    return this.cities.get(id);
  }

  allUnits(): IterableIterator<Unit> {
    return this.units.values();
  }

  allCities(): IterableIterator<City> {
    return this.cities.values();
  }

  unitsOf(player: PlayerId): Unit[] {
    return [...this.units.values()].filter((u) => u.owner === player);
  }

  citiesOf(player: PlayerId): City[] {
    return [...this.cities.values()].filter((c) => c.owner === player);
  }

  /** Every unit on the tile, including cargo. */
  unitsAt(c: Coord): Unit[] {
    return (this.unitsByTile.get(this.grid.index(c)) ?? []).map((id) => this.units.get(id)!);
  }

  cityAt(c: Coord): City | undefined {
    const id = this.cityByTile.get(this.grid.index(c));
    return id === undefined ? undefined : this.cities.get(id);
  }

  // ─── Mutations ──────────────────────────────────────────────────────────────

  foundCity(name: string, at: Coord): City {
    invariant(this.grid.isLand(at), `city ${name} must be on land`);
    invariant(!this.cityAt(at), `tile ${at.x},${at.y} already has a city`);
    const city = City.create(this.ids.city(), name, at, this.grid.isCoastal(at));
    this.cities.set(city.id, city);
    this.cityByTile.set(this.grid.index(at), city.id);
    return city;
  }

  spawnUnit(type: UnitTypeId, owner: PlayerId, at: Coord): Unit {
    const unit = Unit.create(this.ids.unit(), type, owner, at);
    this.units.set(unit.id, unit);
    this.indexAdd(unit.id, at);
    return unit;
  }

  /** Removes a unit and everything it carries (a sunk transport drowns its cargo). */
  removeUnit(id: UnitId): UnitId[] {
    const unit = this.units.get(id);
    if (!unit) return [];
    const removed: UnitId[] = [];
    for (const cargoId of [...unit.cargo]) removed.push(...this.removeUnit(cargoId));
    if (unit.carriedBy) this.units.get(unit.carriedBy)?._removeCargo(id);
    this.indexRemove(id, unit.position);
    this.units.delete(id);
    removed.push(id);
    return removed;
  }

  /** Apply a validated step; cargo is carried along. */
  stepUnit(id: UnitId, to: Coord, cost: number): Result<void, UnitError> {
    const unit = this.units.get(id);
    invariant(unit, `unknown unit ${id}`);
    invariant(this.grid.inBounds(to), 'destination out of bounds');
    const from = unit.position;
    const r = unit.stepTo(to, cost);
    if (!r.ok) return r;
    this.indexMove(id, from, to);
    this.moveCargo(unit, from, to);
    return ok(undefined);
  }

  load(carrierId: UnitId, cargoId: UnitId): Result<void, UnitError> {
    const carrier = this.units.get(carrierId);
    const cargo = this.units.get(cargoId);
    invariant(carrier && cargo, 'unknown unit');
    invariant(carrier.owner === cargo.owner, 'cannot load enemy units');
    const r = carrier.canCarry(cargo);
    if (!r.ok) return r;
    carrier._addCargo(cargoId);
    cargo._setCarrier(carrierId);
    if (!sameTile(cargo.position, carrier.position)) {
      this.indexMove(cargoId, cargo.position, carrier.position);
      cargo.syncPositionWithCarrier(carrier.position);
    }
    return ok(undefined);
  }

  /** Detach cargo; it stays on the carrier's tile until it moves (e.g. disembarks). */
  unload(carrierId: UnitId, cargoId: UnitId): Result<void, UnitError> {
    const carrier = this.units.get(carrierId);
    const cargo = this.units.get(cargoId);
    invariant(carrier && cargo, 'unknown unit');
    if (!carrier._removeCargo(cargoId)) return err('NOT_CARRYING', 'unit is not aboard');
    cargo._setCarrier(null);
    return ok(undefined);
  }

  captureCity(cityId: CityId, newOwner: PlayerId): void {
    const city = this.cities.get(cityId);
    invariant(city, `unknown city ${cityId}`);
    city.capture(newOwner);
  }

  // ─── Persistence ────────────────────────────────────────────────────────────

  toSnapshot(): WorldSnapshot {
    return {
      turn: this.turn,
      idCursor: this.ids.cursor,
      grid: this.grid.toSnapshot(),
      units: [...this.units.values()].map((u) => u.toSnapshot()),
      cities: [...this.cities.values()].map((c) => c.toSnapshot()),
    };
  }

  static fromSnapshot(s: WorldSnapshot): WorldState {
    const w = new WorldState(Grid.fromSnapshot(s.grid), new IdSequence(s.idCursor));
    w.turn = s.turn;
    for (const cs of s.cities) {
      const c = City.fromSnapshot(cs);
      w.cities.set(c.id, c);
      w.cityByTile.set(w.grid.index(c.position), c.id);
    }
    for (const us of s.units) {
      const u = Unit.fromSnapshot(us);
      w.units.set(u.id, u);
      w.indexAdd(u.id, u.position);
    }
    return w;
  }

  // ─── Index maintenance ──────────────────────────────────────────────────────

  private moveCargo(carrier: Unit, from: Coord, to: Coord): void {
    for (const cargoId of carrier.cargo) {
      const cargo = this.units.get(cargoId)!;
      this.indexMove(cargoId, from, to);
      cargo.syncPositionWithCarrier(to);
      this.moveCargo(cargo, from, to);
    }
  }

  private indexAdd(id: UnitId, at: Coord): void {
    const i = this.grid.index(at);
    const list = this.unitsByTile.get(i);
    if (list) list.push(id);
    else this.unitsByTile.set(i, [id]);
  }

  private indexRemove(id: UnitId, at: Coord): void {
    const i = this.grid.index(at);
    const list = this.unitsByTile.get(i);
    if (!list) return;
    const k = list.indexOf(id);
    if (k >= 0) list.splice(k, 1);
    if (list.length === 0) this.unitsByTile.delete(i);
  }

  private indexMove(id: UnitId, from: Coord, to: Coord): void {
    this.indexRemove(id, from);
    this.indexAdd(id, to);
  }
}

const sameTile = (a: Coord, b: Coord) => a.x === b.x && a.y === b.y;
