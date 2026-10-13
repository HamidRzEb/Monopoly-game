// End-to-end test of the game hub over the real server: picking a game when creating a room, per-game lobby
// rules and settings, and full Blackjack / Uno / Poker games (one human autopilot driven through the HTTP API
// plus bots), including that nobody is ever sent another player's hidden cards, and that a card game
// survives a server restart. Usage: node test/hub.js
'use strict';
process.env.BOT_SPEED = '60';
process.env.RATE_LIMIT = 'off';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { server, rooms } = require('../server.js');
const Games = require('../js/games/index.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function request(port, method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ port, method, path: p, headers: { 'Content-Type': 'application/json' } }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
const call = async (port, method, p, body) => { const r = await request(port, method, p, body); return { status: r.status, ...JSON.parse(r.body || '{}') }; };
const post = (port, p, body) => call(port, 'POST', p, body);
function watch(port, room, key, onState) {
  const w = { state: null, req: null };
  w.req = http.get({ port, path: `/api/events?room=${room}&key=${key}` }, (res) => {
    let buf = '';
    res.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        const m = /event: state\ndata: (.*)/.exec(chunk);
        if (m) { w.state = JSON.parse(m[1]); if (onState) onState(w.state); }
      }
    });
  });
  w.req.on('error', () => {});
  return w;
}

// One human played by the bot brain through the HTTP API, exactly like a browser would act on the snapshot it is sent.
function autopilot(port, code, key, mod, onState) {
  let busy = false, moves = 0, rejected = 0;
  const w = watch(port, code, key, (st) => {
    if (onState) onState(st);
    if (st.status !== 'playing' || busy) return;
    const g = mod.Engine.fromSnapshot(JSON.parse(JSON.stringify(st.game)));
    if (g.phase === 'gameover' || g.deciderId() !== st.you) return;
    const move = mod.decide(g, st.you);
    busy = true;
    post(port, '/api/action', { room: code, key, action: move.action, args: move.args }).then((r) => { moves++; if (r.error) { rejected++; console.error('rejected', move, r.error); } busy = false; });
  });
  return { w, stats: () => ({ moves, rejected }) };
}

