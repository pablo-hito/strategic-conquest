import {
  EFFECTIVENESS,
  Rng,
  UNIT_TYPES,
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
  type TurnEvent,
  type Unit,
  type UnitId,
  type UnitTypeId,
} from '@sc/core';
import { PERSONALITIES, PERSONALITY_IDS, type Mix, type Personality, type PersonalityId } from './personalities.js';
import type { BotReport } from './simple-bot.js';

/** Destinations tried per unit before giving up on a goal (keeps turns fast). */
const MAX_PATH_TRIES = 5;
/** Plans further out than this are not searched: the map will have changed first. */
const SEARCH_TURNS = 10;
/**
 * Destinations on the unit's own known landmass are reachable by construction, so a
 * long search can't be a costly failure: let units cross a whole continent.
 */
const LOCAL_SEARCH_TURNS = 40;
/** Enemy land units this close to an own city count as a threat to it. */
const THREAT_RADIUS = 5;
/** A loaded expedition waits at most this long at the staging port for stragglers. */
const MAX_STAGING_WAIT = 3;

export type Phase = 'expand' | 'war';

export interface BotOptions {
  /** Force a personality (otherwise derived from the match, so it varies per game). */
  readonly personality?: PersonalityId;
  /** Development hook: the bot's reading of the game at the end of its turn. */
  readonly debug?: (info: BotDebugInfo) => void;
}

export interface BotDebugInfo {
  readonly phase: Phase;
  readonly target: Coord | null;
  readonly staging: Coord | null;
  readonly waiting: number;
  readonly garrison: number;
}

/**
 * What the bot remembers between turns. Kept outside the match on purpose: after a
 * reload it is rebuilt from the board, and the personality is derived again from the
 * same inputs, so nothing important is lost.
 */
interface Memory {
  personality: PersonalityId;
  /** Current offensive objective (an enemy or neutral city across the sea or the island). */
  target: Coord | null;
  /** Round the loaded expedition started waiting at the staging port. */
  stagingSince: number | null;
  /** Land units that had nothing to do last turn (drives transport production). */
  idleLast: number;
  /** Own city count last turn: a drop means we are being attacked. */
  citiesLast: number;
  /** Until this round the bot fights defensively after losing a city. */
  alertUntil: number;
}

const memories = new WeakMap<Match, Map<PlayerId, Memory>>();

/** The personality this bot plays with in this match (stable across reloads). */
export function botPersonality(match: Match, player: PlayerId, opts: BotOptions = {}): Personality {
  return PERSONALITIES[memoryFor(match, player, opts).personality];
}

function memoryFor(match: Match, player: PlayerId, opts: BotOptions): Memory {
  let byPlayer = memories.get(match);
  if (!byPlayer) memories.set(match, (byPlayer = new Map()));
  let m = byPlayer.get(player);
  if (!m) {
    m = {
      personality: opts.personality ?? derivePersonality(match, player),
      target: null,
      stagingSince: null,
      idleLast: 0,
      citiesLast: match.world.citiesOf(player).length,
      alertUntil: 0,
    };
    byPlayer.set(player, m);
  }
  if (opts.personality) m.personality = opts.personality;
  return m;
}

/** Varies from game to game (map + seat), but is the same every time for one match. */
function derivePersonality(match: Match, player: PlayerId): PersonalityId {
  const names = [...match.world.allCities()].map((c) => c.name).join('|');
  const rng = new Rng(`personality:${player}:${match.world.grid.width}x${match.world.grid.height}:${names}`);
  return PERSONALITY_IDS[Math.floor(rng.next() * PERSONALITY_IDS.length)]!;
}

/**
 * Strategic bot. It plays one turn through the same Match commands a human uses and
 * decides only from its own fog map, so it cannot see through the fog.
 *
 * Each match it plays one of four personalities (expansionist, blitz, fortress,
 * admiral) that differ in timing, army mix, how hard they hold cities and how big a
 * force they gather before striking. The game plan:
 *  - expand: infantry takes every reachable neutral city, transports ferry troops to
 *    other islands, recon drones scout the map;
 *  - war: cities switch to the personality's war mix; a strike force gathers at the
 *    port nearest the chosen target and lands all at once (the surprise attack),
 *    while warships hunt transports and aircraft strike what they can reach;
 *  - always: hold a garrison in every city, answer landings on its islands, take
 *    favorable fights, and switch to defense for a while after losing a city.
 */
export function playBotTurn(match: Match, player: PlayerId, opts: BotOptions = {}): BotReport {
  return new StrategicTurn(match, player, memoryFor(match, player, opts), opts.debug).run();
}

class StrategicTurn {
  private readonly events: TurnEvent[] = [];
  private moves = 0;
  private attacks = 0;
  private readonly fog: PlayerFogMap;
  private readonly known: MapKnowledge;
  private readonly p: Personality;
  private readonly rng: Rng;
  private phase: Phase = 'expand';

