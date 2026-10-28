import type { PlayerId } from '../shared/ids.js';
import { invariant } from '../shared/result.js';
import type { WorldState } from '../world/world-state.js';

export interface VictoryRules {
  /**
   * Share of ALL cities on the map (neutral included) a side must own to win
   * outright. 1 = total conquest. The lobby exposes 0.75–1.
   */
  readonly cityShareToWin: number;
}

export const DEFAULT_VICTORY_RULES: VictoryRules = { cityShareToWin: 0.75 };

export interface PlayerStanding {
  readonly player: PlayerId;
  readonly cities: number;
  readonly units: number;
  readonly eliminated: boolean;
}

export interface VictoryReport {
  readonly standings: PlayerStanding[];
  /** Players knocked out by this evaluation (were alive in `alive`, aren't now). */
  readonly newlyEliminated: PlayerId[];
  /** Set when the match is over. */
  readonly winner: PlayerId | null;
  readonly reason: 'city_share' | 'last_standing' | null;
}

/**
 * A player is out when they hold no city AND have no unit able to take one back
 * (infantry or mechanized infantry, including those aboard transports). Without
 * cities nothing new can be built, so without capturers the player can never recover.
 *
 * Call after any capture or unit loss, and at turn end.
 */
export function evaluateVictory(
  world: WorldState,
  alive: readonly PlayerId[],
  rules: VictoryRules = DEFAULT_VICTORY_RULES,
): VictoryReport {
  invariant(rules.cityShareToWin > 0 && rules.cityShareToWin <= 1, 'cityShareToWin must be in (0, 1]');
  const totalCities = [...world.allCities()].length;

  const standings = alive.map((player): PlayerStanding => {
    const cities = world.citiesOf(player).length;
    const units = world.unitsOf(player);
    const canRecapture = units.some((u) => u.def.canCaptureCities);
    return { player, cities, units: units.length, eliminated: cities === 0 && !canRecapture };
  });

  const newlyEliminated = standings.filter((s) => s.eliminated).map((s) => s.player);
  const survivors = standings.filter((s) => !s.eliminated);

  if (survivors.length === 1) {
    return { standings, newlyEliminated, winner: survivors[0]!.player, reason: 'last_standing' };
  }
  const leader = survivors.find((s) => totalCities > 0 && s.cities / totalCities >= rules.cityShareToWin);
  if (leader) return { standings, newlyEliminated, winner: leader.player, reason: 'city_share' };
  return { standings, newlyEliminated, winner: null, reason: null };
}
