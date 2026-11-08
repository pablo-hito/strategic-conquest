import { describe, expect, it } from 'vitest';
import { PlayerId, UnitId, type CombatResult, type TurnEvent } from '@sc/core';
import { IdMask } from '../src/ids.js';
import { eventsFor } from '../src/masking.js';

const A = PlayerId('p1'), B = PlayerId('p2');

describe('eventsFor', () => {
  it('drops other players\' private events and masks unit ids per player', () => {
    const result: CombatResult = {
      attacker: UnitId('u7'), attackerType: 'heavy_tank', defender: UnitId('u9'), defenderType: 'infantry', defenderOwner: B,
      target: { x: 1, y: 1 }, damageToDefender: 5, damageToAttacker: 1, interceptionDamage: 0,
      defenderDestroyed: false, attackerDestroyed: false, lost: [], cityBombed: null,
    };
    const events: TurnEvent[] = [
      { type: 'unit_produced', audience: A, city: 'c1' as never, unit: UnitId('u12'), unitType: 'infantry', at: { x: 0, y: 0 } },
      { type: 'combat', audience: A, result },
      { type: 'combat', audience: B, result },
      { type: 'player_eliminated', audience: 'all', player: B },
    ];
    const ma = new IdMask(), mb = new IdMask();
    const forB = eventsFor(events, B, mb);
    expect(forB.map((e) => e.type)).toEqual(['combat', 'player_eliminated']);
    const forA = eventsFor(events, A, ma);
    expect(forA.map((e) => e.type)).toEqual(['unit_produced', 'combat', 'player_eliminated']);
    const combatA = forA[1] as Extract<TurnEvent, { type: 'combat' }>;
    const combatB = forB[0] as Extract<TurnEvent, { type: 'combat' }>;
    expect(combatA.result.attacker).not.toBe('u7');
    expect(combatA.result.attacker).not.toBe(combatB.result.attacker); // each player has their own ids
    expect(ma.toReal(combatA.result.attacker)).toBe('u7');
    expect(JSON.stringify(forB)).not.toContain('u12');
  });
});
