// Shared pieces for the card-game screens (Blackjack, Uno, Poker...): a registry the game screens plug into, and
// the widgets they share (playing cards, Uno cards, chips). Browser only.
//
// A game screen is registered with GameUI.register(id, ui) from js/games/<id>-ui.js, where ui has:
//   renderTable(el, ctx)    fill the table area (called on every update)
//   renderPanel(ctx)        return the children of the action panel under the table
//   panelKey(ctx)           optional: the panel is only rebuilt when this string changes, so sliders and
//                           inputs aren't torn down every time a bot makes a move
//   seatSummary(g, p)       small text for a player's row in the sidebar (chips, cards left...)
//   standings(g)            lines for the game-over screen, best first
//   roundLabel(g)           optional text for the top bar ("Round 3/10")
// ctx = { g, view, me, act(action, args), mine }: g is the game rebuilt from your snapshot, `me` the seat you
// are playing, `mine` whether it is your move.
(function () {
  'use strict';
  const { h } = window.U;
  const Core = window.GameCore;

  const uis = {};
  let seen = new Set(), quiet = true;

  // Dealing animations should play once for a card that just appeared, not again at every update.
  // isNew('some-key') is true the first time a key is seen (never while the screen is first being drawn).
  function isNew(key) {
    if (seen.has(key)) return false;
    seen.add(key);
    return !quiet;
  }

  // ---- standard playing cards (integers 0..51; null = face down)
  function playingCard(c, opts = {}) {
    const cls = 'pk-card' + (opts.small ? ' small' : '') + (opts.className ? ' ' + opts.className : '');
    if (c == null) return h('div', { class: cls + ' back' });
    const suit = Core.suitOf(c), rank = Core.rankLabel(Core.rankOf(c)), glyph = Core.SUIT_GLYPH[suit];
    const red = suit === 'H' || suit === 'D';
    return h('div', { class: cls + (red ? ' red' : '') + (opts.key && isNew(opts.key) ? ' deal' : ''), title: Core.cardName(c) },
      h('span', { class: 'pk-corner' }, rank, h('br'), glyph),
      h('span', { class: 'pk-pip' }, glyph));
  }

  // ---- Uno cards: 'r5', 'bS', 'wF'... or null for the back
  const UNO_FACE = { S: '⊘', R: '⇄', D: '+2', W: '★', F: '+4' };
  function unoCard(c, opts = {}) {
    const cls = 'uno-card' + (opts.small ? ' small' : '') + (opts.className ? ' ' + opts.className : '');
    if (c == null) return h('div', { class: cls + ' back' }, h('span', {}, 'UNO'));
    const col = c[0], val = c.slice(1);
    const face = UNO_FACE[val] || val;
    return h('div', { class: `${cls} uc-${col}` + (opts.key && isNew(opts.key) ? ' deal' : ''), title: opts.title || '' },
      h('span', { class: 'uno-corner' }, face), h('span', { class: 'uno-face' }, face));
  }

  // ---- chips
  const chips = (n, cls = '') => h('span', { class: 'cg-chips ' + cls }, h('i', { class: 'cg-chip-dot' }), Number(n).toLocaleString('en-US'));

  window.GameUI = {
    register(id, ui) { uis[id] = ui; },
    get: (id) => uis[id],
    reset() { seen = new Set(); quiet = true; },        // a new game screen is being built
    endRender() { quiet = false; },                      // after the first draw, new cards animate
    rerenderPanel() {},                                  // replaced by the client: redraw the action panel now
    isNew, playingCard, unoCard, chips,
  };
})();