  // Board knowledge, rebuilt every turn from the fog map only.
  private landmass = new Int32Array(0);
  private readonly frontierOf = new Map<number, Coord[]>();
  private readonly neutralOf = new Map<number, Coord[]>();
  private readonly enemyCitiesOf = new Map<number, Coord[]>();
  private unexplored: Coord[] = [];
  private enemies: Unit[] = [];
  private readonly garrison = new Set<UnitId>();
  /** Explorers sent per landmass this turn (a couple are enough; the rest stay useful). */
  private readonly explorers = new Map<number, number>();
  private readonly waiting = new Set<UnitId>();
  private staging: Coord | null = null;

  constructor(
    private readonly match: Match,
    private readonly me: PlayerId,
    private readonly mem: Memory,
    private readonly debug?: (info: BotDebugInfo) => void,
  ) {
    this.fog = match.fogs.get(me)!;
    this.known = fogKnowledge(match.world, this.fog);
    this.p = PERSONALITIES[mem.personality];
    this.rng = new Rng(`bot:${me}:${match.round}`);
  }

  private get world() {
    return this.match.world;
  }

  run(): BotReport {
    if (this.match.activePlayer !== this.me) return this.report();
    this.analyze();
    this.decideStrategy();
    this.manageSpecializations();
    this.manageProduction();

    const mine = () => this.world.unitsOf(this.me);
    for (const u of mine()) if (u.def.stealth && !u.silentRunning) this.match.setSilentRunning(this.me, u.id, true);
    this.assignGarrisons();

    // Order matters: troops reach the docks before transports sail, cargo acts after
    // its transport arrives, and aircraft strike last at whatever is now in view.
    for (const u of mine().filter((u) => u.def.domain === 'land' && u.carriedBy === null)) this.actLand(u.id);
    for (const u of mine().filter((u) => u.def.domain === 'sea' && !u.def.cargo?.accepts.includes('land'))) this.actWarship(u.id);
    for (const u of mine().filter((u) => u.def.cargo?.accepts.includes('land'))) this.actTransport(u.id);
    for (const u of mine().filter((u) => u.def.domain === 'land' && u.carriedBy !== null)) this.actCargo(u.id);
    for (const u of mine().filter((u) => u.def.domain === 'air')) this.actAircraft(u.id);

    this.mem.idleLast = this.waiting.size;
    this.mem.citiesLast = this.world.citiesOf(this.me).length;
    this.debug?.({
      phase: this.phase,
      target: this.mem.target,
      staging: this.staging,
      waiting: this.waiting.size,
      garrison: this.garrison.size,
    });
    return this.report();
  }

  private report(): BotReport {
    return { events: this.events, moves: this.moves, attacks: this.attacks };
  }

  // ─── Knowledge ───────────────────────────────────────────────────────────────

  private analyze(): void {
    const { grid } = this.world;
    this.unexplored = [];
    for (let i = 0; i < grid.size; i++) {
      if (this.fog.isExplored(i)) continue;
      const c = grid.coordOf(i);
      if (grid.neighbors(c).some((n) => this.fog.isExplored(grid.index(n)))) this.unexplored.push(c);
    }

    // Landmasses of explored land, each with its fog frontier and known foreign cities.
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

    for (const c of this.fog.knownCities.values()) {
      if (this.world.city(c.id)?.owner === this.me) continue; // own cities are always known
      const m = label[grid.index(c.position)]!;
      const map = c.owner === null ? this.neutralOf : this.enemyCitiesOf;
      const list = map.get(m);
      if (list) list.push(c.position);
      else map.set(m, [c.position]);
    }

    this.enemies = [];
    for (const id of this.fog.detectedUnits) {
      const u = this.world.unit(id);
      if (u && u.owner !== this.me && u.carriedBy === null) this.enemies.push(u);
    }
  }

  private ownCities(): City[] {
    return this.world.citiesOf(this.me);
  }

  private knownNeutral(): Coord[] {
    return [...this.neutralOf.values()].flat();
  }

  private knownEnemyCities(): Coord[] {
    return [...this.enemyCitiesOf.values()].flat();
  }

  private massOf(c: Coord): number {
    return this.landmass[this.world.grid.index(c)]!;
  }

  /** Landmasses a land unit can step onto: its own, or (aboard) those beside its boat. */
  private massesFor(u: Unit): number[] {
    const here = this.massOf(u.position);
    if (u.carriedBy === null && here >= 0) return [here];
    const set = new Set<number>();
    for (const n of this.world.grid.neighbors(u.position)) {
      const m = this.massOf(n);
      if (m >= 0) set.add(m);
    }
    return [...set];
  }

  private ownMasses(): Set<number> {
    return new Set(this.ownCities().map((c) => this.massOf(c.position)));
  }

  private threatsNear(c: Coord, radius = THREAT_RADIUS): Unit[] {
    return this.enemies.filter((e) => e.def.domain !== 'air' && this.dist(e.position, c) <= radius);
  }

  // ─── Strategy ────────────────────────────────────────────────────────────────

