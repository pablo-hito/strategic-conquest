/**
 * Bot vs bot duels for tuning (not part of the normal suite).
 *   DUEL=1 A=new:blitz B=old:conquistador npx vitest run bench/duel.test.ts
 * "new" is src/; "old" is a snapshot in bench/baseline (not committed): before a tuning
 * session copy src/strategic-bot.ts and src/personalities.ts there, and point its
 * simple-bot import at ../../src/simple-bot.js.
 */
import { it } from 'vitest';
import { Match, PlayerId, generateMap, type MapSize } from '@sc/core';
import { playBotTurn } from '../src/index.js';

type Play = (m: Match, p: PlayerId, o: { personality: never }) => unknown;
type Spec = { label: string; play: (m: Match, p: PlayerId) => void };
const spec = async (s: string): Promise<Spec> => {
  const [ver, pers] = s.split(':') as [string, string];
  const baseline = './baseline/strategic-bot.js';
  const fn: Play = ver === 'old' ? (await import(/* @vite-ignore */ baseline)).playBotTurn : playBotTurn;
  return { label: s, play: (m, p) => void fn(m, p, { personality: pers as never }) };
};

it.skipIf(!process.env.DUEL)('duel', async () => {
  const A = await spec(process.env.A ?? 'new:blitz');
  const B = await spec(process.env.B ?? 'new:conquistador');
  const games = Number(process.env.GAMES ?? 6);
  const size = (process.env.SIZE ?? 'small') as MapSize;
  const maxRounds = Number(process.env.ROUNDS ?? 250);
  const marks = [10, 20, 30, 40, 60, 100, 150];
  let a = 0, b = 0;
  for (let g = 0; g < games; g++) {
    const swap = g % 2 === 1;
    const brains = swap ? [B, A] : [A, B];
    const players = [PlayerId('p1'), PlayerId('p2')];
    const seed = `duel-${process.env.SEED ?? ''}${g >> 1}`;
    const map = generateMap({ size, density: 'normal', seed }, players);
    const { match } = Match.start(map.world, players, undefined, seed);
    const tl: string[] = [];
    while (match.status === 'playing' && match.round <= maxRounds) {
      const p = match.activePlayer!;
      const i = players.indexOf(p);
      brains[i]!.play(match, p);
      match.endTurn(p);
      if (i === 1 && marks.includes(match.round - 1)) {
        const [ia, ib] = swap ? [1, 0] : [0, 1];
        tl.push(`R${match.round - 1}:${match.world.citiesOf(players[ia]!).length}-${match.world.citiesOf(players[ib]!).length}`);
      }
    }
    const w = match.winner ? brains[players.indexOf(match.winner)]!.label : 'none';
    if (w === A.label) a++;
    else if (w === B.label) b++;
    const [ia, ib] = swap ? [1, 0] : [0, 1];
    console.log(`g${g} ${seed}${swap ? ' (swap)' : ''} -> ${w} @R${match.round} cities A-B ${match.world.citiesOf(players[ia]!).length}-${match.world.citiesOf(players[ib]!).length} of ${[...match.world.allCities()].length} | ${tl.join(' ')}`);
  }
  console.log(`${A.label} ${a} - ${b} ${B.label}`);
}, 3_600_000);
