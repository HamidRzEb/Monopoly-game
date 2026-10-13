// Blackjack screen: the dealer on top, everyone's hand on the felt, your actions underneath.
(function () {
  'use strict';
  const { h } = window.U;
  const { playingCard, chips } = window.GameUI;
  const BJ = window.GameModules.blackjack;

  let draft = 0; // the bet being typed (kept between redraws)

  const note = (text) => h('div', { class: 'status' }, text);
  const totalOf = (cards) => {
    const shown = cards.filter((c) => c != null);
    const { total, soft } = BJ.handValue(shown);
    return cards.length === shown.length ? `${soft && total <= 21 ? 'soft ' : ''}${total}` : `${total} + ?`;
  };
  const RESULT = {
    win: (d) => ['WIN', `+${d}`, 'win'], blackjack: (d) => ['BLACKJACK', `+${d}`, 'win'],
    push: () => ['PUSH', '', 'push'], lose: (d) => ['LOSE', `−${Math.abs(d)}`, 'lose'],
  };

  function seatBox(g, p, me) {
    const playing = g.phase === 'play' && g.current === p.id;
    let badge = null;
    if (p.result) { const [label, amount, kind] = RESULT[p.result](p.delta); badge = h('div', { class: 'bj-badge ' + kind }, label, amount ? ` ${amount}` : ''); }
    else if (p.status === 'bust') badge = h('div', { class: 'bj-badge lose' }, 'BUST');
    else if (p.status === 'blackjack') badge = h('div', { class: 'bj-badge win' }, 'BLACKJACK!');
    else if (p.status === 'stand') badge = h('div', { class: 'bj-badge push' }, p.doubled ? 'DOUBLED' : 'STANDS');
    return h('div', { class: 'bj-seat' + (playing ? ' active' : '') + (p.out ? ' out' : '') + (p.id === me ? ' me' : ''), style: `--c:${p.color}` },
      h('div', { class: 'bj-name' }, p.name, p.id === me ? h('span', { class: 'tag' }, 'you') : null),
      p.out ? h('div', { class: 'muted' }, 'out of chips') : [
        h('div', { class: 'bj-hand' }, p.hand.map((c, i) => playingCard(c, { key: `bj-${p.id}-${i}-${c}-${g.round}` }))),
        p.hand.length ? h('div', { class: 'bj-total' }, totalOf(p.hand)) : h('div', { class: 'bj-total muted' }, p.bet ? 'bet placed' : 'betting…'),
        h('div', { class: 'bj-bet' }, p.bet ? ['Bet ', chips(p.bet)] : null),
        badge],
      h('div', { class: 'bj-chips' }, chips(p.chips)));
  }

  window.GameUI.register('blackjack', {
    roundLabel: (g) => `Round ${Math.min(g.round, g.rules.rounds)}/${g.rules.rounds}`,
    seatSummary: (g, p) => (p.out ? 'Out of chips' : chips(p.chips)),
    standings: (g) => [...g.players].sort((a, b) => b.chips - a.chips).map((p) => `${p.name}: ${p.chips.toLocaleString('en-US')} chips${p.out ? ' (out)' : ''}`),

    renderTable(el, { g, me }) {
      const dealerCards = g.dealer;
      el.replaceChildren(h('div', { class: 'felt bj-felt' },
        h('div', { class: 'bj-dealer' },
          h('div', { class: 'bj-name' }, 'Dealer'),
          h('div', { class: 'bj-hand' }, dealerCards.length ? dealerCards.map((c, i) => playingCard(c, { key: `bj-d-${i}-${c}-${g.round}` })) : h('div', { class: 'muted' }, g.phase === 'bet' ? 'Waiting for bets' : '')),
          dealerCards.length ? h('div', { class: 'bj-total' }, totalOf(dealerCards)) : null),
        h('div', { class: 'bj-seats' }, g.players.map((p) => seatBox(g, p, me))),
        h('div', { class: 'felt-note' }, '4-deck shoe · blackjack pays 3 to 2 · dealer stands on 17')));
    },

    panelKey: ({ g, me, mine }) => {
      const p = g.players[me];
      return [g.phase, mine ? 1 : 0, p.bet ? 1 : 0, g.ready.includes(me) ? 1 : 0, p.hand.length, g.round, p.chips, g.current, p.status, p.out ? 1 : 0].join('|');
    },

    renderPanel({ g, me, mine, act }) {
      const p = g.players[me];
      const btn = (label, cls, fn, disabled, title) => h('button', { class: 'btn ' + cls, disabled, title, onclick: fn }, label);
      if (g.phase === 'bet') {
        if (p.out) return [note('You are out of chips. You can keep watching.')];
        if (p.bet) return [note('Bet placed. Waiting for the other players…')];
        const min = g.rules.minBet, max = g.maxBetFor(p);
        draft = Math.max(min, Math.min(max, draft || Math.min(max, 50)));
        const input = h('input', { class: 'input', type: 'number', min, max, step: 5, value: draft, oninput: (e) => { draft = Math.floor(Number(e.target.value)) || min; } });
        const quick = [...new Set([min, 25, 50, 100, 250, 500, max].filter((n) => n >= min && n <= max))];
        return [
          h('div', { class: 'status' }, `Place your bet (${min}–${max}). You have `, chips(p.chips), '.'),
          h('div', { class: 'btn-row' }, quick.map((n) => btn(String(n), 'small', () => { draft = n; input.value = n; }))),
          h('div', { class: 'btn-row' }, input, btn('Place bet', 'primary', () => act('bet', [Math.max(min, Math.min(max, draft))]))),
        ];
      }
      if (g.phase === 'play') {
        if (!mine) return [note(`Waiting for ${g.players[g.current].name}…`)];
        const { total } = BJ.handValue(p.hand);
        return [
          h('div', { class: 'status' }, `Your hand: ${totalOf(p.hand)}. Dealer shows ${totalOf([g.dealer[0]])}.`),
          h('div', { class: 'btn-row' },
            btn('Hit', 'primary big', () => act('hit')),
            btn('Stand', 'big', () => act('stand')),
            btn(`Double (${p.bet})`, '', () => act('double'), !g.canDouble(me), g.canDouble(me) ? 'Double your bet, take exactly one card' : 'Only on your first two cards, with enough chips')),
          total === 21 ? note('21! Stand.') : null,
        ];
      }
      if (g.phase === 'result') {
        const last = g.round >= g.rules.rounds;
        const line = p.out ? 'You are out of chips.' : p.result ? { win: `You win ${p.delta}!`, blackjack: `Blackjack! You win ${p.delta}!`, push: 'Push: your bet comes back.', lose: p.status === 'bust' ? 'Bust. You lose your bet.' : 'The dealer wins this one.' }[p.result] : '';
        return [
          note(line),
          g.ready.includes(me) || p.out
            ? h('div', { class: 'muted' }, 'Waiting for the others…')
            : h('div', { class: 'btn-row' }, btn(last ? 'See final results' : 'Next round', 'primary big pulse', () => act('continue'))),
        ];
      }
      return [];
    },
  });
})();
