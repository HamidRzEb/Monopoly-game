// Real restart test: run the actual server, play, stop it (SIGTERM, like pm2), start it again on the same
// data folder, and check that the game and the player's key come back exactly as they were.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { Game } = require('../js/engine.js');
const AI = require('../js/ai.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tycoon-persist-'));
const ROOMS = path.join(DIR, 'rooms');

function startServer(port) {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(port), DATA_DIR: DIR, BOT_SPEED: '20', RATE_LIMIT: 'off' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start: ' + out)), 8000);
    const iv = setInterval(() => { if (/Game server running/.test(out)) { clearTimeout(t); clearInterval(iv); resolve({ child, log: () => out }); } }, 30);
  });
}
const stopServer = (srv, signal = 'SIGTERM') => new Promise((res) => { srv.child.once('exit', res); srv.child.kill(signal); });

const call = (port, method, p, body) => new Promise((res, rej) => {
  const d = body ? JSON.stringify(body) : null;
  const r = http.request({ port, method, path: p, headers: d ? { 'Content-Type': 'application/json' } : {} }, (x) => { let b = ''; x.on('data', (c) => (b += c)); x.on('end', () => res({ status: x.statusCode, ...JSON.parse(b || '{}') })); });
  r.on('error', rej); if (d) r.write(d); r.end();
});
function watch(port, room, key) { // live state stream: keeps the latest state
  const w = { state: null, req: null };
  w.req = http.get({ port, path: `/api/events?room=${room}&key=${key}` }, (res) => {
    let buf = '';
    res.on('data', (c) => { buf += c; let i; while ((i = buf.indexOf('\n\n')) >= 0) { const ch = buf.slice(0, i); buf = buf.slice(i + 2); const m = /event: state\ndata: (.*)/.exec(ch); if (m) w.state = JSON.parse(m[1]); } });
  });
  w.req.on('error', () => {});
  return w;
}
// the human is played by the bot brain, through the real HTTP API
async function humanAct(port, room, key, st) {
  const g = Game.fromSnapshot(JSON.parse(JSON.stringify(st.game)));
  let sent = null;
  const proxy = new Proxy(g, { get(t, k) {
    if (['rollDice', 'buy', 'declineBuy', 'endTurn', 'payJailFine', 'useJailCard', 'declareBankruptcy', 'auctionPass', 'build', 'sellHouse', 'mortgage', 'unmortgage', 'auctionBid', 'borrow', 'repay'].includes(k)) return (pid, ...args) => { sent = { action: k, args }; };
    const v = t[k]; return typeof v === 'function' ? v.bind(t) : v;
  } });
  AI.act(proxy);
  if (sent) await call(port, 'POST', '/api/action', { room, key, as: st.you, ...sent });
}

