// Game rules engine. Pure state machine with no I/O, shared by server and browser.
// The server owns the real Game; browsers rebuild a read-only copy from snapshots
// (Game.fromSnapshot) so they can reuse the canXxx() helpers to enable/disable buttons.
//
// Every action method takes the acting player id first and throws an Error with a
// human-readable message if the action is not allowed.
(function (root) {
  'use strict';

  const D = (typeof module !== 'undefined' && module.exports) ? require('./data.js') : root.MonopolyData;
  const { SPACES, CARDS, RULES } = D;

  const indexOfId = (id) => SPACES.findIndex((s) => s.id === id);
  const isOwnable = (s) => s.type === 'property' || s.type === 'railroad' || s.type === 'utility';
  const GROUPS = {};
  SPACES.forEach((s, i) => { if (s.group) (GROUPS[s.group] = GROUPS[s.group] || []).push(i); });

  const MANAGE_PHASES = ['roll', 'postroll', 'buy', 'debt'];

  class Game {
    constructor({ players, rules = {}, rng = Math.random }) {
      this.rules = { ...RULES, ...rules };
      this.rng = rng;
      this.players = players.map((p, i) => ({
        id: i, name: p.name, color: p.color, token: p.token, ai: !!p.ai,
        cash: this.rules.startingCash, pos: 0,
        inJail: false, jailTurns: 0, jailCards: 0, bankrupt: false,
      }));
      this.props = {};
      SPACES.forEach((s, i) => { if (isOwnable(s)) this.props[i] = { owner: null, houses: 0, mortgaged: false }; });
      this.housesLeft = this.rules.housesTotal;
      this.hotelsLeft = this.rules.hotelsTotal;
      this.decks = { chance: this.shuffle(CARDS.chance.slice()), chest: this.shuffle(CARDS.chest.slice()) };

      this.current = 0;
      this.phase = 'roll'; // roll | buy | auction | debt | postroll | gameover
      this.doubles = 0;
      this.rolledDoubles = false;
      this.lastDice = null;
      this.lastRoll = null;
      this.rollSeq = 0;
      this.lastCard = null;
      this.cardSeq = 0;
      this.auction = null;
      this.debt = null;
      this.winner = null;
      this.turnCount = 1;
      this.round = 1;
      this.endedByLimit = false;
      this.log = [];
      this.logSeq = 0;
      this.say(`${this.cur().name} goes first.`, 0);
    }

    // ------------------------------------------------------------------ helpers
    shuffle(a) {
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(this.rng() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    }
    die() { return 1 + Math.floor(this.rng() * 6); }
    cur() { return this.players[this.current]; }
    // Who must act right now (differs from the current player during auctions).
    decider() { return this.phase === 'auction' ? this.players[this.auction.turn] : this.cur(); }
    say(text, pid = null) {
      this.log.push({ id: ++this.logSeq, text, pid });
      if (this.log.length > 300) this.log.shift();
    }
    money(n) { return '$' + n.toLocaleString('en-US'); }
    alive() { return this.players.filter((p) => !p.bankrupt); }
    ownedBy(pid) { return Object.keys(this.props).map(Number).filter((i) => this.props[i].owner === pid); }
    groupOf(i) { return GROUPS[SPACES[i].group] || []; }
    hasMonopoly(pid, group) { return GROUPS[group].every((i) => this.props[i].owner === pid); }
    countOwned(pid, type) { return this.ownedBy(pid).filter((i) => SPACES[i].type === type).length; }
    need(pid, ...phases) {
      if (this.phase === 'gameover') throw new Error('The game is over.');
      if (pid !== this.current) throw new Error("It's not your turn.");
      if (!phases.includes(this.phase)) throw new Error("You can't do that right now.");
    }

    mortgageValue(i) { return Math.floor(SPACES[i].price / 2); }
    unmortgageCost(i) { return Math.ceil(this.mortgageValue(i) * (1 + this.rules.mortgageInterest)); }
    // Cash a player could raise right now by selling every building and mortgaging everything.
    liquidValue(pid) {
      let v = this.players[pid].cash;
      for (const i of this.ownedBy(pid)) {
        const st = this.props[i];
        v += st.houses * Math.floor((SPACES[i].houseCost || 0) / 2);
        if (!st.mortgaged) v += this.mortgageValue(i);
      }
      return v;
    }
    netWorth(pid) {
      let v = this.players[pid].cash;
      for (const i of this.ownedBy(pid)) {
        const st = this.props[i];
        v += st.mortgaged ? this.mortgageValue(i) : SPACES[i].price;
        v += st.houses * (SPACES[i].houseCost || 0);
      }
      return v;
    }

    rentFor(i, diceSum, opts = {}) {
      const s = SPACES[i], st = this.props[i];
      if (s.type === 'property') {
        if (st.houses > 0) return s.rent[st.houses];
        return s.rent[0] * (this.hasMonopoly(st.owner, s.group) ? 2 : 1);
      }
      if (s.type === 'railroad') {
        const n = this.countOwned(st.owner, 'railroad');
        return 25 * Math.pow(2, n - 1) * (opts.cardRent === 'railroad' ? 2 : 1);
      }
      if (opts.cardRent === 'utility') return 10 * diceSum;
      return (this.countOwned(st.owner, 'utility') === 2 ? 10 : 4) * diceSum;
    }

    // ------------------------------------------------------------------ snapshots
    snapshot() {
      const debt = this.debt ? { pid: this.debt.pid, amount: this.debt.amount, creditor: this.debt.creditor } : null;
      return JSON.parse(JSON.stringify({
        rules: this.rules, players: this.players, props: this.props,
        housesLeft: this.housesLeft, hotelsLeft: this.hotelsLeft,
        current: this.current, phase: this.phase, doubles: this.doubles, rolledDoubles: this.rolledDoubles,
        lastDice: this.lastDice, lastRoll: this.lastRoll, rollSeq: this.rollSeq,
        lastCard: this.lastCard, cardSeq: this.cardSeq,
        auction: this.auction, debt, winner: this.winner, turnCount: this.turnCount, round: this.round, endedByLimit: this.endedByLimit,
        log: this.log.slice(-80), logSeq: this.logSeq,
      }));
    }
    static fromSnapshot(snap) {
      const g = Object.create(Game.prototype);
      return Object.assign(g, snap);
    }

    // ------------------------------------------------------------------ turn flow
    rollDice(pid) {
      this.need(pid, 'roll');
      const p = this.cur();
      const d1 = this.die(), d2 = this.die(), dbl = d1 === d2;
      this.lastDice = [d1, d2];
      const res = { player: p.id, dice: [d1, d2], from: p.pos, to: p.pos, steps: 0 };
      this.lastRoll = res;
      this.rollSeq++;
      this.say(`${p.name} rolled ${d1} + ${d2}${dbl ? ' (doubles!)' : ''}.`, p.id);

      if (p.inJail) {
        this.rolledDoubles = false;
        if (dbl) {
          this.say(`${p.name} rolled doubles and leaves jail.`, p.id);
          this.releaseFromJail(p);
          this.step(res, d1 + d2);
        } else {
          p.jailTurns++;
          if (p.jailTurns < this.rules.maxJailTurns) {
            this.say(`${p.name} stays in jail (attempt ${p.jailTurns}/${this.rules.maxJailTurns}).`, p.id);
            this.phase = 'postroll';
          } else {
            this.say(`${p.name} must pay the ${this.money(this.rules.jailFine)} fine and leave jail.`, p.id);
            this.charge(p, this.rules.jailFine, null, () => {
              this.releaseFromJail(p);
              this.step(res, d1 + d2);
            });
          }
        }
        return res;
      }

      if (dbl) {
        this.doubles++;
        if (this.doubles >= 3) {
          this.say(`${p.name} rolled doubles three times and goes to jail!`, p.id);
          this.sendToJail(p);
          res.to = p.pos;
          this.phase = 'postroll';
          return res;
        }
      } else {
        this.doubles = 0;
      }
      this.rolledDoubles = dbl;
      this.step(res, d1 + d2);
      return res;
    }

    step(res, steps) {
      const p = this.cur();
      res.from = p.pos;
      res.steps = steps;
      const np = p.pos + steps;
      if (np >= 40) this.collectGo(p);
      p.pos = np % 40;
      res.to = p.pos;
      this.land();
    }

    moveTo(idx, collect) {
      const p = this.cur();
      if (collect && idx < p.pos) this.collectGo(p);
      p.pos = idx;
    }

    collectGo(p) {
      p.cash += this.rules.goSalary;
      this.say(`${p.name} passes Start and collects ${this.money(this.rules.goSalary)}.`, p.id);
    }

    land(opts = {}) {
      const p = this.cur();
      const s = SPACES[p.pos];
      switch (s.type) {
        case 'property': case 'railroad': case 'utility': {
          const st = this.props[p.pos];
          if (st.owner === null) {
            this.phase = 'buy';
            this.say(`${p.name} landed on ${s.name} (${this.money(s.price)}).`, p.id);
            return;
          }
          if (st.owner === p.id) { this.say(`${p.name} landed on their own ${s.name}.`, p.id); return this.afterLand(); }
          if (st.mortgaged) { this.say(`${p.name} landed on ${s.name}, which is mortgaged. No rent.`, p.id); return this.afterLand(); }
          const rent = this.rentFor(p.pos, this.lastDice ? this.lastDice[0] + this.lastDice[1] : 7, opts);
          const owner = this.players[st.owner];
          this.say(`${p.name} landed on ${s.name} and owes ${owner.name} ${this.money(rent)} rent.`, p.id);
          return this.charge(p, rent, owner.id, () => this.afterLand());
        }
        case 'tax':
          this.say(`${p.name} pays ${s.name}: ${this.money(s.amount)}.`, p.id);
          return this.charge(p, s.amount, null, () => this.afterLand());
        case 'gotojail':
          this.say(`${p.name} is sent to jail!`, p.id);
          this.sendToJail(p);
          return this.afterLand();
        case 'chance': return this.drawCard('chance');
        case 'chest': return this.drawCard('chest');
        default:
          this.say(`${p.name} landed on ${s.name}.`, p.id);
          return this.afterLand();
      }
    }

    afterLand() {
      const p = this.cur();
      if (p.inJail) this.rolledDoubles = false;
      this.phase = this.rolledDoubles ? 'roll' : 'postroll';
      if (this.rolledDoubles) this.say(`${p.name} rolled doubles and goes again!`, p.id);
    }

    sendToJail(p) {
      p.pos = this.rules.jailPosition;
      p.inJail = true;
      p.jailTurns = 0;
      this.doubles = 0;
      this.rolledDoubles = false;
    }
    releaseFromJail(p) { p.inJail = false; p.jailTurns = 0; }

    endTurn(pid) {
      this.need(pid, 'postroll');
      this.nextTurn();
    }

    nextTurn() {
      this.doubles = 0;
      this.rolledDoubles = false;
      const from = this.current;
      let n = from;
      do { n = (n + 1) % this.players.length; } while (this.players[n].bankrupt);
      this.current = n;
      this.turnCount++;
      this.phase = 'roll';
      if (n <= from) { // passed the end of the table: a new round begins
        this.round++;
        const left = this.rules.maxRounds - this.round + 1;
        if (this.round > this.rules.maxRounds) return this.endByRoundLimit();
        if (left === 10) this.say(`10 rounds left! When time runs out the richest player wins.`);
        else if (left === 1) this.say('Final round! The richest player wins when it ends.');
      }
    }

    // Time's up: the player with the highest net worth (cash + properties + buildings) wins.
    endByRoundLimit() {
      const ranked = this.alive().sort((a, b) => this.netWorth(b.id) - this.netWorth(a.id) || b.cash - a.cash || a.id - b.id);
      const w = ranked[0];
      this.winner = w.id;
      this.endedByLimit = true;
      this.phase = 'gameover';
      this.say(`Time's up after ${this.rules.maxRounds} rounds! ${w.name} wins with a net worth of ${this.money(this.netWorth(w.id))}.`, w.id);
    }

    // ------------------------------------------------------------------ jail
    payJailFine(pid) {
      this.need(pid, 'roll');
      const p = this.cur();
      if (!p.inJail) throw new Error("You're not in jail.");
      if (p.cash < this.rules.jailFine) throw new Error('Not enough cash.');
      p.cash -= this.rules.jailFine;
      this.releaseFromJail(p);
      this.say(`${p.name} pays ${this.money(this.rules.jailFine)} to leave jail.`, p.id);
    }
    useJailCard(pid) {
      this.need(pid, 'roll');
      const p = this.cur();
      if (!p.inJail) throw new Error("You're not in jail.");
      if (p.jailCards < 1) throw new Error("You don't have a Get Out of Jail Free card.");
      p.jailCards--;
      this.releaseFromJail(p);
      // The card goes back to the bottom of whichever deck has room for it.
      this.decks.chance.length < CARDS.chance.length
        ? this.decks.chance.push(CARDS.chance.find((c) => c.t === 'jailCard'))
        : this.decks.chest.push(CARDS.chest.find((c) => c.t === 'jailCard'));
      this.say(`${p.name} uses a Get Out of Jail Free card.`, p.id);
    }

    // ------------------------------------------------------------------ money & debt
    // Pay `amount` to creditor (null = bank). If the player can't afford it the game
    // enters the 'debt' phase and `resume` runs once they've raised enough money.
    charge(p, amount, creditorId, resume) {
      if (amount <= 0) return resume();
      if (p.cash >= amount) {
        p.cash -= amount;
        if (creditorId !== null) this.players[creditorId].cash += amount;
        return resume();
      }
      this.debt = { pid: p.id, amount, creditor: creditorId, resume, prevPhase: this.phase };
      this.phase = 'debt';
      this.say(`${p.name} owes ${this.money(amount)} but only has ${this.money(p.cash)}. Raise funds or go bankrupt!`, p.id);
    }

    checkDebt() {
      const d = this.debt;
      if (!d) return;
      const p = this.players[d.pid];
      if (p.cash < d.amount) return;
      this.debt = null;
      p.cash -= d.amount;
      if (d.creditor !== null) this.players[d.creditor].cash += d.amount;
      this.say(`${p.name} settles the debt of ${this.money(d.amount)}.`, p.id);
      this.phase = d.prevPhase;
      d.resume();
    }

    declareBankruptcy(pid) {
      this.need(pid, 'debt');
      const p = this.cur();
      const creditor = this.debt.creditor;
      this.say(`${p.name} is bankrupt!${creditor !== null ? ` Everything goes to ${this.players[creditor].name}.` : ''}`, p.id);
      for (const i of this.ownedBy(p.id)) {
        const st = this.props[i];
        if (st.houses === 5) this.hotelsLeft++; else this.housesLeft += st.houses;
        st.houses = 0;
        if (creditor !== null) {
          st.owner = creditor;
        } else {
          st.owner = null;
          st.mortgaged = false;
        }
      }
      if (creditor !== null) {
        this.players[creditor].cash += p.cash;
        this.players[creditor].jailCards += p.jailCards;
      }
      p.cash = 0; p.jailCards = 0; p.bankrupt = true; p.inJail = false;
      this.debt = null;
      const alive = this.alive();
      if (alive.length <= 1) {
        this.winner = alive[0] ? alive[0].id : null;
        this.phase = 'gameover';
        if (alive[0]) this.say(`${alive[0].name} wins the game!`, alive[0].id);
        return;
      }
      this.nextTurn();
    }

    // ------------------------------------------------------------------ buying & auctions
    buy(pid) {
      this.need(pid, 'buy');
      const p = this.cur(), s = SPACES[p.pos];
      if (p.cash < s.price) throw new Error('Not enough cash.');
      p.cash -= s.price;
      this.props[p.pos].owner = p.id;
      this.say(`${p.name} buys ${s.name} for ${this.money(s.price)}.`, p.id);
      this.afterLand();
    }

    declineBuy(pid) {
      this.need(pid, 'buy');
      const p = this.cur();
      this.say(`${p.name} passes on ${SPACES[p.pos].name}. It goes to auction!`, p.id);
      const order = [];
      for (let k = 0; k < this.players.length; k++) {
        const q = this.players[(this.current + k) % this.players.length];
        if (!q.bankrupt) order.push(q.id);
      }
      this.auction = { idx: p.pos, bid: 0, bidder: null, order, active: order.slice(), turn: order[0] };
      this.phase = 'auction';
    }

    auctionBid(pid, amount) {
      const a = this.auction;
      if (this.phase !== 'auction' || !a) throw new Error('No auction in progress.');
      if (a.turn !== pid) throw new Error("It's not your turn to bid.");
      amount = Math.floor(Number(amount));
      if (!(amount > a.bid)) throw new Error(`You must bid more than ${this.money(a.bid)}.`);
      if (amount > this.players[pid].cash) throw new Error('You cannot afford that bid.');
      a.bid = amount;
      a.bidder = pid;
      this.say(`${this.players[pid].name} bids ${this.money(amount)} for ${SPACES[a.idx].name}.`, pid);
      this.advanceAuction();
    }

    auctionPass(pid) {
      const a = this.auction;
      if (this.phase !== 'auction' || !a) throw new Error('No auction in progress.');
      if (a.turn !== pid) throw new Error("It's not your turn to bid.");
      a.active = a.active.filter((id) => id !== pid);
      this.say(`${this.players[pid].name} drops out of the auction.`, pid);
      this.advanceAuction(pid);
    }

    advanceAuction(from = this.auction.turn) {
      const a = this.auction;
      if (a.active.length === 0) return this.finishAuction();
      // Next active bidder after `from` in seating order.
      let k = a.order.indexOf(from);
      let next = null;
      for (let n = 0; n < a.order.length; n++) {
        k = (k + 1) % a.order.length;
        if (a.active.includes(a.order[k])) { next = a.order[k]; break; }
      }
      if (next === a.bidder) return this.finishAuction(); // everyone else has passed
      a.turn = next;
    }

    finishAuction() {
      const a = this.auction, s = SPACES[a.idx];
      this.auction = null;
      if (a.bidder !== null) {
        const w = this.players[a.bidder];
        w.cash -= a.bid;
        this.props[a.idx].owner = w.id;
        this.say(`${w.name} wins ${s.name} for ${this.money(a.bid)}.`, w.id);
      } else {
        this.say(`Nobody bid on ${s.name}.`);
      }
      this.afterLand();
    }

    // ------------------------------------------------------------------ cards
    drawCard(deckName) {
      const p = this.cur();
      const deck = this.decks[deckName];
      const card = deck.shift();
      const label = deckName === 'chance' ? 'Chance' : 'Community Chest';
      this.lastCard = { deck: deckName, text: card.text, player: p.id };
      this.cardSeq++;
      this.say(`${p.name} draws ${label}: "${card.text}"`, p.id);
      if (card.t !== 'jailCard') deck.push(card);
      const done = () => this.afterLand();
      switch (card.t) {
        case 'move':
          this.moveTo(indexOfId(card.to), true);
          return this.land();
        case 'nearest': {
          let idx = p.pos;
          do { idx = (idx + 1) % 40; } while (SPACES[idx].type !== card.kind);
          this.moveTo(idx, true);
          return this.land({ cardRent: card.kind });
        }
        case 'back':
          p.pos = (p.pos - card.n + 40) % 40;
          return this.land();
        case 'gain': p.cash += card.amt; return done();
        case 'pay': return this.charge(p, card.amt, null, done);
        case 'payEach': {
          const others = this.alive().filter((q) => q.id !== p.id);
          const payNext = (k) => (k >= others.length ? done() : this.charge(p, card.amt, others[k].id, () => payNext(k + 1)));
          return payNext(0);
        }
        case 'gainEach':
          for (const q of this.alive()) {
            if (q.id === p.id) continue;
            const x = Math.min(q.cash, card.amt);
            q.cash -= x; p.cash += x;
          }
          return done();
        case 'repairs': {
          let total = 0;
          for (const i of this.ownedBy(p.id)) {
            const h = this.props[i].houses;
            total += h === 5 ? card.hotel : h * card.house;
          }
          this.say(`${p.name}'s repair bill is ${this.money(total)}.`, p.id);
          return this.charge(p, total, null, done);
        }
        case 'jail':
          this.sendToJail(p);
          return done();
        case 'jailCard':
          p.jailCards++;
          return done();
        default:
          return done();
      }
    }

    // ------------------------------------------------------------------ buildings & mortgages
    canManage(pid) { return pid === this.current && MANAGE_PHASES.includes(this.phase); }

    canBuild(pid, i) {
      const s = SPACES[i], st = this.props[i];
      if (!this.canManage(pid) || this.phase === 'debt') return "You can't build right now.";
      if (!st || s.type !== 'property') return 'Only streets can be built on.';
      if (st.owner !== pid) return "You don't own this.";
      if (!this.hasMonopoly(pid, s.group)) return 'You need the whole color set.';
      const group = this.groupOf(i);
      if (group.some((j) => this.props[j].mortgaged)) return 'Unmortgage the whole set first.';
      if (st.houses >= 5) return 'This street already has a hotel.';
      if (group.some((j) => this.props[j].houses < st.houses)) return 'Build evenly across the set.';
      if (st.houses === 4 ? this.hotelsLeft < 1 : this.housesLeft < 1) return 'The bank has none left.';
      if (this.players[pid].cash < s.houseCost) return 'Not enough cash.';
      return null;
    }
    build(pid, i) {
      const err = this.canBuild(pid, i);
      if (err) throw new Error(err);
      const st = this.props[i], s = SPACES[i];
      this.players[pid].cash -= s.houseCost;
      if (st.houses === 4) { this.hotelsLeft--; this.housesLeft += 4; } else this.housesLeft--;
      st.houses++;
      this.say(`${this.players[pid].name} builds a ${st.houses === 5 ? 'hotel' : 'house'} on ${s.name}.`, pid);
    }

    canSell(pid, i) {
      const s = SPACES[i], st = this.props[i];
      if (!this.canManage(pid)) return "You can't do that right now.";
      if (!st || s.type !== 'property') return 'Nothing to sell here.';
      if (st.owner !== pid) return "You don't own this.";
      if (st.houses < 1) return 'No buildings here.';
      if (this.groupOf(i).some((j) => this.props[j].houses > st.houses)) return 'Sell evenly across the set.';
      if (st.houses === 5 && this.housesLeft < 4) return 'The bank lacks houses to replace the hotel.';
      return null;
    }
    sellHouse(pid, i) {
      const err = this.canSell(pid, i);
      if (err) throw new Error(err);
      const st = this.props[i], s = SPACES[i];
      if (st.houses === 5) { this.hotelsLeft++; this.housesLeft -= 4; } else this.housesLeft++;
      st.houses--;
      this.players[pid].cash += Math.floor(s.houseCost / 2);
      this.say(`${this.players[pid].name} sells a building on ${s.name}.`, pid);
      this.checkDebt();
    }

    canMortgage(pid, i) {
      const st = this.props[i];
      if (!this.canManage(pid)) return "You can't do that right now.";
      if (!st) return 'Not a property.';
      if (st.owner !== pid) return "You don't own this.";
      if (st.mortgaged) return 'Already mortgaged.';
      if (SPACES[i].group && this.groupOf(i).some((j) => this.props[j].houses > 0)) return 'Sell all buildings in the set first.';
      return null;
    }
    mortgage(pid, i) {
      const err = this.canMortgage(pid, i);
      if (err) throw new Error(err);
      this.props[i].mortgaged = true;
      this.players[pid].cash += this.mortgageValue(i);
      this.say(`${this.players[pid].name} mortgages ${SPACES[i].name} for ${this.money(this.mortgageValue(i))}.`, pid);
      this.checkDebt();
    }

    canUnmortgage(pid, i) {
      const st = this.props[i];
      if (!this.canManage(pid) || this.phase === 'debt') return "You can't do that right now.";
      if (!st) return 'Not a property.';
      if (st.owner !== pid) return "You don't own this.";
      if (!st.mortgaged) return 'Not mortgaged.';
      if (this.players[pid].cash < this.unmortgageCost(i)) return 'Not enough cash.';
      return null;
    }
    unmortgage(pid, i) {
      const err = this.canUnmortgage(pid, i);
      if (err) throw new Error(err);
      this.props[i].mortgaged = false;
      this.players[pid].cash -= this.unmortgageCost(i);
      this.say(`${this.players[pid].name} pays ${this.money(this.unmortgageCost(i))} to unmortgage ${SPACES[i].name}.`, pid);
    }

    // ------------------------------------------------------------------ trading
    // offer = { cash, props: [spaceIndex], cards }.  `give` leaves `from`, `get` leaves `to`.
    validateTrade(from, to, give, get) {
      if (!['roll', 'postroll'].includes(this.phase)) return 'Trades can only happen at the start or end of a turn.';
      const a = this.players[from], b = this.players[to];
      if (!a || !b || a.bankrupt || b.bankrupt || from === to) return 'Invalid trade partner.';
      for (const [o, who] of [[give, a], [get, b]]) {
        if (!(o.cash >= 0) || !(o.cards >= 0)) return 'Invalid amounts.';
        if (o.cash > who.cash) return `${who.name} doesn't have that much cash.`;
        if (o.cards > who.jailCards) return `${who.name} doesn't have that many jail cards.`;
        for (const i of o.props) {
          const st = this.props[i];
          if (!st || st.owner !== who.id) return `${who.name} doesn't own ${SPACES[i] ? SPACES[i].name : 'that'}.`;
          if (SPACES[i].group && this.groupOf(i).some((j) => this.props[j].houses > 0)) return `Sell the buildings on ${SPACES[i].name}'s color set first.`;
        }
      }
      if (!give.cash && !get.cash && !give.cards && !get.cards && !give.props.length && !get.props.length) return 'The trade is empty.';
      // Mortgaged properties cost the receiver 10% on arrival.
      const fee = (props) => props.filter((i) => this.props[i].mortgaged).reduce((s, i) => s + Math.ceil(this.mortgageValue(i) * this.rules.mortgageInterest), 0);
      if (b.cash + give.cash - get.cash < fee(give.props)) return `${b.name} can't afford the mortgage fee.`;
      if (a.cash + get.cash - give.cash < fee(get.props)) return `${a.name} can't afford the mortgage fee.`;
      return null;
    }
    executeTrade(from, to, give, get) {
      const err = this.validateTrade(from, to, give, get);
      if (err) throw new Error(err);
      const a = this.players[from], b = this.players[to];
      a.cash += get.cash - give.cash; b.cash += give.cash - get.cash;
      a.jailCards += get.cards - give.cards; b.jailCards += give.cards - get.cards;
      const move = (props, receiver) => {
        for (const i of props) {
          this.props[i].owner = receiver.id;
          if (this.props[i].mortgaged) receiver.cash -= Math.ceil(this.mortgageValue(i) * this.rules.mortgageInterest);
        }
      };
      move(give.props, b); move(get.props, a);
      const names = (props) => props.map((i) => SPACES[i].name);
      const bits = (o) => [...names(o.props), o.cash ? this.money(o.cash) : null, o.cards ? `${o.cards} jail card(s)` : null].filter(Boolean).join(', ') || 'nothing';
      this.say(`Trade: ${a.name} gives ${bits(give)}; ${b.name} gives ${bits(get)}.`, from);
    }
  }

  Game.SPACES = SPACES;
  Game.indexOfId = indexOfId;
  Game.GROUPS = GROUPS;
  if (typeof module !== 'undefined' && module.exports) module.exports = { Game };
  else root.MonopolyEngine = { Game };
})(typeof window !== 'undefined' ? window : globalThis);
