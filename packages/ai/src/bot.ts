import {
  findPath,
  fogKnowledge,
  forecastAttack,
  planAttack,
  type City,
  type Coord,
  type MapKnowledge,
  type Match,
  type PlannedPath,
  type PlayerFogMap,
  type PlayerId,
  type TileIndex,
  type TurnEvent,
  type Unit,
  type UnitId,
  type UnitTypeId,
} from '@sc/core';

export interface BotReport {
  /** Everything the bot's commands produced, for the host to route by audience. */
  readonly events: TurnEvent[];
  readonly moves: number;
  readonly attacks: number;
}

/** How many destinations a unit tries to path to before giving up (keeps turns fast). */
const MAX_PATH_TRIES = 6;
/** Plans further out than this are not worth searching for: the map will change first. */
const SEARCH_TURNS = 12;
/** An attack is taken if expected damage dealt beats damage taken by this factor. */
const ATTACK_EDGE = 1.2;
/** Enemies this close to an ungarrisoned own city make the bot pull a defender in. */
const THREAT_RADIUS = 5;

/**
 * A simple, honest bot. It plays one turn through the same Match commands a human
 * uses and decides only from its own fog map (known cities, detected units, explored
 * tiles), so it cannot see through the fog.
 *
 * Strategy, in priority order per unit:
 *  1. take favorable attacks from where it stands;
 *  2. infantry: defend threatened cities, capture the nearest known foreign city
 *     reachable overland, else explore its island, else wait for a transport;
 *  3. transports: ferry waiting infantry to the nearest foreign coast;
 *  4. warships hunt known enemy ships, else explore the sea;
 *  5. fighters scout within half their fuel range and come home.
 * Cities build infantry while their island has work, then transports and escorts.
 */
export function playBotTurn(match: Match, player: PlayerId): BotReport {
  return new BotTurn(match, player).run();
}

/**
 * The one thing the bot remembers between turns: how many land units had nothing to
 * do last turn. It drives production (no point building infantry nobody can use).
 * Kept outside the match on purpose: losing it (e.g. after a reload) only costs a
 * turn of slightly worse production.
 */
const idleLastTurn = new WeakMap<Match, Map<PlayerId, number>>();

class BotTurn {
  private readonly events: TurnEvent[] = [];
  private moves = 0;
  private attacks = 0;
  private readonly fog: PlayerFogMap;
  private readonly known: MapKnowledge;
  /** Land units with nothing to do on their island: candidates for a transport. */
  private readonly waiting = new Set<UnitId>();
  private unexplored: Coord[] = [];
  /**
   * Known landmasses: connected explored land tiles share a label (-1 = water or
   * unexplored). Lets the bot skip path searches to places no land route can reach.
   */
  private landmass = new Int32Array(0);
  private readonly frontierOf = new Map<number, Coord[]>();
  private readonly foreignCitiesOf = new Map<number, Coord[]>();

  constructor(
    private readonly match: Match,
    private readonly me: PlayerId,
  ) {
    this.fog = match.fogs.get(me)!;
    this.known = fogKnowledge(match.world, this.fog);
  }

  private get world() {
    return this.match.world;
  }

  run(): BotReport {
    if (this.match.activePlayer !== this.me) return this.report();
    this.indexUnexplored();
    this.indexLandmasses();
    this.manageProduction();

    const mine = () => this.world.unitsOf(this.me);
    for (const u of mine()) if (u.def.stealth && !u.silentRunning) this.match.setSilentRunning(this.me, u.id, true);

    // Order matters: infantry walks to the docks before transports sail, and cargo
    // acts last so it can storm the beach the transport just reached.
    for (const u of mine().filter((u) => u.def.domain === 'land' && u.carriedBy === null)) this.actLand(u.id);
    for (const u of mine().filter((u) => u.def.cargo?.accepts.includes('land'))) this.actTransport(u.id);
    for (const u of mine().filter((u) => u.def.domain === 'land' && u.carriedBy !== null)) this.actCargo(u.id);
    for (const u of mine().filter((u) => u.def.domain === 'sea' && !u.def.cargo)) this.actWarship(u.id);
    for (const u of mine().filter((u) => u.def.domain === 'air' && u.carriedBy === null)) this.actAircraft(u.id);

    const memory = idleLastTurn.get(this.match) ?? new Map<PlayerId, number>();
    memory.set(this.me, this.waiting.size);
    idleLastTurn.set(this.match, memory);
    return this.report();
  }

  private report(): BotReport {
    return { events: this.events, moves: this.moves, attacks: this.attacks };
  }

