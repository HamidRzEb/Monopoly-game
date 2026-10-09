// Bot brain. act(game) performs exactly one engine action on behalf of game.decider().
// Runs on the server (or in tests); it only uses the public Game API, same as a human.
'use strict';

const { Game } = require('./engine.js');
const { SPACES } = require('./data.js');

const RESERVE = 150; // cash a bot likes to keep after spending
// Trades: a bot values what it gives up this much higher than its plain worth, and wants this
// much extra on top. (Previously 1.25 and 1.05, which made almost every offer a refusal.)
const TRADE_GIVE_PREMIUM = 1.1;
const TRADE_MARGIN = 1.0;

function completesSet(g, pid, i) {
  const s = SPACES[i];
  if (!s.group) return false;
  return g.groupOf(i).every((j) => j === i || g.props[j].owner === pid);
}

// How much a property is worth to this player (used for auctions and trades).
function valueOf(g, pid, i) {
  const s = SPACES[i];
  let v = s.price;
  if (completesSet(g, pid, i)) v *= 1.6;
  else if (s.type === 'railroad') v *= 1.2;
  else if (s.group && g.groupOf(i).some((j) => j !== i && g.props[j].owner === pid)) v *= 1.15; // (not counting i itself)
  // Denying an opponent a set is worth something too.
  if (s.group) {
    const owners = new Set(g.groupOf(i).filter((j) => j !== i).map((j) => g.props[j].owner));
    if (owners.size === 1 && !owners.has(null) && !owners.has(pid)) v *= 1.2;
  }
  return v;
}

const memos = new WeakMap();
function memoFor(g) {
  if (!memos.has(g)) memos.set(g, { turn: new Map(), attempts: new Map() });
  return memos.get(g);
}