async function playThrough(port, type, { bots, settings }) {
  const mod = Games.get(type);
  const a = await post(port, '/api/create', { name: 'Alice', game: type });
  assert(a.room && a.key, JSON.stringify(a));
  const room = rooms.get(a.room);
  assert.strictEqual(room.type, type);
  for (const [k, v] of Object.entries(settings || {})) assert.strictEqual((await post(port, '/api/lobby', { room: a.room, key: a.key, op: 'setSetting', setting: k, value: v })).ok, true, `setting ${k}`);
  for (let i = 0; i < bots; i++) assert.strictEqual((await post(port, '/api/lobby', { room: a.room, key: a.key, op: 'addBot' })).ok, true);
  let leaks = 0, states = 0;
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${type} game did not finish`)), 120000);
    const pilot = autopilot(port, a.room, a.key, mod, (st) => {
      if (st.status !== 'playing') return;
      states++;
      const g = st.game;
      // the player must never be sent a secret that is not theirs
      if (type === 'uno' && g.phase === 'play') leaks += g.hands.filter((h, i) => i !== st.you && h !== null).length + ('drawPile' in g ? 1 : 0);
      if (type === 'poker') {
        if (!g.revealed) leaks += g.players.filter((p) => p.id !== st.you && p.hole.length).length;
        if ('deck' in g) leaks++;
      }
      if (type === 'blackjack') { if ('shoe' in g) leaks++; if (g.phase === 'play' && g.dealer[1] !== null) leaks++; }
      if (g.phase === 'gameover') { clearTimeout(timer); resolve(pilot); }
    });
    room.pilot = pilot;
  });
  await sleep(150);
  const started = await post(port, '/api/lobby', { room: a.room, key: a.key, op: 'start' });
  assert.strictEqual(started.ok, true, JSON.stringify(started));
  // acting out of turn / with a made-up action is refused, never a crash
  assert.strictEqual((await post(port, '/api/action', { room: a.room, key: a.key, action: 'constructor', args: [] })).status, 400);
  assert.strictEqual((await post(port, '/api/action', { room: a.room, key: a.key, action: 'toSave', args: [] })).status, 400);
  assert.strictEqual((await post(port, '/api/action', { room: a.room, key: a.key, action: 'rollDice', args: [] })).status, 400, 'tycoon actions do not exist in other games');
  assert.strictEqual((await post(port, '/api/action', { room: a.room, key: a.key, action: 'proposeTrade', args: [] })).status, 400, 'trading is Tycoon only');
  const pilot = await done;
  const { moves, rejected } = pilot.stats();
  assert.strictEqual(rejected, 0, 'no autopilot move should be rejected');
  assert.strictEqual(leaks, 0, `${type}: hidden information was sent to a player`);
  const g = room.game;
  assert.strictEqual(g.phase, 'gameover');
  assert(g.winner != null && g.players[g.winner]);
  console.log(`${type.padEnd(9)} finished over HTTP: ${moves} human moves, ${states} updates, winner ${g.players[g.winner].name}, 0 rejected, 0 leaks`);
  // rematch goes back to the lobby of the same game and it can be started again
  assert.strictEqual((await post(port, '/api/lobby', { room: a.room, key: a.key, op: 'rematch' })).ok, true);
  assert.strictEqual(room.game, null);
  assert.strictEqual(room.type, type);
  pilot.w.req.destroy();
  return a;
}

(async () => {
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  // ---- the registry the home screen is built from
  assert.deepStrictEqual(Games.list().map((m) => m.id), ['tycoon', 'blackjack', 'uno', 'poker']);
  for (const m of Games.list()) {
    assert(m.name && m.tagline && m.minPlayers >= 1 && m.maxPlayers >= m.minPlayers && m.maxPlayers <= 8, `${m.id} metadata`);
    for (const s of m.settings) assert(s.options.some((o) => o.value === s.default), `${m.id}.${s.key} default is one of its options`);
  }
  // the browser loads the same modules through plain <script> tags: index.html must list every one of them
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  for (const id of Object.keys(Games.GAMES)) {
    assert(html.includes(`js/games/${id}.js`), `index.html should load js/games/${id}.js`);
    if (id !== 'tycoon') assert(html.includes(`js/games/${id}-ui.js`), `index.html should load js/games/${id}-ui.js`);
    assert((await request(port, 'GET', `/js/games/${id}.js`)).status === 200, `${id}.js is served`);
  }

  // ---- creating rooms
  assert.strictEqual((await post(port, '/api/create', { name: 'X', game: 'chess' })).status, 400, 'unknown game');
  assert.strictEqual((await post(port, '/api/create', { name: 'X', game: '__proto__' })).status, 400);
  const dflt = await post(port, '/api/create', { name: 'Old' });
  assert.strictEqual(rooms.get(dflt.room).type, 'tycoon', 'no game given = Tycoon, like before there were several');
  assert.strictEqual((await call(port, 'GET', `/api/room?room=${dflt.room}`)).game, 'tycoon');

  // ---- per-game lobby rules
  {
    const u = await post(port, '/api/create', { name: 'Uma', game: 'uno' });
    const b = await post(port, '/api/join', { room: u.room, name: 'Bo' });
    assert.strictEqual((await post(port, '/api/lobby', { room: u.room, key: b.key, op: 'setSetting', setting: 'target', value: 150 })).status, 403, 'host only');
    assert.strictEqual((await post(port, '/api/lobby', { room: u.room, key: u.key, op: 'setSetting', setting: 'target', value: 7 })).status, 400, 'value must be one of the offered options');
    assert.strictEqual((await post(port, '/api/lobby', { room: u.room, key: u.key, op: 'setSetting', setting: 'rounds', value: 5 })).status, 400, "another game's setting");
    assert.strictEqual((await post(port, '/api/lobby', { room: u.room, key: u.key, op: 'setLength', maxRounds: 60 })).status, 400, "Tycoon's game length does not exist in Uno");
    assert.strictEqual((await post(port, '/api/lobby', { room: u.room, key: u.key, op: 'setSetting', setting: 'target', value: 150 })).ok, true);
    assert.strictEqual(rooms.get(u.room).settings.target, 150);
    for (let i = 0; i < 6; i++) assert.strictEqual((await post(port, '/api/lobby', { room: u.room, key: u.key, op: 'addBot' })).ok, true);
    assert.strictEqual(rooms.get(u.room).seats.length, 8);
    assert.strictEqual((await post(port, '/api/lobby', { room: u.room, key: u.key, op: 'addBot' })).status, 400, 'Uno seats at most 8');
    assert.strictEqual((await post(port, '/api/join', { room: u.room, name: 'Late' })).status, 400, 'room is full');

    const solo = await post(port, '/api/create', { name: 'Solo', game: 'uno' });
    assert.strictEqual((await post(port, '/api/lobby', { room: solo.room, key: solo.key, op: 'start' })).status, 400, 'Uno needs two players');

    const bj = await post(port, '/api/create', { name: 'Solo', game: 'blackjack' });
    for (let i = 0; i < 6; i++) await post(port, '/api/lobby', { room: bj.room, key: bj.key, op: 'addBot' });
    assert.strictEqual(rooms.get(bj.room).seats.length, 6, 'Blackjack seats 6');
    const bj2 = await post(port, '/api/create', { name: 'Solo', game: 'blackjack' });
    assert.strictEqual((await post(port, '/api/lobby', { room: bj2.room, key: bj2.key, op: 'start' })).ok, true, 'Blackjack can be played alone against the dealer');

    // the lobby view tells the browser which game this is and its limits
    const w = watch(port, u.room, u.key);
    while (!w.state) await sleep(20);
    assert.deepStrictEqual([w.state.gameType, w.state.minPlayers, w.state.maxPlayers, w.state.status], ['uno', 2, 8, 'lobby']);
    w.req.destroy();
  }

  // ---- whole games
  await playThrough(port, 'blackjack', { bots: 2, settings: { rounds: 5 } });
  await playThrough(port, 'uno', { bots: 3, settings: { target: 150 } });
  await playThrough(port, 'uno', { bots: 1, settings: { target: 0 } });
  await playThrough(port, 'poker', { bots: 3, settings: { hands: 10 } });

  // ---- a card game survives a server restart (real process, SIGINT like pm2)
  const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-persist-'));
  const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
  const start = (p) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(p), DATA_DIR: DIR }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('server did not start: ' + out)), 8000);
      const iv = setInterval(() => { if (/Game server running/.test(out)) { clearTimeout(t); clearInterval(iv); resolve({ child, log: () => out }); } }, 30);
    });
  };
  const stop = (srv) => new Promise((res) => { srv.child.once('exit', res); srv.child.kill('SIGINT'); });
  for (const type of ['poker', 'uno']) {
    let p = await freePort();
    let srv = await start(p);
    const c = await post(p, '/api/create', { name: 'Solo', game: type });
    await post(p, '/api/lobby', { room: c.room, key: c.key, op: 'addBot' });
    await post(p, '/api/lobby', { room: c.room, key: c.key, op: 'addBot' });
    const w = watch(p, c.room, c.key);
    while (!w.state) await sleep(20);
    await post(p, '/api/lobby', { room: c.room, key: c.key, op: 'start' });
    const mod = Games.get(type);
    let acted = 0;
    // play until the human has made a few moves, then stop the server mid-game
    for (let guard = 0; acted < 6 && guard < 4000; guard++) {
      const st = w.state;
      if (st && st.status === 'playing') {
        const g = mod.Engine.fromSnapshot(JSON.parse(JSON.stringify(st.game)));
        if (g.phase !== 'gameover' && g.deciderId() === st.you) { const m = mod.decide(g, st.you); await post(p, '/api/action', { room: c.room, key: c.key, action: m.action, args: m.args }); acted++; }
      }
      await sleep(25);
    }
    assert(acted >= 6, 'the human played some moves');
    await sleep(100);
    w.req.destroy();
    await stop(srv);
    const file = path.join(DIR, 'rooms', `${c.room}.json`);
    assert(fs.existsSync(file));
    assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).type, type, 'the saved room remembers which game it is');
    p = await freePort();
    srv = await start(p);
    assert(/restored 1 room/.test(srv.log()), srv.log());
    const w2 = watch(p, c.room, c.key);
    while (!w2.state) await sleep(20);
    assert.strictEqual(w2.state.gameType, type);
    assert.strictEqual(w2.state.status, 'playing');
    const g2 = mod.Engine.fromSnapshot(JSON.parse(JSON.stringify(w2.state.game)));
    const handsOf = (st) => (type === 'poker' ? st.game.players[st.you].hole : st.game.hands[st.you]);
    assert(handsOf(w2.state).length > 0, 'the human still holds their own cards after the restart');
    assert.strictEqual((await call(p, 'GET', `/api/room?room=${c.room}&key=${c.key}`)).valid, true, 'the old key still works');
    // and the game goes on
    const log0 = w2.state.game.logSeq;
    for (let guard = 0; w2.state.game.logSeq < log0 + 6 && guard < 4000; guard++) {
      const st = w2.state, g = mod.Engine.fromSnapshot(JSON.parse(JSON.stringify(st.game)));
      if (g.phase !== 'gameover' && g.deciderId() === st.you) { const m = mod.decide(g, st.you); await post(p, '/api/action', { room: c.room, key: c.key, action: m.action, args: m.args }); }
      await sleep(25);
    }
    assert(w2.state.game.logSeq >= log0 + 6, 'the game carried on after the restart');
    console.log(`${type.padEnd(9)} restart: same game, same cards, same key, play continues (${g2.phase})`);
    w2.req.destroy();
    await stop(srv);
    fs.rmSync(path.join(DIR, 'rooms'), { recursive: true, force: true });
  }
  fs.rmSync(DIR, { recursive: true, force: true });
  console.log('hub OK');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
