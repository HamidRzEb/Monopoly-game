// Uno screen: opponents' card backs on top, the piles in the middle, your hand underneath.
(function () {
  'use strict';
  const { h } = window.U;
  const { unoCard } = window.GameUI;
  const UNO = window.GameModules.uno;

  let pendingWild = null; // index of a wild card waiting for its colour to be chosen
  const COLOR_ORDER = { r: 0, y: 1, g: 2, b: 3, w: 4 };

  const note = (text) => h('div', { class: 'status' }, text);

  function opponent(g, p, me) {
    const turn = g.phase === 'play' && g.current === p.id;
    const shown = Math.min(p.cards, 8);
    return h('div', { class: 'uno-opp' + (turn ? ' turn' : '') + (p.id === me ? ' me' : ''), style: `--c:${p.color}` },
      h('div', { class: 'bj-name' }, p.name, p.cards === 1 ? h('span', { class: 'uno-call' }, 'UNO!') : null),
      h('div', { class: 'uno-fan' }, Array.from({ length: shown }, () => unoCard(null, { small: true }))),
      h('div', { class: 'muted' }, `${p.cards} card${p.cards === 1 ? '' : 's'}`, g.rules.target ? ` · ${p.score} pts` : ''));
  }

  window.GameUI.register('uno', {
    roundLabel: (g) => (g.rules.target ? `Round ${g.round} · first to ${g.rules.target}` : ''),
    seatSummary: (g, p) => `${p.cards} card${p.cards === 1 ? '' : 's'}${g.rules.target ? ` · ${p.score} pts` : ''}`,
    standings: (g) => (g.rules.target
      ? [...g.players].sort((a, b) => b.score - a.score).map((p) => `${p.name}: ${p.score} points`)
      : [...g.players].sort((a, b) => (a.id === g.winner ? -1 : b.id === g.winner ? 1 : a.cards - b.cards)).map((p) => `${p.name}: ${p.id === g.winner ? 'went out first' : `${p.cards} cards left`}`)),

    renderTable(el, { g, me, mine, act }) {
      const myTurn = mine && g.phase === 'play';
      const canDraw = myTurn && g.drawn === null;
      const over = g.phase !== 'play' && g.hands;
      const pile = h('button', { class: 'uno-pile' + (canDraw ? ' can' : ''), disabled: !canDraw, title: canDraw ? 'Draw a card' : '', onclick: () => act('draw') },
        unoCard(null), h('span', { class: 'uno-count' }, `${g.drawLeft}`));
      const top = g.discard[g.discard.length - 1];
      el.replaceChildren(h('div', { class: 'felt uno-felt' },
        h('div', { class: 'uno-opps' }, g.players.filter((p) => p.id !== me).map((p) => opponent(g, p, me))),
        h('div', { class: 'uno-center' },
          pile,
          h('div', { class: `uno-discard ring-${g.color}` }, unoCard(top, { key: `uno-top-${g.discardCount}-${top}` })),
          h('div', { class: 'uno-dir', title: g.dir === 1 ? 'Clockwise' : 'Counter-clockwise' }, g.dir === 1 ? '↻' : '↺')),
        h('div', { class: 'uno-colorline' }, 'Colour: ', h('b', { class: `uno-colorname c-${g.color}` }, UNO.COLOR_NAME[g.color])),
        over ? h('div', { class: 'uno-over' },
          h('b', {}, `${g.players[g.roundWinner].name} won the round${g.rules.target ? ` and scored ${g.roundPoints}` : ''}.`),
          g.players.filter((p) => p.id !== g.roundWinner).map((p) => h('div', { class: 'uno-leftover' },
            h('span', { class: 'bj-name' }, p.name),
            h('span', { class: 'uno-fan' }, (g.hands[p.id] || []).map((c) => unoCard(c, { small: true }))))))
          : null));
    },

    panelKey: ({ g, me, mine }) => [g.phase, mine ? 1 : 0, (g.hands[me] || []).join(','), g.drawn, g.color, g.discard[g.discard.length - 1], pendingWild, g.ready.includes(me) ? 1 : 0].join('|'),

    renderPanel({ g, me, mine, act }) {
      const hand = g.hands[me] || [];
      const btn = (label, cls, fn, disabled) => h('button', { class: 'btn ' + cls, disabled, onclick: fn }, label);
      if (!mine || g.phase !== 'play') pendingWild = null;
      if (g.phase === 'result') {
        return [
          note(`${g.players[g.roundWinner].name} wins the round!`),
          g.ready.includes(me) ? h('div', { class: 'muted' }, 'Waiting for the others…') : h('div', { class: 'btn-row' }, btn('Next round', 'primary big pulse', () => act('continue'))),
          h('div', { class: 'uno-hand' }, hand.map((c) => unoCard(c))),
        ];
      }
      const order = hand.map((_, i) => i).sort((a, b) => (COLOR_ORDER[hand[a][0]] - COLOR_ORDER[hand[b][0]]) || hand[a].localeCompare(hand[b]));
      const nth = {}; // identical cards are told apart by how many came before, so only a card that really is new animates
      const cards = order.map((i) => {
        const ok = mine && g.canPlay(me, i);
        nth[hand[i]] = (nth[hand[i]] || 0) + 1;
        const el = unoCard(hand[i], { key: `uno-h-${me}-${hand[i]}#${nth[hand[i]]}`, title: mine && !ok ? (g.drawn !== null && i !== g.drawn ? 'You can only play the card you drew' : g.playError(me, hand[i]) || '') : '' });
        const wrap = h('button', { class: 'uno-hcard' + (ok ? ' playable' : '') + (mine && !ok ? ' dim' : '') + (g.drawn === i ? ' drawn' : ''), disabled: !ok, onclick: () => {
          if (UNO.isWild(hand[i])) { pendingWild = i; window.GameUI.rerenderPanel(); } else act('play', [i, 0]);
        } }, el);
        return wrap;
      });
      let status;
      if (!mine) status = note(`Waiting for ${g.players[g.current].name}…`);
      else if (pendingWild !== null) status = note('Choose the new colour:');
      else if (g.drawn !== null) status = note(`You drew ${UNO.cardLabel(hand[g.drawn])}. Play it, or keep it.`);
      else status = note(g.hands[me].some((_, i) => g.canPlay(me, i)) ? 'Your turn: play a card, or draw one.' : "You can't play: draw a card.");
      const colors = pendingWild === null ? null : h('div', { class: 'btn-row' },
        UNO.COLORS.map((c, ci) => h('button', { class: `btn uno-color uc-${c}`, onclick: () => { const i = pendingWild; pendingWild = null; act('play', [i, ci]); } }, UNO.COLOR_NAME[c])),
        btn('Cancel', 'ghost', () => { pendingWild = null; window.GameUI.rerenderPanel(); }));
      return [
        status,
        colors,
        mine && pendingWild === null ? h('div', { class: 'btn-row' },
          g.drawn === null ? btn('Draw a card', '', () => act('draw')) : btn('Keep it and pass', '', () => act('pass'))) : null,
        h('div', { class: 'uno-hand' }, cards),
      ];
    },
  });
})();
