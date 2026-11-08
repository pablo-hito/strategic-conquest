/**
 * Full games through the same GameSession the UI uses. The "human" seat gives its
 * orders with a scripted strategy; the computer seat is the real bot.
 *   FULLGAME=1 npx vitest run bench/fullgame.test.ts
 */
import { it } from 'vitest';
import { playSimpleBotTurn } from '@sc/ai';
import { GameSession } from '../src/session.js';

it.skipIf(!process.env.FULLGAME)('full games vs the bot', () => {
  const seeds = (process.env.SEEDS ?? 'prueba-1,prueba-2,prueba-3').split(',');
  for (const seed of seeds) {
    const s = GameSession.create({ size: 'small', density: 'normal', players: 2, seed, mode: 'bots', difficulty: (process.env.DIFFICULTY ?? 'normal') as 'normal' });
    const me = s.viewer;
    const bot = s.players[1]!;
    const tally = { botAttacksOnMe: 0, myUnitsLostDefending: 0, myAttacks: 0, botUnitsKilledByMe: 0, citiesLostToBot: 0, citiesTakenFromBot: 0, landingsNearMe: 0 };
    const timeline: string[] = [];
    let firstContact = 0, firstBotAttack = 0, firstCityLost = 0;
    const seenLog = { n: s.log.length };
    let orderChecks = 0;
    while (s.match.status === 'playing' && s.match.round <= 250) {
      // UI rule check: transports come first; cargo at sea never appears in the list.
      const idle = s.idleUnits();
      const firstLand = idle.findIndex((u) => u.def.domain === 'land');
      if (idle.slice(firstLand < 0 ? idle.length : firstLand).some((u) => u.def.cargo)) throw new Error('transport listed after land units');
      orderChecks++;
      playSimpleBotTurn(s.match, me); // my orders this turn
      s.invalidate();
      s.endTurn(); // the real bot plays here
      for (const e of s.log.slice(seenLog.n)) {
        if (e.audience !== me) continue;
        if (/enemigo atacó tu/.test(e.text)) { tally.botAttacksOnMe++; firstBotAttack ||= e.round; if (/destruido/.test(e.text)) tally.myUnitsLostDefending++; }
        if (/te capturó/.test(e.text)) { tally.citiesLostToBot++; firstCityLost ||= e.round; }
      }
      seenLog.n = s.log.length;
      if (!firstContact && s.view().foreignUnits.length > 0) firstContact = s.match.round;
      if (s.match.round % 20 === 0) {
        timeline.push(`R${s.match.round} ${s.world.citiesOf(me).length}-${s.world.citiesOf(bot).length} (u ${s.world.unitsOf(me).length}-${s.world.unitsOf(bot).length})`);
      }
    }
    const botUnits = s.world.unitsOf(bot);
    const mix = [...new Set(botUnits.map((u) => u.type))].map((t) => `${t}:${botUnits.filter((u) => u.type === t).length}`).join(' ');
    console.log(`\n=== ${seed}: bot = ${s.botStyle(bot)}`);
    console.log(`result: ${s.match.winner ? s.nameOf(s.match.winner) + ' wins' : 'no winner'} at round ${s.match.round}; cities me-bot ${s.world.citiesOf(me).length}-${s.world.citiesOf(bot).length}`);
    console.log(`first contact R${firstContact}, first bot attack R${firstBotAttack}, first city lost R${firstCityLost}`);
    console.log(`bot attacks on me ${tally.botAttacksOnMe} (my units destroyed ${tally.myUnitsLostDefending}), cities the bot took from me ${tally.citiesLostToBot}`);
    console.log(`bot army at end: ${mix}`);
    console.log(`timeline (me-bot cities): ${timeline.join(' | ')}`);
    console.log(`unit-order checks passed: ${orderChecks}`);
  }
}, 1_800_000);