(async () => {
  let port = await freePort();
  let srv = await startServer(port);
  assert(/Saving games to/.test(srv.log()), 'server should report that it saves games: ' + srv.log());
  assert.strictEqual((await call(port, 'GET', '/api/health')).saving, true);

  // --- a game: one human + 3 bots, played until it is the human's turn after a few rounds
  const c = await call(port, 'POST', '/api/create', { name: 'Solo' });
  for (let i = 0; i < 3; i++) await call(port, 'POST', '/api/lobby', { room: c.room, key: c.key, op: 'addBot' });
  const w = watch(port, c.room, c.key);
  await sleep(200);
  await call(port, 'POST', '/api/lobby', { room: c.room, key: c.key, op: 'start' });
  let steps = 0, busy = false;
  while (true) {
    const st = w.state;
    if (st && st.status === 'playing') {
      const g = st.game, mine = g.decider === undefined && g.players[st.you] && (g.phase === 'auction' ? g.auction.turn === st.you : g.current === st.you);
      if (mine && g.turnCount >= 24 && g.phase === 'roll' && !g.rolledDoubles) break; // a quiet moment: the bots are waiting for us
      if (mine && !busy) { busy = true; await humanAct(port, c.room, c.key, st); busy = false; steps++; }
    }
    await sleep(25);
    assert(steps < 3000, 'autopilot got stuck');
  }
  await sleep(150);
  const before = w.state;
  const humanSeat = before.you;
  console.log(`before restart: turn ${before.game.turnCount}, round ${before.game.round}, ${before.game.log.length} log lines, human has $${before.game.players[humanSeat].cash}, owns ${Object.values(before.game.props).filter((p) => p.owner === humanSeat).length} properties, loans ${before.game.loans.length}`);

  // --- stop it right away (inside the 1-second save delay) to prove the shutdown flush works
  w.req.destroy();
  await stopServer(srv, 'SIGINT'); // pm2 restart/stop sends SIGINT
  assert(/Saved \d+ room/.test(srv.log()), 'shutdown should flush: ' + srv.log());
  const file = path.join(ROOMS, `${c.room}.json`);
  assert(fs.existsSync(file), 'room file written');
  assert.strictEqual((fs.statSync(file).mode & 0o777), 0o600, 'file is private (it contains secret keys)');
  assert.strictEqual(fs.readdirSync(ROOMS).filter((f) => f.endsWith('.tmp')).length, 0, 'no temp files left');

  // --- plant a corrupt file and an ancient room: neither may stop the server or come back
  fs.writeFileSync(path.join(ROOMS, 'ZZZZ.json'), '{ this is not json');
  const old = JSON.parse(fs.readFileSync(file, 'utf8')); old.code = 'OLDX'; old.lastActivity = Date.now() - 200 * 24 * 3600 * 1000;
  fs.writeFileSync(path.join(ROOMS, 'OLDX.json'), JSON.stringify(old));

  // --- start again on the same folder
  port = await freePort();
  srv = await startServer(port);
  assert(/restored 1 room/.test(srv.log()), 'one room restored (the corrupt and the ancient ones are not): ' + srv.log());
  assert(fs.existsSync(path.join(ROOMS, 'ZZZZ.json.bad')), 'corrupt file is set aside, not deleted');
  assert(!fs.existsSync(path.join(ROOMS, 'OLDX.json')), 'a room idle for 200 days is dropped');
  assert.strictEqual((await call(port, 'GET', `/api/room?room=${c.room}&key=${c.key}`)).valid, true, 'the player\'s OLD key still works after the restart');

  const w2 = watch(port, c.room, c.key);
  while (!w2.state) await sleep(25);
  const after = w2.state;
  assert.deepStrictEqual(after.game, before.game, 'the game is exactly as it was');
  assert.deepStrictEqual(after.seats.map((s) => [s.name, s.type, s.token]), before.seats.map((s) => [s.name, s.type, s.token]));
  assert.strictEqual(after.you, humanSeat);
  assert.strictEqual(after.isHost, true);
  console.log('after restart: identical game state, same seats, the old key works');

  // --- and it keeps going: the human acts, the bots take over again
  const turn0 = after.game.turnCount;
  let guard = 0;
  while (w2.state.game.turnCount < turn0 + 6 && guard++ < 2000) {
    const st = w2.state, g = st.game;
    const mine = g.phase === 'auction' ? g.auction.turn === st.you : g.current === st.you;
    if (mine && !busy) { busy = true; await humanAct(port, c.room, c.key, st); busy = false; }
    await sleep(25);
  }
  assert(w2.state.game.turnCount >= turn0 + 6, 'the game continues (bots resumed after the reload)');
  console.log(`the game carried on: turn ${turn0} -> ${w2.state.game.turnCount}`);

  // --- saved by the 1-second timer too (no shutdown involved)
  await sleep(1600);
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert(onDisk.game.turnCount >= turn0 + 6, 'the timer saved the newer state');

  // --- a finished/removed room's file is deleted
  w2.req.destroy();
  await call(port, 'POST', '/api/leave', { room: c.room, key: c.key }); // the only human leaves -> bots only, room is removed
  await sleep(300);
  assert(!fs.existsSync(file), 'a destroyed room\'s file is deleted');
  await stopServer(srv);
  fs.rmSync(DIR, { recursive: true, force: true });
  console.log('persist OK');
  process.exit(0);
})().catch((e) => { console.error(e); try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {} process.exit(1); });
