// Blackjack: everyone at the table plays against the dealer, with chips.
// Rules: 4-deck shoe; blackjack pays 3:2; dealer stands on all 17s and checks for blackjack when showing an
// ace or ten; double down on any first two cards; no splitting or insurance. After the chosen number of
// rounds the player with the most chips wins; players who can't cover the minimum bet sit out.
(function (root) {
  'use strict';
  const C = (typeof module !== 'undefined' && module.exports) ? require('./core.js') : root.GameCore;
  const { BaseGame, fail, rankOf, newDeck } = C;

  const meta = {
    id: 'blackjack',
    name: 'Blackjack',
    tagline: 'Beat the dealer to 21. Everyone plays against the house.',
    icon: '🂡',
    minPlayers: 1,
    maxPlayers: 6,
    settings: [
      { key: 'rounds', label: 'Rounds', note: 'The player with the most chips after the last round wins.',
        options: [{ value: 5, label: 'Quick (5 rounds)' }, { value: 10, label: 'Standard (10 rounds)' }, { value: 20, label: 'Long (20 rounds)' }], default: 10 },
    ],
    rules: [
      'Get closer to 21 than the dealer without going over. Aces count 1 or 11, face cards 10.',
      'Hit to take a card, Stand to stop, Double to double your bet for exactly one more card.',
      'Blackjack (an ace and a ten-card) pays 3 to 2. The dealer stands on 17.',
    ],
  };

  const RULES = { startChips: 1000, minBet: 10, maxBet: 500, decks: 4 };

  // Best total of a hand (cards are 0..51), and whether an ace is still counting as 11.
  function handValue(cards) {
    let total = 0, aces = 0;
    for (const c of cards) {
      const r = rankOf(c);
      if (r === 14) { aces++; total += 11; } else total += r >= 10 ? 10 : r;
    }
    while (total > 21 && aces) { total -= 10; aces--; }
    return { total, soft: aces > 0 };
  }
  const isBlackjack = (cards) => cards.length === 2 && handValue(cards).total === 21;

  class Blackjack extends BaseGame {
    constructor({ players, rules = {}, rng }) {
      super({ players, rng });
      this.rules = { ...RULES, rounds: 10, ...rules };
      for (const p of this.players) Object.assign(p, { chips: this.rules.startChips, bet: 0, hand: [], status: 'idle', result: null, delta: 0, doubled: false });
      this.dealer = [];
      this.shoe = [];
      this.phase = 'bet'; // bet | play | result | gameover
      this.startRound();
      this.say('Place your bets!');
    }

    // ------------------------------------------------------------------ round flow
    deciderId() {
      if (this.phase === 'bet') { const p = this.players.find((q) => !q.out && !q.bet); return p ? p.id : 0; }
      if (this.phase === 'result') { const p = this.pendingReady()[0]; return p ? p.id : 0; }
      return this.current;
    }

    startRound() {
      for (const p of this.players) {
        if (!p.out && p.chips < this.rules.minBet) { p.out = true; this.say(`${p.name} is out of chips.`, p.id); }
      }
      if (!this.alive().length) return this.endGame(this.richest());
      for (const p of this.players) Object.assign(p, { bet: 0, hand: [], status: p.out ? 'out' : 'idle', result: null, delta: 0, doubled: false });
      this.dealer = [];
      this.ready = [];
      this.phase = 'bet';
      this.current = this.alive()[0].id;
      // Between rounds nothing is in play, so this is the only safe moment to reshuffle (a round needs < 60 cards).
      if (this.shoe.length < 80) {
        this.freshShoe();
        if (this.round > 1) this.say('The dealer shuffles a fresh shoe.');
      }
    }

    richest() {
      return this.players.reduce((best, p) => (best == null || p.chips > this.players[best].chips ? p.id : best), null);
    }

    freshShoe() {
      this.shoe = this.shuffle([].concat(...Array.from({ length: this.rules.decks }, newDeck)));
    }
    draw() {
      if (!this.shoe.length) this.freshShoe(); // can't happen with a 4-deck shoe checked every round, but never crash
      return this.shoe.pop();
    }

    maxBetFor(p) { return Math.min(this.rules.maxBet, p.chips); }

    bet(pid, amount) {
      if (this.phase !== 'bet') fail("Bets are closed.");
      const p = this.players[pid];
      if (!p || p.out) fail('You are not in this round.');
      if (p.bet) fail('You already placed a bet.');
      if (amount < this.rules.minBet) fail(`The minimum bet is ${this.rules.minBet}.`);
      if (amount > this.maxBetFor(p)) fail(`The most you can bet is ${this.maxBetFor(p)}.`);
      p.chips -= amount;
      p.bet = amount;
      p.status = 'ready';
      this.say(`${p.name} bets ${amount}.`, pid);
      if (this.alive().every((q) => q.bet)) this.deal();
    }

    deal() {
      this.phase = 'play';
      const seated = this.alive();
      for (let k = 0; k < 2; k++) {
        for (const p of seated) p.hand.push(this.draw());
        this.dealer.push(this.draw());
      }
      for (const p of seated) p.status = isBlackjack(p.hand) ? 'blackjack' : 'playing';
      this.say(`The dealer shows ${this.cardText(this.dealer[0])}.`);
      const up = rankOf(this.dealer[0]);
      if ((up === 14 || up >= 10) && isBlackjack(this.dealer)) {
        this.say('The dealer has blackjack!');
        return this.settle();
      }
      this.advance(-1);
    }

    cardText(c) { return C.cardName(c); }

    // Move to the next player who still has a decision, or let the dealer play.
    advance(from) {
      const next = this.seatAfter(from, (p) => !p.out && p.status === 'playing');
      if (next === -1 || (from >= 0 && next <= from)) return this.dealerTurn();
      this.current = next;
      this.turnCount++;
    }

    needPlay(pid) {
      if (this.phase !== 'play') fail("It's not time to play your hand.");
      if (this.current !== pid) fail("It's not your turn.");
    }

    canDouble(pid) {
      const p = this.players[pid];
      return this.phase === 'play' && this.current === pid && p.hand.length === 2 && p.chips >= p.bet;
    }

    hit(pid) {
      this.needPlay(pid);
      const p = this.players[pid];
      p.hand.push(this.draw());
      const v = handValue(p.hand).total;
      this.say(`${p.name} hits and gets ${this.cardText(p.hand[p.hand.length - 1])} (${v}).`, pid);
      this.afterCard(p, v);
    }

    stand(pid) {
      this.needPlay(pid);
      const p = this.players[pid];
      p.status = 'stand';
      this.say(`${p.name} stands on ${handValue(p.hand).total}.`, pid);
      this.advance(pid);
    }

    double(pid) {
      this.needPlay(pid);
      const p = this.players[pid];
      if (p.hand.length !== 2) fail('You can only double on your first two cards.');
      if (p.chips < p.bet) fail("You don't have enough chips to double.");
      p.chips -= p.bet;
      p.bet *= 2;
      p.doubled = true;
      p.hand.push(this.draw());
      const v = handValue(p.hand).total;
      this.say(`${p.name} doubles to ${p.bet} and gets ${this.cardText(p.hand[2])} (${v}).`, pid);
      if (v > 21) this.afterCard(p, v); else { p.status = 'stand'; this.advance(pid); }
    }

    afterCard(p, v) {
      if (v > 21) { p.status = 'bust'; this.say(`${p.name} busts!`, p.id); this.advance(p.id); }
      else if (v === 21) { p.status = 'stand'; this.advance(p.id); }
    }

    dealerTurn() {
      const anyLive = this.alive().some((p) => p.status === 'stand');
      this.say(`The dealer turns over ${this.cardText(this.dealer[1])}.`);
      if (anyLive) {
        while (handValue(this.dealer).total < 17) {
          this.dealer.push(this.draw());
          this.say(`The dealer draws ${this.cardText(this.dealer[this.dealer.length - 1])}.`);
        }
      }
      const v = handValue(this.dealer).total;
      this.say(v > 21 ? `The dealer busts with ${v}!` : `The dealer has ${v}.`);
      this.settle();
    }

    settle() {
      const dv = handValue(this.dealer).total, dBJ = isBlackjack(this.dealer);
      for (const p of this.alive()) {
        const v = handValue(p.hand).total;
        let back = 0, res;
        if (p.status === 'bust') res = 'lose';
        else if (p.status === 'blackjack') { if (dBJ) { res = 'push'; back = p.bet; } else { res = 'blackjack'; back = p.bet + Math.floor(p.bet * 1.5); } }
        else if (dBJ) res = 'lose';
        else if (dv > 21 || v > dv) { res = 'win'; back = p.bet * 2; }
        else if (v === dv) { res = 'push'; back = p.bet; }
        else res = 'lose';
        p.chips += back;
        p.delta = back - p.bet;
        p.result = res;
        const word = { win: 'wins', lose: 'loses', push: 'pushes', blackjack: 'has blackjack and wins' }[res];
        this.say(`${p.name} ${word}${p.delta ? ` (${p.delta > 0 ? '+' : '−'}${Math.abs(p.delta)})` : ''}.`, p.id);
      }
      this.phase = 'result';
      this.ready = [];
    }

    nextRound() {
      if (this.round >= this.rules.rounds) {
        for (const p of this.players) if (!p.out && p.chips < this.rules.minBet) p.out = true;
        return this.endGame(this.richest());
      }
      this.round++;
      this.startRound();
      if (this.phase === 'bet') this.say(`Round ${this.round}: place your bets!`);
    }

    continue(pid) { this.readyUp(pid, this.nextRound); }

    fallbackMove(pid) {
      if (this.phase === 'bet') return { action: 'bet', args: [this.rules.minBet] };
      if (this.phase === 'play') return { action: 'stand', args: [] };
      return { action: 'continue', args: [] };
    }

    // ------------------------------------------------------------------ what a player may see
    view() {
      const o = this.publicState();
      delete o.shoe;
      o.shoeLeft = this.shoe.length;
      // the dealer's second card stays face down until the dealer plays
      if (this.phase === 'play') o.dealer = [this.dealer[0], null];
      return C.clone(o);
    }
  }

  // ------------------------------------------------------------------ bot
  // Basic strategy for hit/stand/double; bets a modest slice of the stack. Works from a snapshot, so it
  // can only use what a real player sees.
  function decide(g, seat, rng = Math.random) {
    const p = g.players[seat];
    if (g.phase === 'bet') {
      const want = Math.round((p.chips * (0.05 + rng() * 0.07)) / 10) * 10;
      return { action: 'bet', args: [Math.max(g.rules.minBet, Math.min(want, g.maxBetFor(p)))] };
    }
    if (g.phase === 'play') {
      const { total, soft } = handValue(p.hand);
      const upRank = rankOf(g.dealer[0]);
      const up = upRank === 14 ? 11 : Math.min(10, upRank);
      const dbl = g.canDouble(seat);
      let move;
      if (soft) {
        if (total >= 19) move = 'stand';
        else if (total === 18) move = up >= 9 ? 'hit' : (dbl && up <= 6 ? 'double' : 'stand');
        else move = dbl && up >= 5 && up <= 6 ? 'double' : 'hit';
      } else if (total >= 17) move = 'stand';
      else if (total >= 13) move = up <= 6 ? 'stand' : 'hit';
      else if (total === 12) move = up >= 4 && up <= 6 ? 'stand' : 'hit';
      else if (total === 11) move = dbl ? 'double' : 'hit';
      else if (total === 10) move = dbl && up <= 9 ? 'double' : 'hit';
      else if (total === 9) move = dbl && up >= 3 && up <= 6 ? 'double' : 'hit';
      else move = 'hit';
      return { action: move, args: [] };
    }
    return { action: 'continue', args: [] };
  }

  const actions = { bet: ['int'], hit: [], stand: [], double: [], continue: [] };

  const module_ = {
    meta, Engine: Blackjack, actions, decide, handValue, isBlackjack,
    create(players, settings, rng) { return new Blackjack({ players, rules: { rounds: settings.rounds }, rng }); },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = module_;
  else (root.GameModules = root.GameModules || {}).blackjack = module_;
})(typeof window !== 'undefined' ? window : globalThis);