  private decideStrategy(): void {
    const round = this.match.round;
    const cities = this.ownCities().length;
    if (cities < this.mem.citiesLast) this.mem.alertUntil = round + 6; // we just lost a city

    // Unexplored map is room to expand too: not knowing a city is not the same as
    // there being none.
    const expansionLeft =
      this.knownNeutral().length > 0 ||
      [...this.ownMasses()].some((m) => (this.frontierOf.get(m)?.length ?? 0) > 0) ||
      this.unexplored.length > 0;
    const contact = this.knownEnemyCities().length > 0 || this.enemies.some((e) => e.def.domain === 'land');
    this.phase = round < this.p.expandUntil && expansionLeft && !(contact && round > this.p.expandUntil / 2) ? 'expand' : 'war';

    // Re-evaluated every turn (the board changes), with randomness that only shifts
    // every 10 rounds so the bot commits to an objective instead of zigzagging.
    const previous = this.mem.target;
    this.mem.target = this.chooseTarget();
    if (!this.mem.target || !previous || previous.x !== this.mem.target.x || previous.y !== this.mem.target.y) {
      this.mem.stagingSince = null;
    }

    // Staging port: a coastal city close to the target AND on an island where the
    // troops actually are (troops can't walk to a port on another island).
    const target = this.mem.target;
    if (target) {
      const troopsOn = new Map<number, number>();
      for (const u of this.world.unitsOf(this.me)) {
        if (u.def.domain !== 'land' || u.carriedBy !== null) continue;
        const m = this.massOf(u.position);
        troopsOn.set(m, (troopsOn.get(m) ?? 0) + 1);
      }
      const ports = this.ownCities().filter((c) => c.isCoastal && (troopsOn.get(this.massOf(c.position)) ?? 0) > 0);
      const score = (c: City) => this.dist(c.position, target) - 2 * Math.min(10, troopsOn.get(this.massOf(c.position)) ?? 0);
      this.staging = ports.sort((a, b) => score(a) - score(b))[0]?.position ?? null;
    }
  }

  /**
   * Enemy cities first in war (weakest known defense, then distance, with a little
   * randomness so the bot doesn't always hit the same spot); neutral cities overseas
   * while expanding.
   */
  private chooseTarget(): Coord | null {
    const home = this.ownCities();
    if (home.length === 0) return null;
    const fromHome = (c: Coord) => Math.min(...home.map((h) => this.dist(h.position, c)));
    const pool = this.phase === 'war' && this.knownEnemyCities().length > 0 ? this.knownEnemyCities() : this.knownNeutral();
    if (pool.length === 0) return null;
    const defenders = (c: Coord) => this.enemies.filter((e) => this.dist(e.position, c) <= 2).length;
    const jitter = new Rng(`target:${this.me}:${Math.floor(this.match.round / 10)}`);
    const noise = new Map(pool.map((c) => [`${c.x},${c.y}`, jitter.next() * 8]));
    const score = (c: Coord) => fromHome(c) + defenders(c) * 6 + noise.get(`${c.x},${c.y}`)!;
    return pool.reduce((best, c) => (score(c) < score(best) ? c : best));
  }

  private manageSpecializations(): void {
    const cities = this.ownCities();
    this.p.specializations.forEach((spec, i) => {
      const needed = 4 + i * 3;
      if (cities.length < needed) return;
      const already = cities.filter((c) => c.specialization === spec).length;
      const wanted = this.p.specializations.slice(0, i + 1).filter((s) => s === spec).length;
      if (already >= wanted) return;
      const candidates = cities.filter(
        (c) =>
          c.specialization === 'none' &&
          (!c.production || c.production.progress === 0) &&
          (spec !== 'naval_yard' || c.isCoastal),
      );
      // Naval yards go to the most open harbor; the rest to cities away from the front.
      const pick = candidates.sort((a, b) => this.threatsNear(a.position, 8).length - this.threatsNear(b.position, 8).length)[0];
      if (pick) this.match.setSpecialization(this.me, pick.id, spec);
    });
  }

  private manageProduction(): void {
    const units = this.world.unitsOf(this.me);
    const counts = new Map<UnitTypeId, number>();
    for (const u of units) counts.set(u.type, (counts.get(u.type) ?? 0) + 1);
    const cities = this.ownCities();
    const alert = this.match.round < this.mem.alertUntil;
    const mix: Mix = { ...(this.phase === 'expand' ? this.p.expandMix : this.p.warMix) };
    if (alert) {
      mix.infantry = (mix.infantry ?? 0) + 3;
      mix.heavy_tank = (mix.heavy_tank ?? 0) + 2;
    }
    if (this.enemies.some((e) => e.def.domain === 'air')) mix.anti_air = (mix.anti_air ?? 0) + 1;
    const transportCap = Math.max(1, Math.min(6, Math.ceil(this.mem.idleLast / 3) + (this.phase === 'war' ? 1 : 0)));

    // Eyes first: a recon drone finds islands and the enemy far faster than infantry.
    const drones = counts.get('recon_drone') ?? 0;
    const wantDrones = Math.max(1, this.p.drones);
    let droneQueued = cities.some((c) => c.production?.unit === 'recon_drone' && c.production.progress > 0);

    for (const city of cities) {
      if (city.production && city.production.progress > 0) continue; // never waste progress
      if (!droneQueued && drones < wantDrones && this.unexplored.length > 0 && (counts.get('infantry') ?? 0) >= 2) {
        droneQueued = true;
        counts.set('recon_drone', drones + 1);
        if (city.production?.unit !== 'recon_drone') this.match.setProduction(this.me, city.id, 'recon_drone');
        continue;
      }
      // A city with no garrison and enemies nearby builds a defender first.
      const garrisoned = this.world.unitsAt(city.position).some((u) => u.owner === this.me && u.def.domain === 'land');
      let want: UnitTypeId | null = null;
      if (!garrisoned && this.threatsNear(city.position).length > 0) want = 'infantry';
      // Land still to take on this island: infantry (and the odd tank) gets it fastest.
      if (!want && this.islandHasWork(city) && !alert) {
        const blitzTank = this.p.id === 'blitz' && (counts.get('infantry') ?? 0) % 3 === 2;
        want = blitzTank ? 'heavy_tank' : 'infantry';
      }
      if (!want) want = this.pickFromMix(city, mix, counts, transportCap);
      if (!want) continue;
      counts.set(want, (counts.get(want) ?? 0) + 1);
      if (city.production?.unit !== want) this.match.setProduction(this.me, city.id, want);
    }
  }

