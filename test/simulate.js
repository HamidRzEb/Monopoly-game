// Plays many bot-only games with seeded randomness and checks invariants.
// Usage: node test/simulate.js [games=200]
'use strict';
const assert = require('assert');
const { Game } = require('../js/engine.js');
const AI = require('../js/ai.js');
const { SPACES } = require('../js/data.js');

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function invariants(g) {
  let houses = 0, hotels = 0;
  for (const [i, st] of Object.entries(g.props)) {
    if (st.houses === 5) hotels++; else houses += st.houses;
    if (st.owner !== null) assert(!g.players[st.owner].bankrupt, `bankrupt player owns ${SPACES[i].name}`);
    if (st.houses) assert(!st.mortgaged, 'mortgaged property has buildings');
  }
  assert.strictEqual(houses + g.housesLeft, g.rules.housesTotal, 'house supply mismatch');
  assert.strictEqual(hotels + g.hotelsLeft, g.rules.hotelsTotal, 'hotel supply mismatch');
  for (const p of g.players) assert(p.cash >= 0, `${p.name} has negative cash`);
}

const N = Number(process.argv[2]) || 200;
let finished = 0, totalSteps = 0, maxSteps = 0, limited = 0;
const STEP_CAP = 60000;
for (let seed = 1; seed <= N; seed++) {
  const count = 2 + (seed % 7);
  const g = new Game({
    players: Array.from({ length: count }, (_, i) => ({ name: 'Bot' + i, color: '#000', token: 'hat', ai: true })),
    rng: mulberry32(seed),
  });
  let steps = 0;
  while (g.phase !== 'gameover' && steps < STEP_CAP) {
    const p = g.decider();
    const offer = AI.proposeTrade(g, p);
    if (offer && g.players[offer.to].ai && !g.validateTrade(p.id, offer.to, offer.give, offer.get)
        && AI.evaluateTrade(g, offer.to, offer.get, offer.give)) {
      g.executeTrade(p.id, offer.to, offer.give, offer.get);
    }
    AI.act(g);
    if (steps % 25 === 0) invariants(g);
    steps++;
  }
  invariants(g);
  if (g.phase === 'gameover') {
    finished++;
    if (g.endedByLimit) { // time ran out: the winner must be the richest survivor
      const best = Math.max(...g.alive().map((p) => g.netWorth(p.id)));
      assert.strictEqual(g.netWorth(g.winner), best, 'round limit must pick the highest net worth');
      assert(!g.players[g.winner].bankrupt);
      limited++;
    } else assert.strictEqual(g.alive().length, 1);
    assert(g.round <= g.rules.maxRounds + 1);
  }
  totalSteps += steps; maxSteps = Math.max(maxSteps, steps);
}
console.log(`${finished}/${N} games finished (${limited} by the round limit); avg ${Math.round(totalSteps / N)} bot actions, max ${maxSteps}`);
assert.strictEqual(finished, N, 'every game must finish now that there is a round limit');
console.log('simulation OK');
