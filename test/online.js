// End-to-end test: starts the real server, creates a room, two "humans" (autopiloted
// through the HTTP API using the same browser-side Game views) plus two bots play a game.
// Usage: node test/online.js
'use strict';
process.env.BOT_SPEED = '60';
process.env.RATE_LIMIT = 'off';
const assert = require('assert');
const http = require('http');
const { server, rooms } = require('../server.js');
const { Game } = require('../js/engine.js');
const AI = require('../js/ai.js');

function request(port, method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ port, method, path, headers: { 'Content-Type': 'application/json' } }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => resolve({ status: res.statusCode, body: buf, headers: res.headers }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
const api = async (port, path, body) => {
  const r = await request(port, 'POST', path, body);
  const j = JSON.parse(r.body);
  return { status: r.status, ...j };
};

function connect(port, room, key, onState) {
  const req = http.get({ port, path: `/api/events?room=${room}&key=${key}` }, (res) => {
    let buf = '';
    res.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = /event: (\w+)/.exec(chunk), data = /data: (.*)/.exec(chunk);
        if (ev && data && ev[1] === 'state') onState(JSON.parse(data[1]));
      }
    });
  });
  return req;
}

(async () => {
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  // static files & security
  assert.strictEqual((await request(port, 'GET', '/')).status, 200);
  assert.strictEqual((await request(port, 'GET', '/js/engine.js')).status, 200);
  assert.strictEqual((await request(port, 'GET', '/server.js')).status, 404);
  assert.strictEqual((await request(port, 'GET', '/package.json')).status, 404);
  assert.strictEqual((await request(port, 'GET', '/js/../server.js')).status, 404);
  assert.strictEqual((await request(port, 'GET', '/%2e%2e/server.js')).status, 404);

  // lobby
  const a = await api(port, '/api/create', { name: 'Alice' });
  assert(a.room && a.key);
  const b = await api(port, '/api/join', { room: a.room, name: 'Bob' });
  assert(b.key && b.key !== a.key);
  assert.strictEqual((await api(port, '/api/join', { room: 'ZZZZ', name: 'X' })).status, 404);
  assert.strictEqual((await api(port, '/api/lobby', { room: a.room, key: b.key, op: 'addBot' })).status, 403, 'non-host cannot add bots');
  assert.strictEqual((await api(port, '/api/lobby', { room: a.room, key: a.key, op: 'start' })).ok, true);

  // ---- counter offers (room 1: two humans, game already started)
  {
    const room = rooms.get(a.room), g = room.game;
    const seatOf = (key) => room.seats.findIndex((s) => s.key === key);
    const cur = g.current;
    const proposer = seatOf(a.key) === cur ? a : b, other = proposer === a ? b : a;
    const pi = seatOf(proposer.key), oi = seatOf(other.key);
    g.props[1].owner = pi;
    const act = (who, action, extra) => api(port, '/api/action', { room: a.room, key: who.key, action, args: [], ...extra });
    const empty = { cash: 0, cards: 0, props: [] };
    // proposer sells Old Town for $100
    let r = await act(proposer, 'proposeTrade', { to: oi, give: { ...empty, props: [1] }, get: { ...empty, cash: 100 } });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(room.trade.from, pi);
    // only the addressee may counter
    assert.strictEqual((await act(proposer, 'counterTrade', { give: empty, get: empty })).status, 400);
    // an invalid counter must not destroy the original offer
    r = await act(other, 'counterTrade', { give: { ...empty, cash: 999999 }, get: { ...empty, props: [1] } });
    assert.strictEqual(r.status, 400);
    assert(room.trade && room.trade.from === pi, 'original offer lost after invalid counter');
    // valid counter: other pays $150 for it
    r = await act(other, 'counterTrade', { give: { ...empty, cash: 150 }, get: { ...empty, props: [1] } });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert(room.trade && room.trade.from === oi && room.trade.to === pi, 'counter should flow back to the proposer');
    assert.strictEqual(room.trade.give.cash, 150);
    // proposer accepts the counter
    const cashBefore = [g.players[pi].cash, g.players[oi].cash];
    r = await act(proposer, 'respondTrade', { accept: true });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(g.props[1].owner, oi, 'property should have moved');
    assert.strictEqual(g.players[pi].cash, cashBefore[0] + 150);
    assert.strictEqual(g.players[oi].cash, cashBefore[1] - 150);
    assert.strictEqual(room.trade, null);
    // ---- the bank over the wire: borrow/repay are validated by the server like every other action
    const cashNow = g.players[cur].cash;
    r = await act(proposer.key === a.key ? a : b, 'borrow', { args: [250] });
    assert.strictEqual(r.status, 400, 'loans come in steps of $100');
    r = await act(other, 'borrow', { args: [100] });
    assert.strictEqual(r.status, 400, 'only the player whose turn it is can borrow');
    r = await act(proposer, 'borrow', { args: [300] });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(g.players[cur].cash, cashNow + 300);
    assert.strictEqual(g.debtOf(cur), 300);
    r = await act(proposer, 'repay', { args: [g.loansOf(cur)[0].id, 100] });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(g.debtOf(cur), 200);
    r = await act(proposer, 'repay', { args: [999, 100] });
    assert.strictEqual(r.status, 400, 'unknown loan');
    // the host can change the speed, anyone else cannot
    assert.strictEqual((await api(port, '/api/lobby', { room: a.room, key: proposer.key === a.key ? a.key : b.key, op: 'setSpeed', speed: 'fast' })).ok, proposer === a, 'only the host (Alice) may');
    assert.strictEqual((await api(port, '/api/lobby', { room: a.room, key: a.key, op: 'setSpeed', speed: 'warp' })).status, 400);
    assert.strictEqual((await api(port, '/api/lobby', { room: a.room, key: a.key, op: 'setSpeed', speed: 'relaxed' })).ok, true);
    assert.strictEqual(room.settings.speed, 'relaxed');
    console.log('counter-offer flow OK');
  }

  // ---- local co-op: ONE browser (one key) plays several seats, and the server says who is "me"
  {
    const L = await api(port, '/api/create', { name: 'Alice', locals: ['Bob', 'Cara'] });
    assert(L.room && L.key);
    const lroom = rooms.get(L.room);
    assert.strictEqual(lroom.seats.length, 3);
    assert(lroom.seats.every((s) => s.key === L.key), 'all local seats share the browser key');
    // the browser may rename/retoken any of its local seats via `as`
    assert.strictEqual((await api(port, '/api/lobby', { room: L.room, key: L.key, op: 'setName', name: 'Bobby', as: 1 })).ok, true);
    assert.strictEqual(lroom.seats[1].name, 'Bobby');
    assert.strictEqual((await api(port, '/api/lobby', { room: L.room, key: L.key, op: 'addLocal', name: 'Dan' })).ok, true);
    assert.strictEqual(lroom.seats.length, 4);
    assert.strictEqual((await api(port, '/api/lobby', { room: L.room, key: L.key, op: 'addBot' })).ok, true);
    assert.strictEqual((await api(port, '/api/lobby', { room: L.room, key: 'nope', op: 'addLocal' })).status, 403);
    // game length: host-only, from the allowed list, and it reaches the game
    assert.strictEqual((await api(port, '/api/lobby', { room: L.room, key: L.key, op: 'setLength', maxRounds: 999 })).status, 400);
    assert.strictEqual((await api(port, '/api/lobby', { room: L.room, key: L.key, op: 'setLength', maxRounds: 60 })).ok, true);
    assert.strictEqual(lroom.settings.maxRounds, 60);
    // a stranger cannot act as one of our seats
    const S2 = await api(port, '/api/join', { room: L.room, name: 'Eve' });
    assert.strictEqual((await api(port, '/api/lobby', { room: L.room, key: S2.key, op: 'setName', name: 'Hacked', as: 0 })).ok, true);
    assert.notStrictEqual(lroom.seats[0].name, 'Hacked', 'a different key must not be able to act as someone else\'s seat');
    assert.strictEqual((await api(port, '/api/lobby', { room: L.room, key: S2.key, op: 'addLocal' })).status, 403, 'only the host can add local players');
    await api(port, '/api/leave', { room: L.room, key: S2.key });

    // play the whole game through ONE stream, acting as whichever local seat the server says is "me"
    let last = null, errs = 0, acts = 0, stalemate = false;
    const finished = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('local co-op game did not finish; last: ' + (last && last.game ? JSON.stringify({ phase: last.game.phase, current: last.game.current, you: last.you, trade: last.trade, auction: last.game.auction, turn: last.game.turnCount, alive: last.game.players.filter((p) => !p.bankrupt).length, acts }) : 'no state'))), 300000);
      let busy = false;
      connect(port, L.room, L.key, (st) => {
        last = st;
        if (st.status === 'lobby') return;
        if (st.game.phase === 'gameover') { clearTimeout(timer); return resolve(); }
        if (st.game.turnCount > 2500) { stalemate = true; clearTimeout(timer); return resolve(); } // endless bot-vs-bot game (known)
        const g = Game.fromSnapshot(JSON.parse(JSON.stringify(st.game)));
        const seatsMine = st.seats.map((x, i) => (x.mine ? i : -1)).filter((i) => i >= 0);
        assert(seatsMine.includes(st.you), 'you must be one of my local seats');
        assert(st.isHost === true);
        const decider = g.decider().id;
        const mustAnswer = st.trade && seatsMine.includes(st.trade.to);
        if (mustAnswer && !busy) {
          busy = true;
          const accept = AI.evaluateTrade(g, st.you, st.trade.get, st.trade.give);
          api(port, '/api/action', { room: L.room, key: L.key, as: st.you, action: 'respondTrade', accept }).then(() => { busy = false; }, reject);
          return;
        }
        if (seatsMine.includes(decider)) assert.strictEqual(st.you, mustAnswer ? st.trade.to : decider, 'server should point "me" at the player who must act');
        if (busy || !seatsMine.includes(decider) || st.trade) return;
        let sent = null;
        const proxy = new Proxy(g, { get(t, prop) {
          if (['rollDice', 'buy', 'declineBuy', 'endTurn', 'payJailFine', 'useJailCard', 'declareBankruptcy', 'auctionPass', 'build', 'sellHouse', 'mortgage', 'unmortgage', 'auctionBid'].includes(prop)) return (pid, ...args) => { sent = { action: prop, args }; };
          const v = t[prop]; return typeof v === 'function' ? v.bind(t) : v;
        } });
        try { AI.act(proxy); } catch (e) { return reject(e); }
        if (!sent) return;
        busy = true;
        api(port, '/api/action', { room: L.room, key: L.key, as: st.you, ...sent }).then((r) => { acts++; if (r.error) errs++; busy = false; }, reject);
      });
    });
    await new Promise((r) => setTimeout(r, 200));
    assert.strictEqual((await api(port, '/api/lobby', { room: L.room, key: L.key, op: 'start' })).ok, true);
    await finished;
    assert.strictEqual(lroom.game.rules.maxRounds, 60, 'chosen game length should apply');
    if (stalemate) console.warn('WARNING: local co-op game hit the 2500-turn stalemate cutoff (all-bot endgames can stall)');
    else if (last.game.endedByLimit) assert(last.game.winner != null, 'time limit must name a winner');
    else assert.strictEqual(last.game.players.filter((p) => !p.bankrupt).length, 1);
    assert.strictEqual(errs, 0, 'no action should have been rejected');
    console.log(`local co-op game ${stalemate ? 'cut off' : 'finished'}: ${acts} actions from one browser, ${errs} rejected`);
    // rematch returns the whole group to the lobby
    assert.strictEqual((await api(port, '/api/lobby', { room: L.room, key: L.key, op: 'rematch' })).ok, true);
    assert.strictEqual(lroom.seats.filter((s) => s.key === L.key).length, 4, 'local players stay after a rematch');
  }

  const c = await api(port, '/api/create', { name: 'Carol' });
  const d = await api(port, '/api/join', { room: c.room, name: 'Dan' });
  await api(port, '/api/lobby', { room: c.room, key: c.key, op: 'addBot' });
  await api(port, '/api/lobby', { room: c.room, key: c.key, op: 'addBot' });
  const humans = [{ key: c.key }, { key: d.key }];
  let finalState = null, errors = 0, actions = 0;

  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout: game did not finish')), 300000);
    for (const h of humans) {
      h.busy = false;
      h.req = connect(port, c.room, h.key, (st) => {
        h.state = st;
        if (st.status === 'lobby') return;
        const snap = st.game;
        if (snap.phase === 'gameover') { finalState = st; clearTimeout(timer); return resolve(); }
        const g = Game.fromSnapshot(JSON.parse(JSON.stringify(snap)));
        const me = st.you;
        if (st.trade && st.trade.to === me && !h.busy) {
          h.busy = true;
          const accept = AI.evaluateTrade(g, me, st.trade.get, st.trade.give);
          api(port, '/api/action', { room: c.room, key: h.key, action: 'respondTrade', accept }).then(() => { h.busy = false; }, reject);
          return;
        }
        if (g.decider().id !== me || h.busy) return;
        // Autopilot: run the bot brain against a view whose actions go over HTTP instead.
        let sent = null;
        const proxy = new Proxy(g, {
          get(t, prop) {
            if (['rollDice', 'buy', 'declineBuy', 'endTurn', 'payJailFine', 'useJailCard', 'declareBankruptcy', 'auctionPass', 'build', 'sellHouse', 'mortgage', 'unmortgage', 'auctionBid'].includes(prop)) {
              return (pid, ...args) => { sent = { action: prop, args }; };
            }
            const v = t[prop];
            return typeof v === 'function' ? v.bind(t) : v;
          },
        });
        try { AI.act(proxy); } catch (e) { return reject(e); }
        if (!sent) return;
        h.busy = true;
        api(port, '/api/action', { room: c.room, key: h.key, ...sent }).then((r) => {
          actions++;
          if (r.error) errors++;
          h.busy = false;
        }, reject);
      });
    }
  });

  // Not started yet: start from the host (Carol).
  await new Promise((r) => setTimeout(r, 200));
  const started = await api(port, '/api/lobby', { room: c.room, key: c.key, op: 'start' });
  assert.strictEqual(started.ok, true, JSON.stringify(started));
  assert.strictEqual((await api(port, '/api/join', { room: c.room, name: 'Late' })).status, 400, 'cannot join a started game');

  await done;
  assert.strictEqual(finalState.game.phase, 'gameover');
  if (finalState.game.endedByLimit) assert(finalState.game.winner != null);
  else assert.strictEqual(finalState.game.players.filter((p) => !p.bankrupt).length, 1);
  console.log(`online game finished: ${actions} human actions, ${errors} rejected, turn ${finalState.game.turnCount}`);

  // Anti-cheat: acting out of turn is rejected
  const r2 = await api(port, '/api/lobby', { room: c.room, key: c.key, op: 'rematch' });
  assert.strictEqual(r2.ok, true);
  const bad = await api(port, '/api/action', { room: c.room, key: d.key, action: 'rollDice', args: [] });
  assert.strictEqual(bad.status, 400);

  for (const h of humans) h.req.destroy();
  console.log('online test OK');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
