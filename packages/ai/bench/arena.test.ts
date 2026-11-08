/**
 * Bot arena: complete games between bots, for tuning. Not part of the normal suite.
 *   ARENA=1 npx vitest run bench/arena.test.ts
 * Optional: ARENA_GAMES, ARENA_SIZE (small|medium), ARENA_ROUNDS.
 */
import { it } from 'vitest';
import { Match, PlayerId, generateMap, type MapSize } from '@sc/core';
import { botPersonality, playBotTurn, playSimpleBotTurn, type PersonalityId } from '../src/index.js';

type Brain = { name: string; play: (m: Match, p: PlayerId) => void; personality?: PersonalityId };

export function playGame(seed: string, size: MapSize, brains: [Brain, Brain], maxRounds: number) {
  const players = [PlayerId('p1'), PlayerId('p2')];
  const map = generateMap({ size, density: 'normal', seed }, players);
  const { match } = Match.start(map.world, players, undefined, seed);
  let slowest = 0;
  const combats = [0, 0];
  const timeline: string[] = [];
  while (match.status === 'playing' && match.round <= maxRounds) {
    const p = match.activePlayer!;
    const i = players.indexOf(p);
    const t = performance.now();
    brains[i]!.play(match, p);
    slowest = Math.max(slowest, performance.now() - t);
    match.endTurn(p);
    if (i === 1 && match.round % 25 === 0) {
      timeline.push(`R${match.round}:${players.map((q) => match.world.citiesOf(q).length).join('-')}`);
    }
  }
  return {
    winner: match.winner ? brains[players.indexOf(match.winner)]!.name : 'none',
    rounds: match.round,
    cities: players.map((q) => match.world.citiesOf(q).length),
    units: players.map((q) => match.world.unitsOf(q).length),
    slowest: Math.round(slowest),
    timeline,
    personalities: players.map((q) => (brains[players.indexOf(q)]!.name === 'strategic' ? botPersonality(match, q).id : '-')),
    combats,
  };
}

const strategic = (personality?: PersonalityId): Brain => ({
  name: 'strategic',
  play: (m, p) => playBotTurn(m, p, personality ? { personality } : {}),
});
const simple: Brain = { name: 'simple', play: (m, p) => void playSimpleBotTurn(m, p) };

it.skipIf(!process.env.ARENA)('arena: strategic vs simple', () => {
  const games = Number(process.env.ARENA_GAMES ?? 6);
  const size = (process.env.ARENA_SIZE ?? 'small') as MapSize;
  const maxRounds = Number(process.env.ARENA_ROUNDS ?? 200);
  const forced = process.env.ARENA_PERSONALITY as PersonalityId | undefined;
  let wins = 0;
  const offset = Number(process.env.ARENA_OFFSET ?? 0);
  for (let g = offset; g < offset + games; g++) {
    const seatSwap = g % 2 === 1;
    const brains: [Brain, Brain] = seatSwap ? [simple, strategic(forced)] : [strategic(forced), simple];
    const r = playGame(`arena-${g}`, size, brains, maxRounds);
    if (r.winner === 'strategic') wins++;
    console.log(
      `game ${g} seats ${brains.map((b) => b.name).join('/')} [${r.personalities.join('/')}] -> ${r.winner} @R${r.rounds} cities ${r.cities.join('-')} units ${r.units.join('-')} slowest ${r.slowest}ms | ${r.timeline.join(' ')}`,
    );
  }
  console.log(`strategic won ${wins}/${games} (maps ${offset}..${offset + games - 1})`);
}, 1_800_000);