  // ─── Production ──────────────────────────────────────────────────────────────

  /**
   * Cities build infantry while their island still has work. Surplus troops (idle
   * land units in own cities beyond one garrison each) call for transports; once the
   * surplus is large, cities stop adding infantry and build fighting units instead,
   * which keeps the army from snowballing into hundreds of idle units.
   */
  private manageProduction(): void {
    const units = this.world.unitsOf(this.me);
    const count = (t: UnitTypeId) => units.filter((u) => u.type === t).length;
    const cities = this.world.citiesOf(this.me);
    const surplus = idleLastTurn.get(this.match)?.get(this.me) ?? 0;
    let transports = count('transport');
    let destroyers = count('destroyer');
    let fighters = count('fighter');
    let infantryQueued = 0;

    for (const city of cities) {
      // Never throw away progress: only (re)plan between units.
      if (city.production && city.production.progress > 0) continue;
      let want: UnitTypeId;
      if (this.islandHasWork(city) && surplus < 4) {
        want = infantryQueued % 4 === 3 ? 'heavy_tank' : 'infantry';
        infantryQueued++;
      } else if (city.isCoastal && transports < Math.min(8, 1 + Math.ceil(surplus / 3))) {
        want = 'transport';
        transports++;
      } else if (city.isCoastal && destroyers < Math.ceil(cities.length / 3)) {
        want = 'destroyer';
        destroyers++;
      } else if (fighters < Math.ceil(cities.length / 5)) {
        want = 'fighter';
        fighters++;
      } else {
        // Fleet and air wing are at strength: more troops to ship, or slow-to-build armor.
        want = surplus < 8 ? 'infantry' : 'heavy_tank';
      }
      if (city.production?.unit !== want) this.match.setProduction(this.me, city.id, want);
    }
  }

  /** Is there a foreign city or unexplored land reachable overland from this city? */
  private islandHasWork(city: City): boolean {
    const m = this.landmass[this.world.grid.index(city.position)]!;
    return (this.frontierOf.get(m)?.length ?? 0) > 0 || (this.foreignCitiesOf.get(m)?.length ?? 0) > 0;
  }

  // ─── Unit behaviors ──────────────────────────────────────────────────────────

  private actLand(id: UnitId): void {
    if (this.tryAttack(id)) return;
    const u = this.alive(id);
    if (!u || u.movesLeft <= 0) return;
    if (this.defendThreatenedCity(u)) return;

    if (u.def.canCaptureCities) {
      if (this.goToForeignCityOverland(u)) return;
    } else if (u.def.attack > 0 && this.closeInOnEnemy(u)) {
      // Tanks can't take cities: they hunt known enemy land units instead.
      this.tryAttack(id);
      return;
    }
    if (this.explore(u, { overlandOnly: true })) return;

    // Nothing left on this island: board a transport, walk to one, or wait for one.
    if (u.def.attack <= 0) return;
    this.waiting.add(id);
    // Only transports this unit can actually walk to: docked on its landmass or
    // anchored right off its coast.
    const mine = this.landmass[this.world.grid.index(u.position)]!;
    const touches = (c: Coord) =>
      this.landmass[this.world.grid.index(c)] === mine ||
      this.world.grid.neighbors(c).some((n) => this.landmass[this.world.grid.index(n)] === mine);
    const ships = this.world.unitsOf(this.me).filter(
      (t) => t.def.cargo?.accepts.includes('land') && t.cargo.length < t.def.cargo.slots && touches(t.position),
    );
    const here = ships.find((t) => this.dist(t.position, u.position) === 0);
    if (here) {
      if (this.match.board(this.me, u.id, here.id).ok) this.moves++;
      return;
    }
    const ship = this.nearest(u.position, ships);
    if (ship) this.moveToward(u, ship.position);
  }

  /** Move next to the nearest known enemy land unit reachable overland. */
  private closeInOnEnemy(u: Unit): boolean {
    const targets = this.detectedEnemies()
      .filter((e) => e.def.domain === 'land')
      .sort((a, b) => this.dist(u.position, a.position) - this.dist(u.position, b.position))
      .slice(0, 3);
    return targets.some((e) => this.moveToBeside(u, e.position));
  }