  /** Neutral cities left on this island, or fog to clear and too few troops to clear it. */
  private islandHasWork(city: City): boolean {
    const m = this.massOf(city.position);
    if ((this.neutralOf.get(m)?.length ?? 0) > 0) return true;
    if ((this.frontierOf.get(m)?.length ?? 0) === 0) return false;
    const troops = this.world.unitsOf(this.me).filter((u) => u.def.domain === 'land' && this.massOf(u.position) === m).length;
    return troops < 3;
  }

  /** Unit whose share of the army is furthest below the mix, among what this city can build. */
  private pickFromMix(city: City, mix: Mix, counts: Map<UnitTypeId, number>, transportCap: number): UnitTypeId | null {
    const total = [...counts.values()].reduce((a, b) => a + b, 0) + 1;
    const weightSum = Object.values(mix).reduce((a, b) => a + (b ?? 0), 0);
    let best: UnitTypeId | null = null;
    let bestGap = -Infinity;
    for (const [type, w] of Object.entries(mix) as [UnitTypeId, number][]) {
      if (!city.canProduce(type).ok) continue;
      const have = counts.get(type) ?? 0;
      if (type === 'transport' && have >= transportCap) continue;
      if (type === 'recon_drone' && have >= this.p.drones) continue;
      if ((type === 'carrier' || type === 'battleship') && have >= Math.ceil(this.ownCities().length / 8)) continue;
      const gap = w / weightSum - have / total + this.rng.next() * 0.02;
      if (gap > bestGap) [best, bestGap] = [type, gap];
    }
    return best ?? (city.canProduce('infantry').ok ? 'infantry' : null);
  }

  /** Each city keeps its nearest land units as garrison (front-line cities keep one more). */
  private assignGarrisons(): void {
    const land = this.world
      .unitsOf(this.me)
      .filter((u) => u.def.domain === 'land' && u.carriedBy === null && u.def.attack > 0);
    const taken = new Set<UnitId>();
    const enemyCities = this.knownEnemyCities();
    for (const city of this.ownCities()) {
      const threatened = this.threatsNear(city.position, 8).length > 0;
      // Front line: an enemy city or enemy troops within striking distance of a landing.
      const frontline = threatened || enemyCities.some((c) => this.dist(c, city.position) <= 14);
      // Interior cities stay empty so every soldier is out working, except for the
      // fortress personality, which holds everything it owns.
      // Coastal cities are always exposed to landings once the war is on.
      let want = 0;
      if (threatened) want = this.p.garrison + 1;
      else if (this.phase === 'war' && (frontline || city.isCoastal || this.p.id === 'fortress')) want = this.p.garrison;
      if (want === 0) continue;
      const near = land
        .filter((u) => !taken.has(u.id) && this.dist(u.position, city.position) <= 6 && this.massOf(u.position) === this.massOf(city.position))
        // Prefer units already inside (dug in), and units that can't take cities:
        // infantry is what expeditions need.
        .sort((a, b) =>
          this.dist(a.position, city.position) - this.dist(b.position, city.position) ||
          Number(!!a.def.canCaptureCities) - Number(!!b.def.canCaptureCities),
        )
        .slice(0, want);
      for (const u of near) {
        taken.add(u.id);
        this.garrison.add(u.id);
      }
    }
  }

  // ─── Land units ──────────────────────────────────────────────────────────────

  private actLand(id: UnitId): void {
    if (this.tryAttack(id)) return;
    const u = this.alive(id);
    if (!u || u.movesLeft <= 0) return;

    if (this.garrison.has(id)) {
      // Stay put (and dig in) unless something can be killed next door.
      const home = this.nearest(u.position, this.ownCities());
      if (home && this.dist(home.position, u.position) > 0) this.moveToward(u, home.position);
      return;
    }

    // Enemies on our island: everyone available answers.
    if (this.respondToInvasion(u)) return;

    if (u.def.canCaptureCities && this.captureOverland(u, this.phase === 'war' ? 'any' : 'neutral')) return;
    if (this.phase === 'war' && this.marchOnTarget(u)) return;
    if (this.explore(u, true)) return;

    // Nothing to do on this island: get on a boat (or walk to the staging port).
    this.waiting.add(id);
    this.boardOrGather(u);
  }

