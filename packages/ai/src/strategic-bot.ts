import {
  EFFECTIVENESS,
  armyCap,
  Rng,
  UNIT_TYPES,
  findPath,
  fogKnowledge,
  hasRoomFor,
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
/** grow: the opening land grab. attack / hold: the war, alternating with the balance of power. */
export type Stance = 'grow' | 'attack' | 'hold';
/** A war stance is kept at least this long before the balance is re-read. */
const MIN_STANCE_ROUNDS = 8;
/** Responders sent against each enemy unit that lands on our island. */
const RESPONDERS_PER_INVADER = 3;
/** A neutral city further than this on foot is left to the boats (infantry is slow). */
const MAX_WALK_TURNS = 8;
/** Neutral cities within this distance of an own capturer on the same island count as "on foot". */
const WALK_RADIUS = 16;

export interface BotOptions {
  /** Force a personality (otherwise derived from the match, so it varies per game). */
  readonly personality?: PersonalityId;
  /** Development hook: the bot's reading of the game at the end of its turn. */
  readonly debug?: (info: BotDebugInfo) => void;
}

export interface BotDebugInfo {
  readonly phase: Phase;
  readonly stance: Stance;
  readonly target: Coord | null;
  readonly staging: Coord | null;
  readonly waiting: number;
  readonly garrison: number;
  /** What each unit ended up doing this turn (counts per decision). */
  readonly decisions: Readonly<Record<string, number>>;
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
  stance: Stance;
  stanceSince: number;
  /** Round the current objective was chosen: an offensive sticks to it for a while. */
  targetSince: number;
  /** Decaying memory of the enemy army seen (value in build turns): out of sight is not gone. */
  enemyArmySeen: number;
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
      stance: 'grow',
      stanceSince: 0,
      targetSince: 0,
      enemyArmySeen: 0,
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
  /** Attack stance: strike forces sail for enemy cities and fights are taken more readily. */
  private offensive = false;
  private exploredShare = 0;
  /** Land units already sent against each invader this turn. */
  private readonly responders = new Map<UnitId, number>();

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
  private readonly decisions: Record<string, number> = {};
  /** Cities already chosen as a destination this turn, and by how many units. */
  private readonly claimed = new Map<string, number>();

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

  /** Map area relative to the small map (1 small, ~2.7 medium, ~6.7 huge). */
  private get scale(): number {
    return this.world.grid.size / 2400;
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

    this.makeRoomUnderCap();
    this.mem.idleLast = this.waiting.size;
    this.mem.citiesLast = this.world.citiesOf(this.me).length;
    this.debug?.({
      phase: this.phase,
      stance: this.mem.stance,
      target: this.mem.target,
      staging: this.staging,
      waiting: this.waiting.size,
      garrison: this.garrison.size,
      decisions: this.decisions,
    });
    return this.report();
  }

  private note(what: string): void {
    this.decisions[what] = (this.decisions[what] ?? 0) + 1;
  }

  private report(): BotReport {
    return { events: this.events, moves: this.moves, attacks: this.attacks };
  }

  // ─── Knowledge ───────────────────────────────────────────────────────────────

  private analyze(): void {
    const { grid } = this.world;
    this.unexplored = [];
    let explored = 0;
    for (let i = 0; i < grid.size; i++) {
      if (this.fog.isExplored(i)) {
        explored++;
        continue;
      }
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
    this.exploredShare = explored / grid.size;

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

    const seen = this.enemies.reduce((n, e) => n + (e.def.attack > 0 ? UNIT_TYPES[e.type].buildTurns : 0), 0);
    this.mem.enemyArmySeen = Math.max(seen, this.mem.enemyArmySeen * 0.97);

    if (this.mem.stance === 'grow') {
      // The opening is the same for every personality: grab land while there is land
      // to grab. Meeting the enemy doesn't end it; losing a city or running out does.
      // Unexplored map is room to expand too: not knowing a city is not the same as
      // there being none.
      const nothingLeft = this.knownNeutral().length === 0 && this.exploredShare >= 0.7;
      // Bigger maps take longer to claim: the opening stretches with the map.
      const openingEnds = Math.round(this.p.expandUntil * Math.sqrt(this.scale));
      if (nothingLeft || round >= openingEnds || round < this.mem.alertUntil) this.setStance(this.readBalance());
    } else if (round - this.mem.stanceSince >= MIN_STANCE_ROUNDS || (round < this.mem.alertUntil && this.mem.stance === 'attack')) {
      const next = round < this.mem.alertUntil ? 'hold' : this.readBalance();
      if (next !== this.mem.stance) this.setStance(next);
    }
    this.phase = this.mem.stance === 'grow' ? 'expand' : 'war';
    this.offensive = this.mem.stance === 'attack';

    // Re-evaluated every turn (the board changes), with randomness that only shifts
    // every 10 rounds so the bot commits to an objective instead of zigzagging.
    const previous = this.mem.target;
    const keep =
      previous &&
      this.offensive &&
      round - this.mem.targetSince < 25 &&
      this.knownEnemyCities().some((c) => c.x === previous.x && c.y === previous.y);
    if (!keep) {
      this.mem.target = this.chooseTarget();
      if (!this.mem.target || !previous || previous.x !== this.mem.target.x || previous.y !== this.mem.target.y) {
        this.mem.stagingSince = null;
        this.mem.targetSince = round;
      }
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

  private setStance(stance: Stance): void {
    this.mem.stance = stance;
    this.mem.stanceSince = this.match.round;
  }

  /**
   * Attack or hold? Compares cities (production) and armies (own counted exactly, the
   * enemy's from what has been seen lately), against the personality's threshold.
   * The threshold drifts a little every 20 rounds so the bot's mood is not predictable:
   * the same position may bring an offensive in one game and a build-up in another.
   */
  private readBalance(): Stance {
    const enemyCities = this.knownEnemyCities().length;
    if (enemyCities === 0 && this.mem.enemyArmySeen === 0) return 'attack'; // nobody found yet: raid and scout
    const army = this.world
      .unitsOf(this.me)
      .reduce((n, u) => n + (u.def.attack > 0 ? UNIT_TYPES[u.type].buildTurns : 0), 0);
    const mine = this.ownCities().length * 10 + army;
    const theirs = Math.max(1, enemyCities * 10 + this.mem.enemyArmySeen);
    const mood = (new Rng(`mood:${this.me}:${Math.floor(this.match.round / 20)}`).next() - 0.5) * 0.4;
    return mine / theirs >= this.p.aggression + mood ? 'attack' : 'hold';
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
    const defenders = (c: Coord) => this.enemies.filter((e) => e.def.domain !== 'air' && this.dist(e.position, c) <= 2).length;
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
    const cities = this.ownCities();
    // Count what is already being built as if it existed: two cities must not both
    // start the one transport that was missing.
    const counts = new Map<UnitTypeId, number>();
    const add = (t: UnitTypeId) => counts.set(t, (counts.get(t) ?? 0) + 1);
    for (const u of units) add(u.type);
    for (const c of cities) if (c.production && c.production.progress > 0) add(c.production.unit);

    const alert = this.match.round < this.mem.alertUntil;
    const mix: Mix = { ...(this.phase === 'expand' ? this.p.expandMix : this.p.warMix) };
    if (alert) {
      mix.infantry = (mix.infantry ?? 0) + 3;
      mix.heavy_tank = (mix.heavy_tank ?? 0) + 2;
    }
    if (this.enemies.some((e) => e.def.domain === 'air')) mix.anti_air = (mix.anti_air ?? 0) + 1;

    // Boats on demand: one per couple of neutral cities overseas, and enough for the
    // troops that had nothing to do last turn. The war adds the strike force's lift.
    const overseas = this.overseasNeutral().length;
    let wantTransports = Math.max(overseas > 0 ? Math.ceil(overseas / 2) : 0, Math.ceil(this.mem.idleLast / 3));
    if (this.phase === 'war' && this.knownEnemyCities().length > 0) wantTransports = Math.max(wantTransports, this.offensive ? 2 : 1);
    wantTransports = Math.min(wantTransports, 2 + Math.floor(cities.length / 2));

    // Eyes first: recon drones find islands and the enemy far faster than infantry,
    // and a big map needs more of them.
    const scouts = Math.max(2, this.p.drones, Math.round(2 * this.scale ** 0.7));
    // Scouts grow with the empire: on a small home island the first cities must build
    // boats, not a squadron of drones.
    const wantDrones = this.unexplored.length === 0 ? 0 : this.exploredShare < 0.8 ? Math.min(scouts, 1 + Math.floor(cities.length / 3)) : this.p.drones;
    // Troops already waiting for a boat: more infantry would only pile up on the docks.
    const surplus = this.mem.idleLast >= 8;
    // In the opening a surplus never turns into armor (tanks can't take cities and
    // ended up parked in the rear): extra boats, and mechanized infantry inland.
    const openingSurplus = surplus && this.phase === 'expand';
    if (openingSurplus) wantTransports = Math.max(wantTransports, Math.min(2 + Math.floor(cities.length / 2), Math.ceil(this.mem.idleLast / 3) + 1));

    // Coastal cities with troops on their island build the boats.
    const landOn = new Map<number, number>();
    for (const u of units) {
      if (u.def.domain !== 'land' || u.carriedBy !== null) continue;
      const m = this.massOf(u.position);
      landOn.set(m, (landOn.get(m) ?? 0) + 1);
    }
    const shipyardScore = (c: City) => (c.isCoastal ? 100 : 0) + (landOn.get(this.massOf(c.position)) ?? 0);
    const order = [...cities].sort((a, b) => shipyardScore(b) - shipyardScore(a));

    for (const city of order) {
      if (city.production && city.production.progress > 0) continue; // never waste progress
      let want: UnitTypeId | null = null;
      // A city with no garrison and enemies nearby builds a defender first.
      const garrisoned = this.world.unitsAt(city.position).some((u) => u.owner === this.me && u.def.domain === 'land');
      if (!garrisoned && this.threatsNear(city.position).length > 0) want = 'infantry';
      if (!want && (counts.get('recon_drone') ?? 0) < wantDrones && (counts.get('infantry') ?? 0) >= 2) want = 'recon_drone';
      if (!want && city.isCoastal && (counts.get('transport') ?? 0) < wantTransports && (counts.get('infantry') ?? 0) >= 2) want = 'transport';
      // Land still to take on this island: infantry gets it fastest.
      if (!want && !alert && this.islandHasWork(city) && !(openingSurplus && (this.neutralOf.get(this.massOf(city.position))?.length ?? 0) === 0)) want = 'infantry';
      if (!want && this.phase === 'expand') want = surplus ? 'mech_infantry' : 'infantry';
      if (!want) want = this.pickFromMix(city, mix, counts);
      if (!want || !city.canProduce(want).ok) continue;
      if (city.production?.unit !== want || city.production.progress === 0) this.note(`prod:${want}`);
      add(want);
      if (city.production?.unit !== want) this.match.setProduction(this.me, city.id, want);
    }
  }

  /**
   * Known neutral cities that need a boat: none of our troops can walk there, or the
   * walk is long (infantry crawls; a transport sails 6 a turn).
   */
  private overseasNeutral(): Coord[] {
    if (this.overseasCache) return this.overseasCache;
    const walkers = this.world
      .unitsOf(this.me)
      .filter((u) => u.def.domain === 'land' && u.carriedBy === null && u.def.canCaptureCities);
    const onFoot = (c: Coord) => walkers.some((u) => this.massOf(u.position) === this.massOf(c) && this.dist(u.position, c) <= WALK_RADIUS);
    return (this.overseasCache = this.knownNeutral().filter((c) => !onFoot(c)));
  }
  private overseasCache: Coord[] | null = null;

  /** Neutral cities left on this island, or fog to clear and too few troops to clear it. */
  private islandHasWork(city: City): boolean {
    const m = this.massOf(city.position);
    const troops = this.world.unitsOf(this.me).filter((u) => u.def.domain === 'land' && u.carriedBy === null && this.massOf(u.position) === m).length;
    // Enough soldiers already here for what is left to take (plus a few to explore):
    // more would only pile up on the docks.
    const neutral = this.neutralOf.get(m)?.length ?? 0;
    if (neutral > 0) return troops < neutral + 3;
    if ((this.frontierOf.get(m)?.length ?? 0) === 0) return false;
    return troops < 3;
  }

  /**
   * Unit whose share of the army is furthest below the mix, among what this city can
   * build. Transports and drones are decided by demand, not by the mix. At least 40% of
   * the land army can take cities: tanks win battles, infantry wins the war.
   */
  private pickFromMix(city: City, mix: Mix, counts: Map<UnitTypeId, number>): UnitTypeId | null {
    const total = [...counts.values()].reduce((a, b) => a + b, 0) + 1;
    const weightSum = Object.values(mix).reduce((a, b) => a + (b ?? 0), 0);
    let best: UnitTypeId | null = null;
    let bestGap = -Infinity;
    for (const [type, w] of Object.entries(mix) as [UnitTypeId, number][]) {
      if (type === 'transport' || type === 'recon_drone') continue;
      if (!city.canProduce(type).ok) continue;
      if (UNIT_TYPES[type].domain === 'sea' && !city.isCoastal) continue;
      const have = counts.get(type) ?? 0;
      if ((type === 'carrier' || type === 'battleship') && have >= Math.ceil(this.ownCities().length / 8)) continue;
      const gap = w / weightSum - have / total + this.rng.next() * 0.02;
      if (gap > bestGap) [best, bestGap] = [type, gap];
    }
    if (best && UNIT_TYPES[best].domain === 'land' && !UNIT_TYPES[best].canCaptureCities) {
      let land = 0;
      let capturers = 0;
      for (const [t, n] of counts) {
        if (UNIT_TYPES[t].domain !== 'land') continue;
        land += n;
        if (UNIT_TYPES[t].canCaptureCities) capturers += n;
      }
      if (capturers < 0.4 * (land + 1)) best = (mix.mech_infantry ?? 0) > 0 && (counts.get('mech_infantry') ?? 0) < (counts.get('infantry') ?? 0) / 2 ? 'mech_infantry' : 'infantry';
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
      // While neutral cities are left, soldiers are worth more taking them than
      // guarding quiet coasts.
      const quietCoast = city.isCoastal && this.knownNeutral().length === 0;
      let want = 0;
      if (threatened) want = this.p.garrison + 1;
      else if (this.phase === 'war' && (frontline || quietCoast || this.p.id === 'fortress')) want = this.p.garrison;
      if (want === 0) continue;
      const near = land
        .filter((u) => !taken.has(u.id) && this.dist(u.position, city.position) <= 6 && this.massOf(u.position) === this.massOf(city.position))
        // Prefer units already inside (dug in), and units that can't take cities:
        // infantry is what expeditions need.
        .sort((a, b) => {
          const inside = Number(this.dist(b.position, city.position) === 0) - Number(this.dist(a.position, city.position) === 0);
          return inside || Number(!!a.def.canCaptureCities) - Number(!!b.def.canCaptureCities) || this.dist(a.position, city.position) - this.dist(b.position, city.position);
        })
        .slice(0, want);
      for (const u of near) {
        taken.add(u.id);
        this.garrison.add(u.id);
      }
    }
  }

  /**
   * Upkeep: at the army cap nothing gets built, not even the transports idle troops
   * are waiting for. Disband just enough idle soldiers (cheapest, farthest from the
   * enemy) to let production resume.
   */
  private makeRoomUnderCap(): void {
    const units = this.world.unitsOf(this.me).length;
    const cap = armyCap(this.world, this.me);
    if (units < cap || this.waiting.size === 0) return;
    const enemyAt = this.enemies.map((e) => e.position).concat(this.knownEnemyCities());
    const remoteness = (u: Unit) => (enemyAt.length ? Math.min(...enemyAt.map((c) => this.dist(c, u.position))) : 0);
    const spare = [...this.waiting]
      .map((id) => this.world.unit(id))
      .filter((u): u is Unit => !!u && u.carriedBy === null && !this.garrison.has(u.id))
      .sort((a, b) => UNIT_TYPES[a.type].buildTurns - UNIT_TYPES[b.type].buildTurns || remoteness(b) - remoteness(a));
    for (const u of spare.slice(0, units - cap + 2)) {
      if (this.match.disband(this.me, u.id).ok) this.waiting.delete(u.id);
    }
  }

  // ─── Land units ──────────────────────────────────────────────────────────────

  private actLand(id: UnitId): void {
    if (this.tryAttack(id)) return;
    const u = this.alive(id);
    if (!u || u.movesLeft <= 0) return;

    if (this.garrison.has(id)) {
      this.note('land:garrison');
      // Stay put (and dig in) unless something can be killed next door.
      const home = this.nearest(u.position, this.ownCities());
      if (home && this.dist(home.position, u.position) > 0) this.moveToward(u, home.position);
      return;
    }

    // Enemies on our island: everyone available answers.
    if (this.respondToInvasion(u)) return this.note('land:invasion');

    if (u.def.canCaptureCities && this.captureOverland(u, this.offensive ? 'any' : 'neutral')) return this.note('land:capture');
    if ((this.offensive || this.match.round < this.mem.alertUntil) && this.marchOnTarget(u)) return this.note('land:march');
    if (this.explore(u, true)) return this.note('land:explore');

    // Nothing to do on this island: get on a boat (or walk to the staging port).
    this.note('land:wait');
    this.waiting.add(id);
    this.boardOrGather(u);
  }

  private respondToInvasion(u: Unit): boolean {
    // A few units answer each invader near our cities; the rest keep working
    // (chasing every enemy tank around a shared island froze whole armies).
    const mass = this.massOf(u.position);
    const cities = this.ownCities();
    const invaders = this.enemies
      .filter(
        (e) =>
          e.def.domain === 'land' &&
          this.massOf(e.position) === mass &&
          this.dist(e.position, u.position) <= 10 &&
          (this.responders.get(e.id) ?? 0) < RESPONDERS_PER_INVADER &&
          cities.some((c) => this.dist(c.position, e.position) <= 6),
      )
      .sort((a, b) => this.dist(u.position, a.position) - this.dist(u.position, b.position));
    for (const e of invaders.slice(0, 2)) {
      if (this.moveToBeside(u, e.position)) {
        this.responders.set(e.id, (this.responders.get(e.id) ?? 0) + 1);
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
    // Aircraft parked in a city don't defend it: walking in takes it (and them).
    const defended = (c: Coord) => this.enemies.some((e) => e.def.domain !== 'air' && this.dist(e.position, c) === 0);
    const candidates = pool
      .sort((a, b) => Number(defended(a)) - Number(defended(b)) || this.dist(u.position, a) - this.dist(u.position, b))
      .slice(0, MAX_PATH_TRIES);
    for (const c of candidates) {
      if (defended(c)) continue;
      // One soldier per neutral city is enough; enemy cities get a small squad.
      const neutral = (this.world.cityAt(c) && this.fog.knownCities.get(this.world.cityAt(c)!.id)?.owner) == null;
      const key = `${c.x},${c.y}`;
      if ((this.claimed.get(key) ?? 0) >= (neutral ? 1 : 4)) continue;
      const path = findPath(this.known, u, c, { maxTurns: LOCAL_SEARCH_TURNS });
      if (!path || !this.isOverland(path, ashore)) continue;
      if (neutral && !ashore && path.turns > MAX_WALK_TURNS) continue; // a boat gets there sooner
      this.claimed.set(key, (this.claimed.get(key) ?? 0) + 1);
      return this.follow(u, path);
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
    if (!u.def.canCaptureCities && !(this.offensive && this.targetIsEnemy())) return;
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
      this.p.strikeStyle === 'massed' && this.offensive && this.staging && this.massOf(this.staging) === mass
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
    // Boats carrying only infantry keep taking neutral cities while any are left
    // overseas; the strike force is whatever else is aboard.
    const cargoUnits = t.cargo.map((id) => this.world.unit(id)).filter((x): x is Unit => !!x);
    const expedition = cargoUnits.every((x) => x.def.canCaptureCities) && this.overseasNeutral().length > 0 && !this.isStaging(t);
    const massed = this.p.strikeStyle === 'massed' && this.offensive && this.targetIsEnemy() && !expedition;
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
    const canCapture = cargoUnits.some((x) => x.def.canCaptureCities);
    // Massed strikes all go for the shared objective; raiders each pick the nearest
    // useful shore, preferring cities with no known defenders.
    const goal = massed && this.mem.target ? this.mem.target : null;
    const defended = (c: Coord) => this.enemies.some((e) => e.def.domain === 'land' && this.dist(e.position, c) <= 1);
    // On hold, only undefended enemy cities are worth a landing.
    const enemyCities = this.offensive ? this.knownEnemyCities() : this.knownEnemyCities().filter((c) => !defended(c));
    const targets = [...(goal ? [goal] : []), ...(canCapture ? this.overseasNeutral() : []), ...enemyCities];
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
    if (this.p.strikeStyle === 'massed' && this.offensive && this.staging && this.overseasNeutral().length === 0) port = this.staging;
    else {
      const anchor = this.nearest(t.position, waiting);
      port = anchor ? this.nearest(anchor.position, ports)?.position : undefined;
    }
    if (port && this.dist(port, t.position) > 0) this.moveToward(t, port);
  }

  private isStaging(t: Unit): boolean {
    return !!this.staging && this.offensive && this.dist(t.position, this.staging) <= 1;
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
    if (this.offensive) {
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

  /**
   * Recon: fly as far into the fog as the fuel allows, over several turns if needed,
   * and land at whichever base is nearest when the tank says so. On a big map a drone
   * that returned home every other turn never saw past its own coast.
   */
  private actScout(u: Unit): void {
    // Several legs per turn: a drone that stops at the fog edge with moves to spare
    // burns them anyway, and the next turn may be too short to get home.
    for (let leg = 0; leg < 4 && u.fuel !== null && u.movesLeft > 0; leg++) {
      const before = u.movesLeft;
      this.scoutLeg(u);
      if (!this.alive(u.id) || u.movesLeft >= before) return;
    }
  }

  private scoutLeg(u: Unit): void {
    if (u.fuel === null) return;
    const bases = this.ownCities().map((c) => c.position);
    if (bases.length === 0) return;
    const homeOf = (c: Coord) => this.nearestCoord(c, bases)!;
    // Airborne units burn every unused move at the end of the turn, so fuel buys
    // whole turns: the round trip must fit in them (this turn's moves included).
    const turnsLeft = Math.floor((u.fuel - u.movesLeft) / u.def.moves) + 1;
    const range = u.movesLeft + (turnsLeft - 1) * u.def.moves - 2;
    let best: Coord | null = null;
    let bestScore = -Infinity;
    for (const c of this.unexplored) {
      const there = this.dist(u.position, c);
      if (there === 0) continue;
      const back = this.dist(c, homeOf(c));
      if (there + back > range) continue;
      const key = `air:${Math.floor(c.x / 8)},${Math.floor(c.y / 8)}`;
      if (this.claimed.get(key) === 1 && there > 3) continue; // another scout is headed there
      // Far from our bases is new ground; close to the drone is cheap.
      const score = back - 0.5 * there + this.rng.next() * 2;
      if (score > bestScore) [best, bestScore] = [c, score];
    }
    if (best) {
      this.claimed.set(`air:${Math.floor(best.x / 8)},${Math.floor(best.y / 8)}`, 1);
      if (this.moveToward(u, best)) {
        // Moving lifts the fog: what was the edge is not anymore.
        this.unexplored = this.unexplored.filter((c) => !this.fog.isExplored(this.world.grid.index(c)));
        return this.note('air:scout');
      }
    }
    const home = homeOf(u.position);
    if (this.dist(home, u.position) > 0) this.moveToward(u, home);
    this.note('air:home');
  }

  private actAircraft(id: UnitId): void {
    const u = this.alive(id);
    if (!u || u.fuel === null) return;
    if (u.def.attack === 0 && u.carriedBy === null) return this.actScout(u);
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
    let edge = this.match.round < this.mem.alertUntil ? Math.min(this.p.attackEdge, 1) : this.p.attackEdge;
    if (this.offensive) edge *= 0.8;
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
      // Ganging up: with friends next to the target, wearing it down is worth a trade
      // (the next attacker finishes it).
      const friends = this.world
        .unitsOf(this.me)
        .filter((x) => x.id !== id && x.def.attack > 0 && !x.attackedThisTurn && x.movesLeft > 0 && this.dist(x.position, e.position) <= (x.def.attackRange?.max ?? 1)).length;
      const localEdge = friends >= 2 ? edge * 0.5 : friends === 1 ? edge * 0.75 : edge;
      if (!kills && f.damageToDefender < taken * localEdge) continue;
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
    if (path) return this.follow(u, path);
    // A full tile (stacking limit) can't be entered: get as close as the crowd allows.
    if (u.def.domain !== 'land' || hasRoomFor(this.world, this.me, goal)) return false;
    const around = this.world.grid
      .neighbors(goal)
      .filter((c) => this.world.grid.isLand(c) && hasRoomFor(this.world, this.me, c))
      .sort((a, b) => this.dist(u.position, a) - this.dist(u.position, b))
      .slice(0, 2);
    for (const c of around) {
      if (this.dist(c, u.position) === 0) return true;
      const p2 = findPath(this.known, u, c, { maxTurns: this.searchTurns(u, c) });
      if (p2) return this.follow(u, p2);
    }
    return false;
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
    // Spread around the target (free tiles first): units on every side cut it off,
    // and a city ringed on half its sides is besieged.
    const crowd = (c: Coord) => this.world.unitsAt(c).filter((x) => x.owner === this.me && x.carriedBy === null).length;
    const spots = this.world.grid
      .neighbors(target)
      .filter((c) => (naval ? this.isKnownWaterOrPort(c) : u.def.domain === 'air' || this.fog.isExplored(this.world.grid.index(c))))
      .sort((a, b) => Math.min(crowd(a), 1) - Math.min(crowd(b), 1) || this.dist(u.position, a) - this.dist(u.position, b))
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

