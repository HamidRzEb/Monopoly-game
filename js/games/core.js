// Shared building blocks for the card games (Blackjack, Uno, Poker...): a base engine class and
// playing-card helpers. Pure logic, no I/O; loaded by both the server (require) and the browser (<script>).
//
// A game engine extends BaseGame and provides:
//   view(seat)      the state one player is allowed to see (hidden hands/decks are left out)
//   deciderId()     who has to act next (the server's bot scheduler asks this)
//   fallbackMove(pid)  a safe legal move, used if a bot ever throws
// and one method per action the player can take, each `(pid, ...intArgs)`, throwing an Error with a
// human-readable message if the move isn't allowed. The server runs `game[action](seat, ...args)`.
(function (root) {
  'use strict';

  const clone = (o) => JSON.parse(JSON.stringify(o));

  function shuffle(a, rng = Math.random) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // ---- standard 52-card deck: a card is an integer 0..51
  const SUITS = ['S', 'H', 'D', 'C'];
  const SUIT_GLYPH = { S: '♠', H: '♥', D: '♦', C: '♣' };
  const RANK_LABEL = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
  const rankOf = (c) => 2 + (c % 13);            // 2..14 (ace high)
  const suitOf = (c) => SUITS[Math.floor(c / 13)];
  const rankLabel = (r) => RANK_LABEL[r] || String(r);
  const cardName = (c) => rankLabel(rankOf(c)) + SUIT_GLYPH[suitOf(c)];
  const newDeck = () => Array.from({ length: 52 }, (_, i) => i);

  const fail = (msg) => { throw new Error(msg); };

  class BaseGame {
    constructor({ players, rng = Math.random }) {
      this.rng = rng;
      // `out` = no longer in the game (broke / eliminated)
      this.players = players.map((p, i) => ({ id: i, name: p.name, color: p.color, token: p.token, ai: !!p.ai, out: false }));
      this.current = 0;
      this.phase = 'play';       // each game adds its own phases; 'gameover' always means finished
      this.winner = null;
      this.round = 1;
      this.turnCount = 1;
      this.ready = [];           // who has pressed "continue" during a 'result' phase
      this.log = [];
      this.logSeq = 0;
    }

    // ------------------------------------------------------------------ helpers
    shuffle(a) { return shuffle(a, this.rng); }
    cur() { return this.players[this.current]; }
    alive() { return this.players.filter((p) => !p.out); }
    decider() { return this.players[this.deciderId()]; }
    deciderId() { return this.current; }
    say(text, pid = null) {
      this.log.push({ id: ++this.logSeq, text, pid });
      if (this.log.length > 200) this.log.shift();
    }
    // The next seat after `from` (stepping `dir`) that satisfies `ok`, or -1.
    seatAfter(from, ok = (p) => !p.out, dir = 1) {
      const n = this.players.length;
      for (let k = 1; k <= n; k++) {
        const i = (((from + dir * k) % n) + n) % n;
        if (ok(this.players[i])) return i;
      }
      return -1;
    }
    needTurn(pid, phase) {
      if (this.phase === 'gameover') fail('The game is over.');
      if (phase && this.phase !== phase) fail('You can\'t do that right now.');
      if (this.deciderId() !== pid) fail("It's not your turn.");
    }

    // "Continue" between rounds/hands: everyone still playing presses it (bots do so by themselves).
    pendingReady() { return this.alive().filter((p) => !this.ready.includes(p.id)); }
    readyUp(pid, next) {
      if (this.phase !== 'result') fail('Nothing to continue from.');
      const p = this.players[pid];
      if (!p || p.out) fail('You are not in this round.');
      if (!this.ready.includes(pid)) this.ready.push(pid);
      if (!this.pendingReady().length) next.call(this);
    }

    endGame(winner) {
      this.phase = 'gameover';
      this.winner = winner;
      if (winner != null) this.say(`${this.players[winner].name} wins the game!`, winner);
    }

    // ------------------------------------------------------------------ snapshots & saving
    // `seat` is who is looking (undefined = a spectator). Games override view().
    snapshot(seat) {
      const o = this.view(seat);
      o.players = o.players || this.players;
      o.log = this.log.slice(-60);
      o.logSeq = this.logSeq;
      return clone(o);
    }
    view() { return clone(this.publicState()); }
    publicState() { const o = {}; for (const k of Object.keys(this)) if (k !== 'rng') o[k] = this[k]; return o; }
    toSave() { return clone(this.publicState()); }
    static fromSave(data, rng = Math.random) {
      const g = Object.assign(Object.create(this.prototype), clone(data));
      g.rng = rng;
      return g;
    }
    static fromSnapshot(snap) { return Object.assign(Object.create(this.prototype), snap); }
  }

  const API = { BaseGame, clone, shuffle, fail, SUITS, SUIT_GLYPH, rankOf, suitOf, rankLabel, cardName, newDeck };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else root.GameCore = API;
})(typeof window !== 'undefined' ? window : globalThis);