  private respondToInvasion(u: Unit): boolean {
    const mass = this.massOf(u.position);
    const invaders = this.enemies
      .filter((e) => e.def.domain === 'land' && this.massOf(e.position) === mass && this.dist(e.position, u.position) <= 10)
      .sort((a, b) => this.dist(u.position, a.position) - this.dist(u.position, b.position));
    for (const e of invaders.slice(0, 2)) {
      if (this.moveToBeside(u, e.position)) {
        this.tryAttack(u.id);
        return true;
      }
    }
    return false;
  }

  private captureOverland(u: Unit, which: 'neutral' | 'any', ashore = false): boolean {
    const masses = this.massesFor(u);
    const pool = masses.flatMap((m) => [
      ...(this.neutralOf.get(m) ?? []),
      ...(which === 'any' ? (this.enemyCitiesOf.get(m) ?? []) : []),
    ]);
    // Undefended cities first, then nearest.
    const defended = (c: Coord) => this.enemies.some((e) => this.dist(e.position, c) === 0);
    const candidates = pool
      .sort((a, b) => Number(defended(a)) - Number(defended(b)) || this.dist(u.position, a) - this.dist(u.position, b))
      .slice(0, MAX_PATH_TRIES);
    for (const c of candidates) {
      if (defended(c)) continue;
      const path = findPath(this.known, u, c, { maxTurns: LOCAL_SEARCH_TURNS });
      if (path && this.isOverland(path, ashore)) return this.follow(u, path);
    }
    return false;
  }

  /**
   * War on the same island: wait until enough of the army is nearby, then everyone
   * moves on the target together (tanks clear defenders, infantry takes the city).
   */
  private marchOnTarget(u: Unit): boolean {
    const target = this.mem.target;
    if (!target || this.massOf(target) !== this.massOf(u.position)) return false;
    const army = this.world
      .unitsOf(this.me)
      .filter((x) => x.def.domain === 'land' && !this.garrison.has(x.id) && x.carriedBy === null && this.massOf(x.position) === this.massOf(target));
    const ready = army.length >= Math.ceil(this.p.strikeSize / 2) || this.match.round < this.mem.alertUntil;
    if (!ready) {
      // Gather at the own city closest to the target.
      const rally = this.nearest(target, this.ownCities().filter((c) => this.massOf(c.position) === this.massOf(target)));
      if (rally && this.dist(rally.position, u.position) > 2) return this.moveToward(u, rally.position);
      return true; // hold position until the army is ready
    }
    if (this.moveToBeside(u, target)) {
      this.tryAttack(u.id);
      return true;
    }
    return false;
  }

  /** Is the current objective an enemy city (where non-capturing units have work)? */
  private targetIsEnemy(): boolean {
    const t = this.mem.target;
    if (!t) return false;
    const c = this.world.cityAt(t);
    return !!c && (this.fog.knownCities.get(c.id)?.owner ?? null) !== null;
  }

  private boardOrGather(u: Unit): void {
    // Armor only ships out to fight: neutral cities need infantry, not tanks.
    if (!u.def.canCaptureCities && !(this.phase === 'war' && this.targetIsEnemy())) return;
    const mass = this.massOf(u.position);
    const touches = (c: Coord) =>
      this.massOf(c) === mass || this.world.grid.neighbors(c).some((n) => this.massOf(n) === mass);
    // Every boat must be able to take a city: armor only boards one that already
    // carries infantry.
    const hasCapturer = (t: Unit) => t.cargo.some((id) => this.world.unit(id)?.def.canCaptureCities);
    const ships = this.world
      .unitsOf(this.me)
      .filter(
        (t) =>
          t.def.cargo?.accepts.includes('land') &&
          t.freeCapacity >= u.def.size &&
          touches(t.position) &&
          (u.def.canCaptureCities || hasCapturer(t)),
      );
    const here = ships.find((t) => this.dist(t.position, u.position) === 0);
    if (here) {
      if (this.match.board(this.me, u.id, here.id).ok) this.moves++;
      return;
    }
    // Massed strikes gather at the staging port; otherwise troops go to the nearest transport.
    const goal =
      this.p.strikeStyle === 'massed' && this.phase === 'war' && this.staging && this.massOf(this.staging) === mass
        ? this.staging
        : this.nearest(u.position, ships)?.position;
    if (goal && this.dist(goal, u.position) > 0) this.moveToward(u, goal);
  }

