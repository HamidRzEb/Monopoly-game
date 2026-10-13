// Texas Hold'em screen: the board and pot in the middle, every player's seat around it, your betting controls below.
(function () {
  'use strict';
  const { h } = window.U;
  const { playingCard, chips } = window.GameUI;

  let raiseTo = 0;       // the raise being set up (kept between redraws)
  let wasMyTurn = false;

  const note = (text) => h('div', { class: 'status' }, text);
  const STREET = { preflop: 'Pre-flop', flop: 'Flop', turn: 'Turn', river: 'River', showdown: 'Showdown' };

  // What each player won this hand (an even split of every pot they won).
  function winnings(g) {
    const won = {};
    if (g.result) for (const pot of g.result.pots) for (const id of pot.winners) won[id] = (won[id] || 0) + Math.floor(pot.amount / pot.winners.length);
    return won;
  }

  function seat(g, p, me, won) {
    const inResult = g.phase === 'result' || g.phase === 'gameover';
    const isButton = g.button === p.id;
    const toAct = g.phase === 'bet' && g.toAct === p.id;
    const winner = inResult && won[p.id] > 0;
    const showCards = p.hole.length > 0;
    const cards = showCards ? p.hole : (p.hasCards ? [null, null] : []);
    const status = p.out && !p.hasCards ? 'OUT' : p.folded ? 'FOLDED' : p.allIn ? 'ALL IN' : '';
    return h('div', { class: 'pk-seat' + (toAct ? ' active' : '') + (p.folded || (p.out && !p.hasCards) ? ' folded' : '') + (winner ? ' winner' : '') + (p.id === me ? ' me' : ''), style: `--c:${p.color}` },
      h('div', { class: 'bj-name' }, p.name, p.id === me ? h('span', { class: 'tag' }, 'you') : null, isButton && !(p.out && !p.hasCards) ? h('span', { class: 'pk-button', title: 'Dealer button' }, 'D') : null),
      h('div', { class: 'pk-hole' }, cards.map((c, i) => playingCard(c, { small: true, key: `pk-${g.handNo}-${p.id}-${i}-${c}` }))),
      h('div', { class: 'bj-chips' }, chips(p.chips)),
      p.bet ? h('div', { class: 'pk-bet' }, 'Bet ', chips(p.bet)) : null,
      status ? h('div', { class: 'bj-badge push' }, status) : null,
      inResult && g.result && g.result.hands[p.id] ? h('div', { class: 'pk-handname' }, g.result.hands[p.id]) : null,
      winner ? h('div', { class: 'bj-badge win' }, `WINS +${won[p.id]}`) : null);
  }

  window.GameUI.register('poker', {
    roundLabel: (g) => { const b = g.blinds(); return `Hand ${Math.min(g.handNo, g.rules.hands)}/${g.rules.hands} · blinds ${b.sb}/${b.bb}`; },
    seatSummary: (g, p) => (p.out ? 'Out of chips' : chips(p.chips)),
    standings: (g) => [...g.players].sort((a, b) => b.chips - a.chips).map((p) => `${p.name}: ${p.chips.toLocaleString('en-US')} chips${p.out ? ' (out)' : ''}`),

    renderTable(el, { g, me }) {
      const won = winnings(g);
      const slots = Array.from({ length: 5 }, (_, i) => (g.board[i] != null ? playingCard(g.board[i], { key: `pk-b-${g.handNo}-${i}-${g.board[i]}` }) : h('div', { class: 'pk-card empty' })));
      const result = g.result && (g.phase === 'result' || g.phase === 'gameover')
        ? g.result.pots.map((pot, i) => h('div', { class: 'pk-result' },
          `${pot.winners.map((id) => g.players[id].name).join(' & ')} ${pot.winners.length > 1 ? 'split' : 'wins'} ${pot.amount}`,
          pot.hand ? ` with ${pot.hand}` : ' (everyone else folded)', g.result.pots.length > 1 ? h('span', { class: 'muted' }, i === 0 ? ' · main pot' : ` · side pot ${i}`) : null))
        : null;
      el.replaceChildren(h('div', { class: 'felt pk-felt' },
        h('div', { class: 'pk-board' }, slots),
        h('div', { class: 'pk-pot' }, 'Pot ', chips(g.phase === 'bet' ? g.pot() : (g.result ? g.result.pots.reduce((s, x) => s + x.amount, 0) : 0)), h('span', { class: 'muted' }, `  ${STREET[g.street] || ''}`)),
        result ? h('div', { class: 'pk-results' }, result) : null,
        h('div', { class: 'pk-seats' }, g.players.map((p) => seat(g, p, me, won)))));
    },

    panelKey: ({ g, me, mine }) => {
      const p = g.players[me];
      return [g.phase, mine ? 1 : 0, g.street, g.currentBet, g.lastRaise, p.bet, p.chips, p.folded ? 1 : 0, g.ready.includes(me) ? 1 : 0, g.handNo, g.toAct, p.out ? 1 : 0].join('|');
    },

    renderPanel({ g, me, mine, act }) {
      const p = g.players[me];
      const btn = (label, cls, fn, disabled, title) => h('button', { class: 'btn ' + cls, disabled, title, onclick: fn }, label);
      if (g.phase === 'result') {
        return [
          note(g.result ? `Hand ${g.handNo} is over.` : ''),
          g.ready.includes(me) || p.out
            ? h('div', { class: 'muted' }, p.out ? 'You are out of chips. You can keep watching.' : 'Waiting for the others…')
            : h('div', { class: 'btn-row' }, btn(g.handNo >= g.rules.hands ? 'See final results' : 'Deal next hand', 'primary big pulse', () => act('continue'))),
        ];
      }
      if (g.phase !== 'bet') return [];
      if (!mine) wasMyTurn = false;
      if (p.out) return [note('You are out of chips. You can keep watching.')];
      if (p.folded) return [note(`You folded. Waiting for ${g.players[g.toAct].name}…`)];
      if (!mine) { return [note(p.allIn ? "You're all in. Let's see the cards…" : `Waiting for ${g.players[g.toAct].name}…`)]; }

      const l = g.legal(me);
      const pot = g.pot();
      if (!wasMyTurn || raiseTo < l.minRaiseTo || raiseTo > l.maxRaiseTo) raiseTo = l.minRaiseTo;
      wasMyTurn = true;
      const label = g.currentBet === 0 ? 'Bet' : 'Raise to';
      const raiseBtn = btn('', 'primary', () => act('raise', [raiseTo]));
      const input = h('input', { class: 'input', type: 'number', min: l.minRaiseTo, max: l.maxRaiseTo, value: raiseTo });
      const slider = h('input', { type: 'range', class: 'pk-slider', min: l.minRaiseTo, max: l.maxRaiseTo, step: 1, value: raiseTo });
      const set = (v) => { raiseTo = Math.max(l.minRaiseTo, Math.min(l.maxRaiseTo, Math.floor(Number(v)) || l.minRaiseTo)); input.value = raiseTo; slider.value = raiseTo; raiseBtn.textContent = raiseTo === l.maxRaiseTo ? `All in (${raiseTo})` : `${label} ${raiseTo}`; };
      input.addEventListener('change', () => set(input.value));
      slider.addEventListener('input', () => set(slider.value));
      set(raiseTo);
      const frac = (f) => g.currentBet + Math.round((pot + l.toCall) * f);
      const quick = [['Min', l.minRaiseTo], ['½ pot', frac(0.5)], ['Pot', frac(1)], ['All in', l.maxRaiseTo]];
      const toCallText = l.toCall >= p.chips ? `All in (${p.chips})` : `Call ${l.toCall}`;
      return [
        h('div', { class: 'status' }, 'Your turn. ', l.canCheck ? 'Nothing to call.' : `${l.toCall} to call.`, ` Pot ${pot}.`),
        h('div', { class: 'btn-row' },
          btn('Fold', 'danger', () => { if (!l.canCheck || confirm('You can check for free. Fold anyway?')) act('fold'); }),
          l.canCheck ? btn('Check', 'big primary', () => act('check')) : btn(toCallText, 'big primary', () => act('call'))),
        l.canRaise ? h('div', { class: 'pk-raise' },
          h('div', { class: 'btn-row' }, quick.map(([name, v]) => btn(name, 'small', () => set(v)))),
          h('div', { class: 'btn-row' }, slider),
          h('div', { class: 'btn-row' }, input, raiseBtn)) : null,
      ];
    },
  });
})();
