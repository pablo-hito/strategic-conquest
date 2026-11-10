import type { CombatResult, PlayerId, PlayerView, TurnEvent } from '@sc/core';
import type { IdMask } from './ids.js';

/** The player's view with every unit id replaced by that player's opaque id. */
export function maskView(view: PlayerView, mask: IdMask): PlayerView {
  const m = (id: string) => mask.toOpaque(id);
  return {
    ...view,
    ownUnits: view.ownUnits.map((u) => ({
      ...u,
      id: m(u.id),
      carriedBy: u.carriedBy === null ? null : m(u.carriedBy),
      cargo: u.cargo.map(m),
    })),
    foreignUnits: view.foreignUnits.map((u) => ({ ...u, id: m(u.id) })),
    ghosts: view.ghosts.map((g) => ({ ...g, id: m(g.id) })),
  };
}

/** Events a player may hear about, with unit ids masked for them. */
export function eventsFor(events: readonly TurnEvent[], player: PlayerId, mask: IdMask): TurnEvent[] {
  const m = (id: string) => mask.toOpaque(id);
  const out: TurnEvent[] = [];
  for (const e of events) {
    if (e.audience !== 'all' && e.audience !== player) continue;
    switch (e.type) {
      case 'unit_produced':
      case 'aircraft_crashed':
      case 'out_of_supply':
        out.push({ ...e, unit: m(e.unit) });
        break;
      case 'units_deserted':
        out.push({ ...e, units: e.units.map(m) });
        break;
      case 'aircraft_landed':
        out.push({ ...e, unit: m(e.unit), carrier: m(e.carrier) });
        break;
      case 'combat': {
        const r: CombatResult = {
          ...e.result,
          attacker: m(e.result.attacker),
          defender: e.result.defender === null ? null : m(e.result.defender),
          lost: e.result.lost.map(m),
        };
        out.push({ ...e, result: r });
        break;
      }
      default:
        out.push(e);
    }
  }
  return out;
}
