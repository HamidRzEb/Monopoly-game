// Every game the server can host. To add a game: write js/games/<id>.js (see blackjack.js for the shape),
// register it here, add its <script> tag to index.html and its screen in js/games/<id>-ui.js.
// Node only; in the browser each game file registers itself on window.GameModules.
'use strict';
const GAMES = {
  tycoon: require('./tycoon.js'),
  blackjack: require('./blackjack.js'),
  uno: require('./uno.js'),
  poker: require('./poker.js'),
};
module.exports = {
  GAMES,
  DEFAULT_GAME: 'tycoon',
  list: () => Object.values(GAMES).map((m) => m.meta),
  get: (id) => (Object.prototype.hasOwnProperty.call(GAMES, id) ? GAMES[id] : null),
};