  private actCargo(id: UnitId): void {
    const u = this.alive(id);
    if (!u || u.movesLeft <= 0) return;
    const ship = u.carriedBy ? this.world.unit(u.carriedBy) : undefined;
    // Docked in an own port: wait for the expedition to sail. At sea: act if there is
    // something to do on the shore next to the boat, otherwise keep riding.
    if (!ship || this.isDocked(ship.position)) return;
    if (this.tryAttack(id)) return;
    if (u.def.canCaptureCities && this.captureOverland(u, 'any', true)) return;
    // Land next to the objective (or any foreign city on this shore).
    const masses = this.massesFor(u);
    const cities = masses
      .flatMap((m) => [...(this.enemyCitiesOf.get(m) ?? []), ...(this.neutralOf.get(m) ?? [])])
      .sort((a, b) => this.dist(u.position, a) - this.dist(u.position, b))
      .slice(0, 2);
    for (const c of cities) {
      for (const spot of this.world.grid.neighbors(c)) {
        const i = this.world.grid.index(spot);
        if (!this.fog.isExplored(i) || !this.world.grid.isLand(spot) || this.world.cityAt(spot)) continue;
        if (this.dist(spot, u.position) > 1) continue;
        const path = findPath(this.known, u, spot, { maxTurns: 1 });
        if (path && this.isOverland(path, true)) {
          this.follow(u, path);
          this.tryAttack(id);
          return;
        }
      }
    }
    if (u.def.canCaptureCities) this.explore(u, true, true);
  }

  private isDocked(c: Coord): boolean {
    return this.world.cityAt(c)?.owner === this.me;
  }

  // ─── Transports ──────────────────────────────────────────────────────────────

  private actTransport(id: UnitId): void {
    const t = this.alive(id);
    if (!t || t.movesLeft <= 0) return;
    if (this.fleeIfThreatened(t)) return;

    const loaded = t.cargoLoad;
    const capacity = t.def.cargo!.capacity;
    if (loaded === 0) return this.fetchTroops(t);

    // Raids (and all expansion): sail as soon as there is a useful load. Massed war:
    // wait at the staging port until the strike force is aboard (the surprise attack).
    const massed = this.p.strikeStyle === 'massed' && this.phase === 'war' && this.targetIsEnemy();
    if (massed && this.mem.target && this.staging && this.dist(t.position, this.staging) <= 1) {
      const aboardAtStaging = this.world
        .unitsOf(this.me)
        .filter((x) => x.def.cargo?.accepts.includes('land') && this.dist(x.position, this.staging!) <= 1)
        .reduce((n, x) => n + x.cargo.length, 0);
      this.mem.stagingSince ??= this.match.round;
      const forceReady = aboardAtStaging >= this.p.strikeSize;
      const timeUp = this.match.round - this.mem.stagingSince >= MAX_STAGING_WAIT;
      if (!forceReady && !timeUp) return; // hold until the whole strike force is aboard
      this.mem.stagingSince = null;
    } else if (!massed && loaded < Math.min(2, capacity)) {
      const moreComing = [...this.waiting].some((w) => this.dist(this.world.unit(w)!.position, t.position) <= 4);
      if (moreComing) return;
    }

    // Where this boat can be useful depends on who is aboard: infantry can take any
    // city, armor only has business where the enemy is.
    const cargo = t.cargo.map((id) => this.world.unit(id)).filter((x): x is Unit => !!x);
    const canCapture = cargo.some((x) => x.def.canCaptureCities);
    // Massed strikes all go for the shared objective; raiders each pick the nearest
    // useful shore, preferring cities with no known defenders.
    const goal = massed && this.mem.target ? this.mem.target : null;
    const defended = (c: Coord) => this.enemies.some((e) => e.def.domain === 'land' && this.dist(e.position, c) <= 1);
    const targets = [
      ...(goal ? [goal] : []),
      ...(canCapture ? this.knownNeutral().filter((c) => !this.ownMasses().has(this.massOf(c))) : []),
      ...this.knownEnemyCities(),
    ];
    const ordered = [...new Set(targets)].sort((a, b) =>
      a === goal ? -1 : b === goal ? 1 : Number(defended(a)) - Number(defended(b)) || this.dist(t.position, a) - this.dist(t.position, b),
    );
    for (const c of ordered.slice(0, MAX_PATH_TRIES)) if (this.landingApproach(t, c)) return;
    this.explore(t, false);
  }

  /** Empty transport: sit at the port nearest the idle troops (staging port in war). */
  private fetchTroops(t: Unit): void {
    const waiting = [...this.waiting].map((w) => this.world.unit(w)).filter((w): w is Unit => !!w && w.carriedBy === null);
    const ports = this.ownCities().filter((c) => c.isCoastal);
    let port: Coord | undefined;
    if (this.p.strikeStyle === 'massed' && this.phase === 'war' && this.staging) port = this.staging;
    else {
      const anchor = this.nearest(t.position, waiting);
      port = anchor ? this.nearest(anchor.position, ports)?.position : undefined;
    }
    if (port && this.dist(port, t.position) > 0) this.moveToward(t, port);
  }

  /** Approach a target city from the side with the fewest known enemies. */
  private landingApproach(t: Unit, city: Coord): boolean {
    const spots = this.world.grid
      .neighbors(city)
      .filter((c) => this.isKnownWaterOrPort(c))
      .sort((a, b) => this.threatsNear(a, 1).length - this.threatsNear(b, 1).length || this.dist(t.position, a) - this.dist(t.position, b))
      .slice(0, 3);
    for (const s of spots) {
      if (this.dist(s, t.position) === 0) return true;
      const path = findPath(this.known, t, s, { maxTurns: this.searchTurns(t, s) });
      if (path && path.steps.every((st) => st.kind === 'move')) return this.follow(t, path);
    }
    return false;
  }