  private actCargo(id: UnitId): void {
    const u = this.alive(id);
    if (!u || u.movesLeft <= 0) return;
    if (this.tryAttack(id)) return;
    // Only leave the boat for an overland objective; otherwise keep riding.
    if (u.def.canCaptureCities) {
      if (this.goToForeignCityOverland(u, { requireFirstStepAshore: true })) return;
      this.explore(u, { overlandOnly: true, requireFirstStepAshore: true });
      return;
    }
    // Armor lands next to a foreign city to cover the infantry taking it.
    const cities = this.landmassesFor(u)
      .flatMap((m) => this.foreignCitiesOf.get(m) ?? [])
      .sort((a, b) => this.dist(u.position, a) - this.dist(u.position, b))
      .slice(0, 2);
    for (const c of cities) {
      for (const spot of this.world.grid.neighbors(c)) {
        const i = this.world.grid.index(spot);
        if (!this.fog.isExplored(i) || !this.world.grid.isLand(spot) || this.world.cityAt(spot)) continue;
        const path = findPath(this.known, u, spot, { maxTurns: SEARCH_TURNS });
        if (path && this.isOverland(path, true)) {
          this.follow(u, path);
          return;
        }
      }
    }
  }

  private actTransport(id: UnitId): void {
    const t = this.alive(id);
    if (!t || t.movesLeft <= 0) return;
    const waiting = [...this.waiting]
      .map((w) => this.world.unit(w))
      .filter((w): w is Unit => !!w && w.carriedBy === null);
    const nearbyWaiting = waiting.filter((w) => this.dist(w.position, t.position) <= 6);
    const full = t.cargo.length >= (t.def.cargo?.slots ?? 0);

    if (t.cargo.length === 0 || (!full && t.cargo.length < 2 && nearbyWaiting.length > 0)) {
      // Pick-up: sit in the own port closest to the idle infantry; they walk aboard.
      const ports = this.world.citiesOf(this.me).filter((c) => c.isCoastal);
      const anchor = this.nearest(t.position, waiting);
      const port = anchor ? this.nearest(anchor.position, ports) : undefined;
      if (port && this.dist(port.position, t.position) > 0) this.moveToward(t, port.position);
      return;
    }
    // Deliver: nearest known foreign city with a reachable water tile beside it, else unexplored coast.
    const targets = this.foreignCities()
      .filter((c) => !this.sameIslandAsAnyOwnCity(c.position))
      .sort((a, b) => this.dist(t.position, a.position) - this.dist(t.position, b.position));
    for (const c of targets.slice(0, MAX_PATH_TRIES)) if (this.moveToBeside(t, c.position)) return;
    this.explore(t, {});
  }

  private actWarship(id: UnitId): void {
    if (this.tryAttack(id)) return;
    const u = this.alive(id);
    if (!u || u.movesLeft <= 0) return;
    const byDistance = (a: { position: Coord }, b: { position: Coord }) =>
      this.dist(u.position, a.position) - this.dist(u.position, b.position);
    // 1. Hunt the closest known enemy ship.
    const prey = this.detectedEnemies()
      .filter((e) => e.def.domain === 'sea' && this.dist(e.position, u.position) <= 12)
      .sort(byDistance)[0];
    // 2. Otherwise take the fight to the nearest known enemy-held coast.
    const coast = this.foreignCities()
      .filter((c) => c.owner !== null)
      .sort(byDistance)
      .slice(0, 2);
    for (const target of [...(prey ? [prey] : []), ...coast]) {
      if (this.moveToBeside(u, target.position)) {
        this.tryAttack(id);
        return;
      }
    }
    // 3. Otherwise scout the sea.
    this.explore(u, {});
  }

  private actAircraft(id: UnitId): void {
    if (this.tryAttack(id)) return;
    const u = this.alive(id);
    if (!u || u.movesLeft <= 0 || u.fuel === null) return;
    const home = this.nearest(u.position, this.world.citiesOf(this.me));
    if (!home) return;
    const atHome = this.dist(u.position, home.position) === 0;
    if (!atHome) {
      this.moveToward(u, home.position); // always come back the turn after a sortie
      return;
    }
    // Sortie radius: out this turn, back next turn, with loiter fuel accounted for.
    const radius = Math.floor(u.fuel / 2) - 1;
    const goal = this.unexplored
      .filter((c) => this.dist(c, home.position) <= Math.min(radius, u.movesLeft))
      .sort((a, b) => this.dist(b, home.position) - this.dist(a, home.position))[0];
    if (goal) this.moveToward(u, goal);
  }

  // ─── Building blocks ─────────────────────────────────────────────────────────

