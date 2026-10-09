// Unit tests for how bots judge trade offers and what hint they give when they refuse.
'use strict';
const assert = require('assert');
const { Game } = require('../js/engine.js');
const AI = require('../js/ai.js');

const mk = () => new Game({ players: [{ name: 'Human', ai: false }, { name: 'Bot', ai: true }] });
const empty = { cash: 0, cards: 0, props: [] };
const offer = (o) => ({ ...empty, ...o });

// Bot owns Sunset Plaza (index 11, $140) with nothing else in its colour.
{
  const g = mk(); g.props[11].owner = 1;
  const ask = (cash) => AI.assessTrade(g, 1, offer({ props: [11] }), offer({ cash }));
  const low = ask(100);
  assert.strictEqual(low.ok, false); assert.strictEqual(low.reason, 'value');
  assert(low.shortfall > 0 && low.shortfall % 5 === 0);
  assert.strictEqual(ask(100 + low.shortfall).ok, true, 'adding the hinted amount must make the bot accept');
  assert.strictEqual(ask(100 + low.shortfall - 5).ok, false, 'the hint should be tight, not wasteful');
  assert.strictEqual(ask(140).ok, false, 'paying face value is not enough (bot wants a small premium)');
  assert.strictEqual(ask(160).ok, true, 'about 10% over face value is enough');
  assert(AI.declineHint(low).includes('$' + low.shortfall));
}
// A property that completes the bot's set is worth more to it, so it pays more for it than face value.
{
  const g = mk(); g.props[11].owner = 1; g.props[13].owner = 1; // pink set, bot needs 14
  g.props[14].owner = 0;
  const sell = (cash) => AI.assessTrade(g, 1, offer({ cash }), offer({ props: [14] }));
  assert.strictEqual(sell(200).ok, true, 'bot gives $200 for a $160 street that completes its set');
}
// The bot never splits a colour set it fully owns, whatever the price.
{
  const g = mk(); g.props[1].owner = 1; g.props[3].owner = 1; // full brown set
  const v = AI.assessTrade(g, 1, offer({ props: [1] }), offer({ cash: 1400 }));
  assert.strictEqual(v.ok, false); assert.strictEqual(v.reason, 'set');
  assert(AI.declineHint(v).includes('Old Town Lane'));
}
// Gifts are accepted; mortgaged properties are worth less to the bot.
{
  const g = mk(); g.props[11].owner = 1;
  assert.strictEqual(AI.assessTrade(g, 1, empty, offer({ cash: 10 })).ok, true);
  const full = AI.assessTrade(g, 1, offer({ props: [11] }), offer({ cash: 100 })).shortfall;
  g.props[11].mortgaged = true;
  assert.strictEqual(AI.assessTrade(g, 1, offer({ props: [11] }), offer({ cash: 100 })).ok, true, 'a mortgaged street is cheap');
  assert(full > 0);
}
console.log('trade-ai OK');
