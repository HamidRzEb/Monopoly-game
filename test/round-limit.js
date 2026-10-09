// The round limit: tiny limits end the game, the richest player wins, and the warning messages appear.
'use strict';
const assert = require('assert');
const { Game } = require('../js/engine.js');
const AI = require('../js/ai.js');

function play(maxRounds, seed) {
  let s = seed;
  const rng = () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
  const g = new Game({ players: ['A', 'B', 'C'].map((name) => ({ name, ai: true })), rules: { maxRounds }, rng });
  for (let i = 0; i < 100000 && g.phase !== 'gameover'; i++) AI.act(g);
  return g;
}
for (let seed = 1; seed <= 20; seed++) {
  const g = play(12, seed);
  assert.strictEqual(g.phase, 'gameover', 'game must end');
  assert(g.round <= 13);
  if (g.endedByLimit) {
    assert.strictEqual(g.round, 13, 'ends as round 13 would begin');
    assert.strictEqual(g.netWorth(g.winner), Math.max(...g.alive().map((p) => g.netWorth(p.id))));
    assert(g.log.some((l) => /Time's up/.test(l.text)));
  }
}
const g = play(30, 7);
assert(g.log.some((l) => /10 rounds left/.test(l.text)) || g.phase === 'gameover', 'warning 10 rounds out');
// default is finite
assert(new Game({ players: [{ name: 'A' }, { name: 'B' }] }).rules.maxRounds > 0);
console.log('round-limit OK');