  /** Take the best favorable attack available from the unit's current position. */
  private tryAttack(id: UnitId): boolean {
    const u = this.alive(id);
    if (!u || u.def.attack <= 0 || u.attackedThisTurn || u.movesLeft <= 0) return false;
    const reach = u.def.attackRange?.max ?? 1;
    let best: { at: Coord; score: number } | null = null;
    for (const e of this.detectedEnemies()) {
      const d = this.dist(e.position, u.position);
      if (d > reach) continue;
      const plan = planAttack(this.world, this.fog, this.me, id, e.position);
      if (!plan.ok) continue;
      const f = forecastAttack(this.world, plan.value);
      const kills = plan.value.defender !== null && f.damageToDefender >= plan.value.defender.hp;
      const taken = f.damageToAttacker + f.interceptionDamage;
      if (!kills && f.damageToDefender < taken * ATTACK_EDGE) continue;
      if (taken >= u.hp) continue; // suicide
      const score = f.damageToDefender - taken + (kills ? 5 : 0);
      if (!best || score > best.score) best = { at: e.position, score };
    }
    if (!best) return false;
    const r = this.match.attack(this.me, id, best.at);
    if (!r.ok) return false;
    this.attacks++;
    this.events.push(...r.value.events);
    return true;
  }

  private defendThreatenedCity(u: Unit): boolean {
    const enemies = this.detectedEnemies().filter((e) => e.def.domain === 'land');
    if (enemies.length === 0) return false;
    for (const city of this.world.citiesOf(this.me)) {
      const garrisoned = this.world.unitsAt(city.position).some((x) => x.owner === this.me && x.def.domain === 'land');
      if (garrisoned) continue;
      if (!enemies.some((e) => this.dist(e.position, city.position) <= THREAT_RADIUS)) continue;
      if (this.dist(u.position, city.position) > 4) continue;
      if (this.moveToward(u, city.position)) return true;
    }
    return false;
  }

  private goToForeignCityOverland(u: Unit, opts: { requireFirstStepAshore?: boolean } = {}): boolean {
    const candidates = this.landmassesFor(u)
      .flatMap((m) => this.foreignCitiesOf.get(m) ?? [])
      .map((position) => ({ position }))
      .sort((a, b) => this.dist(u.position, a.position) - this.dist(u.position, b.position))
      .slice(0, MAX_PATH_TRIES);
    for (const c of candidates) {
      const path = findPath(this.known, u, c.position, { maxTurns: SEARCH_TURNS });
      if (!path || !this.isOverland(path, opts.requireFirstStepAshore)) continue;
      return this.follow(u, path);
    }
    return false;
  }

  private explore(u: Unit, opts: { overlandOnly?: boolean; requireFirstStepAshore?: boolean }): boolean {
    // Unexplored terrain is unknown, so any frontier tile is a candidate; the path is
    // planned on the bot's own knowledge and gets corrected as the fog lifts. Land
    // units only consider the fog's edge around landmasses they can walk on.
    const pool = opts.overlandOnly
      ? this.landmassesFor(u).flatMap((m) => this.frontierOf.get(m) ?? [])
      : this.unexplored;
    const candidates = pool
      .slice()
      .sort((a, b) => this.dist(u.position, a) - this.dist(u.position, b))
      .slice(0, MAX_PATH_TRIES);
    for (const c of candidates) {
      const path = findPath(this.known, u, c, { maxTurns: SEARCH_TURNS });
      if (!path || path.steps.length === 0) continue;
      if (opts.overlandOnly && !this.isOverland(path, opts.requireFirstStepAshore)) continue;
      return this.follow(u, path);
    }
    return false;
  }

  /** Overland = never boards a transport (and, for cargo, starts by stepping ashore). */
  private isOverland(path: PlannedPath, firstStepAshore = false): boolean {
    if (path.steps.some((s) => s.kind === 'board')) return false;
    if (firstStepAshore && path.steps[0] && !this.world.grid.isLand(path.steps[0].coord)) return false;
    return true;
  }

  private moveToward(u: Unit, goal: Coord): boolean {
    const path = findPath(this.known, u, goal, { maxTurns: SEARCH_TURNS });
    return path ? this.follow(u, path) : false;
  }

  /** Move next to `target` (for ships and transports, onto a reachable neighboring tile). */
  private moveToBeside(u: Unit, target: Coord): boolean {
    // Ships can only use known water (or an own port); try the 3 closest such spots.
    const naval = u.def.domain === 'sea';
    const spots = this.world.grid
      .neighbors(target)
      .filter((c) => !naval || this.isKnownWaterOrPort(c))
      .sort((a, b) => this.dist(u.position, a) - this.dist(u.position, b))
      .slice(0, 3);
    for (const s of spots) {
      if (s.x === u.position.x && s.y === u.position.y) return true;
      const path = findPath(this.known, u, s, { maxTurns: SEARCH_TURNS });
      if (path && path.steps.every((st) => st.kind === 'move')) return this.follow(u, path);
    }
    return false;
  }