  /** An exposed transport runs from enemy warships it cannot fight. */
  private fleeIfThreatened(t: Unit): boolean {
    const hunters = this.enemies.filter((e) => e.def.domain === 'sea' && e.def.attack > 0 && this.dist(e.position, t.position) <= 3);
    if (hunters.length === 0) return false;
    const port = this.nearest(t.position, this.ownCities().filter((c) => c.isCoastal));
    return port ? this.moveToward(t, port.position) : false;
  }

  // ─── Warships ────────────────────────────────────────────────────────────────

  private actWarship(id: UnitId): void {
    if (this.tryAttack(id)) return;
    const u = this.alive(id);
    if (!u || u.movesLeft <= 0) return;
    const byDist = (a: { position: Coord }, b: { position: Coord }) => this.dist(u.position, a.position) - this.dist(u.position, b.position);

    // 1. Enemy transports near our coasts are the top priority, then any ship close by.
    const ownCities = this.ownCities();
    const nearOurs = (e: Unit) => ownCities.some((c) => this.dist(c.position, e.position) <= 8);
    const prey = this.enemies
      .filter((e) => e.def.domain === 'sea' && this.dist(e.position, u.position) <= 14)
      .sort((a, b) => Number(!!b.def.cargo && nearOurs(b)) - Number(!!a.def.cargo && nearOurs(a)) || byDist(a, b))
      .slice(0, 2);
    for (const e of prey) if (this.hunt(u, e.position)) return;

    // 2. Escort: stay next to our loaded transports when an expedition is under way.
    const convoy = this.world
      .unitsOf(this.me)
      .filter((t) => t.def.cargo?.accepts.includes('land') && t.cargo.length > 0 && !this.isDocked(t.position))
      .sort(byDist)[0];
    if (convoy && u.type !== 'submarine' && this.dist(convoy.position, u.position) > 1 && this.hunt(u, convoy.position)) return;

    // 3. In war, take the fight to the enemy coast (battleships shell it from range).
    if (this.phase === 'war') {
      const coast = (this.mem.target ? [this.mem.target] : this.knownEnemyCities().sort((a, b) => this.dist(u.position, a) - this.dist(u.position, b))).slice(0, 2);
      for (const c of coast) if (this.hunt(u, c)) return;
    }
    this.explore(u, false);
  }

  /** Move within striking distance of `c` and fire if possible. */
  private hunt(u: Unit, c: Coord): boolean {
    if (this.moveToBeside(u, c)) {
      this.tryAttack(u.id);
      return true;
    }
    return false;
  }

  // ─── Aircraft ────────────────────────────────────────────────────────────────

  private actAircraft(id: UnitId): void {
    const u = this.alive(id);
    if (!u || u.fuel === null) return;
    if (u.carriedBy !== null && u.movesLeft <= 0) return;
    const bases = [
      ...this.ownCities().map((c) => c.position),
      ...this.world.unitsOf(this.me).filter((c) => c.def.cargo?.accepts.includes('air')).map((c) => c.position),
    ];
    const home = this.nearestCoord(u.position, bases);
    if (!home) return;
    const atBase = this.dist(u.position, home) === 0;
    if (!atBase) {
      if (u.def.attack > 0 && this.tryAttack(id)) return;
      if (u.movesLeft > 0) this.moveToward(u, home); // always come back after a sortie
      return;
    }
    if (u.movesLeft <= 0) return;
    // Sortie radius: out this turn, back next turn, loiter fuel included.
    const radius = Math.min(Math.floor(u.fuel / 2) - 1, u.movesLeft);
    if (u.def.attack > 0) {
      const targets = this.enemies
        .filter((e) => this.dist(e.position, home) <= radius && EFFECTIVENESS[u.type][e.def.targetClass] > 0)
        .sort((a, b) => this.dist(home, a.position) - this.dist(home, b.position))
        .slice(0, 3);
      for (const e of targets) {
        if (this.moveToBeside(u, e.position)) {
          this.tryAttack(id);
          return;
        }
      }
      if (u.type === 'strategic_bomber') {
        const city = this.knownEnemyCities().filter((c) => this.dist(c, home) <= radius)[0];
        if (city && this.moveToBeside(u, city)) {
          this.tryAttack(id);
          return;
        }
      }
    }
    // Scouting: the farthest piece of fog edge within range.
    const goal = this.unexplored
      .filter((c) => this.dist(c, home) <= radius)
      .sort((a, b) => this.dist(b, home) - this.dist(a, home))[0];
    if (goal) this.moveToward(u, goal);
  }

  // ─── Building blocks ─────────────────────────────────────────────────────────

