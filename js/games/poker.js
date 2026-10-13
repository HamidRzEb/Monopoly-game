// Texas Hold'em, no-limit, played with chips over a set number of hands. Blinds start at 10/20 and double every
// few hands so a game always ends; after the last hand the biggest stack wins (or whoever is left when
// everyone else is broke). Side pots, all-ins, split pots and the heads-up blind rule are handled.
(function (root) {
  'use strict';
  const C = (typeof module !== 'undefined' && module.exports) ? require('./core.js') : root.GameCore;
  const { BaseGame, fail, rankOf, suitOf, newDeck, rankLabel } = C;

  const meta = {
    id: 'poker',
    name: "Texas Hold'em",
    tagline: 'No-limit poker: bluff, bet and take the pot.',
    icon: '♠',
    minPlayers: 2,
    maxPlayers: 8,
    settings: [
      { key: 'hands', label: 'Hands', note: 'Blinds go up every few hands. After the last hand the biggest stack wins.',
        options: [{ value: 10, label: 'Quick (10 hands)' }, { value: 25, label: 'Standard (25 hands)' }, { value: 50, label: 'Long (50 hands)' }], default: 25 },
    ],
    rules: [
      'Everyone gets two private cards; five shared cards come out in three stages (flop, turn, river).',
      'Make the best five-card hand from your two cards and the five shared ones.',
      'On your turn: fold, check/call, or raise. The player to the left of the dealer posts the small blind, the next one the big blind.',
      'No-limit: you can raise any amount up to all your chips. Win the pot at showdown or by making everyone else fold.',
    ],
  };

  const RULES = { startChips: 1000, sb: 10, bb: 20, blindEvery: 8 };

  // ------------------------------------------------------------------ hand evaluation
  const CATEGORY = ['High card', 'Pair', 'Two pair', 'Three of a kind', 'Straight', 'Flush', 'Full house', 'Four of a kind', 'Straight flush'];

  // Score of exactly five cards: bigger is better, ties are exactly equal.
  function eval5(cs) {
    const rs = cs.map(rankOf).sort((a, b) => b - a);
    const flush = cs.every((c) => suitOf(c) === suitOf(cs[0]));
    let high = 0;
    if (new Set(rs).size === 5) { if (rs[0] - rs[4] === 4) high = rs[0]; else if (rs[0] === 14 && rs[1] === 5) high = 5; } // 5-high "wheel"
    const count = {};
    for (const r of rs) count[r] = (count[r] || 0) + 1;
    const groups = Object.entries(count).map(([r, n]) => [n, Number(r)]).sort((a, b) => b[0] - a[0] || b[1] - a[1]);
    const g = groups.map((x) => x[1]);
    let cat, ks;
    if (high && flush) { cat = 8; ks = [high]; }
    else if (groups[0][0] === 4) { cat = 7; ks = g; }
    else if (groups[0][0] === 3 && groups[1][0] === 2) { cat = 6; ks = g; }
    else if (flush) { cat = 5; ks = rs; }
    else if (high) { cat = 4; ks = [high]; }
    else if (groups[0][0] === 3) { cat = 3; ks = g; }
    else if (groups[0][0] === 2 && groups[1][0] === 2) { cat = 2; ks = g; }
    else if (groups[0][0] === 2) { cat = 1; ks = g; }
    else { cat = 0; ks = rs; }
    let s = cat;
    for (let i = 0; i < 5; i++) s = s * 15 + (ks[i] || 0);
    return s;
  }

  // Best five of five, six or seven cards.
  function bestScore(cards) {
    const n = cards.length;
    if (n === 5) return eval5(cards);
    let best = -1;
    for (let a = 0; a < n - 4; a++) for (let b = a + 1; b < n - 3; b++) for (let c = b + 1; c < n - 2; c++) for (let d = c + 1; d < n - 1; d++) for (let e = d + 1; e < n; e++) {
      const s = eval5([cards[a], cards[b], cards[c], cards[d], cards[e]]);
      if (s > best) best = s;
    }
    return best;
  }
  const categoryOf = (score) => Math.floor(score / 15 ** 5);
  function handName(score) {
    const cat = categoryOf(score), top = Math.floor(score / 15 ** 4) % 15;
    if (cat === 8 && top === 14) return 'Royal flush';
    if (cat === 0) return `${rankLabel(top)}-high`;
    return CATEGORY[cat];
  }

  class Poker extends BaseGame {
    constructor({ players, rules = {}, rng }) {
      super({ players, rng });
      this.rules = { ...RULES, hands: 25, ...rules };
      for (const p of this.players) Object.assign(p, { chips: this.rules.startChips, bet: 0, total: 0, folded: false, allIn: false, acted: false, hole: [] });
      this.board = [];
      this.deck = [];
      this.button = this.players.length - 1; // the first hand moves it to seat 0... then on to the next player
      this.handNo = 0;
      this.street = 'preflop';
      this.currentBet = 0;
      this.lastRaise = 0;
      this.toAct = 0;
      this.revealed = false;
      this.result = null;
      this.phase = 'bet'; // bet | result | gameover
      this.startHand();
    }

    blinds() {
      const m = 2 ** Math.floor(Math.max(0, this.handNo - 1) / this.rules.blindEvery);
      return { sb: this.rules.sb * m, bb: this.rules.bb * m };
    }
    canAct(p) { return !p.out && !p.folded && !p.allIn; }
    inHand() { return this.players.filter((p) => !p.out && !p.folded); }
    pot() { return this.players.reduce((s, p) => s + p.total, 0); }

    deciderId() {
      if (this.phase === 'result') { const p = this.pendingReady()[0]; return p ? p.id : 0; }
      return this.toAct;
    }

    // ------------------------------------------------------------------ dealing a hand
    startHand() {
      if (this.alive().length < 2 || this.handNo >= this.rules.hands) return this.finish();
      this.handNo++;
      this.round = this.handNo;
      this.phase = 'bet';
      this.street = 'preflop';
      this.board = [];
      this.revealed = false;
      this.result = null;
      this.ready = [];
      this.deck = this.shuffle(newDeck());
      for (const p of this.players) Object.assign(p, { bet: 0, total: 0, folded: p.out, allIn: false, acted: false, hole: [] });
      this.button = this.seatAfter(this.button);
      const seated = this.alive();
      for (let k = 0; k < 2; k++) for (const p of seated) p.hole.push(this.deck.pop());
      const { sb, bb } = this.blinds();
      const headsUp = seated.length === 2;
      const sbSeat = headsUp ? this.button : this.seatAfter(this.button);
      const bbSeat = this.seatAfter(sbSeat);
      this.post(this.players[sbSeat], sb);
      this.post(this.players[bbSeat], bb);
      this.currentBet = Math.max(...seated.map((p) => p.bet));
      this.lastRaise = bb;
      this.say(`Hand ${this.handNo}: ${this.players[this.button].name} has the button. Blinds ${sb}/${bb}.`);
      const first = this.seatAfter(headsUp ? this.button - 1 + this.players.length : bbSeat, (p) => this.canAct(p));
      this.toAct = first === -1 ? 0 : first;
      this.turnCount++;
      this.moveOnIfSettled();
    }

    post(p, amount) {
      const a = Math.min(amount, p.chips);
      p.chips -= a; p.bet += a; p.total += a;
      if (!p.chips) p.allIn = true;
    }

    // ------------------------------------------------------------------ what the player to act may do
    legal(pid) {
      const p = this.players[pid];
      const toCall = Math.min(this.currentBet - p.bet, p.chips);
      const maxTo = p.bet + p.chips;
      const othersCanAct = this.players.some((q) => q.id !== pid && this.canAct(q));
      const canRaise = othersCanAct && maxTo > this.currentBet;
      return {
        toCall, canCheck: this.currentBet === p.bet, canRaise,
        minRaiseTo: Math.min(this.currentBet + this.lastRaise, maxTo), maxRaiseTo: maxTo,
      };
    }

    need(pid) {
      if (this.phase !== 'bet') fail("There's no betting right now.");
      if (this.toAct !== pid) fail("It's not your turn.");
    }

    fold(pid) {
      this.need(pid);
      const p = this.players[pid];
      p.folded = true;
      this.say(`${p.name} folds.`, pid);
      this.afterAction(pid);
    }
    check(pid) {
      this.need(pid);
      const p = this.players[pid];
      if (this.currentBet !== p.bet) fail('You have to call, raise or fold.');
      p.acted = true;
      this.say(`${p.name} checks.`, pid);
      this.afterAction(pid);
    }
    call(pid) {
      this.need(pid);
      const p = this.players[pid];
      const amount = Math.min(this.currentBet - p.bet, p.chips);
      if (amount <= 0) fail('Nothing to call: check instead.');
      this.post(p, amount);
      p.acted = true;
      this.say(p.allIn ? `${p.name} calls ${amount} and is all in.` : `${p.name} calls ${amount}.`, pid);
      this.afterAction(pid);
    }
    // `to` is your total bet for this street after raising (all in = bet + chips).
    raise(pid, to) {
      this.need(pid);
      const p = this.players[pid], l = this.legal(pid);
      if (!l.canRaise) fail("You can't raise: just call or fold.");
      if (to > l.maxRaiseTo) fail("You don't have that many chips.");
      if (to <= this.currentBet) fail(`A raise has to be more than ${this.currentBet}.`);
      if (to < l.minRaiseTo) fail(`The minimum raise is to ${l.minRaiseTo}.`);
      const verb = this.currentBet === 0 ? 'bets' : 'raises to';
      const size = to - this.currentBet;
      this.post(p, to - p.bet);
      if (size >= this.lastRaise) this.lastRaise = size;
      this.currentBet = to;
      for (const q of this.players) if (q.id !== pid) q.acted = false;
      p.acted = true;
      this.say(p.allIn ? `${p.name} ${verb} ${to} and is all in!` : `${p.name} ${verb} ${to}.`, pid);
      this.afterAction(pid);
    }

    // ------------------------------------------------------------------ betting round bookkeeping
    roundSettled() {
      const actors = this.players.filter((p) => this.canAct(p));
      if (!actors.length) return true;
      if (actors.length === 1) return actors[0].bet >= this.currentBet; // nobody left to bet against
      return actors.every((p) => p.acted && p.bet === this.currentBet);
    }

    afterAction(pid) {
      this.turnCount++;
      const left = this.inHand();
      if (left.length === 1) return this.award(left);
      if (this.roundSettled()) return this.nextStreet();
      this.toAct = this.seatAfter(pid, (p) => this.canAct(p) && (!p.acted || p.bet < this.currentBet));
    }

    moveOnIfSettled() { // blinds can leave nobody able to bet (everyone all in): go straight to the next street
      if (this.roundSettled()) this.nextStreet();
    }

    nextStreet() {
      for (const p of this.players) { p.bet = 0; p.acted = false; }
      this.currentBet = 0;
      this.lastRaise = this.blinds().bb;
      const order = ['preflop', 'flop', 'turn', 'river', 'showdown'];
      this.street = order[order.indexOf(this.street) + 1];
      if (this.street === 'showdown') return this.showdown();
      const n = this.street === 'flop' ? 3 : 1;
      for (let i = 0; i < n; i++) this.board.push(this.deck.pop());
      this.say(`${{ flop: 'The flop', turn: 'The turn', river: 'The river' }[this.street]}: ${this.board.map(C.cardName).join(' ')}.`);
      const actors = this.players.filter((p) => this.canAct(p));
      if (actors.length < 2) { // everyone else is all in: show the cards and run the board out
        if (!this.revealed) { this.revealed = true; this.say('All in! The hands are turned face up.'); }
        return this.nextStreet();
      }
      this.toAct = this.seatAfter(this.button, (p) => this.canAct(p));
    }

    // ------------------------------------------------------------------ ending a hand
    // Side pots: slice the total contributions at each distinct all-in level.
    buildPots() {
      const live = this.players.filter((p) => !p.out && !p.folded);
      const levels = [...new Set(live.map((p) => p.total).filter((t) => t > 0))].sort((a, b) => a - b);
      const pots = [];
      let prev = 0;
      for (const lvl of levels) {
        const amount = this.players.reduce((s, p) => s + Math.max(0, Math.min(p.total, lvl) - prev), 0);
        pots.push({ amount, eligible: live.filter((p) => p.total >= lvl).map((p) => p.id) });
        prev = lvl;
      }
      const assigned = pots.reduce((s, p) => s + p.amount, 0);
      if (pots.length && this.pot() > assigned) pots[pots.length - 1].amount += this.pot() - assigned; // dead money from folded players
      return pots;
    }

    // 0 for the seat just left of the button ... n-1 for the button itself (who gets odd chips last)
    fromButton(id) { const n = this.players.length; return (((id - this.button - 1) % n) + n) % n; }

    award(winners) { // everyone else folded
      const w = winners[0];
      const amount = this.pot();
      w.chips += amount;
      this.say(`${w.name} wins ${amount}; everyone else folded.`, w.id);
      this.result = { uncontested: true, pots: [{ amount, winners: [w.id], hand: null }], hands: {} };
      this.endHand();
    }

    showdown() {
      this.revealed = true;
      const live = this.inHand();
      const score = {};
      for (const p of live) score[p.id] = bestScore([...p.hole, ...this.board]);
      const pots = this.buildPots().map((pot) => {
        const best = Math.max(...pot.eligible.map((id) => score[id]));
        const winners = pot.eligible.filter((id) => score[id] === best);
        const share = Math.floor(pot.amount / winners.length);
        let odd = pot.amount - share * winners.length;
        // odd chips go to the winners closest to the left of the button
        const ordered = [...winners].sort((a, b) => this.fromButton(a) - this.fromButton(b));
        for (const id of ordered) { this.players[id].chips += share + (odd > 0 ? 1 : 0); if (odd > 0) odd--; }
        return { amount: pot.amount, winners, hand: handName(best) };
      });
      const hands = {};
      for (const p of live) hands[p.id] = handName(score[p.id]);
      this.result = { uncontested: false, pots, hands };
      pots.forEach((pot, i) => {
        const names = pot.winners.map((id) => this.players[id].name).join(' and ');
        this.say(`${names} ${pot.winners.length > 1 ? 'split' : 'wins'} ${pots.length > 1 ? (i === 0 ? 'the main pot' : `side pot ${i}`) : 'the pot'} of ${pot.amount} with ${pot.hand}.`, pot.winners[0]);
      });
      this.endHand();
    }

    endHand() {
      for (const p of this.players) { p.bet = 0; p.total = 0; } // the pot has been paid out
      for (const p of this.alive()) {
        if (p.chips <= 0) { p.out = true; p.chips = 0; this.say(`${p.name} is out of chips.`, p.id); }
      }
      this.phase = 'result';
      this.ready = [];
    }

    continue(pid) { this.readyUp(pid, this.startHand); }

    finish() {
      const best = this.players.reduce((b, p) => (b == null || p.chips > this.players[b].chips ? p.id : b), null);
      this.endGame(best);
    }

    fallbackMove(pid) {
      if (this.phase === 'result') return { action: 'continue', args: [] };
      return this.legal(pid).canCheck ? { action: 'check', args: [] } : { action: 'fold', args: [] };
    }

    // ------------------------------------------------------------------ what a player may see
    view(seat) {
      const o = this.publicState();
      delete o.deck;
      o.players = this.players.map((p) => {
        const show = p.id === seat || (this.revealed && !p.folded);
        return { ...p, hole: show ? p.hole : [], hasCards: p.hole.length > 0 && !p.folded };
      });
      return C.clone(o);
    }
  }

  // ------------------------------------------------------------------ bot
  // Estimates its chance of winning by dealing out the unknown cards at random, then compares that with the
  // price of the bet (pot odds) and bluffs now and then. Only uses what a real player can see.
  function equity(g, seat, sims, rng) {
    const me = g.players[seat];
    const known = new Set([...me.hole, ...g.board]);
    const unseen = newDeck().filter((c) => !known.has(c));
    const rivals = g.players.filter((p) => p.id !== seat && !p.out && !p.folded).length;
    let score = 0;
    for (let s = 0; s < sims; s++) {
      for (let i = 0; i < 2 + rivals * 2 + 5; i++) { // partial shuffle: pick what we need
        const j = i + Math.floor(rng() * (unseen.length - i));
        [unseen[i], unseen[j]] = [unseen[j], unseen[i]];
      }
      let k = 0;
      const board = g.board.slice();
      while (board.length < 5) board.push(unseen[k++]);
      const mine = bestScore([...me.hole, ...board]);
      let beaten = 1, tied = 0;
      for (let r = 0; r < rivals; r++) {
        const theirs = bestScore([unseen[k++], unseen[k++], ...board]);
        if (theirs > mine) { beaten = 0; break; }
        if (theirs === mine) tied++;
      }
      score += beaten * (tied ? 1 / (tied + 1) : 1);
    }
    return score / sims;
  }

  function decide(g, seat, rng = Math.random, sims = 160) {
    if (g.phase === 'result') return { action: 'continue', args: [] };
    const me = g.players[seat], l = g.legal(seat);
    const pot = g.pot();
    const eq = equity(g, seat, sims, rng);
    const rivals = g.players.filter((p) => p.id !== seat && !p.out && !p.folded).length;
    const raiseTo = (frac) => {
      const want = g.currentBet + Math.max(g.lastRaise, Math.round((pot + l.toCall) * frac / 10) * 10);
      return Math.max(l.minRaiseTo, Math.min(l.maxRaiseTo, want));
    };
    // a random "feel" for this decision, so bots aren't perfectly predictable
    const luck = rng();
    const strongBar = 0.62 + 0.04 * Math.min(rivals - 1, 4); // more opponents: need more to be sure we're ahead
    if (l.toCall === 0) {
      if (l.canRaise && (eq > strongBar || (eq > 0.5 && luck < 0.5) || luck < 0.06)) return { action: 'raise', args: [raiseTo(eq > 0.8 ? 0.9 : 0.5)] };
      return { action: 'check', args: [] };
    }
    const price = l.toCall / (pot + l.toCall);                  // the share of the final pot we must put in
    const scare = me.chips > 0 ? Math.min(0.15, l.toCall / (me.chips + l.toCall) * 0.2) : 0; // big bets deserve respect
    if (eq > 0.85 && l.canRaise && luck < 0.8) return { action: 'raise', args: [raiseTo(1)] };
    if (eq > strongBar + 0.08 && l.canRaise && luck < 0.55) return { action: 'raise', args: [raiseTo(0.6)] };
    if (eq > price + 0.03 + scare) return { action: 'call', args: [] };
    if (luck < 0.03 && l.toCall <= me.chips * 0.05) return { action: 'call', args: [] }; // curiosity
    return { action: 'fold', args: [] };
  }

  const actions = { fold: [], check: [], call: [], raise: ['int'], continue: [] };

  const module_ = {
    meta, Engine: Poker, actions, decide, bestScore, handName, equity,
    create(players, settings, rng) { return new Poker({ players, rules: { hands: settings.hands }, rng }); },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = module_;
  else (root.GameModules = root.GameModules || {}).poker = module_;
})(typeof window !== 'undefined' ? window : globalThis);