  /** Execute this turn's part of a path. */
  private follow(u: Unit, path: PlannedPath): boolean {
    const now = path.steps.filter((s) => s.turn === 0).map((s) => s.coord);
    if (now.length === 0) return false;
    const r = this.match.move(this.me, u.id, now);
    if (!r.ok) return false;
    this.moves++;
    this.events.push(...r.value.events);
    return true;
  }

  // ─── Knowledge (fog-limited) ─────────────────────────────────────────────────

  private indexUnexplored(): void {
    const { grid } = this.world;
    this.unexplored = [];
    // Only the fog's edge matters: unexplored tiles next to explored ones.
    for (let i = 0; i < grid.size; i++) {
      if (this.fog.isExplored(i)) continue;
      const c = grid.coordOf(i);
      if (grid.neighbors(c).some((n) => this.fog.isExplored(grid.index(n)))) this.unexplored.push(c);
    }
  }

  /** Label explored land into landmasses and file frontier tiles and targets under each. */
  private indexLandmasses(): void {
    const { grid } = this.world;
    const label = new Int32Array(grid.size).fill(-1);
    const isKnownLand = (i: number) => this.fog.isExplored(i) && grid.isLand(grid.coordOf(i));
    let next = 0;
    for (let start = 0; start < grid.size; start++) {
      if (label[start] !== -1 || !isKnownLand(start)) continue;
      const m = next++;
      const frontier = new Map<number, Coord>();
      const stack = [start];
      label[start] = m;
      while (stack.length) {
        const c = grid.coordOf(stack.pop()!);
        for (const n of grid.neighbors(c)) {
          const j = grid.index(n);
          if (!this.fog.isExplored(j)) frontier.set(j, n);
          else if (label[j] === -1 && isKnownLand(j)) {
            label[j] = m;
            stack.push(j);
          }
        }
      }
      this.frontierOf.set(m, [...frontier.values()]);
    }
    this.landmass = label;
    for (const c of this.foreignCities()) {
      const m = label[grid.index(c.position)]!;
      if (m < 0) continue;
      const list = this.foreignCitiesOf.get(m);
      if (list) list.push(c.position);
      else this.foreignCitiesOf.set(m, [c.position]);
    }
  }

  /** Landmasses a land unit can step onto: its own, or (aboard) those beside its boat. */
  private landmassesFor(u: Unit): number[] {
    const { grid } = this.world;
    const here = this.landmass[grid.index(u.position)]!;
    if (u.carriedBy === null && here >= 0) return [here];
    const set = new Set<number>();
    for (const n of grid.neighbors(u.position)) {
      const m = this.landmass[grid.index(n)]!;
      if (m >= 0) set.add(m);
    }
    return [...set];
  }

  private foreignCities(): { position: Coord; owner: PlayerId | null }[] {
    return [...this.fog.knownCities.values()].filter((c) => this.world.city(c.id)?.owner !== this.me && c.owner !== this.me);
  }

  private detectedEnemies(): Unit[] {
    const out: Unit[] = [];
    for (const id of this.fog.detectedUnits) {
      const u = this.world.unit(id);
      if (u && u.owner !== this.me && u.carriedBy === null) out.push(u);
    }
    return out;
  }

  private sameIslandAsAnyOwnCity(c: Coord): boolean {
    // Cheap proxy: a foreign city within 3 tiles overland of an own city is "ours to walk to".
    return this.world.citiesOf(this.me).some((own) => this.dist(own.position, c) <= 3);
  }

  private isKnownWaterOrPort(c: Coord): boolean {
    const i = this.world.grid.index(c);
    if (!this.fog.isExplored(i)) return false;
    if (this.world.grid.isWater(c)) return true;
    return this.world.cityAt(c)?.owner === this.me;
  }

  private alive(id: UnitId): Unit | undefined {
    const u = this.world.unit(id);
    return u && u.owner === this.me ? u : undefined;
  }

  private nearest<T extends { position: Coord }>(from: Coord, items: readonly T[]): T | undefined {
    let best: T | undefined;
    let bd = Infinity;
    for (const it of items) {
      const d = this.dist(from, it.position);
      if (d < bd) [best, bd] = [it, d];
    }
    return best;
  }

  private dist(a: Coord, b: Coord): number {
    return this.world.grid.distance(a, b);
  }
}
