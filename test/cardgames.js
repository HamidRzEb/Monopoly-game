// Rules and simulation tests for Blackjack, Uno and Texas Hold'em, without the server.
// Usage: node test/cardgames.js [games-per-setup]
'use strict';
const assert = require('assert');
const BJ = require('../js/games/blackjack.js');
const UNO = require('../js/games/uno.js');
const POKER = require('../js/games/poker.js');
const { cardName } = require('../js/games/core.js');

const GAMES_EACH = Number(process.argv[2]) || 30;

function seeded(seed) { // mulberry32: reproducible runs, so a failure can be replayed
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const people = (n) => Array.from({ length: n }, (_, i) => ({ name: `P${i}`, color: '#000', token: 'x', ai: true }));
const card = (rank, suit = 0) => (rank - 2) + suit * 13; // 2..14, suit 0..3

// ---------------------------------------------------------------- poker: hands
{
  const best = (...cs) => POKER.bestScore(cs);
  const hands = {
    royal: best(card(14, 1), card(13, 1), card(12, 1), card(11, 1), card(10, 1)),
    straightFlush: best(card(9, 2), card(8, 2), card(7, 2), card(6, 2), card(5, 2)),
    quads: best(card(7), card(7, 1), card(7, 2), card(7, 3), card(2)),
    fullHouse: best(card(9), card(9, 1), card(9, 2), card(4), card(4, 1)),
    flush: best(card(14, 3), card(10, 3), card(8, 3), card(5, 3), card(3, 3)),
    straight: best(card(10), card(9, 1), card(8, 2), card(7, 3), card(6)),
    wheel: best(card(14), card(2, 1), card(3, 2), card(4, 3), card(5)),
    trips: best(card(8), card(8, 1), card(8, 2), card(13), card(2)),
    twoPair: best(card(8), card(8, 1), card(5, 2), card(5, 3), card(2)),
    pair: best(card(8), card(8, 1), card(14, 2), card(5, 3), card(2)),
    high: best(card(14), card(12, 1), card(9, 2), card(5, 3), card(2)),
  };
  const order = ['royal', 'straightFlush', 'quads', 'fullHouse', 'flush', 'straight', 'trips', 'twoPair', 'pair', 'high'];
  for (let i = 0; i + 1 < order.length; i++) assert(hands[order[i]] > hands[order[i + 1]], `${order[i]} should beat ${order[i + 1]}`);
  assert(hands.straight > hands.wheel, 'a six-high straight beats the wheel');
  assert(hands.wheel > hands.trips, 'the wheel is a straight (5-high), above three of a kind');
  assert.strictEqual(POKER.handName(hands.royal), 'Royal flush');
  assert.strictEqual(POKER.handName(hands.wheel), 'Straight');
  assert.strictEqual(POKER.handName(hands.high), 'A-high');
  // kickers decide between equal pairs; suits never do
  assert(best(card(8), card(8, 1), card(14, 2), card(5, 3), card(2)) > best(card(8, 2), card(8, 3), card(13, 2), card(5, 1), card(2, 1)));
  assert.strictEqual(best(card(8), card(8, 1), card(14, 2), card(5, 3), card(2)), best(card(8, 2), card(8, 3), card(14, 1), card(5, 1), card(2, 1)));
  // best five out of seven
  assert.strictEqual(best(card(14), card(14, 1), card(14, 2), card(9), card(9, 1), card(2), card(3)), best(card(14), card(14, 1), card(14, 2), card(9), card(9, 1)));
}

// ---------------------------------------------------------------- poker: betting, side pots
{
  const p = POKER.create(people(3), { hands: 5 }, seeded(1));
  const total = () => p.players.reduce((s, x) => s + x.chips, 0) + p.pot();
  assert.strictEqual(total(), 3000);
  // button is seat 0 in hand 1, so seat 1 posts 10, seat 2 posts 20 and seat 0 acts first
  assert.deepStrictEqual([p.players[1].bet, p.players[2].bet, p.toAct], [10, 20, 0]);
  assert.throws(() => p.call(1), /turn/);
  assert.throws(() => p.raise(0, 30), /minimum raise/);
  assert.throws(() => p.check(0), /call, raise or fold/);
  p.call(0); p.call(1);
  assert.strictEqual(p.toAct, 2, 'the big blind still has the option');
  p.check(2);
  assert.strictEqual(p.street, 'flop');
  assert.strictEqual(p.board.length, 3);
  assert.strictEqual(p.toAct, 1, 'after the flop the first active player left of the button acts');
  p.fold(1); p.fold(2);
  assert.strictEqual(p.phase, 'result');
  assert.strictEqual(p.players[0].chips, 1000 + 40, 'seat 0 wins the blinds of the others');
  assert.strictEqual(total(), 3000, 'chips are conserved');
  assert.strictEqual(p.result.uncontested, true);
  assert.strictEqual(p.players[2].hole.length, 2);
  assert(!p.snapshot(0).players[1].hole.length, 'a folded opponent\'s cards stay hidden');
}
{
  // side pots: three players all in with different stacks. Rig the deck so seat 2 > seat 1 > seat 0.
  const g = new POKER.Engine({ players: people(3), rules: { hands: 5 }, rng: seeded(3) });
  const reset = (stacks, holes, board) => {
    // re-deal the same hand with chosen stacks/cards
    for (const [i, s] of stacks.entries()) Object.assign(g.players[i], { chips: s, bet: 0, total: 0, folded: false, allIn: false, acted: false, out: false });
    g.players.forEach((q, i) => { q.hole = holes[i]; });
    g.board = []; g.deck = board.slice().reverse().concat(g.deck.filter((c) => ![...board, ...holes.flat()].includes(c))); // board cards come off the top
    g.phase = 'bet'; g.street = 'preflop'; g.revealed = false; g.result = null;
    g.button = 0;
    g.post(g.players[1], 10); g.post(g.players[2], 20);
    g.currentBet = 20; g.lastRaise = 20; g.toAct = 0;
  };
  const AA = [card(14), card(14, 1)], KK = [card(13), card(13, 1)], QQ = [card(12), card(12, 1)];
  // seat 0 (short, 100) has the best hand, seat 1 (300) second, seat 2 (500) worst
  reset([100, 300, 500], [AA, KK, QQ], [card(2, 2), card(5, 3), card(9, 2), card(7, 3), card(3, 1)]);
  assert.strictEqual(g.players.reduce((s, x) => s + x.chips + x.total, 0), 900);
  g.raise(0, 100);           // all in for 100
  g.raise(1, 300);           // all in for 300
  g.call(2);                 // calls 300 of 500 (not all in)
  assert.strictEqual(g.phase, 'result', 'with nobody left to bet against, the board runs out by itself');
  assert.strictEqual(g.board.length, 5);
  // main pot 3*100=300 -> seat 0 (AA); side pot 2*200=400 -> seat 1 (KK); seat 2 keeps the 200 he never put in
  assert.deepStrictEqual(g.players.map((x) => x.chips), [300, 400, 200]);
  assert.deepStrictEqual(g.result.pots.map((x) => [x.amount, x.winners]), [[300, [0]], [400, [1]]]);
  assert.strictEqual(g.players.reduce((s, x) => s + x.chips, 0), 900, 'chips conserved through side pots');
  assert(g.revealed && g.snapshot(2).players[0].hole.length === 2, 'all-in hands are turned over');
}
{
  // a tie splits the pot, odd chip to the player closest to the left of the button
  const g = new POKER.Engine({ players: people(3), rules: { hands: 5 }, rng: seeded(4) });
  for (const q of g.players) Object.assign(q, { chips: 0, bet: 0, total: 0, folded: false, allIn: false, out: false });
  g.players[0].total = 101; g.players[1].total = 101; g.players[2].total = 101; // 303 in the pot
  g.players[0].hole = [card(14), card(2)]; g.players[1].hole = [card(14, 1), card(2, 1)]; g.players[2].hole = [card(3), card(4)];
  g.board = [card(13, 2), card(12, 2), card(11, 3), card(9, 3), card(8, 3)];
  g.button = 2; g.phase = 'bet';
  g.showdown();
  assert.deepStrictEqual(g.players.map((x) => x.chips), [152, 151, 0].map((x, i) => (i === 2 ? 0 : x)));
}

// ---------------------------------------------------------------- blackjack: payouts
{
  const play = (shoe, bets, moves) => {
    const g = BJ.create(people(1), { rounds: 5 }, seeded(5));
    g.shoe = shoe.slice().reverse(); // we list cards in the order they come out
    g.bet(0, bets);
    for (const m of moves) g[m](0);
    return g;
  };
  const A = 14, K = 13;
  // deal order: p, dealer, p, dealer
  let g = play([card(A), card(9), card(K), card(8)], 100, []);
  assert.strictEqual(g.phase, 'result');
  assert.strictEqual(g.players[0].chips, 1000 + 150, 'blackjack pays 3:2');
  g = play([card(10), card(9), card(8), card(7)], 100, ['stand']); // 18 vs 16 -> dealer draws
  assert.strictEqual(g.phase === 'result' || g.phase === 'play', true);
  g = play([card(10), card(10), card(9), card(7), card(5)], 100, ['stand']); // 19 vs 17 -> dealer stands, player wins
  assert.strictEqual(g.players[0].result, 'win');
  assert.strictEqual(g.players[0].chips, 1100);
  g = play([card(10), card(10), card(9), card(7), card(10)], 100, ['stand']);
  assert.strictEqual(g.dealer.length, 2, 'dealer stands on 17');
  g = play([card(5), card(10), card(6), card(7), card(10), card(2)], 100, ['double']); // 11 doubled, draws 10 = 21 vs 17
  assert.strictEqual(g.players[0].bet, 200);
  assert.strictEqual(g.players[0].chips, 1200, 'a won double pays double');
  g = play([card(10), card(10), card(6), card(7), card(9)], 100, ['hit']); // 16 hit 9 = 25 bust
  assert.strictEqual(g.players[0].result, 'lose');
  assert.strictEqual(g.players[0].chips, 900);
  assert.strictEqual(g.dealer.length, 2, 'the dealer does not draw when everyone busted');
  g = play([card(10), card(A), card(9), card(K)], 100, []); // dealer shows an ace and has blackjack
  assert.strictEqual(g.players[0].result, 'lose');
  assert.strictEqual(g.phase, 'result');
  g = play([card(A), card(A), card(K), card(K)], 100, []); // both blackjack -> push
  assert.strictEqual(g.players[0].result, 'push');
  assert.strictEqual(g.players[0].chips, 1000);
  assert.deepStrictEqual([BJ.handValue([card(A), card(A), card(9)]).total, BJ.handValue([card(A), card(6)]).soft], [21, true]);
  const g2 = BJ.create(people(1), { rounds: 5 }, seeded(6));
  assert.throws(() => g2.bet(0, 5), /minimum/);
  assert.throws(() => g2.bet(0, 5000), /most you can bet/);
  assert.throws(() => g2.hit(0), /time to play/);
  assert(g2.snapshot(0).shoeLeft > 100 && !('shoe' in g2.snapshot(0)));
}

// ---------------------------------------------------------------- uno: rules
{
  const g = UNO.create(people(3), { target: 0 }, seeded(7));
  const total = (x) => x.hands.reduce((s, h) => s + h.length, 0) + x.drawPile.length + x.discard.length;
  assert.strictEqual(total(g), 108);
  assert(/^[rygb]\d$/.test(g.top()), 'the first card is a plain number');
  // rig a position: 3 players, p0 to play
  g.current = 0; g.dir = 1; g.color = 'r'; g.discard = ['r5']; g.drawn = null;
  g.hands = [['r7', 'b5', 'wF', 'g2'], ['y1', 'y2'], ['b9', 'b8', 'b7']];
  assert.throws(() => g.play(1, 0), /turn/);
  assert.throws(() => g.play(0, 3), /doesn't match/);
  assert.throws(() => g.play(0, 2, 0), /only allowed when you have no/);
  g.play(0, 1);                                   // b5 matches the number
  assert.strictEqual(g.color, 'b'); assert.strictEqual(g.current, 1);
  g.hands[1] = ['bR', 'y2'];
  g.play(1, 0);                                   // reverse: direction flips, back to player 0
  assert.strictEqual(g.dir, -1); assert.strictEqual(g.current, 0);
  g.hands[0] = ['wF', 'g2']; g.color = 'b';
  g.play(0, 0, 2);                                // wild draw four, no blue in hand, picks green
  assert.strictEqual(g.color, 'g');
  assert.strictEqual(g.hands[2].length, 3 + 4, 'the next player (going backwards) is player 2... draws 4');
}
{
  // draw rules: a card that fits can be played or kept; a card that doesn't ends the turn
  const g = UNO.create(people(2), { target: 0 }, seeded(8));
  g.current = 0; g.color = 'r'; g.discard = ['r5']; g.drawn = null;
  g.hands = [['b1'], ['y1', 'y2']];
  g.drawPile = ['b9', 'r2'];
  g.draw(0);                                      // gets r2 (fits)
  assert.strictEqual(g.drawn, 1); assert.strictEqual(g.current, 0);
  assert.throws(() => g.draw(0), /already drew/);
  assert.throws(() => g.play(0, 0), /only play the card you drew/);
  g.pass(0);
  assert.strictEqual(g.current, 1); assert.strictEqual(g.drawn, null);
  g.hands[1] = ['y1', 'y2']; g.drawPile = ['b9'];
  g.draw(1);                                      // b9 doesn't fit red 5
  assert.strictEqual(g.current, 0, 'a card that doesn\'t fit ends the turn by itself');
  // two players: reverse acts like a skip, and winning scores the other hands
  const h = UNO.create(people(2), { target: 150 }, seeded(9));
  h.current = 0; h.color = 'r'; h.discard = ['r5']; h.drawn = null;
  h.hands = [['rR', 'r1'], ['wW', 'y9']];
  h.play(0, 0);
  assert.strictEqual(h.current, 0, 'reverse with two players is a skip');
  h.play(0, 0);
  assert.strictEqual(h.phase, 'result');
  assert.strictEqual(h.players[0].score, 50 + 9);
  assert(h.snapshot(1).hands[0], 'hands are revealed when the round ends');
  h.continue(0); h.continue(1);
  assert.strictEqual(h.phase, 'play'); assert.strictEqual(h.round, 2);
  // the snapshot hides everyone else's hand and the draw pile
  const s = h.snapshot(1);
  assert(s.hands[1] && s.hands[0] === null && !('drawPile' in s));
}

// ---------------------------------------------------------------- full simulations
const MODS = { blackjack: BJ, uno: UNO, poker: POKER };
function simulate(name, nPlayers, settings, seed) {
  const mod = MODS[name];
  const rng = seeded(seed);
  const g = mod.create(people(nPlayers), settings, rng);
  const start = g.toSave();
  let steps = 0;
  const startChips = nPlayers * (g.rules.startChips || 0);
  while (g.phase !== 'gameover') {
    if (++steps > 20000) throw new Error(`${name} (${nPlayers}p, seed ${seed}) did not finish`);
    const d = g.decider();
    // the bot only gets what a real player is shown
    const view = mod.Engine.fromSnapshot(JSON.parse(JSON.stringify(g.snapshot(d.id))));
    let move;
    try { move = name === 'poker' ? mod.decide(view, d.id, rng, 40) : mod.decide(view, d.id, rng); }
    catch (e) { throw new Error(`${name} bot crashed (seed ${seed}, step ${steps}): ${e.stack}`); }
    try { g[move.action](d.id, ...move.args); }
    catch (e) { throw new Error(`${name} bot move ${JSON.stringify(move)} rejected (seed ${seed}, step ${steps}, phase ${g.phase}): ${e.message}`); }

    // invariants
    if (name === 'poker') assert.strictEqual(g.players.reduce((s, p) => s + p.chips, 0) + g.pot(), startChips, `poker chips must be conserved (seed ${seed})`);
    if (name === 'poker') for (const p of g.players) assert(p.chips >= 0 && p.bet >= 0);
    if (name === 'blackjack') for (const p of g.players) assert(p.chips >= 0, 'blackjack chips never negative');
    if (name === 'uno') assert.strictEqual(g.hands.reduce((s, h) => s + h.length, 0) + g.drawPile.length + g.discard.length, 108, `uno must always hold 108 cards (seed ${seed})`);
    // nobody sees anyone else's secrets
    if (steps % 7 === 0) {
      for (const seat of [0, nPlayers - 1]) {
        const s = JSON.stringify(g.snapshot(seat));
        if (name === 'uno' && g.phase === 'play') {
          const other = g.hands.findIndex((_, i) => i !== seat);
          assert.strictEqual(g.snapshot(seat).hands[other], null);
          assert(!('drawPile' in g.snapshot(seat)));
        }
        if (name === 'poker' && !g.revealed) for (const p of g.snapshot(seat).players) if (p.id !== seat) assert.strictEqual(p.hole.length, 0, 'poker hole cards leaked');
        if (name === 'poker') assert(!('deck' in g.snapshot(seat)));
        if (name === 'blackjack' && g.phase === 'play') assert.strictEqual(g.snapshot(seat).dealer[1], null, 'blackjack hole card leaked');
        assert(s.length < 60000);
      }
      // saving and loading in the middle of a game changes nothing
      const copy = mod.Engine.fromSave(JSON.parse(JSON.stringify(g.toSave())), rng);
      assert.deepStrictEqual(JSON.parse(JSON.stringify(copy.toSave())), JSON.parse(JSON.stringify(g.toSave())), 'save/load must round-trip');
    }
  }
  assert(g.winner != null, 'a finished game has a winner');
  return { steps, g };
}

const setups = [
  ['blackjack', 1, { rounds: 5 }], ['blackjack', 4, { rounds: 10 }], ['blackjack', 6, { rounds: 20 }],
  ['uno', 2, { target: 0 }], ['uno', 4, { target: 150 }], ['uno', 8, { target: 0 }], ['uno', 3, { target: 300 }],
  ['poker', 2, { hands: 25 }], ['poker', 5, { hands: 25 }], ['poker', 8, { hands: 10 }],
];
for (const [name, n, settings] of setups) {
  let total = 0, max = 0;
  const t0 = Date.now();
  const games = name === 'poker' ? Math.max(5, Math.floor(GAMES_EACH / 3)) : GAMES_EACH;
  for (let k = 0; k < games; k++) { const { steps } = simulate(name, n, settings, 1000 * n + k + name.length); total += steps; max = Math.max(max, steps); }
  console.log(`${name.padEnd(9)} ${n} players ${JSON.stringify(settings).padEnd(16)} ${games} games OK (avg ${Math.round(total / games)} moves, max ${max}, ${Date.now() - t0} ms)`);
}
console.log('cardgames OK');
