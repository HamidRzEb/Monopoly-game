// Browser client: home -> lobby -> game. Holds no game logic; it renders server snapshots
// and sends the player's intents to the server.
(function () {
  'use strict';
  const { SPACES, COLORS, TOKENS, THEME, SPEEDS } = window.MonopolyData;
  const { Game } = window.MonopolyEngine;
  const { h, money, icon, openModal, closeModal, refreshModal, redrawModal, modalKind, toast, sleep } = window.U;
  const app = document.getElementById('app');
  const $ = (sel) => document.querySelector(sel);

  const S = {
    room: null, key: null, view: null, game: null, es: null,
    layoutBuilt: false, seenRoll: null, seenCard: null, anim: {},
    syncing: false, dirty: false, inflight: false, draft: null, shownOver: false,
  };

  // ------------------------------------------------------------------ network
  async function post(path, body) {
    const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    let j = {};
    try { j = await r.json(); } catch { /* non-JSON error */ }
    if (!r.ok) throw new Error(j.error || 'Request failed.');
    return j;
  }
  const lobby = (op, extra = {}) =>
    post('/api/lobby', { room: S.room, key: S.key, op, ...extra }).catch((e) => toast(e.message));

  async function act(action, args = [], extra = {}) {
    if (S.inflight) return false;
    S.inflight = true;
    try { await post('/api/action', { room: S.room, key: S.key, as: S.view ? S.view.you : undefined, action, args, ...extra }); return true; }
    catch (e) { toast(e.message); return false; }
    finally { S.inflight = false; }
  }

  // Who you are in a game is a secret key. It is kept for this tab (sessionStorage) AND for the whole browser
  // (localStorage, up to 24h), so closing a tab or restarting the browser doesn't lose your seat.
  const SESSIONS_KEY = 'tycoon.sessions', SESSION_TTL = 24 * 60 * 60 * 1000;
  const loadSessions = () => {
    try {
      const all = JSON.parse(localStorage.getItem(SESSIONS_KEY) || '{}');
      for (const k of Object.keys(all)) if (Date.now() - all[k].ts > SESSION_TTL) delete all[k];
      return all;
    } catch { return {}; }
  };
  const storeSessions = (all) => { try { localStorage.setItem(SESSIONS_KEY, JSON.stringify(all)); } catch { /* private mode */ } };
  const saveSession = () => {
    try { sessionStorage.setItem('tycoon.session', JSON.stringify({ room: S.room, key: S.key })); } catch { /* private mode */ }
    const all = loadSessions();
    all[S.room] = { key: S.key, ts: Date.now() };
    storeSessions(all);
  };
  const clearSession = (code) => {
    try { sessionStorage.removeItem('tycoon.session'); } catch { /* ignore */ }
    const all = loadSessions();
    delete all[code];
    storeSessions(all);
  };
  const readSession = () => { try { return JSON.parse(sessionStorage.getItem('tycoon.session')); } catch { return null; } };
  async function getJson(path) {
    const r = await fetch(path);
    let j = {};
    try { j = await r.json(); } catch { /* non-JSON error */ }
    if (!r.ok) throw new Error(j.error || 'Request failed.');
    return j;
  }
  const savedName = () => { try { return localStorage.getItem('tycoon.name') || ''; } catch { return ''; } };
  const saveName = (n) => { try { localStorage.setItem('tycoon.name', n); } catch { /* ignore */ } };

  function setConn(state) {
    let el = $('#conn');
    if (state === 'ok') { if (el) el.remove(); return; }
    if (!el) { el = h('div', { id: 'conn' }, 'Reconnecting…'); document.body.append(el); }
  }

  function connect() {
    disconnect();
    const es = new EventSource(`/api/events?room=${encodeURIComponent(S.room)}&key=${encodeURIComponent(S.key)}`);
    S.es = es;
    es.addEventListener('state', (e) => { if (S.es !== es) return; setConn('ok'); onState(JSON.parse(e.data)); });
    es.addEventListener('toast', (e) => toast(JSON.parse(e.data).text));
    es.addEventListener('kicked', () => { if (S.es === es) leaveLocal('Your seat was taken over from another device, or you were removed. Enter your name and press Join to take it back.', true); });
    es.onerror = () => {
      if (S.es !== es) return;
      if (es.readyState === EventSource.CLOSED) leaveLocal('You were disconnected. Enter your name and press Join to take your seat back.', true);
      else setConn('retry');
    };
  }
  function disconnect() {
    if (S.es) { const es = S.es; S.es = null; es.close(); }
    setConn('ok');
  }
  function leaveLocal(message, keepRoom) {
    disconnect();
    const code = S.room;
    if (code) clearSession(code);
    S.room = S.key = S.view = S.game = null;
    S.layoutBuilt = false; S.seenRoll = S.seenCard = null; S.shownOver = false;
    S.prevCash = {}; S.prevJail = {}; S.prevOwners = null;
    closeModal();
    // keepRoom: stay on /?room=CODE so the home screen is pre-filled and the person can rejoin
    history.replaceState(null, '', keepRoom && code ? `?room=${code}` : location.pathname);
    document.title = THEME.title;
    renderHome(keepRoom && code ? code : '');
    if (message) toast(message, 7000);
  }
  async function leave() {
    if (!confirm('Leave this room?' + (S.view && S.view.status === 'playing' ? ' A bot will take your place.' : ''))) return;
    try { await post('/api/leave', { room: S.room, key: S.key }); } catch { /* already gone */ }
    leaveLocal();
  }

  function copyInvite() {
    const url = `${location.origin}/?room=${S.room}`;
    const done = () => toast('Invite link copied!');
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(done, () => prompt('Copy this link:', url));
    else prompt('Copy this link:', url);
  }

  // ------------------------------------------------------------------ home
  function renderHome(prefillCode = '') {
    if (!prefillCode) prefillCode = (new URLSearchParams(location.search).get('room') || '').toUpperCase();
    const name = h('input', { class: 'input', maxlength: 16, placeholder: 'Your name', value: savedName() });
    const code = h('input', { class: 'input code-input', maxlength: 4, placeholder: 'ABCD', value: prefillCode });
    const getName = () => {
      const n = name.value.trim();
      if (!n) { toast('Enter your name first.'); name.focus(); return null; }
      saveName(n);
      return n;
    };
    const enter = (r) => {
      S.room = r.room; S.key = r.key; saveSession();
      history.replaceState(null, '', `?room=${r.room}`);
      connect();
    };
    const create = async () => { const n = getName(); if (n) try { enter(await post('/api/create', { name: n })); } catch (e) { toast(e.message); } };
    const join = async () => {
      const n = getName(); if (!n) return;
      const c = code.value.trim().toUpperCase();
      if (c.length !== 4) return toast('Room codes have 4 letters.');
      try {
        const info = await getJson(`/api/room?room=${c}`);
        if (info.status === 'playing') return rejoinDialog(c, n, info, enter, join); // started: take back a free seat
        enter(await post('/api/join', { room: c, name: n }));
      } catch (e) { toast(e.message); }
    };
    const myGames = h('div', { class: 'my-games' });
    showMyGames(myGames, enter);
    code.addEventListener('input', () => { code.value = code.value.toUpperCase().replace(/[^A-Z]/g, ''); });
    app.replaceChildren(h('div', { class: 'screen' }, h('div', { class: 'card home' },
      icon('assets/logo', '', 'home-logo'),
      h('h1', { class: 'home-title' }, THEME.title),
      h('p', { class: 'muted' }, 'Buy, trade and bankrupt your friends. Add bots to fill the table.'),
      myGames,
      name,
      h('button', { class: 'btn primary big', onclick: create }, 'Create online room'),
      h('button', { class: 'btn big', onclick: () => localSetup(name.value.trim()) }, 'Local co-op (same device)'),
      h('p', { class: 'muted small-note' }, 'Local co-op: everyone plays on this screen, taking turns. You can still add bots, or friends online.'),
      h('div', { class: 'or' }, 'or join an online room'),
      h('div', { class: 'row' }, code, h('button', { class: 'btn big', onclick: join }, 'Join')))));
    name.focus();
  }

  // "Your games": games this browser is still part of. Each is checked with the server first, so only
  // ones that still work are offered.
  async function showMyGames(box, enter) {
    const all = loadSessions();
    for (const [code, sess] of Object.entries(all)) {
      let info;
      try { info = await getJson(`/api/room?room=${code}&key=${encodeURIComponent(sess.key)}`); } catch { clearSession(code); continue; }
      if (!info.valid) { const rest = loadSessions(); delete rest[code]; storeSessions(rest); continue; }
      const mine = info.status === 'playing' ? 'game in progress' : 'waiting in the lobby';
      box.append(h('div', { class: 'my-game' },
        h('div', {}, h('b', {}, `Room ${code}`), h('span', { class: 'muted' }, ` · ${mine} · ${info.seats.length} players`)),
        h('button', { class: 'btn primary', onclick: () => enter({ room: code, key: sess.key }) }, 'Rejoin')));
    }
    if (box.children.length) box.prepend(h('div', { class: 'muted small-note' }, 'Your games'));
  }

  // The game has already started: the only way in is to take back a seat that is free (its player is
  // disconnected, or a bot took over).
  function rejoinDialog(code, typedName, info, enter, retry) {
    const free = info.seats.filter((s) => s.reclaimable);
    const claim = async (seat) => {
      try {
        const r = await post('/api/join', { room: code, name: seat.name, seat: seat.index });
        closeModal();
        enter(r);
      } catch (e) { toast(e.message); }
    };
    openModal(() => h('div', { class: 'rejoin' },
      h('h2', {}, `Room ${code} has already started`),
      free.length
        ? [h('p', { class: 'muted' }, 'Were you playing? Choose your seat to take it back:'),
          h('div', { class: 'rejoin-list' }, free.map((s) => h('button', { class: 'rejoin-seat' + (s.name.toLowerCase() === typedName.toLowerCase() ? ' match' : ''), onclick: () => claim(s) },
            Board.tokenIcon(s.token), h('span', { class: 'rs-name' }, s.name), h('small', {}, s.bot ? 'a bot is playing for them' : 'disconnected'))))]
        : h('p', {}, 'Every player in this game is connected right now, so there is no free seat. If you were playing and got disconnected, give it a few seconds and press Refresh.'),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn', onclick: () => { closeModal(); retry(); } }, 'Refresh'),
        h('button', { class: 'btn ghost', onclick: closeModal }, 'Cancel'))),
    { kind: 'rejoin', live: false });
  }

  // Local co-op: a few people share this screen. Names are collected here, then it's the normal lobby
  // (where bots and online friends can still be added).
  function localSetup(firstName) {
    const names = [firstName || savedName() || 'Player 1', 'Player 2'];
    openModal(() => h('div', { class: 'local-setup' },
      h('h2', {}, 'Local co-op'),
      h('p', { class: 'muted' }, 'Everyone plays on this device and takes turns. Who is playing?'),
      names.map((n, k) => h('div', { class: 'row' },
        h('input', { class: 'input', maxlength: 16, value: n, placeholder: `Player ${k + 1}`, oninput: (e) => { names[k] = e.target.value; } }),
        names.length > 2 ? h('button', { class: 'btn small ghost', onclick: () => { names.splice(k, 1); redrawModal(); } }, 'Remove') : null)),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn', disabled: names.length >= 8, onclick: () => { names.push(`Player ${names.length + 1}`); redrawModal(); } }, '+ Add player'),
        h('button', { class: 'btn primary', onclick: async () => {
          const list = names.map((n, k) => n.trim() || `Player ${k + 1}`);
          saveName(list[0]);
          try {
            const r = await post('/api/create', { name: list[0], locals: list.slice(1) });
            closeModal();
            S.room = r.room; S.key = r.key; saveSession();
            history.replaceState(null, '', `?room=${r.room}`);
            connect();
          } catch (e) { toast(e.message); }
        } }, 'Create room'),
        h('button', { class: 'btn ghost', onclick: closeModal }, 'Cancel'))),
    { kind: 'local', live: false });
  }

  // ------------------------------------------------------------------ lobby
  function renderLobby() {
    if (document.activeElement && document.activeElement.classList.contains('name-input')) return; // don't steal focus while typing
    const v = S.view, isHost = v.isHost;
    const localCount = v.seats.filter((s) => s.mine).length;
    document.title = THEME.title;
    // Every seat on this browser (me, plus local co-op players) can be renamed and given a token.
    const rows = v.seats.map((s, i) => h('li', { class: 'seat' + (s.mine ? ' me' : '') },
      s.mine
        ? h('button', { class: 'token-btn', title: 'Change token', onclick: () => pickToken(i) }, Board.tokenIcon(s.token))
        : h('span', { class: 'token-btn static' }, Board.tokenIcon(s.token)),
      s.mine
        ? h('input', { class: 'input name-input', maxlength: 16, value: s.name, onchange: (e) => { if (i === v.you) saveName(e.target.value); lobby('setName', { name: e.target.value, as: i }); } })
        : h('span', { class: 'seat-name' }, s.name),
      i === v.host ? h('span', { class: 'badge' }, icon('assets/icons/crown', '', 'badge-icon crown'), 'Host') : null,
      s.mine && localCount > 1 ? h('span', { class: 'badge' }, 'Local') : null,
      s.type === 'bot' ? h('span', { class: 'badge bot' }, icon('assets/icons/bot', '', 'badge-icon bot'), 'Bot') : null,
      s.type === 'human' && !s.connected ? h('span', { class: 'badge warn' }, 'offline') : null,
      isHost && i !== v.host ? h('button', { class: 'btn small ghost', onclick: () => lobby('removeSeat', { index: i }) }, 'Remove') : null));
    const full = v.seats.length >= v.maxPlayers;
    app.replaceChildren(h('div', { class: 'screen' }, h('div', { class: 'card lobby' },
      h('h1', {}, THEME.title),
      h('div', { class: 'code-row' },
        h('div', { class: 'code' }, v.code),
        h('button', { class: 'btn', onclick: copyInvite }, 'Copy invite link')),
      h('p', { class: 'muted' }, localCount > 1
        ? 'Local co-op: the people marked Local share this screen. You can also add bots or invite friends online with the code.'
        : 'Friends can join with this code or link. The host can add bots to fill the table.'),
      h('ul', { class: 'seats' }, rows),
      h('div', { class: 'length-row' }, h('span', {}, 'Game length'),
        isHost
          ? h('select', { class: 'input', onchange: (e) => lobby('setLength', { maxRounds: Number(e.target.value) }) },
            v.roundOptions.map((n) => h('option', { value: n, selected: n === v.settings.maxRounds }, `${lengthName(n)} (${n} rounds)`)))
          : h('b', {}, `${lengthName(v.settings.maxRounds)} (${v.settings.maxRounds} rounds)`),
        h('span', { class: 'muted' }, 'When time runs out, the richest player wins.')),
      h('div', { class: 'length-row' }, h('span', {}, 'Game speed'),
        isHost ? speedSelect() : h('b', {}, SPEEDS[v.settings.speed].label),
        h('span', { class: 'muted' }, 'How fast bots play and animations run. The host can change it during the game too.')),
      isHost
        ? h('div', { class: 'row' },
          h('button', { class: 'btn', disabled: full, onclick: () => lobby('addBot') }, '+ Add bot'),
          h('button', { class: 'btn', disabled: full, onclick: () => lobby('addLocal') }, '+ Add local player'),
          h('button', { class: 'btn primary', disabled: v.seats.length < 2, onclick: () => lobby('start') }, 'Start game'))
        : h('p', { class: 'muted center-text' }, 'Waiting for the host to start…'),
      h('button', { class: 'link', onclick: leave }, 'Leave room'))));
  }

  const lengthName = (n) => (n <= 60 ? 'Quick' : n <= 120 ? 'Standard' : 'Long');

  function pickToken(seatIdx) {
    const taken = new Set(S.view.seats.map((s, i) => (i === seatIdx ? null : s.token)));
    openModal(() => h('div', {},
      h('h2', {}, `Choose a token for ${S.view.seats[seatIdx].name}`),
      h('div', { class: 'token-grid' }, TOKENS.map((t) => h('button', {
        class: 'token-opt', disabled: taken.has(t.id), title: t.name,
        onclick: () => { lobby('setToken', { token: t.id, as: seatIdx }); closeModal(); },
      }, Board.tokenIcon(t.id), h('span', {}, t.name)))),
      h('button', { class: 'btn', onclick: closeModal }, 'Cancel')), { kind: 'token' });
  }

  // ------------------------------------------------------------------ state sync
  const pageBuild = (document.querySelector('meta[name=build]') || {}).content;
  function checkBuild(view) {
    if (!pageBuild || !view.build || view.build === pageBuild || document.getElementById('update-banner')) return;
    document.body.append(h('div', { id: 'update-banner' }, 'A new version of the game is available. ',
      h('button', { class: 'btn small primary', onclick: () => location.reload() }, 'Reload now')));
  }

  function onState(view) {
    S.view = view;
    checkBuild(view);
    if (view.status === 'lobby') {
      S.game = null; S.layoutBuilt = false; S.seenRoll = S.seenCard = null; S.shownOver = false;
      S.sawLobby = true;
      if (['manage', 'trade', 'incoming', 'player', 'deed', 'gameover'].includes(modalKind())) closeModal();
      renderLobby();
      return;
    }
    S.game = Game.fromSnapshot(view.game);
    if (!S.layoutBuilt) {
      if (modalKind() === 'token') closeModal();
      buildGameLayout();
      S.seenRoll = S.game.rollSeq; S.seenCard = S.game.cardSeq; // joining mid-game: don't replay old events
      if (S.sawLobby) { S.sawLobby = false; Sfx.play('start'); } // the game just started while we were in the lobby
    }
    syncGame();
  }

  async function syncGame() {
    if (S.syncing) { S.dirty = true; return; }
    S.syncing = true;
    try {
      do {
        S.dirty = false;
        const g = S.game;
        if (g.rollSeq !== S.seenRoll) {
          S.seenRoll = g.rollSeq;
          await animateRoll(g.lastRoll);
        }
        if (S.game.cardSeq !== S.seenCard) {
          S.seenCard = S.game.cardSeq;
          const c = S.game.lastCard;
          if (c) { Sfx.play('card', { deck: c.deck }); Board.showCard(c, S.game.players[c.player].name, 4800 * animScale()); }
        }
        renderGame();
      } while (S.dirty);
    } finally { S.syncing = false; }
  }

  // Dice / walking / card timings follow the room's game speed (Relaxed / Normal / Fast).
  const animScale = () => (SPEEDS[(S.view && S.view.settings && S.view.settings.speed)] || SPEEDS.normal).anim;

  async function animateRoll(res) {
    if (!res) return;
    Sfx.play('dice');
    const scale = animScale();
    await Board.rollAnimation(res.dice, scale);
    if (res.steps > 0 && !document.hidden) {
      for (let k = 1; k <= res.steps; k++) {
        S.anim[res.player] = (res.from + k) % 40;
        Board.renderTokens(S.game, S.anim, res.player);
        await sleep(110 * scale);
      }
    }
    delete S.anim[res.player];
    if (res.steps > 0) Board.flashTile(res.to);
  }

  // ------------------------------------------------------------------ game screen
  function buildGameLayout() {
    app.replaceChildren(h('div', { class: 'game' },
      h('div', { class: 'board-wrap' }, h('div', { class: 'board', id: 'board' })),
      h('aside', { class: 'side' },
        h('div', { class: 'topbar' },
          h('span', { class: 'room-tag' }, 'Room ', h('b', {}, S.view.code), h('span', { id: 'round', class: 'round-tag' })),
          h('span', { id: 'speedbox' }),
          h('button', { class: 'btn small', onclick: copyInvite }, 'Invite'),
          h('button', { class: 'btn small ghost', onclick: leave }, 'Leave')),
        h('div', { id: 'players', class: 'players' }),
        h('div', { id: 'panel', class: 'panel' }),
        h('div', { id: 'log', class: 'log' })),
      h('aside', { id: 'deeds', class: 'deeds' },
        h('div', { class: 'deeds-head' }, h('h2', {}, 'My properties'), h('button', { class: 'btn small ghost deeds-close', onclick: () => $('#deeds').classList.remove('open') }, 'Close'), h('div', { id: 'deeds-sub', class: 'muted' })),
        h('div', { id: 'deedlist', class: 'deedlist' })),
      h('button', { id: 'deeds-toggle', class: 'btn deeds-toggle', onclick: () => $('#deeds').classList.toggle('open') }, 'My properties')));
    Board.build($('#board'), showDeed);
    S.layoutBuilt = true;
    S.shownOver = false;
    S.prevCash = {}; S.prevJail = {}; S.prevOwners = null; S.shownDeeds = null; S.lastYou = undefined;
    S.turnEnd = {}; S.lastCurrent = undefined; S.recapTurn = -1; S.recapOpen = false; S.recap = []; S.speedShown = null;
  }

  function renderGame() {
    const g = S.game;
    Board.render(g, S.anim);
    trackTurns(g);
    renderSpeed();
    renderPlayers();
    renderRound();
    renderPanel();
    renderDeeds();
    renderLog();
    const t = S.view.trade, me = S.view.you;
    if (S.view.seats.filter((x) => x.mine).length > 1 && g.phase !== 'gameover') { // local co-op: say who to hand the screen to
      if (S.lastYou !== undefined && S.lastYou !== me) toast(`${g.players[me].name}, it's your move`);
      S.lastYou = me;
    }
    if (t && t.to === me) { if (modalKind() !== 'incoming' && S.countering !== t.id) incomingTradeModal(t); }
    else if (modalKind() === 'incoming') closeModal();
    else if (S.countering && !(t && t.id === S.countering)) { // the offer was withdrawn or expired while composing
      S.countering = null;
      if (modalKind() === 'trade') { S.counterSent = true; closeModal(); toast('That offer is no longer open.'); }
    }
    if (g.phase === 'gameover' && !S.shownOver) { S.shownOver = true; Sfx.play('win'); gameOverModal(); }
    refreshModal();
  }

  // Players kept getting lost, so: announce whose turn it is, and remember where each player's last turn
  // ended so they can be shown what happened while they were away.
  function trackTurns(g) {
    const me = S.view.you;
    if (S.lastCurrent !== undefined && S.lastCurrent !== g.current && g.phase !== 'gameover') {
      S.turnEnd[S.lastCurrent] = g.logSeq;
      Board.showTurn(g.players[g.current], 1700 * animScale());
    }
    S.lastCurrent = g.current;
    if (S.turnEnd[me] === undefined && g.current !== me) S.turnEnd[me] = g.logSeq; // joined mid-game: nothing to recap yet
    if (g.phase === 'roll' && g.decider().id === me && S.turnEnd[me] !== undefined && S.recapTurn !== g.turnCount) {
      S.recapTurn = g.turnCount;
      S.recap = g.log.filter((l) => l.id > S.turnEnd[me]).slice(-12);
      S.recapOpen = S.recap.length > 0;
    } else if (!(g.phase === 'roll' && g.decider().id === me)) S.recapOpen = false;
  }

  function recapCard(g, me) {
    const name = g.players[me].name;
    return h('div', { class: 'recap' },
      h('div', { class: 'recap-head' }, h('b', {}, 'While you were away'),
        h('button', { class: 'btn small ghost', onclick: () => { S.recapOpen = false; renderPanel(); } }, 'Got it')),
      S.recap.map((l) => h('div', { class: 'recap-line' + (l.pid === me || l.text.includes(name) ? ' mine' : '') },
        l.pid != null && g.players[l.pid] ? h('i', { class: 'dot', style: `background:${g.players[l.pid].color}` }) : null, l.text)));
  }

  // Host-only game speed selector (also available mid-game).
  function speedSelect(prefix) {
    const cur = S.view.settings.speed;
    return h('select', { class: 'input speed-select', title: 'How fast bots play and animations run', onchange: (e) => lobby('setSpeed', { speed: e.target.value }) },
      Object.entries(SPEEDS).map(([k, s]) => h('option', { value: k, selected: k === cur }, (prefix || '') + s.label)));
  }
  function renderSpeed() {
    const box = $('#speedbox');
    if (!box) return;
    const key = `${S.view.isHost}:${S.view.settings.speed}`;
    if (S.speedShown === key) return; // don't rebuild (and close) the dropdown on every update
    S.speedShown = key;
    box.replaceChildren(S.view.isHost ? speedSelect('Speed: ') : h('span', { class: 'muted small-note' }, SPEEDS[S.view.settings.speed].label));
  }

  function renderRound() {
    const el = $('#round'), g = S.game;
    if (!el) return;
    const left = g.rules.maxRounds - g.round;
    el.textContent = g.phase === 'gameover' ? '' : ` · Round ${Math.min(g.round, g.rules.maxRounds)}/${g.rules.maxRounds}`;
    el.classList.toggle('hurry', left < 10 && g.phase !== 'gameover');
    el.title = left < 10 ? 'Almost out of time: the richest player wins when the last round ends.' : 'The richest player wins when the last round ends.';
  }

  function renderPlayers() {
    const g = S.game, v = S.view, el = $('#players');
    const isHost = v.isHost;
    const localCount = v.seats.filter((x) => x.mine).length;
    const prev = S.prevCash || (S.prevCash = {});
    const prevJail = S.prevJail || (S.prevJail = {});
    let myDelta = 0, otherDelta = 0, jailed = false;
    const flows = []; // [{ pid, delta }] for flying bills
    const owners = {};
    for (const i of Object.keys(g.props)) owners[i] = g.props[i].owner;
    let bought = null;
    if (S.prevOwners) for (const i of Object.keys(owners)) if (S.prevOwners[i] === null && owners[i] !== null) bought = { idx: Number(i), by: owners[i] };
    S.prevOwners = owners;
    el.classList.toggle('two-col', g.players.length > 4);
    el.replaceChildren(...g.players.map((p) => {
      const delta = prev[p.id] === undefined ? 0 : p.cash - prev[p.id];
      prev[p.id] = p.cash;
      if (prevJail[p.id] === false && p.inJail) jailed = true;
      prevJail[p.id] = p.inJail;
      if (delta) flows.push({ pid: p.id, delta });
      if (p.id === v.you) myDelta = delta; else if (Math.abs(delta) > Math.abs(otherDelta)) otherDelta = delta;
      const cashEl = h('span', { class: 'pmoney' }, p.bankrupt ? 'Bankrupt' : money(p.cash - delta));
      if (delta && !p.bankrupt) countTo(cashEl, p.cash - delta, p.cash);
      else if (!p.bankrupt) cashEl.textContent = money(p.cash);
      const seat = v.seats[p.id] || {};
      const pips = g.ownedBy(p.id).map((i) => {
        const s = SPACES[i];
        const bg = s.group ? COLORS[s.group] : s.type === 'railroad' ? '#555' : '#bbb';
        return h('i', { class: 'pip' + (g.props[i].mortgaged ? ' mort' : ''), style: `background:${bg}`, title: s.name });
      });
      return h('div', { 'data-pid': p.id, class: `pcard${p.id === g.current && g.phase !== 'gameover' ? ' current' : ''}${p.bankrupt ? ' bankrupt' : ''}`, style: `--c:${p.color}`, onclick: () => showPlayer(p.id) },
        h('div', { class: 'ptoken' }, Board.tokenIcon(p.token)),
        h('div', { class: 'pinfo' },
          h('div', { class: 'pname' }, p.name,
            p.id === v.you ? h('span', { class: 'tag' }, localCount > 1 ? 'playing' : 'you') : (seat.mine && localCount > 1 ? h('span', { class: 'tag' }, 'local') : null),
            seat.type === 'bot' ? h('span', { class: 'tag' }, icon('assets/icons/bot', '', 'tag-icon bot'), 'Bot') : null,
            seat.type === 'human' && !seat.connected && !p.bankrupt ? h('span', { class: 'tag warn' }, seat.botControlled ? 'bot-controlled' : 'offline') : null,
            p.inJail ? h('span', { class: 'tag' }, icon('assets/icons/jail', '', 'tag-icon'), 'Jail') : null,
            p.jailCards ? h('span', { class: 'tag' }, icon('assets/icons/jail-card', '', 'tag-icon'), `×${p.jailCards}`) : null,
            g.debtOf(p.id) ? h('span', { class: 'tag warn', title: 'Owed to the bank' }, `Owes ${money(g.debtOf(p.id))}`) : null),
          h('div', { class: 'prow' }, h('span', { class: 'cash' + (delta ? ' bump' : '') }, p.bankrupt ? null : icon('assets/icons/money', '', 'cash-icon'), cashEl), h('div', { class: 'pips' }, pips))),
        delta ? h('span', { class: 'float ' + (delta > 0 ? 'up' : 'down') }, (delta > 0 ? '+' : '−') + money(Math.abs(delta))) : null,
        isHost && seat.type === 'human' && !seat.mine && !p.bankrupt && !seat.connected
          ? h('button', { class: 'btn small', onclick: (e) => { e.stopPropagation(); lobby('toBot', { index: p.id }); } }, 'Make bot')
          : null);
    }));
    // Sound: my own money at full volume, someone else's more quietly; jail slam for anyone.
    if (jailed) Sfx.play('jail');
    if (bought) Sfx.play('buy', { volume: bought.by === v.you ? 1 : 0.5 });
    // (a purchase already has its own sound, so skip the generic "pay" clink for it)
    const skipOut = !!bought;
    if (myDelta && !(skipOut && myDelta < 0)) Sfx.play(myDelta > 0 ? 'cash-in' : 'cash-out', { big: Math.abs(myDelta) >= 200 });
    else if (!myDelta && otherDelta && !(skipOut && otherDelta < 0)) Sfx.play(otherDelta > 0 ? 'cash-in' : 'cash-out', { volume: 0.4, big: Math.abs(otherDelta) >= 200 });
    requestAnimationFrame(() => flyMoney(g, flows));
  }

  // ---- money animation
  const reducedMotion = () => window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Number rolls from the old to the new amount.
  function countTo(el, from, to, ms = 800) {
    if (document.hidden || reducedMotion()) { el.textContent = money(to); return; }
    const t0 = performance.now();
    const tick = (now) => {
      const k = Math.min(1, (now - t0) / ms);
      const eased = 1 - Math.pow(1 - k, 3);
      el.textContent = money(Math.round(from + (to - from) * eased));
      if (k < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  const centerOf = (el) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };

  // Bills fly from whoever paid to whoever received. Payments to the bank (tax, buying) fly to
  // the board square; money from the bank (salary) flies in from the middle of the board.
  function flyMoney(g, flows) {
    if (!flows.length || document.hidden || reducedMotion() || !Element.prototype.animate) return;
    const card = (pid) => document.querySelector(`.pcard[data-pid="${pid}"]`);
    const board = document.getElementById('board');
    if (!board) return;
    const losers = flows.filter((f) => f.delta < 0), winners = flows.filter((f) => f.delta > 0);
    const spawn = (from, to, amount) => flyBills(from, to, amount);
    if (losers.length && winners.length) {
      for (const l of losers) for (const w of winners) if (card(l.pid) && card(w.pid)) spawn(centerOf(card(l.pid)), centerOf(card(w.pid)), Math.min(-l.delta, w.delta));
    } else {
      for (const l of losers) if (card(l.pid)) spawn(centerOf(card(l.pid)), centerOf(board.children[g.players[l.pid].pos] || board), -l.delta);
      for (const w of winners) if (card(w.pid)) spawn(centerOf(board.children[0] || board), centerOf(card(w.pid)), w.delta);
    }
  }

  function flyBills(from, to, amount) {
    const n = Math.max(3, Math.min(10, Math.round(amount / 40) + 2));
    for (let k = 0; k < n; k++) {
      const el = icon('assets/icons/money', '', 'fly-bill');
      document.body.append(el);
      const j = () => (Math.random() - 0.5) * 36;
      const midX = from.x + (to.x - from.x) * 0.5, midY = from.y + (to.y - from.y) * 0.5 - 70 - Math.random() * 60;
      const anim = el.animate([
        { transform: `translate(${from.x - 18 + j()}px, ${from.y - 13 + j()}px) rotate(${Math.random() * 40 - 20}deg) scale(.4)`, opacity: 0 },
        { opacity: 1, offset: 0.15 },
        { transform: `translate(${midX - 18}px, ${midY - 13}px) rotate(${Math.random() * 200 - 100}deg) scale(1.05)`, offset: 0.55 },
        { transform: `translate(${to.x - 18 + j() / 3}px, ${to.y - 13 + j() / 3}px) rotate(${Math.random() * 360}deg) scale(.5)`, opacity: 0 },
      ], { duration: 750 + Math.random() * 250, delay: k * 70, easing: 'ease-in-out', fill: 'backwards' });
      anim.onfinish = () => el.remove();
      anim.oncancel = () => el.remove();
    }
  }

  function renderLog() {
    const el = $('#log');
    const g = S.game;
    el.replaceChildren(...g.log.slice(-40).map((l) => h('div', { class: 'logline' },
      l.pid != null && g.players[l.pid] ? h('i', { class: 'dot', style: `background:${g.players[l.pid].color}` }) : null, l.text)));
    el.scrollTop = el.scrollHeight;
  }

  // ------------------------------------------------------------------ action panel
  const btn = (label, cls, fn, disabled, title) => h('button', { class: 'btn ' + cls, disabled, title, onclick: fn }, label);

  function renderPanel() {
    const g = S.game, v = S.view, me = v.you;
    const el = $('#panel');
    el.replaceChildren();
    const p = g.cur(), d = g.decider();

    if (g.phase === 'gameover') {
      document.title = THEME.title;
      el.append(h('div', { class: 'status big winner' }, icon('assets/icons/trophy', '', 'trophy'), `${g.players[g.winner].name} wins!`),
        v.isHost ? btn('Back to lobby (rematch)', 'primary', () => lobby('rematch')) : h('div', { class: 'muted' }, 'Waiting for the host to start a rematch…'));
      return;
    }

    const mine = d.id === me;
    const localCount = v.seats.filter((x) => x.mine).length;
    document.title = (mine ? (localCount > 1 ? `${g.players[me].name}'s turn – ` : 'Your turn – ') : '') + THEME.title;
    const botNote = v.seats[d.id] && v.seats[d.id].botControlled ? ' (bot)' : '';
    el.append(h('div', { class: 'turn-head', style: `--c:${p.color}` }, Board.tokenIcon(p.token), p.id === me && localCount <= 1 ? 'Your turn' : `${p.name}'s turn`));

    const t = v.trade;
    if (t && t.from === me) {
      el.append(h('div', { class: 'notice' }, `Waiting for ${g.players[t.to].name} to answer your trade offer…`,
        btn('Cancel offer', 'small', () => act('cancelTrade'))));
    }

    if (!mine) {
      el.append(h('div', { class: 'status' }, g.phase === 'auction' ? 'Auction in progress…' : `Waiting for ${d.name}${botNote}…`));
      if (g.phase === 'auction') el.append(auctionView(g, d, false));
      return;
    }

    const me_ = g.players[me];
    if (S.recapOpen && g.phase === 'roll') el.append(recapCard(g, me));
    const row = h('div', { class: 'btn-row' });
    switch (g.phase) {
      case 'roll':
        if (me_.inJail) {
          el.append(h('div', { class: 'status' }, `You're in jail (attempt ${me_.jailTurns + 1}/${g.rules.maxJailTurns}). Roll doubles, pay, or use a card.`));
          row.append(
            btn(`Pay ${money(g.rules.jailFine)}`, '', () => act('payJailFine'), me_.cash < g.rules.jailFine),
            me_.jailCards ? btn('Use jail card', '', () => act('useJailCard')) : null,
            btn('Roll dice', 'primary', () => act('rollDice')));
        } else {
          el.append(h('div', { class: 'status' }, g.rolledDoubles ? 'Doubles! Roll again.' : 'Your move.'));
          row.append(btn([icon('assets/icons/dice', '', 'btn-icon'), 'Roll dice'], 'primary big pulse', () => act('rollDice')));
        }
        break;
      case 'buy': {
        const s = SPACES[me_.pos];
        el.append(h('div', { class: 'status' }, `You landed on ${s.name}. Buy it for ${money(s.price)}?`));
        row.append(btn(`Buy ${money(s.price)}`, 'primary', () => act('buy'), me_.cash < s.price, me_.cash < s.price ? 'Not enough cash' : ''),
          btn('Auction', '', () => act('declineBuy')));
        break;
      }
      case 'auction':
        el.append(auctionView(g, d, true));
        break;
      case 'postroll':
        el.append(h('div', { class: 'status' }, 'Done? You can still manage properties or propose a trade.'));
        row.append(btn('End turn', 'primary big', () => act('endTurn')));
        break;
      case 'debt': {
        const debt = g.debt;
        const to = debt.creditor != null ? g.players[debt.creditor].name : 'the bank';
        el.append(h('div', { class: 'status warn' }, `You owe ${money(debt.amount)} to ${to} but have ${money(me_.cash)}. Sell buildings, mortgage properties, or borrow from the bank (you could raise up to ${money(g.liquidValue(me))} by selling).`));
        row.append(btn('Declare bankruptcy', 'danger', () => { if (confirm('Really go bankrupt? You are out of the game.')) act('declareBankruptcy'); }));
        break;
      }
      default: break;
    }
    el.append(row);

    if (['roll', 'postroll', 'buy', 'debt'].includes(g.phase)) {
      el.append(h('div', { class: 'btn-row' },
        btn('My properties', '', openDeeds),
        btn('Bank', '', openBank),
        ['roll', 'postroll'].includes(g.phase) ? btn('Trade', '', openTradeComposer, g.alive().length < 2) : null));
    }
  }

  function auctionView(g, d, mine) {
    const a = g.auction, s = SPACES[a.idx];
    const box = h('div', { class: 'auction' },
      h('h3', {}, `Auction: ${s.name}`),
      h('div', {}, a.bidder != null ? `Highest bid: ${money(a.bid)} by ${g.players[a.bidder].name}` : 'No bids yet.'),
      h('div', { class: 'muted' }, 'Still in: ' + a.active.map((id) => g.players[id].name).join(', ')));
    if (!mine) return box;
    const cash = g.players[d.id].cash;
    const input = h('input', { class: 'input', type: 'number', min: a.bid + 1, max: cash, value: Math.min(cash, a.bid + 10) });
    box.append(
      h('div', { class: 'muted' }, `You have ${money(cash)}.`),
      h('div', { class: 'btn-row' }, [10, 50, 100].map((n) => btn(`+${n}`, 'small', () => { input.value = Math.min(cash, a.bid + n); }))),
      h('div', { class: 'btn-row' }, input,
        btn('Bid', 'primary', () => act('auctionBid', [Math.floor(Number(input.value))])),
        btn('Pass', '', () => act('auctionPass'))));
    return box;
  }

  // ------------------------------------------------------------------ modals
  function rentTable(i) {
    const s = SPACES[i];
    const rows = [];
    if (s.type === 'property') {
      rows.push(['Rent', money(s.rent[0])], ['Full color set', money(s.rent[0] * 2)]);
      s.rent.slice(1, 5).forEach((r, k) => rows.push([`With ${k + 1} house${k ? 's' : ''}`, money(r)]));
      rows.push(['With hotel', money(s.rent[5])], ['House / hotel cost', money(s.houseCost)]);
    } else if (s.type === 'railroad') {
      [1, 2, 3, 4].forEach((n) => rows.push([`${n} station${n > 1 ? 's' : ''} owned`, money(25 * 2 ** (n - 1))]));
    } else if (s.type === 'utility') {
      rows.push(['One utility owned', '4× dice roll'], ['Both utilities owned', '10× dice roll']);
    }
    if (s.price) rows.push(['Mortgage value', money(Math.floor(s.price / 2))]);
    return h('table', { class: 'rent' }, rows.map(([a, b]) => h('tr', {}, h('td', {}, a), h('td', {}, b))));
  }

  function showDeed(i) {
    const s = SPACES[i];
    openModal(() => {
      const g = S.game, st = g && g.props[i];
      const owner = st && st.owner != null ? g.players[st.owner] : null;
      const blurb = {
        go: `Collect ${money(g.rules.goSalary)} every time you pass.`, jail: 'Just visiting, unless you were sent here.',
        parking: 'A safe place to rest. Nothing happens.', gotojail: 'Go directly to jail. Do not collect salary.',
        chance: 'Draw a Chance card.', chest: 'Draw a Community Chest card.', tax: `Pay ${money(s.amount || 0)} to the bank.`,
      }[s.type];
      return h('div', { class: 'deed' },
        h('div', { class: 'deed-head', style: s.group ? `background:${COLORS[s.group]}` : '' },
          s.type === 'property' ? null : icon('assets/icons/' + s.id, '', 'deed-icon'), h('h2', {}, s.name)),
        s.type === 'property' ? icon('assets/icons/' + s.id, '', 'deed-art') : null,
        s.price ? h('div', { class: 'deed-price' }, `Price ${money(s.price)}`) : null,
        blurb ? h('p', {}, blurb) : rentTable(i),
        st ? h('p', { class: 'owner-line' }, owner ? [h('i', { class: 'dot', style: `background:${owner.color}` }), `Owned by ${owner.name}`, st.mortgaged ? ' (mortgaged)' : ''] : 'Unowned') : null,
        h('button', { class: 'btn', onclick: closeModal }, 'Close'));
    }, { kind: 'deed' });
  }

  function showPlayer(pid) {
    if (pid === S.view.you) return openDeeds(); // my own cards live in the docked column
    openModal(() => {
      const g = S.game, p = g.players[pid];
      const owned = g.ownedBy(pid);
      return h('div', {},
        h('h2', {}, p.name),
        h('p', {}, p.bankrupt ? 'Bankrupt' : `${money(p.cash)} cash · net worth ${money(g.netWorth(pid))}${p.jailCards ? ` · ${p.jailCards} jail card(s)` : ''}`),
        owned.length
          ? h('ul', { class: 'proplist' }, owned.map((i) => propLine(g, i)))
          : h('p', { class: 'muted' }, 'No properties.'),
        h('button', { class: 'btn', onclick: closeModal }, 'Close'));
    }, { kind: 'player' });
  }

  function propLine(g, i, extra) {
    const s = SPACES[i], st = g.props[i];
    return h('li', { class: 'propline' + (st.mortgaged ? ' mort' : '') },
      h('i', { class: 'chip', style: `background:${s.group ? COLORS[s.group] : s.type === 'railroad' ? '#555' : '#bbb'}` }),
      h('span', { class: 'pl-name' }, s.name),
      st.houses ? h('span', { class: 'pl-houses' }, st.houses === 5 ? icon('assets/icons/hotel', '', 'bld hotel') : Array.from({ length: st.houses }, () => icon('assets/icons/house', '', 'bld house'))) : null,
      st.mortgaged ? h('span', { class: 'tag' }, 'mortgaged') : null,
      extra);
  }

  // ------------------------------------------------------------------ my property cards
  const LIGHT_GROUPS = new Set(['lightblue', 'yellow']);

  function openDeeds() {
    const el = $('#deeds');
    if (!el) return;
    if (getComputedStyle($('#deeds-toggle')).display !== 'none') el.classList.add('open'); // drawer on narrow screens
    el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); // docked: just draw the eye
    setTimeout(() => el.classList.remove('flash'), 1200);
  }

  // [{ label, value, cur }] - `cur` marks the rent you would collect right now.
  function rentRows(g, me, i) {
    const s = SPACES[i], st = g.props[i];
    if (s.type === 'property') {
      const mono = g.hasMonopoly(me, s.group);
      const rows = [
        { label: 'Rent', value: money(s.rent[0]), cur: st.houses === 0 && !mono },
        { label: 'Full set', value: money(s.rent[0] * 2), cur: st.houses === 0 && mono },
      ];
      for (let k = 1; k <= 4; k++) rows.push({ label: `${k} house${k > 1 ? 's' : ''}`, value: money(s.rent[k]), cur: st.houses === k });
      rows.push({ label: 'Hotel', value: money(s.rent[5]), cur: st.houses === 5 });
      return rows;
    }
    if (s.type === 'railroad') {
      const n = g.countOwned(me, 'railroad');
      return [1, 2, 3, 4].map((k) => ({ label: `${k} station${k > 1 ? 's' : ''}`, value: money(25 * 2 ** (k - 1)), cur: k === n }));
    }
    const n = g.countOwned(me, 'utility');
    return [{ label: 'One utility', value: '4× dice', cur: n === 1 }, { label: 'Both utilities', value: '10× dice', cur: n === 2 }];
  }

  function deedCard(g, me, i) {
    const s = SPACES[i], st = g.props[i];
    const color = s.group ? COLORS[s.group] : s.type === 'railroad' ? '#3d3d3d' : '#8a8f98';
    const textColor = LIGHT_GROUPS.has(s.group) ? '#1d2733' : '#fff';
    const group = s.group ? g.groupOf(i) : null;
    const have = group ? group.filter((j) => g.props[j].owner === me).length : 0;
    const mono = group && have === group.length;
    const chips = [];
    if (group) chips.push(h('span', { class: 'chip-tag' + (mono ? ' good' : '') }, mono ? 'Full set' : `${have}/${group.length} of set`));
    if (st.mortgaged) chips.push(h('span', { class: 'chip-tag warn' }, 'Mortgaged'));
    const button = (label, name, err) => h('button', { class: 'btn small', disabled: !!err, title: err || '', onclick: () => act(name, [i]) }, label);
    const actions = h('div', { class: 'dk-actions' });
    if (s.type === 'property') {
      actions.append(button(`Build ${money(s.houseCost)}`, 'build', g.canBuild(me, i)), button(`Sell +${money(Math.floor(s.houseCost / 2))}`, 'sellHouse', g.canSell(me, i)));
    }
    actions.append(st.mortgaged
      ? button(`Unmortgage ${money(g.unmortgageCost(i))}`, 'unmortgage', g.canUnmortgage(me, i))
      : button(`Mortgage +${money(g.mortgageValue(i))}`, 'mortgage', g.canMortgage(me, i)));
    return h('div', { class: 'deed-card' + (st.mortgaged ? ' mort' : ''), 'data-idx': i },
      h('div', { class: 'dk-top', style: `background:${color};color:${textColor}` }, s.name),
      h('div', { class: 'dk-pic' }, icon('assets/icons/' + s.id, '', 'dk-img'),
        st.houses ? h('div', { class: 'dk-houses' }, st.houses === 5 ? icon('assets/icons/hotel', '', 'bld hotel') : Array.from({ length: st.houses }, () => icon('assets/icons/house', '', 'bld house'))) : null,
        st.mortgaged ? icon('assets/icons/mortgaged', '', 'dk-stamp') : null),
      h('div', { class: 'dk-chips' }, chips),
      h('div', { class: 'dk-rents' }, rentRows(g, me, i).map((r) => h('div', { class: 'dk-row' + (r.cur ? ' cur' : '') }, h('span', {}, r.label), h('b', {}, r.value)))),
      h('div', { class: 'dk-meta' },
        h('span', {}, `Price ${money(s.price)}`),
        s.houseCost ? h('span', {}, `Building ${money(s.houseCost)}`) : null,
        h('span', {}, `Mortgage ${money(g.mortgageValue(i))}`)),
      actions);
  }

  function renderDeeds() {
    const box = $('#deedlist');
    if (!box) return;
    const g = S.game, me = S.view.you;
    const mine = g.ownedBy(me).sort((a, b) => a - b);
    const scroll = box.scrollTop;
    const known = S.shownDeeds;
    S.shownDeeds = new Set(mine);
    $('#deeds-sub').textContent = `${money(g.players[me].cash)} cash · ${mine.length} propert${mine.length === 1 ? 'y' : 'ies'}${g.debtOf(me) ? ` · owes the bank ${money(g.debtOf(me))}` : ''}`;
    $('#deeds-toggle').textContent = `My properties (${mine.length})`;
    box.replaceChildren(...(mine.length
      ? mine.map((i) => {
        const card = deedCard(g, me, i);
        if (known && !known.has(i)) card.classList.add('new'); // just acquired
        return card;
      })
      : [h('div', { class: 'deeds-empty' }, 'Properties you buy will appear here, with their rents and build options.')]));
    box.scrollTop = scroll;
  }

  // ------------------------------------------------------------------ the bank
  // Total interest you would pay on a loan if you only make the scheduled payments.
  function interestEstimate(c, amount) {
    let remaining = amount, total = 0;
    const step = Math.ceil(amount / c.rounds);
    while (remaining > 0) { total += Math.ceil(remaining * c.rate); remaining -= Math.min(step, remaining); }
    return total;
  }

  function openBank() { openModal(buildBank, { kind: 'bank', cls: 'wide' }); }

  function buildBank() {
    const g = S.game, me = S.view.you, c = g.rules.loans, p = g.players[me];
    const avail = g.creditAvailable(me), loans = g.loansOf(me);
    const amounts = [100, 200, 300, 500, 800, 1000, 1500, 2000].filter((a) => a >= c.min && a % c.step === 0 && a <= c.creditCap);
    const pct = Math.round(c.rate * 100);
    const borrowBtn = (a) => {
      const err = g.canBorrow(me, a);
      return h('button', { class: 'bank-amount', disabled: !!err, title: err || `Pay back about ${money(a + interestEstimate(c, a))} in total`, onclick: () => act('borrow', [a]) },
        h('b', {}, money(a)), h('small', {}, `+${money(interestEstimate(c, a))} interest`));
    };
    const loanRow = (l) => {
      const input = h('input', { class: 'input', type: 'number', min: 1, max: l.remaining, value: Math.min(100, l.remaining) });
      const payBtn = (label, amount, extra = '') => {
        const err = g.canRepay(me, l.id, amount);
        return h('button', { class: 'btn small' + extra, disabled: !!err, title: err || '', onclick: () => act('repay', [l.id, amount]) }, label);
      };
      return h('div', { class: 'loan' },
        h('div', { class: 'loan-top' }, h('b', {}, `Loan #${l.id}`), h('span', {}, `owe ${money(l.remaining)} of ${money(l.principal)}`)),
        h('div', { class: 'muted' }, `Next payment at the start of your turn: ${money(g.paymentDue(l))} (${money(Math.min(l.step, l.remaining))} back + ${money(g.interestDue(l))} interest)`),
        h('div', { class: 'btn-row' },
          l.remaining > 100 ? payBtn(`Pay ${money(100)}`, 100) : null,
          payBtn(`Pay it all ${money(l.remaining)}`, l.remaining, ' primary'),
          input,
          h('button', { class: 'btn small', onclick: () => act('repay', [l.id, Math.floor(Number(input.value))]) }, 'Pay amount')));
    };
    return h('div', { class: 'bank' },
      h('h2', {}, 'The Bank'),
      h('p', { class: 'muted' }, `You have ${money(p.cash)}. The bank lends up to half of what you own (at most ${money(c.creditCap)}), ${c.maxActive} loans at a time. `
        + `Each round you pay back a fifth of the loan plus ${pct}% interest on what you still owe, so paying early saves interest. `
        + 'Anything you owe counts against your net worth, and if you go bankrupt the bank writes it off.'),
      h('div', { class: 'bank-credit' }, `You can borrow up to `, h('b', {}, money(avail)), ` right now`, loans.length >= c.maxActive ? ` (you already have ${c.maxActive} loans)` : ''),
      h('div', { class: 'bank-amounts' }, amounts.map(borrowBtn)),
      loans.length ? [h('h3', {}, 'Your loans'), loans.map(loanRow)] : h('p', { class: 'muted' }, "You don't owe the bank anything."),
      h('div', { class: 'btn-row' }, h('button', { class: 'btn', onclick: closeModal }, 'Close')));
  }

  // ---- trading
  function describeOffer(g, o) {
    const bits = o.props.map((i) => SPACES[i].name);
    if (o.cash) bits.push(money(o.cash));
    if (o.cards) bits.push(`${o.cards} jail card${o.cards > 1 ? 's' : ''}`);
    return bits.length ? bits.join(', ') : 'nothing';
  }

  function openTradeComposer() {
    const g = S.game, me = S.view.you;
    const others = g.alive().filter((p) => p.id !== me);
    if (!others.length) return;
    const empty = () => ({ cash: 0, cards: 0, props: new Set() });
    S.draft = { to: others[0].id, give: empty(), get: empty() };
    openModal(buildTrade, { kind: 'trade', live: false, cls: 'wide' });
  }

  // Counter offer: the composer opens pre-filled with their terms swapped round, ready to edit.
  function openCounter(t) {
    const as = (o) => ({ cash: o.cash, cards: o.cards, props: new Set(o.props) });
    S.countering = t.id;
    S.counterSent = false;
    S.draft = { to: t.from, counter: t, give: as(t.get), get: as(t.give) }; // what they asked of me -> what I give
    openModal(buildTrade, {
      kind: 'trade', live: false, cls: 'wide',
      onClose: () => { if (!S.counterSent) { S.countering = null; renderGame(); } }, // cancelled -> back to their offer
    });
  }

  function buildTrade() {
    const g = S.game, me = S.view.you, d = S.draft;
    const redraw = () => window.U.redrawModal();
    const side = (title, pid, offer) => {
      const p = g.players[pid];
      const cashInput = h('input', {
        class: 'input', type: 'number', min: 0, max: p.cash, value: offer.cash,
        onchange: (e) => { offer.cash = Math.max(0, Math.min(p.cash, Math.floor(Number(e.target.value) || 0))); e.target.value = offer.cash; },
      });
      const props = g.ownedBy(pid).map((i) => {
        const locked = SPACES[i].group && g.groupOf(i).some((j) => g.props[j].houses > 0);
        return h('label', { class: 'trade-prop' + (locked ? ' locked' : '') },
          h('input', { type: 'checkbox', checked: offer.props.has(i), disabled: locked, onchange: (e) => { e.target.checked ? offer.props.add(i) : offer.props.delete(i); } }),
          h('i', { class: 'chip', style: `background:${SPACES[i].group ? COLORS[SPACES[i].group] : '#999'}` }),
          SPACES[i].name, g.props[i].mortgaged ? ' (mortgaged)' : '', locked ? ' (has buildings)' : '');
      });
      return h('div', { class: 'trade-side' },
        h('h3', {}, title),
        h('label', {}, 'Cash (up to ', money(p.cash), ')', cashInput),
        p.jailCards ? h('label', {}, 'Jail cards', h('input', { class: 'input', type: 'number', min: 0, max: p.jailCards, value: offer.cards, onchange: (e) => { offer.cards = Math.max(0, Math.min(p.jailCards, Math.floor(Number(e.target.value) || 0))); e.target.value = offer.cards; } })) : null,
        props.length ? props : h('div', { class: 'muted' }, 'No properties'));
    };
    const partner = d.counter ? h('b', {}, g.players[d.to].name) : h('select', { class: 'input', onchange: (e) => { d.to = Number(e.target.value); d.get = { cash: 0, cards: 0, props: new Set() }; redraw(); } },
      g.alive().filter((p) => p.id !== me).map((p) => h('option', { value: p.id, selected: p.id === d.to }, p.name)));
    const toJson = (o) => ({ cash: o.cash, cards: o.cards, props: [...o.props] });
    const propose = () => {
      const give = toJson(d.give), get = toJson(d.get);
      const err = g.validateTrade(me, d.to, give, get);
      if (err) return toast(err);
      if (d.counter) {
        S.counterSent = true;
        closeModal();
        act('counterTrade', [], { to: d.to, give, get }).then((ok) => { if (!ok) { S.countering = null; renderGame(); } }); // on failure, show their original offer again
      } else {
        closeModal();
        act('proposeTrade', [], { to: d.to, give, get });
      }
    };
    return h('div', { class: 'trade' },
      h('h2', {}, d.counter ? 'Counter offer' : 'Propose a trade'),
      d.counter ? h('p', { class: 'muted' }, `Their offer: you receive ${describeOffer(g, d.counter.give)}, you give ${describeOffer(g, d.counter.get)}. Change the terms below.`) : null,
      h('label', {}, 'Trade with ', partner),
      h('div', { class: 'trade-grid' }, side('You give', me, d.give), side(`${g.players[d.to].name} gives`, d.to, d.get)),
      h('div', { class: 'btn-row' }, btn(d.counter ? 'Send counter offer' : 'Send offer', 'primary', propose), btn('Cancel', '', closeModal)));
  }

  function incomingTradeModal(t) {
    openModal(() => {
      const g = S.game;
      return h('div', {},
        h('h2', {}, `${g.players[t.from].name} offers a trade`),
        h('p', {}, h('b', {}, 'You receive: '), describeOffer(g, t.give)),
        h('p', {}, h('b', {}, 'You give: '), describeOffer(g, t.get)),
        h('div', { class: 'btn-row' },
          btn('Accept', 'primary', () => act('respondTrade', [], { accept: true })),
          btn('Counter offer', '', () => openCounter(t)),
          btn('Decline', '', () => act('respondTrade', [], { accept: false }))));
    }, { kind: 'incoming', closable: false });
  }

  function confetti() {
    return h('div', { class: 'confetti' }, Array.from({ length: 48 }, () => h('i', {
      style: `left:${Math.random() * 100}%;background:hsl(${Math.floor(Math.random() * 360)} 85% 55%);animation-delay:${(Math.random() * 2.5).toFixed(2)}s;animation-duration:${(2.5 + Math.random() * 2).toFixed(2)}s;transform:rotate(${Math.floor(Math.random() * 360)}deg)`,
    })));
  }

  function gameOverModal() {
    openModal(() => {
      const g = S.game, v = S.view;
      const ranked = [...g.players].sort((a, b) => (a.bankrupt - b.bankrupt) || (g.netWorth(b.id) - g.netWorth(a.id)));
      return h('div', { class: 'gameover' },
        confetti(),
        icon('assets/icons/trophy', '', 'trophy big'),
        h('h1', {}, `${g.players[g.winner].name} wins!`),
        g.endedByLimit ? h('p', { class: 'muted' }, `Time's up after ${g.rules.maxRounds} rounds. The richest player wins.`) : null,
        h('ol', {}, ranked.map((p) => h('li', {}, `${p.name}: ${p.bankrupt ? 'bankrupt' : money(g.netWorth(p.id)) + ' net worth'}`))),
        h('div', { class: 'btn-row' },
          v.isHost ? btn('Back to lobby', 'primary', () => { closeModal(); lobby('rematch'); }) : null,
          btn('Close', '', closeModal)));
    }, { kind: 'gameover', live: false });
  }

  // ------------------------------------------------------------------ boot
  function boot() {
    document.title = THEME.title;
    const code = (new URLSearchParams(location.search).get('room') || '').toUpperCase();
    let saved = readSession();
    if (!(saved && saved.room && (!code || saved.room === code)) && code) { // new tab / restarted browser: use the browser's memory
      const remembered = loadSessions()[code];
      if (remembered) saved = { room: code, key: remembered.key };
    }
    if (saved && saved.room && (!code || saved.room === code)) {
      S.room = saved.room; S.key = saved.key; saveSession();
      app.replaceChildren(h('div', { class: 'screen' }, h('div', { class: 'card' }, h('p', {}, 'Reconnecting…'))));
      connect();
    } else {
      renderHome(code);
    }
  }
  boot();
})();