const AI = {
  act(g) {
    const p = g.decider();
    switch (g.phase) {
      case 'auction': return this.auction(g, p);
      case 'debt': return this.debt(g, p);
      case 'buy': return this.buy(g, p);
      case 'roll': return this.roll(g, p);
      case 'postroll': return this.postroll(g, p);
      default: return null;
    }
  },

  buy(g, p) {
    const s = SPACES[p.pos];
    if (p.cash >= s.price && (completesSet(g, p.id, p.pos) || p.cash - s.price >= RESERVE)) return g.buy(p.id);
    return g.declineBuy(p.id);
  },

  auction(g, p) {
    const a = g.auction;
    const maxBid = Math.min(Math.floor(valueOf(g, p.id, a.idx)), p.cash - 40);
    const next = a.bid + (a.bid < 100 ? 10 : 20);
    if (next <= maxBid) return g.auctionBid(p.id, next);
    return g.auctionPass(p.id);
  },

  roll(g, p) {
    if (p.inJail) {
      if (p.jailCards > 0) return g.useJailCard(p.id);
      // Early in the game it's worth getting out to buy things; later, sitting in jail is safe.
      const unowned = Object.values(g.props).filter((st) => st.owner === null).length;
      if (unowned > 8 && p.cash >= g.rules.jailFine + 300) return g.payJailFine(p.id);
    }
    return g.rollDice(p.id);
  },

  postroll(g, p) {
    if (this.tryBuild(g, p)) return;
    if (this.tryUnmortgage(g, p)) return;
    return g.endTurn(p.id);
  },

  tryBuild(g, p) {
    const options = g.ownedBy(p.id)
      .filter((i) => !g.canBuild(p.id, i) && p.cash - SPACES[i].houseCost >= RESERVE + 50)
      .sort((a, b) => g.props[a].houses - g.props[b].houses || SPACES[a].houseCost - SPACES[b].houseCost);
    if (!options.length) return false;
    g.build(p.id, options[0]);
    return true;
  },

  tryUnmortgage(g, p) {
    const options = g.ownedBy(p.id)
      .filter((i) => !g.canUnmortgage(p.id, i) && p.cash - g.unmortgageCost(i) >= RESERVE + 150)
      .sort((a, b) => SPACES[b].price - SPACES[a].price);
    if (!options.length) return false;
    g.unmortgage(p.id, options[0]);
    return true;
  },

  debt(g, p) {
    const mine = g.ownedBy(p.id);
    // Sell buildings first (most built-up street first), then mortgage the cheapest properties.
    const sell = mine.filter((i) => !g.canSell(p.id, i)).sort((a, b) => g.props[b].houses - g.props[a].houses);
    if (sell.length) return g.sellHouse(p.id, sell[0]);
    const mort = mine.filter((i) => !g.canMortgage(p.id, i)).sort((a, b) => SPACES[a].price - SPACES[b].price);
    if (mort.length) return g.mortgage(p.id, mort[0]);
    return g.declareBankruptcy(p.id);
  },

  // A bot with all-but-one street of a color set offers cash for the missing one, raising
  // its offer each time it's refused. Returns { to, give, get } or null. The caller (server
  // or test) decides what to do with it. At most one proposal per bot per turn.
  proposeTrade(g, p) {
    if (!['roll', 'postroll'].includes(g.phase)) return null;
    const memo = memoFor(g);
    if (memo.turn.get(p.id) === g.turnCount) return null;
    const groups = Object.keys(Game.GROUPS);
    let best = null;
    for (const group of groups) {
      const idxs = Game.GROUPS[group];
      const mine = idxs.filter((i) => g.props[i].owner === p.id);
      const missing = idxs.filter((i) => g.props[i].owner !== p.id);
      if (missing.length !== 1 || mine.length < 1) continue;
      const target = missing[0], st = g.props[target];
      if (st.owner === null || g.players[st.owner].bankrupt) continue;
      if (idxs.some((i) => g.props[i].houses > 0)) continue;
      const key = `${p.id}:${target}`;
      const attempts = memo.attempts.get(key) || 0;
      if (attempts >= 6) continue;
      const price = SPACES[target].price;
      const cash = Math.min(Math.round((price * (1.5 + 0.5 * attempts)) / 10) * 10, p.cash - 100);
      if (cash < price * 0.8) continue;
      if (!best || SPACES[target].price > SPACES[best.target].price) best = { target, key, cash, owner: st.owner, attempts };
    }
    if (!best) return null;
    memo.turn.set(p.id, g.turnCount);
    memo.attempts.set(best.key, best.attempts + 1);
    return {
      to: best.owner,
      give: { cash: best.cash, props: [], cards: 0 },
      get: { cash: 0, props: [best.target], cards: 0 },
    };
  },

  // Should this bot accept the trade? `give` leaves the bot, `get` goes to the bot.
  // Returns { ok } or { ok:false, reason:'set', property } or { ok:false, reason:'value', shortfall }.
  // `shortfall` is how much more cash (in dollars) would make the bot say yes.
  assessTrade(g, botId, give, get) {
    // Never break up a monopoly the bot owns.
    for (const i of give.props) {
      if (SPACES[i].group && g.hasMonopoly(botId, SPACES[i].group)) return { ok: false, reason: 'set', property: SPACES[i].name };
    }
    const worth = (o, premium) => {
      let v = o.cash + o.cards * 50;
      for (const i of o.props) v += valueOf(g, botId, i) * premium * (g.props[i].mortgaged ? 0.6 : 1);
      return v;
    };
    const got = worth(get, 1);
    const cost = worth(give, TRADE_GIVE_PREMIUM) * TRADE_MARGIN;
    if (got >= cost) return { ok: true };
    return { ok: false, reason: 'value', shortfall: Math.ceil((cost - got) / 5) * 5 };
  },

  evaluateTrade(g, botId, give, get) { return this.assessTrade(g, botId, give, get).ok; },

  // Short human-readable reason for a refusal, e.g. "wants about $75 more".
  declineHint(a) {
    if (a.reason === 'set') return `won't break up their ${a.property} colour set`;
    return `wants about $${a.shortfall} more`;
  },
};

module.exports = AI;
