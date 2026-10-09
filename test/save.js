// Saving a game to disk and loading it back must change nothing. Proof 1: the same seeded games, one run
// untouched and one that is serialised and reloaded after EVERY action, must end in an identical state.
// Proof 2: each kind of "pay a debt, then carry on" still works when the game is saved in the middle of it.
'use strict';
const assert = require('assert');
const { Game } = require('../js/engine.js');
const AI = require('../js/ai.js');

function mulberry32(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const names = (n) => Array.from({ length: n }, (_, i) => ({ name: 'P' + i, ai: true }));
const roundtrip = (g) => Game.fromSave(JSON.parse(JSON.stringify(g.toSave())), g.rng); // through real JSON text, like a file
const json = (g) => JSON.stringify(g.toSave());

// ---- Proof 1: identical outcomes with and without saving after every action
let debts = 0, compared = 0;
for (let seed = 1; seed <= 40; seed++) {
  const players = 2 + (seed % 5);
  const plain = new Game({ players: names(players), rng: mulberry32(seed) });
  let saved = new Game({ players: names(players), rng: mulberry32(seed) });
  for (let step = 0; step < 4000 && plain.phase !== 'gameover'; step++) {
    AI.act(plain);
    AI.act(saved);
    if (saved.debt) debts++;
    saved = roundtrip(saved); // <- save to JSON text and load it back, every single action
    assert.strictEqual(json(saved), json(plain), `seed ${seed}: diverged after action ${step}`);
  }
  compared++;
}
console.log(`identical after save+load on every action: ${compared} games (${debts} of those actions happened mid-debt)`);

// ---- Proof 2: a save in the middle of a debt, for each kind of continuation
const mk = (n = 3) => new Game({ players: names(n).map((p) => ({ name: p.name })), rng: mulberry32(7) });
const give = (g, pid, ...idx) => idx.forEach((i) => { g.props[i].owner = pid; });

{ // rent: land on someone's property with too little cash
  const g = mk(); give(g, 1, 39); g.players[0].cash = 5; g.players[0].pos = 35; g.phase = 'roll'; g.rng = () => 0.999; // dice 6,6? use steps below
  g.players[0].pos = 37; g.step({ steps: 0, from: 0, to: 0 }, 2); // lands on 39 (rent 50)
  assert.strictEqual(g.phase, 'debt');
  const r = roundtrip(g);
  assert.deepStrictEqual(r.debt.then, { t: 'after' });
  r.players[0].cash = 400; r.checkDebt();
  assert.strictEqual(r.players[1].cash, 1500 + 50, 'the rent is paid to the owner after the reload');
  assert.notStrictEqual(r.phase, 'debt');
}
{ // a card that makes you pay EVERY other player: save in the middle, finish after
  const g = mk(4);
  g.decks.chance.unshift({ t: 'payEach', amt: 50, text: 'test' });
  g.players[0].cash = 70; g.players[0].pos = 7; g.phase = 'roll'; // chance square
  g.drawCard('chance'); // pays P1 ($70 -> $20), then can't afford P2
  assert.strictEqual(g.phase, 'debt');
  assert.strictEqual(g.players[1].cash, 1550);
  const r = roundtrip(g);
  assert.strictEqual(r.debt.then.t, 'payEach');
  assert.deepStrictEqual(r.debt.then.ids, [1, 2, 3]);
  assert.strictEqual(r.debt.then.k, 2, 'two more players still to be paid');
  r.players[0].cash = 500; r.checkDebt(); // settles P2 and carries on to P3
  assert.strictEqual(r.players[2].cash, 1550);
  assert.strictEqual(r.players[3].cash, 1550, 'the last player is paid too, after the reload');
  assert.notStrictEqual(r.phase, 'debt');
}
{ // third failed jail attempt: pay the fine, then move by the dice
  const g = mk(); const p = g.players[0];
  p.inJail = true; p.jailTurns = 2; p.pos = 10; p.cash = 10; g.phase = 'roll';
  const seq = [0.0, 0.2]; g.rng = () => seq.shift(); // dice 1 and 2: not doubles
  g.rollDice(0);
  assert.strictEqual(g.phase, 'debt');
  const r = roundtrip(g);
  assert.strictEqual(r.debt.then.t, 'jailMove'); assert.strictEqual(r.debt.then.steps, 3);
  r.players[0].cash = 200; r.checkDebt();
  assert.strictEqual(r.players[0].inJail, false, 'released after paying');
  assert.strictEqual(r.players[0].pos, 13, 'and moved 1+2 from the jail square');
}
{ // bank installments across two loans: save while the first is unpaid
  const g = mk(); g.players[0].cash = 5000; g.phase = 'postroll';
  g.borrow(0, 500); g.borrow(0, 300);
  g.players[0].cash = 10;
  g.endTurn(0); g.phase = 'postroll'; g.endTurn(1); g.phase = 'postroll'; g.endTurn(2); // back to P0: payments due
  assert.strictEqual(g.phase, 'debt');
  const r = roundtrip(g);
  assert.strictEqual(r.debt.then.t, 'installment');
  r.players[0].cash = 1000; r.checkDebt();
  while (r.phase === 'debt') { r.players[0].cash += 1000; r.checkDebt(); }
  assert.strictEqual(r.loansOf(0).length, 2);
  assert(r.loansOf(0).every((l) => l.remaining < l.principal), 'both loans were paid down after the reload');
  assert.strictEqual(r.phase, 'roll');
}
{ // an auction in progress and a hidden deck order survive too
  const g = mk(); g.players[0].pos = 1; g.phase = 'roll'; g.land(); g.declineBuy(0);
  assert.strictEqual(g.phase, 'auction');
  const r = roundtrip(g);
  assert.deepStrictEqual(r.auction, g.auction);
  r.auctionBid(0, 30); r.auctionPass(1); r.auctionPass(2);
  assert.strictEqual(r.props[1].owner, 0, 'the auction can be finished after the reload');
  assert.deepStrictEqual(roundtrip(g).decks, g.decks, 'card deck order is kept');
}
// older saves (from before a feature existed) still load
{
  const g = mk(); const data = g.toSave(); delete data.loans; delete data.round; delete data.loanSeq; delete data.endedByLimit; delete data.rules.loans;
  const old = Game.fromSave(data);
  assert.deepStrictEqual(old.loans, []); assert.strictEqual(old.round, 1); assert(old.rules.loans.rate > 0);
}
console.log('save OK');
