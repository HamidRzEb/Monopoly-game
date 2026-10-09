// Board, cards, tokens and rules. Everything themeable lives here:
// rename spaces, change prices, swap emoji fallbacks. Shared by server and browser.
(function (root) {
  'use strict';

  const THEME = {
    title: 'Tycoon',
    // Images are looked up by convention (see assets/README.md); emoji below are
    // shown until/unless a matching image file exists.
    assetExtensions: ['png', 'svg', 'jpg', 'webp'],
  };

  const RULES = {
    startingCash: 1500,
    goSalary: 200,
    jailFine: 50,
    jailPosition: 10,
    maxJailTurns: 3,
    housesTotal: 32,
    hotelsTotal: 12,
    mortgageInterest: 0.1,
    maxPlayers: 8,
    // Games can't run forever: after this many rounds (everyone has had a turn) the richest player wins.
    maxRounds: 120,
    roundOptions: [60, 120, 200], // choices offered to the host in the lobby
    // The bank: each loan is paid back in `rounds` equal parts of the principal, one per round, plus
    // `rate` interest on whatever you still owe, charged at the start of each of your turns.
    loans: { rate: 0.05, rounds: 5, step: 100, min: 100, maxActive: 3, creditFraction: 0.5, creditCap: 2000 },
  };

  // Pace of the game. `bot` scales how long bots pause between actions, `anim` the dice/walking/card animations.
  const SPEEDS = {
    relaxed: { label: 'Relaxed', bot: 1.8, anim: 1.5 },
    normal: { label: 'Normal', bot: 1, anim: 1 },
    fast: { label: 'Fast', bot: 0.5, anim: 0.7 },
  };

  const COLORS = {
    brown: '#8b5a2b', lightblue: '#8fd3f4', pink: '#e0529c', orange: '#f39c34',
    red: '#d93a3a', yellow: '#f5d62e', green: '#2e9e5b', darkblue: '#2a4fa8',
  };

  // rent = [base, 1 house, 2, 3, 4, hotel]
  const street = (id, name, group, price, rent, houseCost) =>
    ({ type: 'property', id, name, group, price, rent, houseCost });
  const rail = (id, name) => ({ type: 'railroad', id, name, price: 200 });
  const util = (id, name) => ({ type: 'utility', id, name, price: 150 });

  const SPACES = [
    { type: 'go', id: 'go', name: 'Start' },
    street('old-town', 'Old Town Lane', 'brown', 60, [2, 10, 30, 90, 160, 250], 50),
    { type: 'chest', id: 'chest-1', name: 'Community Chest' },
    street('harbor-road', 'Harbor Road', 'brown', 60, [4, 20, 60, 180, 320, 450], 50),
    { type: 'tax', id: 'income-tax', name: 'Income Tax', amount: 200 },
    rail('north-station', 'North Station'),
    street('maple-street', 'Maple Street', 'lightblue', 100, [6, 30, 90, 270, 400, 550], 50),
    { type: 'chance', id: 'chance-1', name: 'Chance' },
    street('cedar-avenue', 'Cedar Avenue', 'lightblue', 100, [6, 30, 90, 270, 400, 550], 50),
    street('birch-boulevard', 'Birch Boulevard', 'lightblue', 120, [8, 40, 100, 300, 450, 600], 50),

    { type: 'jail', id: 'jail', name: 'Jail / Just Visiting' },
    street('sunset-plaza', 'Sunset Plaza', 'pink', 140, [10, 50, 150, 450, 625, 750], 100),
    util('power-company', 'Power Company'),
    street('rosewood-court', 'Rosewood Court', 'pink', 140, [10, 50, 150, 450, 625, 750], 100),
    street('lakeview-drive', 'Lakeview Drive', 'pink', 160, [12, 60, 180, 500, 700, 900], 100),
    rail('east-station', 'East Station'),
    street('market-square', 'Market Square', 'orange', 180, [14, 70, 200, 550, 750, 950], 100),
    { type: 'chest', id: 'chest-2', name: 'Community Chest' },
    street('gallery-row', 'Gallery Row', 'orange', 180, [14, 70, 200, 550, 750, 950], 100),
    street('opera-lane', 'Opera Lane', 'orange', 200, [16, 80, 220, 600, 800, 1000], 100),

    { type: 'parking', id: 'parking', name: 'Free Parking' },
    street('cherry-hill', 'Cherry Hill', 'red', 220, [18, 90, 250, 700, 875, 1050], 150),
    { type: 'chance', id: 'chance-2', name: 'Chance' },
    street('riverside-walk', 'Riverside Walk', 'red', 220, [18, 90, 250, 700, 875, 1050], 150),
    street('crimson-way', 'Crimson Way', 'red', 240, [20, 100, 300, 750, 925, 1100], 150),
    rail('south-station', 'South Station'),
    street('golden-gate', 'Golden Gate', 'yellow', 260, [22, 110, 330, 800, 975, 1150], 150),
    street('amber-avenue', 'Amber Avenue', 'yellow', 260, [22, 110, 330, 800, 975, 1150], 150),
    util('water-company', 'Water Company'),
    street('sunflower-park', 'Sunflower Park', 'yellow', 280, [24, 120, 360, 850, 1025, 1200], 150),

    { type: 'gotojail', id: 'go-to-jail', name: 'Go To Jail' },
    street('emerald-row', 'Emerald Row', 'green', 300, [26, 130, 390, 900, 1100, 1275], 200),
    street('pine-heights', 'Pine Heights', 'green', 300, [26, 130, 390, 900, 1100, 1275], 200),
    { type: 'chest', id: 'chest-3', name: 'Community Chest' },
    street('garden-avenue', 'Garden Avenue', 'green', 320, [28, 150, 450, 1000, 1200, 1400], 200),
    rail('west-station', 'West Station'),
    { type: 'chance', id: 'chance-3', name: 'Chance' },
    street('grand-plaza', 'Grand Plaza', 'darkblue', 350, [35, 175, 500, 1100, 1300, 1500], 200),
    { type: 'tax', id: 'luxury-tax', name: 'Luxury Tax', amount: 100 },
    street('skyline-tower', 'Skyline Tower', 'darkblue', 400, [50, 200, 600, 1400, 1700, 2000], 200),
  ];

  // Card effects: move{to id} | nearest{kind} | back{n} | gain | pay | payEach |
  // gainEach | repairs{house,hotel} | jail | jailCard
  const CARDS = {
    chance: [
      { t: 'move', to: 'go', text: 'Advance to Start. Collect $200.' },
      { t: 'move', to: 'crimson-way', text: 'Advance to Crimson Way.' },
      { t: 'move', to: 'sunset-plaza', text: 'Advance to Sunset Plaza.' },
      { t: 'move', to: 'skyline-tower', text: 'Take a stroll to Skyline Tower.' },
      { t: 'move', to: 'north-station', text: 'Take a trip to North Station.' },
      { t: 'nearest', kind: 'utility', text: 'Advance to the nearest utility. Pay 10x the dice roll to the owner.' },
      { t: 'nearest', kind: 'railroad', text: 'Advance to the nearest station. Pay the owner double rent.' },
      { t: 'nearest', kind: 'railroad', text: 'Advance to the nearest station. Pay the owner double rent.' },
      { t: 'gain', amt: 50, text: 'The bank pays you a dividend of $50.' },
      { t: 'gain', amt: 150, text: 'Your building loan matures. Collect $150.' },
      { t: 'jailCard', text: 'Get Out of Jail Free. Keep this card until needed.' },
      { t: 'back', n: 3, text: 'Go back 3 spaces.' },
      { t: 'jail', text: 'Go directly to Jail. Do not pass Start.' },
      { t: 'repairs', house: 25, hotel: 100, text: 'Make general repairs: $25 per house, $100 per hotel.' },
      { t: 'pay', amt: 15, text: 'Speeding fine. Pay $15.' },
      { t: 'payEach', amt: 50, text: 'You are elected chairperson. Pay each player $50.' },
    ],
    chest: [
      { t: 'move', to: 'go', text: 'Advance to Start. Collect $200.' },
      { t: 'gain', amt: 200, text: 'Bank error in your favor. Collect $200.' },
      { t: 'pay', amt: 50, text: "Doctor's fee. Pay $50." },
      { t: 'gain', amt: 50, text: 'From the sale of stock you get $50.' },
      { t: 'jailCard', text: 'Get Out of Jail Free. Keep this card until needed.' },
      { t: 'jail', text: 'Go directly to Jail. Do not pass Start.' },
      { t: 'gain', amt: 100, text: 'Holiday fund matures. Collect $100.' },
      { t: 'gain', amt: 20, text: 'Income tax refund. Collect $20.' },
      { t: 'gainEach', amt: 10, text: "It's your birthday. Collect $10 from every player." },
      { t: 'gain', amt: 100, text: 'Life insurance matures. Collect $100.' },
      { t: 'pay', amt: 100, text: 'Hospital fees. Pay $100.' },
      { t: 'pay', amt: 50, text: 'School fees. Pay $50.' },
      { t: 'gain', amt: 25, text: 'Receive a $25 consultancy fee.' },
      { t: 'repairs', house: 40, hotel: 115, text: 'Street repairs: $40 per house, $115 per hotel.' },
      { t: 'gain', amt: 10, text: 'You win second prize in a beauty contest. Collect $10.' },
      { t: 'gain', amt: 100, text: 'You inherit $100.' },
    ],
  };

  const TOKENS = [
    { id: 'hat', name: 'Top Hat' },
    { id: 'car', name: 'Race Car' },
    { id: 'dog', name: 'Scottie Dog' },
    { id: 'ship', name: 'Battleship' },
    { id: 'thimble', name: 'Thimble' },
    { id: 'boot', name: 'Boot' },
    { id: 'cat', name: 'Cat' },
    { id: 'plane', name: 'Plane' },
  ];

  const PLAYER_COLORS = ['#e53935', '#1e88e5', '#43a047', '#fb8c00', '#8e24aa', '#00acc1', '#ec407a', '#546e7a'];

  const BOT_NAMES = ['Ada', 'Bolt', 'Cleo', 'Dex', 'Echo', 'Fizz', 'Gizmo', 'Hexa', 'Iris', 'Juno', 'Koda', 'Luna'];

  const DATA = { THEME, RULES, SPEEDS, COLORS, SPACES, CARDS, TOKENS, PLAYER_COLORS, BOT_NAMES };
  if (typeof module !== 'undefined' && module.exports) module.exports = DATA;
  else root.MonopolyData = DATA;
})(typeof window !== 'undefined' ? window : globalThis);
