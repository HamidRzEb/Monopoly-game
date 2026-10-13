// Tycoon (the Monopoly-like board game) described as a game module. The rules engine itself lives in
// js/engine.js, the bots in js/ai.js and the screen in js/client.js; this file is what the lobby and the server
// need to know about it. See blackjack.js for the shape of a module.
(function (root) {
  'use strict';
  const D = (typeof module !== 'undefined' && module.exports) ? require('../data.js') : root.MonopolyData;
  const E = (typeof module !== 'undefined' && module.exports) ? require('../engine.js') : root.MonopolyEngine;
  const { RULES, PLAYER_COLORS } = D;

  const lengthName = (n) => (n <= 60 ? 'Quick' : n <= 120 ? 'Standard' : 'Long');

  const meta = {
    id: 'tycoon',
    name: D.THEME.title,
    art: 'assets/logo',
    tagline: 'Buy, trade and bankrupt your friends.',
    icon: '🏠',
    minPlayers: 2,
    maxPlayers: RULES.maxPlayers,
    settings: [
      { key: 'maxRounds', label: 'Game length', note: 'When time runs out, the richest player wins.',
        options: RULES.roundOptions.map((n) => ({ value: n, label: `${lengthName(n)} (${n} rounds)` })), default: RULES.maxRounds },
    ],
    rules: [
      'Roll the dice, buy the properties you land on and collect rent from the others.',
      'Build houses on complete colour sets, trade with other players, borrow from the bank.',
      'Last player standing wins, or the richest when the round limit is reached.',
    ],
  };

  // The actions a player may send, with the kinds of their (integer) arguments. Trades are handled by the server.
  const actions = {
    rollDice: [], buy: [], declineBuy: [], endTurn: [], payJailFine: [], useJailCard: [],
    declareBankruptcy: [], auctionPass: [],
    build: ['int'], sellHouse: ['int'], mortgage: ['int'], unmortgage: ['int'], auctionBid: ['int'],
    borrow: ['int'], repay: ['int', 'int'], // the bank: (amount) and (loanId, amount)
  };

  const module_ = {
    meta, Engine: E.Game, actions,
    create(players, settings) {
      return new E.Game({
        players: players.map((p, i) => ({ ...p, color: PLAYER_COLORS[i] })),
        rules: { maxRounds: settings.maxRounds },
      });
    },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = module_;
  else (root.GameModules = root.GameModules || {}).tycoon = module_;
})(typeof window !== 'undefined' ? window : globalThis);