  /** Best favorable attack from the unit's current position (per the personality's edge). */
  private tryAttack(id: UnitId): boolean {
    const u = this.alive(id);
    if (!u || u.def.attack <= 0 || u.attackedThisTurn || u.movesLeft <= 0) return false;
    const reach = u.def.attackRange?.max ?? 1;
    const edge = this.match.round < this.mem.alertUntil ? Math.min(this.p.attackEdge, 1) : this.p.attackEdge;
    let best: { at: Coord; score: number } | null = null;
    for (const e of this.enemies) {
      if (!this.world.unit(e.id)) continue;
      if (this.dist(e.position, u.position) > reach) continue;
      const plan = planAttack(this.world, this.fog, this.me, id, e.position);
      if (!plan.ok) continue;
      const f = forecastAttack(this.world, plan.value);
      const kills = plan.value.defender !== null && f.damageToDefender >= plan.value.defender.hp;
      const taken = f.damageToAttacker + f.interceptionDamage;
      if (taken >= u.hp) continue; // never suicidal
      if (!kills && f.damageToDefender < taken * edge) continue;
      const value = plan.value.defender ? UNIT_TYPES[plan.value.defender.type].buildTurns : 0;
      const score = f.damageToDefender - taken + (kills ? 4 + value / 2 : 0);
      if (!best || score > best.score) best = { at: e.position, score };
    }
    // Strategic bombers also hit cities.
    if (!best && u.type === 'strategic_bomber') {
      const city = this.knownEnemyCities().find((c) => this.dist(c, u.position) <= reach);
      if (city && planAttack(this.world, this.fog, this.me, id, city).ok) best = { at: city, score: 1 };
    }
    if (!best) return false;
    const r = this.match.attack(this.me, id, best.at);
    if (!r.ok) return false;
    this.attacks++;
    this.events.push(...r.value.events);
    this.enemies = this.enemies.filter((e) => this.world.unit(e.id));
    return true;
  }

  private explore(u: Unit, overland: boolean, ashore = false): boolean {
    if (overland) {
      const m = this.massOf(u.position);
      const cap = 2 + Math.floor(this.world.unitsOf(this.me).length / 10);
      if ((this.explorers.get(m) ?? 0) >= cap) return false;
      this.explorers.set(m, (this.explorers.get(m) ?? 0) + 1);
    }
    const pool = overland ? this.massesFor(u).flatMap((m) => this.frontierOf.get(m) ?? []) : this.unexplored;
    // A little randomness so several scouts don't all chase the same corner.
    const candidates = pool
      .map((c) => ({ c, d: this.dist(u.position, c) + this.rng.next() * 3 }))
      .sort((a, b) => a.d - b.d)
      .slice(0, MAX_PATH_TRIES)
      .map((x) => x.c);
    for (const c of candidates) {
      const path = findPath(this.known, u, c, { maxTurns: overland ? LOCAL_SEARCH_TURNS : SEARCH_TURNS });
      if (!path || path.steps.length === 0) continue;
      if (overland && !this.isOverland(path, ashore)) continue;
      return this.follow(u, path);
    }
    return false;
  }

  private isOverland(path: PlannedPath, firstStepAshore = false): boolean {
    if (path.steps.some((s) => s.kind === 'board')) return false;
    if (firstStepAshore && path.steps[0] && !this.world.grid.isLand(path.steps[0].coord)) return false;
    return true;
  }

  private moveToward(u: Unit, goal: Coord): boolean {
    const path = findPath(this.known, u, goal, { maxTurns: this.searchTurns(u, goal) });
    return path ? this.follow(u, path) : false;
  }

  /** Long searches only where a route is known to exist (same landmass) or at sea. */
  private searchTurns(u: Unit, goal: Coord): number {
    if (u.def.domain === 'land' && u.carriedBy === null && this.massOf(goal) === this.massOf(u.position)) return LOCAL_SEARCH_TURNS;
    if (u.def.domain === 'sea') return 2 * SEARCH_TURNS;
    return SEARCH_TURNS;
  }

  /** Move within attack range of `target` (adjacent for most units). */
  private moveToBeside(u: Unit, target: Coord): boolean {
    const range = u.def.attackRange?.max ?? 1;
    if (this.dist(u.position, target) <= range && this.dist(u.position, target) >= (u.def.attackRange?.min ?? 1)) return true;
    const naval = u.def.domain === 'sea';
    const spots = this.world.grid
      .neighbors(target)
      .filter((c) => (naval ? this.isKnownWaterOrPort(c) : u.def.domain === 'air' || this.fog.isExplored(this.world.grid.index(c))))
      .sort((a, b) => this.dist(u.position, a) - this.dist(u.position, b))
      .slice(0, 3);
    for (const s of spots) {
      if (s.x === u.position.x && s.y === u.position.y) return true;
      const path = findPath(this.known, u, s, { maxTurns: this.searchTurns(u, s) });
      if (path && path.steps.every((st) => st.kind === 'move' || st.kind === 'disembark')) return this.follow(u, path);
    }
    return false;
  }

  private follow(u: Unit, path: PlannedPath): boolean {
    const now = path.steps.filter((s) => s.turn === 0).map((s) => s.coord);
    if (now.length === 0) return false;
    const r = this.match.move(this.me, u.id, now);
    if (!r.ok) return false;
    this.moves++;
    this.events.push(...r.value.events);
    return true;
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

  private nearestCoord(from: Coord, items: readonly Coord[]): Coord | undefined {
    return this.nearest(from, items.map((position) => ({ position })))?.position;
  }

  private dist(a: Coord, b: Coord): number {
    return this.world.grid.distance(a, b);
  }
}

