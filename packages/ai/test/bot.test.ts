import { describe, expect, it } from 'vitest';
import { Grid, Match, PlayerId, WorldState, generateMap, type MapSize } from '@sc/core';
import { playBotTurn } from '../src/index.js';

const P1 = PlayerId('p1');
const P2 = PlayerId('p2');

function newMatch(seed: string, size: MapSize = 'small', players = [P1, P2]) {
  const map = generateMap({ size, density: 'normal', seed }, players);
  return Match.start(map.world, players, undefined, seed).match;
}

/** Run turns: bots play, everyone else just passes. */
function runRounds(match: Match, bots: ReadonlySet<PlayerId>, rounds: number): void {
  const stop = match.round + rounds;
  while (match.status === 'playing' && match.round < stop) {
    const p = match.activePlayer!;
    if (bots.has(p)) playBotTurn(match, p);
    const r = match.endTurn(p);
    if (!r.ok) throw new Error(r.error.message);
  }
}

describe('playBotTurn', () => {
  it('expands against a passive opponent', () => {
    const match = newMatch('bot-expands');
    runRounds(match, new Set([P2]), 60);
    const bot = match.world.citiesOf(P2).length;
    expect(bot).toBeGreaterThanOrEqual(5);
    expect(match.world.citiesOf(P1).length).toBeLessThanOrEqual(1);
  });

  it('builds and uses transports once its island is done', () => {
    const match = newMatch('bot-ferries', 'medium');
    let carried = 0;
    const stop = match.round + 80;
    while (match.status === 'playing' && match.round < stop) {
      const p = match.activePlayer!;
      if (p === P2) {
        playBotTurn(match, p);
        carried = Math.max(carried, match.world.unitsOf(P2).filter((u) => u.carriedBy !== null).length);
      }
      match.endTurn(p);
    }
    expect(match.world.unitsOf(P2).some((u) => u.type === 'transport')).toBe(true);
    expect(carried).toBeGreaterThan(0);
  });

  it('two bots fight a whole game deterministically', () => {
    const play = () => {
      const match = newMatch('bot-duel');
      const events: string[] = [];
      const stop = match.round + 90;
      while (match.status === 'playing' && match.round < stop) {
        const p = match.activePlayer!;
        const r = playBotTurn(match, p);
        for (const e of r.events) events.push(e.type);
        match.endTurn(p);
      }
      return { snap: JSON.stringify(match.toSnapshot()), events };
    };
    const a = play();
    const b = play();
    expect(a.snap).toBe(b.snap);
    expect(a.events).toContain('city_captured');
    expect(a.events).toContain('combat');
  });

  it('does nothing when it is not its turn', () => {
    const match = newMatch('bot-idle');
    const before = JSON.stringify(match.toSnapshot());
    expect(playBotTurn(match, P2)).toEqual({ events: [], moves: 0, attacks: 0 });
    expect(JSON.stringify(match.toSnapshot())).toBe(before);
  });

  it('takes favorable fights and avoids hopeless ones', () => {
    const w = new WorldState(Grid.filled(8, 3, 'plains'));
    w.foundCity('Home', { x: 0, y: 1 }).capture(P1);
    w.foundCity('Theirs', { x: 7, y: 1 }).capture(P2);
    const tank = w.spawnUnit('heavy_tank', P1, { x: 3, y: 1 });
    const weak = w.spawnUnit('infantry', P2, { x: 4, y: 1 });
    weak.takeDamage(6);
    const { match } = Match.start(w, [P1, P2]);
    const r = playBotTurn(match, P1);
    expect(r.attacks).toBe(1);
    expect(match.world.unit(weak.id)).toBeUndefined();
    void tank;

    const w2 = new WorldState(Grid.filled(8, 3, 'plains'));
    w2.foundCity('Home', { x: 0, y: 1 }).capture(P1);
    w2.foundCity('Theirs', { x: 7, y: 1 }).capture(P2);
    const inf = w2.spawnUnit('infantry', P1, { x: 3, y: 1 });
    inf.takeDamage(5);
    w2.spawnUnit('heavy_tank', P2, { x: 4, y: 1 });
    const m2 = Match.start(w2, [P1, P2]).match;
    expect(playBotTurn(m2, P1).attacks).toBe(0);
  });

  it('keeps turns fast on a medium map with many units', () => {
    const match = newMatch('bot-speed', 'medium', [P1, P2, PlayerId('p3'), PlayerId('p4')]);
    let slowest = 0;
    const stop = match.round + 60;
    while (match.status === 'playing' && match.round < stop) {
      const p = match.activePlayer!;
      const t = performance.now();
      playBotTurn(match, p);
      slowest = Math.max(slowest, performance.now() - t);
      match.endTurn(p);
    }
    expect(slowest).toBeLessThan(1000);
  });
});
