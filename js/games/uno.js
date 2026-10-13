// Uno: shed your hand first. 108-card deck; Skip, Reverse, Draw Two, Wild and Wild Draw Four.
// House rules kept simple: no stacking of draw cards, no challenging a Wild Draw Four (but you may only play
// one when you have no card of the current colour), UNO is called for you automatically, and after drawing
// you may play that card or keep it. The host can play a single round or a match to a points target.
(function (root) {
  'use strict';
  const C = (typeof module !== 'undefined' && module.exports) ? require('./core.js') : root.GameCore;
  const { BaseGame, fail } = C;

  const meta = {
    id: 'uno',
    name: 'Uno',
    tagline: 'Match colours and numbers, be first to empty your hand.',
    icon: '🃏',
    minPlayers: 2,
    maxPlayers: 8,
    settings: [
      { key: 'target', label: 'Match length', note: 'In a match, the winner of each round scores the cards left in everyone else\'s hands.',
        options: [{ value: 0, label: 'Single round' }, { value: 150, label: 'First to 150 points' }, { value: 300, label: 'First to 300 points' }], default: 0 },
    ],
    rules: [
      'Play a card that matches the colour or the number/symbol of the top card.',
      'Skip jumps the next player, Reverse flips direction, Draw Two makes the next player draw 2 and miss a turn.',
      'Wild picks the colour. Wild Draw Four also makes the next player draw 4, but only if you hold no card of the current colour.',
      'Nothing to play? Draw a card; if it fits you may play it. The first player with no cards wins the round.',
    ],
  };

  const COLORS = ['r', 'y', 'g', 'b'];
  const COLOR_NAME = { r: 'red', y: 'yellow', g: 'green', b: 'blue' };
  const VALUE_NAME = { S: 'Skip', R: 'Reverse', D: 'Draw Two', W: 'Wild', F: 'Wild Draw Four' };

  // A card is a string: colour letter + value. 'r5' = red 5, 'bS' = blue skip, 'wF' = wild draw four.
  const colorOf = (c) => c[0];
  const valueOf = (c) => c.slice(1);
  const isWild = (c) => c[0] === 'w';
  const cardLabel = (c) => (isWild(c) ? VALUE_NAME[valueOf(c)] : `${COLOR_NAME[colorOf(c)]} ${VALUE_NAME[valueOf(c)] || valueOf(c)}`);
  const points = (c) => (isWild(c) ? 50 : /\d/.test(valueOf(c)) ? Number(valueOf(c)) : 20);

  function newDeck() {
    const d = [];
    for (const c of COLORS) {
      d.push(c + '0');
      for (const v of ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'S', 'R', 'D']) d.push(c + v, c + v);
    }
    for (let i = 0; i < 4; i++) d.push('wW', 'wF');
    return d;
  }

  class Uno extends BaseGame {
    constructor({ players, rules = {}, rng }) {
      super({ players, rng });
      this.rules = { target: 0, handSize: 7, ...rules };
      for (const p of this.players) p.score = 0;
      this.starter = Math.floor(this.rng() * this.players.length);
      this.roundWinner = null;
      this.roundPoints = 0;
      this.deal();
    }

    deal() {
      this.drawPile = this.shuffle(newDeck());
      this.discard = [];
      this.hands = this.players.map(() => []);
      for (let k = 0; k < this.rules.handSize; k++) for (const h of this.hands) h.push(this.drawPile.pop());
      // the first face-up card is always a plain number
      let first = this.drawPile.pop();
      const skipped = [];
      while (!/^[rygb]\d$/.test(first)) { skipped.push(first); first = this.drawPile.pop(); }
      this.drawPile.unshift(...skipped);
      this.discard.push(first);
      this.color = colorOf(first);
      this.dir = 1;
      this.current = this.starter;
      this.drawn = null;     // index (in the current hand) of a card that was just drawn and may be played
      this.phase = 'play';   // play | result | gameover
      this.ready = [];
      this.roundWinner = null;
      this.say(`Round ${this.round}: ${this.cur().name} starts. The first card is ${cardLabel(first)}.`);
    }

    deciderId() {
      if (this.phase === 'result') { const p = this.pendingReady()[0]; return p ? p.id : 0; }
      return this.current;
    }
    top() { return this.discard[this.discard.length - 1]; }
    next(from = this.current, steps = 1) {
      const n = this.players.length;
      return (((from + this.dir * steps) % n) + n) % n;
    }

    // Why can't this card be played now? (null = it can)
    playError(pid, card) {
      if (isWild(card)) {
        if (valueOf(card) === 'F' && this.hands[pid].some((c) => !isWild(c) && colorOf(c) === this.color)) {
          return `Wild Draw Four is only allowed when you have no ${COLOR_NAME[this.color]} card.`;
        }
        return null;
      }
      if (colorOf(card) === this.color || valueOf(card) === valueOf(this.top())) return null;
      return `That card doesn't match ${COLOR_NAME[this.color]} or ${VALUE_NAME[valueOf(this.top())] || valueOf(this.top())}.`;
    }
    canPlay(pid, idx) {
      const card = this.hands[pid][idx];
      return !!card && (this.drawn === null || idx === this.drawn) && !this.playError(pid, card);
    }
    hasPlay(pid) { return this.hands[pid].some((_, i) => this.canPlay(pid, i)); }

    drawCard() {
      if (!this.drawPile.length) { // reshuffle everything under the top card
        const top = this.discard.pop();
        this.drawPile = this.shuffle(this.discard);
        this.discard = [top];
        if (this.drawPile.length) this.say('The draw pile ran out: the discards are shuffled back in.');
      }
      return this.drawPile.pop(); // may be undefined if every card is in hands (practically impossible)
    }
    giveCards(pid, n) {
      let got = 0;
      for (let i = 0; i < n; i++) { const c = this.drawCard(); if (c) { this.hands[pid].push(c); got++; } }
      return got;
    }

    // ------------------------------------------------------------------ actions
    play(pid, idx, colorIdx = 0) {
      this.needTurn(pid, 'play');
      const hand = this.hands[pid], card = hand[idx];
      if (!card) fail('No such card.');
      if (this.drawn !== null && idx !== this.drawn) fail('After drawing you may only play the card you drew.');
      const err = this.playError(pid, card);
      if (err) fail(err);
      if (isWild(card) && !(colorIdx >= 0 && colorIdx < 4)) fail('Choose a colour.');
      const me = this.players[pid];
      hand.splice(idx, 1);
      this.discard.push(card);
      this.color = isWild(card) ? COLORS[colorIdx] : colorOf(card);
      this.say(`${me.name} plays ${cardLabel(card)}${isWild(card) ? ` and picks ${COLOR_NAME[this.color]}` : ''}.`, pid);
      if (!hand.length) return this.roundOver(pid);
      if (hand.length === 1) this.say(`${me.name} says UNO!`, pid);
      this.drawn = null;
      const v = valueOf(card);
      let steps = 1;
      if (v === 'S') { steps = 2; this.say(`${this.players[this.next()].name} is skipped.`); }
      else if (v === 'R') {
        if (this.players.length === 2) { steps = 2; this.say('Reverse: with two players it acts like a skip.'); }
        else { this.dir = -this.dir; this.say('The direction reverses.'); }
      } else if (v === 'D' || v === 'F') {
        const victim = this.next(), n = v === 'D' ? 2 : 4;
        this.giveCards(victim, n);
        this.say(`${this.players[victim].name} draws ${n} cards and misses a turn.`, victim);
        steps = 2;
      }
      this.current = this.next(this.current, steps);
      this.turnCount++;
    }

    draw(pid) {
      this.needTurn(pid, 'play');
      if (this.drawn !== null) fail('You already drew a card. Play it or pass.');
      const hand = this.hands[pid];
      if (this.giveCards(pid, 1) === 0) { this.say(`${this.players[pid].name} can't draw: no cards left.`); return this.advance(); }
      this.say(`${this.players[pid].name} draws a card.`, pid);
      const idx = hand.length - 1;
      if (this.playError(pid, hand[idx])) this.advance(); // doesn't fit: the turn passes by itself
      else this.drawn = idx;                              // fits: play it or pass
    }

    pass(pid) {
      this.needTurn(pid, 'play');
      if (this.drawn === null) fail('Draw a card first.');
      this.say(`${this.players[pid].name} keeps the card and passes.`, pid);
      this.advance();
    }

    advance() {
      this.drawn = null;
      this.current = this.next();
      this.turnCount++;
    }

    roundOver(pid) {
      const pts = this.hands.reduce((sum, h, i) => (i === pid ? sum : sum + h.reduce((s, c) => s + points(c), 0)), 0);
      const p = this.players[pid];
      p.score += pts;
      this.roundWinner = pid;
      this.roundPoints = pts;
      this.say(`${p.name} is out of cards and wins the round${this.rules.target ? `, scoring ${pts} (total ${p.score})` : ''}!`, pid);
      if (!this.rules.target || p.score >= this.rules.target) {
        this.endGame(this.rules.target ? this.topScorer() : pid);
      } else {
        this.phase = 'result';
        this.ready = [];
      }
    }
    topScorer() { return this.players.reduce((b, p) => (b == null || p.score > this.players[b].score ? p.id : b), null); }

    continue(pid) { this.readyUp(pid, this.nextRound); }
    nextRound() {
      this.round++;
      this.starter = (this.starter + 1) % this.players.length;
      this.deal();
    }

    fallbackMove(pid) {
      if (this.phase === 'result') return { action: 'continue', args: [] };
      if (this.drawn !== null) return { action: 'pass', args: [] };
      return { action: 'draw', args: [] };
    }

    // ------------------------------------------------------------------ what a player may see
    // Same shape as the real game so helpers like canPlay() work on a snapshot: your own hand is real, the
    // others are null (all shown once the round is over), the draw pile is hidden and only the top discard is kept.
    view(seat) {
      const o = this.publicState();
      const open = this.phase !== 'play';
      o.players = this.players.map((p, i) => ({ ...p, cards: this.hands[i].length }));
      o.hands = this.hands.map((h, i) => (open || i === seat ? h : null));
      o.drawLeft = this.drawPile.length;
      delete o.drawPile; delete o.starter;
      o.discard = [this.top()];
      o.discardCount = this.discard.length;
      if (this.current !== seat) o.drawn = null;
      return C.clone(o);
    }
  }

  // ------------------------------------------------------------------ bot
  // Works from a snapshot, so it only knows what a real player sees.
  function decide(g, seat) {
    if (g.phase === 'result') return { action: 'continue', args: [] };
    const hand = g.hands[seat];
    const options = hand.map((_, i) => i).filter((i) => g.canPlay(seat, i));
    if (!options.length) return { action: g.drawn !== null ? 'pass' : 'draw', args: [] };
    const nextP = g.players[g.next()];
    const danger = nextP.cards <= 2; // the next player is nearly out: hit them with an action card
    const count = (cards, col) => cards.filter((c) => !isWild(c) && colorOf(c) === col).length;
    const score = (i) => {
      const c = hand[i], v = valueOf(c);
      let s = isWild(c) ? (v === 'F' ? 4 : 5)                       // keep wilds for later
        : 10 + (/\d/.test(v) ? Number(v) / 2 : 6);                  // shed high cards and action cards first
      if (danger && ['S', 'D', 'R', 'F'].includes(v)) s += 20;
      if (hand.length === 2 && isWild(c)) s += 30;                  // about to go out: use the wild
      return s;
    };
    options.sort((a, b) => score(b) - score(a));
    const idx = options[0];
    // colour to call: the one we hold most of once this card has left our hand
    const rest = hand.filter((_, i) => i !== idx);
    const best = COLORS.map((c, i) => [count(rest, c), i]).sort((a, b) => b[0] - a[0])[0];
    return { action: 'play', args: [idx, best[0] ? best[1] : Math.floor(Math.random() * 4)] };
  }

  const actions = { play: ['int', 'int'], draw: [], pass: [], continue: [] };

  const module_ = {
    meta, Engine: Uno, actions, decide, cardLabel, colorOf, valueOf, isWild, COLORS, COLOR_NAME, points,
    create(players, settings, rng) { return new Uno({ players, rules: { target: settings.target }, rng }); },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = module_;
  else (root.GameModules = root.GameModules || {}).uno = module_;
})(typeof window !== 'undefined' ? window : globalThis);
