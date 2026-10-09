// The board: 40 tiles on an 11x11 CSS grid, tokens, buildings, dice and the drawn-card popup.
(function () {
  'use strict';
  const { SPACES, COLORS, TOKENS, THEME } = window.MonopolyData;
  const { h, money, icon, sleep } = window.U;

  // (dice faces: assets/dice/1..6.svg|png; plain digits if missing)
  const tokenInfo = (id) => TOKENS.find((t) => t.id === id) || TOKENS[0];
  const tokenIcon = (id, cls) => icon('assets/tokens/' + id, tokenInfo(id).name[0], cls);

  function gridPos(i) {
    if (i <= 10) return { row: 11, col: 11 - i };
    if (i <= 20) return { row: 21 - i, col: 1 };
    if (i <= 30) return { row: 1, col: i - 19 };
    return { row: i - 29, col: 11 };
  }
  function sideOf(i) {
    if (i % 10 === 0) return 'corner';
    return i < 10 ? 'bottom' : i < 20 ? 'left' : i < 30 ? 'top' : 'right';
  }

  let refs = [];
  let center = null;
  let cardTimer = null;

  function priceLabel(s) {
    if (s.type === 'tax') return money(s.amount);
    return s.price ? money(s.price) : '';
  }

  function build(root, onTile) {
    root.replaceChildren();
    refs = SPACES.map((s, i) => {
      const { row, col } = gridPos(i);
      const side = sideOf(i);
      const band = s.group ? h('div', { class: 'band', style: `background:${COLORS[s.group]}` }) : null;
      const tokens = h('div', { class: 'tokens' });
      const el = h('div', {
        class: `tile side-${side} type-${s.type}`, style: `grid-row:${row};grid-column:${col}`,
        title: s.name, onclick: () => onTile(i),
      },
      band,
      h('div', { class: 'tbody' },
        h('div', { class: 'tname' }, s.name),
        icon('assets/icons/' + s.id, '', 'ticon'),
        h('div', { class: 'tprice' }, priceLabel(s))),
      h('div', { class: 'mort-mark' }, icon('assets/icons/mortgaged', 'MORTGAGED', 'mort-img')),
      h('div', { class: 'owner-tag' }), // small coloured tag in the owner's colour (shown when owned)
      tokens);
      root.append(el);
      return { el, band, tokens };
    });

    const dice = [h('div', { class: 'die' }), h('div', { class: 'die' })];
    center = {
      dice,
      slot: h('div', { class: 'card-slot' }),
      banner: h('div', { class: 'banner-slot' }),
      ticker: h('div', { class: 'ticker' }),
    };
    root.append(h('div', { class: 'center' },
      h('div', { class: 'logo' }, icon('assets/logo', '', 'logo-img'), h('div', { class: 'logo-text' }, THEME.title)),
      h('div', { class: 'dice' }, dice),
      center.ticker,
      center.banner,
      center.slot));
    setDice(null);
  }

  function setDice(vals) {
    center.dice.forEach((d, k) => {
      d.replaceChildren();
      if (!vals) { d.classList.add('blank'); return; }
      d.classList.remove('blank');
      d.append(icon('assets/dice/' + vals[k], String(vals[k]), 'die-face'));
    });
  }

  // Both dice are thrown in from opposite corners, tumble, bounce and settle; faces flicker
  // quickly at first and slow down like real dice coming to rest.
  async function rollAnimation(final, scale = 1) {
    const reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (document.hidden || reduce || !center.dice[0].animate) { setDice(final); return; }
    const rnd = () => 1 + Math.floor(Math.random() * 6);
    const spin = [1, -1];
    const anims = center.dice.map((d, k) => {
      const s = k ? 1 : -1;
      d.classList.remove('blank');
      return d.animate([
        { transform: `translate(${s * -260}%, -230%) rotate(0deg) scale(.5)`, opacity: 0, offset: 0 },
        { transform: `translate(${s * -120}%, -60%) rotate(${spin[k] * 240}deg) scale(1.15)`, opacity: 1, offset: 0.25 },
        { transform: `translate(${s * 40}%, 18%) rotate(${spin[k] * 470}deg) scale(1.2)`, offset: 0.5 },
        { transform: `translate(${s * 16}%, -34%) rotate(${spin[k] * 600}deg) scale(1.1)`, offset: 0.7 },
        { transform: `translate(0, 8%) rotate(${spin[k] * 690}deg) scale(1)`, offset: 0.86 },
        { transform: `translate(0, -6%) rotate(${spin[k] * 715}deg) scale(1)`, offset: 0.94 },
        { transform: `translate(0, 0) rotate(${spin[k] * 720}deg) scale(1)`, offset: 1 },
      ], { duration: (1050 + k * 140) * scale, easing: 'ease-out' });
    });
    let delay = 45 * scale;
    const end = performance.now() + 900 * scale;
    while (performance.now() < end) {
      setDice([rnd(), rnd()]);
      await sleep(delay);
      delay += 16 * scale;
    }
    setDice(final);
    await Promise.all(anims.map((a) => a.finished.catch(() => {})));
  }

  function renderTokens(g, anim = {}, hopId = null) {
    refs.forEach((r) => r.tokens.replaceChildren());
    for (const p of g.players) {
      if (p.bankrupt) continue;
      const pos = anim[p.id] != null ? anim[p.id] : p.pos;
      const cls = 'token' + (p.id === g.current && g.phase !== 'gameover' ? ' active' : '') + (p.inJail && anim[p.id] == null ? ' injail' : '') + (p.id === hopId ? ' hop' : '');
      refs[pos].tokens.append(h('div', { class: cls, style: `--c:${p.color}`, title: p.name }, tokenIcon(p.token)));
    }
  }

  function render(g, anim = {}) {
    refs.forEach((r, i) => {
      const st = g.props[i];
      const owner = st && st.owner != null ? g.players[st.owner] : null;
      r.el.classList.toggle('owned', !!owner);
      r.el.classList.toggle('mortgaged', !!(st && st.mortgaged));
      if (owner) r.el.style.setProperty('--owner', owner.color); else r.el.style.removeProperty('--owner');
      const seen = r.prev !== undefined; // skip animations on the very first render
      if (seen && st && st.owner !== r.prev.owner && st.owner != null) pulse(r.el, 'claim', 900);
      if (r.band) {
        r.band.replaceChildren();
        const grown = seen && st.houses > r.prev.houses;
        if (st.houses === 5) r.band.append(icon('assets/icons/hotel', '', 'bld hotel' + (grown ? ' pop' : '')));
        else for (let k = 0; k < st.houses; k++) r.band.append(icon('assets/icons/house', '', 'bld house' + (grown && k === st.houses - 1 ? ' pop' : '')));
      }
      r.prev = { owner: st ? st.owner : null, houses: st ? st.houses : 0 };
    });
    renderTokens(g, anim);
    const last = g.log[g.log.length - 1];
    center.ticker.textContent = last ? last.text : '';
    if (g.lastDice && !center.dice[0].firstChild) setDice(g.lastDice);
    if (!g.lastDice) setDice(null);
  }

  // Uses assets/cards/<chance|chest>.png as the card face when present (text is laid over its
  // parchment area); otherwise falls back to a plain coloured card.
  function pulse(el, cls, ms) {
    el.classList.remove(cls);
    void el.offsetWidth; // restart the CSS animation
    el.classList.add(cls);
    setTimeout(() => el.classList.remove(cls), ms);
  }
  const flashTile = (i) => pulse(refs[i].el, 'landed', 1000);

  function showCard(card, who, ms = 4800) {
    clearTimeout(cardTimer);
    const label = card.deck === 'chance' ? 'Chance' : 'Community Chest';
    const el = h('div', { class: 'drawn-card ' + card.deck },
      icon('assets/cards/' + card.deck, '', 'dc-bg'),
      h('div', { class: 'dc-head' }, icon('assets/icons/' + (card.deck === 'chance' ? 'chance-card' : 'chest-card'), ''), label),
      h('div', { class: 'dc-body' },
        h('div', { class: 'dc-who' }, h('b', {}, who), h('span', {}, ' drew')),
        h('div', { class: 'dc-text' }, card.text)));
    const centerEl = center.slot.parentNode;
    const close = () => { el.remove(); centerEl.classList.remove('card-open'); };
    el.onclick = close;
    center.slot.replaceChildren(el);
    centerEl.classList.add('card-open'); // hides the status line behind the card
    cardTimer = setTimeout(close, ms);
  }

  // A short "Ada's turn" banner in the middle of the board whenever the turn passes on.
  let bannerTimer = null;
  function showTurn(player, ms = 1700) {
    clearTimeout(bannerTimer);
    const el = h('div', { class: 'turn-banner', style: `--c:${player.color}` }, tokenIcon(player.token), h('span', {}, `${player.name}'s turn`));
    center.banner.replaceChildren(el);
    bannerTimer = setTimeout(() => el.remove(), ms);
  }

  window.Board = { build, render, renderTokens, rollAnimation, setDice, showCard, showTurn, flashTile, tokenIcon, tokenInfo };
})();
