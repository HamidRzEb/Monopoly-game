// Multiplayer server. Zero dependencies: plain HTTP, Server-Sent Events for live updates,
// JSON POSTs for actions. The server owns the authoritative Game; browsers only render
// snapshots and send intents.
//
//   node server.js            (PORT env var overrides 3000)
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Game } = require('./js/engine.js');
const AI = require('./js/ai.js');
const { TOKENS, PLAYER_COLORS, BOT_NAMES, RULES } = require('./js/data.js');
const DEFAULT_SETTINGS = { maxRounds: RULES.maxRounds };

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const MAX_ROOMS = 500;
const SPEED = Number(process.env.BOT_SPEED) || 1; // tests set this high to skip bot thinking time
const TAKEOVER_MS = 45 * 1000;       // a disconnected player's turn is played by a bot after this long
const TRADE_TIMEOUT_MS = 60 * 1000;  // unanswered trade offers expire
const ROOM_IDLE_MS = 10 * 60 * 1000; // rooms with no connected humans are deleted after this long

const rooms = new Map();

// ---------------------------------------------------------------- abuse protection
// Behind a reverse proxy (Caddy/nginx) set TRUST_PROXY=1 so the real client IP is read from
// X-Forwarded-For. All limits can be tuned with env vars; RATE_LIMIT=off disables them (tests).
const LIMITS_ON = process.env.RATE_LIMIT !== 'off';
const num = (name, def) => Number(process.env[name]) || def;
const LIMIT = {
  create: [num('LIMIT_CREATE', 20), 10 * 60 * 1000],   // new rooms per IP per 10 min
  join: [num('LIMIT_JOIN', 60), 10 * 60 * 1000],       // join attempts per IP per 10 min
  api: [num('LIMIT_API', 2400), 60 * 1000],            // all other API calls per IP per minute
};
const MAX_STREAMS_PER_IP = num('LIMIT_STREAMS', 40);   // concurrent live connections per IP
const hits = new Map();       // `${bucket}:${ip}` -> [timestamps]
const streamsByIp = new Map();
function clientIp(req) {
  if (process.env.TRUST_PROXY) {
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (fwd) return fwd;
  }
  return req.socket.remoteAddress || 'unknown';
}
function rateLimit(req, bucket) {
  if (!LIMITS_ON) return;
  const [max, windowMs] = LIMIT[bucket];
  const key = `${bucket}:${clientIp(req)}`;
  const now = Date.now();
  const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (list.length >= max) fail('Too many requests. Please slow down and try again in a bit.', 429);
  list.push(now);
  hits.set(key, list);
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > 10 * 60 * 1000) hits.delete(k); }, 60 * 1000).unref();

// ---------------------------------------------------------------- helpers
const rid = (n) => crypto.randomBytes(n).toString('hex');
const clean = (s, fallback) => {
  const t = String(s == null ? '' : s).replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
  return t || fallback;
};
class HttpError extends Error { constructor(msg, status = 400) { super(msg); this.status = status; } }
const fail = (msg, status) => { throw new HttpError(msg, status); };

function newCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += letters[crypto.randomInt(letters.length)];
    if (!rooms.has(c)) return c;
  }
}

function uniqueName(room, name) {
  let n = name, k = 2;
  while (room.seats.some((s) => s.name.toLowerCase() === n.toLowerCase())) n = `${name.slice(0, 13)} ${k++}`;
  return n;
}
function freeToken(room, preferred) {
  const taken = new Set(room.seats.map((s) => s.token));
  if (preferred && !taken.has(preferred) && TOKENS.some((t) => t.id === preferred)) return preferred;
  const free = TOKENS.filter((t) => !taken.has(t.id));
  return (free.length ? free[0] : TOKENS[0]).id; // list order puts tokens that have artwork first
}
function makeSeat(room, { name, type, token }) {
  return {
    name: uniqueName(room, name), type, token: freeToken(room, token),
    key: type === 'human' ? rid(16) : null, streams: new Set(), connected: type === 'bot', lastSeen: Date.now(),
  };
}

const humanSeats = (room) => room.seats.filter((s) => s.type === 'human');
const connectedHumans = (room) => humanSeats(room).filter((s) => s.connected);
const hostSeat = (room) => room.seats[room.host];

function getRoom(code) {
  const room = rooms.get(String(code || '').toUpperCase());
  if (!room) fail('Room not found. Check the code.', 404);
  return room;
}
function authSeat(room, key) {
  const idx = room.seats.findIndex((s) => s.key && s.key === key);
  if (idx < 0) fail('You are not in this room.', 403);
  return idx;
}
// Local co-op: several seats can share one key (one browser, several people). The seat a
// request acts as is `body.as` when that seat belongs to the same key, else the first one.
function actorSeat(room, body) {
  const primary = authSeat(room, body.key);
  const as = body.as;
  if (Number.isInteger(as) && room.seats[as] && room.seats[as].key === body.key) return as;
  return primary;
}
const keyGroup = (room, key) => room.seats.map((s, j) => (s.key && s.key === key ? j : -1)).filter((j) => j >= 0);
const isHostKey = (room, key) => !!key && hostSeat(room) && hostSeat(room).key === key;
const streamsOfKey = (room, key) => room.seats.filter((s) => s.key === key).flatMap((s) => [...s.streams]);
const setKeyConnected = (room, key, on) => room.seats.forEach((s) => { if (s.key === key) { s.connected = on; s.lastSeen = Date.now(); } });

// Which of this browser's players is "me" right now: the one who has to answer a trade, else
// whoever must act (their turn / their auction bid), else the current player if local.
function effectiveYou(room, i) {
  const group = keyGroup(room, room.seats[i].key);
  const g = room.game;
  if (!group.length) return i;
  if (!g || group.length === 1) return group[0];
  if (room.trade && group.includes(room.trade.to)) return room.trade.to;
  const d = g.decider().id;
  if (group.includes(d)) return d;
  if (group.includes(g.current)) return g.current;
  return group.find((j) => !g.players[j].bankrupt) ?? group[0];
}

// ---------------------------------------------------------------- state broadcast
function viewFor(room, you) {
  const g = room.game;
  return {
    code: room.code,
    build: buildId(),
    status: g ? 'playing' : 'lobby',
    you: effectiveYou(room, you),
    isHost: isHostKey(room, room.seats[you].key),
    host: room.host,
    maxPlayers: RULES.maxPlayers,
    settings: room.settings,
    roundOptions: RULES.roundOptions,
    seats: room.seats.map((s, i) => ({
      name: s.name, type: s.type, token: s.token, connected: s.connected,
      mine: !!s.key && s.key === room.seats[you].key, // seats this browser controls (local co-op)
      botControlled: g ? isBotControlled(room, i) : s.type === 'bot',
    })),
    game: g ? room.snapshot : null,
    trade: room.trade ? { id: room.trade.id, from: room.trade.from, to: room.trade.to, give: room.trade.give, get: room.trade.get } : null,
  };
}

function broadcast(room) {
  room.lastActivity = Date.now();
  if (room.game) room.snapshot = room.game.snapshot();
  const done = new Set();
  room.seats.forEach((seat, i) => {
    if (!seat.key || done.has(seat.key)) return;
    done.add(seat.key);
    const streams = streamsOfKey(room, seat.key);
    if (!streams.length) return;
    const payload = `event: state\ndata: ${JSON.stringify(viewFor(room, i))}\n\n`;
    for (const res of streams) res.write(payload);
  });
}
function toast(room, seatIdx, text) {
  const seat = room.seats[seatIdx];
  if (!seat || !seat.key) return;
  for (const res of streamsOfKey(room, seat.key)) res.write(`event: toast\ndata: ${JSON.stringify({ text })}\n\n`);
}

// ---------------------------------------------------------------- bots
function isBotControlled(room, idx) {
  const s = room.seats[idx];
  if (!s) return false;
  if (s.type === 'bot') return true;
  return !s.connected && Date.now() - s.lastSeen > TAKEOVER_MS; // temporary stand-in for a dropped player
}

function scheduleBot(room, delay) {
  const g = room.game;
  if (room.botTimer || !g || g.phase === 'gameover' || room.trade) return;
  if (!connectedHumans(room).length) return; // nobody watching, pause
  const d = g.decider();
  let wait = delay == null ? 900 : delay;
  if (!isBotControlled(room, d.id)) {
    const s = room.seats[d.id];
    if (s.type === 'human' && !s.connected) wait = Math.max(wait, TAKEOVER_MS - (Date.now() - s.lastSeen) + 50);
    else return; // a connected human is deciding
  }
  room.botTimer = setTimeout(() => { room.botTimer = null; runBot(room); }, wait / SPEED);
}

function afterChange(room, botDelay) {
  const g = room.game;
  if (g && room.trade && ((g.current !== room.trade.from && g.current !== room.trade.to) || !['roll', 'postroll'].includes(g.phase))) room.trade = null;
  broadcast(room);
  scheduleBot(room, botDelay);
}

function runBot(room) {
  const g = room.game;
  if (!g || g.phase === 'gameover') return;
  const d = g.decider();
  if (!isBotControlled(room, d.id)) return scheduleBot(room);
  const before = { roll: g.rollSeq, card: g.cardSeq };
  try {
    if (!room.trade && g.current === d.id && ['roll', 'postroll'].includes(g.phase)) {
      const offer = AI.proposeTrade(g, d);
      if (offer && botOffersTrade(room, d, offer)) return afterChange(room, 1500);
    }
    AI.act(g);
  } catch (e) {
    console.error('bot error:', e);
    fallbackAction(g, d.id);
  }
  let delay = g.phase === 'auction' ? 500 : 800 + Math.random() * 500;
  if (g.rollSeq !== before.roll) delay += 2300; // let clients finish the dice + walking animation
  if (g.cardSeq !== before.card) delay += 2200;
  afterChange(room, delay);
}

function fallbackAction(g, id) {
  const tries = { postroll: 'endTurn', buy: 'declineBuy', auction: 'auctionPass', debt: 'declareBankruptcy', roll: 'rollDice' };
  try { g[tries[g.phase]](id); } catch (e) { console.error('bot fallback failed:', e.message); }
}

// Returns true if the offer changed something (accepted by a bot, or now pending with a human).
function botOffersTrade(room, bot, offer) {
  const g = room.game;
  if (g.validateTrade(bot.id, offer.to, offer.give, offer.get)) return false;
  if (isBotControlled(room, offer.to)) {
    if (!AI.evaluateTrade(g, offer.to, offer.get, offer.give)) return false;
    g.executeTrade(bot.id, offer.to, offer.give, offer.get);
    return true;
  }
  openTrade(room, { from: bot.id, to: offer.to, give: offer.give, get: offer.get });
  return true;
}

function openTrade(room, t) {
  const trade = { id: rid(4), ...t };
  room.trade = trade;
  setTimeout(() => {
    if (room.trade && room.trade.id === trade.id) {
      room.trade = null;
      if (room.game) room.game.say(`${room.game.players[trade.to].name} didn't answer the trade offer.`);
      afterChange(room);
    }
  }, TRADE_TIMEOUT_MS).unref();
}

// ---------------------------------------------------------------- request handlers
const GAME_ACTIONS = {
  rollDice: [], buy: [], declineBuy: [], endTurn: [], payJailFine: [], useJailCard: [],
  declareBankruptcy: [], auctionPass: [],
  build: ['int'], sellHouse: ['int'], mortgage: ['int'], unmortgage: ['int'], auctionBid: ['int'],
};

function cleanOffer(o) {
  o = o || {};
  const int = (v) => (Number.isInteger(v) && v >= 0 && v <= 1e6 ? v : fail('Invalid trade.'));
  const props = Array.isArray(o.props) ? o.props.slice(0, 40).map((v) => (Number.isInteger(v) && v >= 0 && v < 40 ? v : fail('Invalid trade.'))) : [];
  return { cash: int(o.cash || 0), cards: int(o.cards || 0), props: [...new Set(props)] };
}

const routes = {
  'POST /api/create'(body, ctx) {
    if (rooms.size >= MAX_ROOMS) fail('The server is full. Try again later.', 503);
    const room = { code: newCode(), seats: [], host: 0, game: null, snapshot: null, trade: null, botTimer: null, lastActivity: Date.now(), settings: { ...DEFAULT_SETTINGS } };
    const seat = makeSeat(room, { name: clean(body.name, 'Player'), type: 'human' });
    room.seats.push(seat);
    // Local co-op: extra players who share this browser
    const locals = Array.isArray(body.locals) ? body.locals.slice(0, RULES.maxPlayers - 1) : [];
    for (const n of locals) addLocalSeat(room, seat.key, clean(n, 'Player'));
    rooms.set(room.code, room);
    return { room: room.code, key: seat.key };
  },

  'POST /api/join'(body) {
    const room = getRoom(body.room);
    if (body.key) {
      const i = room.seats.findIndex((s) => s.key === body.key);
      if (i >= 0) return { room: room.code, key: body.key };
    }
    if (room.game) fail('That game has already started.');
    if (room.seats.length >= RULES.maxPlayers) fail('The room is full.');
    const seat = makeSeat(room, { name: clean(body.name, 'Player'), type: 'human' });
    room.seats.push(seat);
    broadcast(room);
    return { room: room.code, key: seat.key };
  },

  'POST /api/leave'(body) {
    const room = getRoom(body.room);
    authSeat(room, body.key);
    leaveKey(room, body.key);
    return { ok: true };
  },

  'POST /api/lobby'(body) {
    const room = getRoom(body.room);
    const me = actorSeat(room, body);
    const isHost = isHostKey(room, body.key);
    switch (body.op) {
      case 'setLength': {
        if (!isHost) fail('Only the host can change the game length.', 403);
        if (room.game) fail('The game has started.');
        if (!RULES.roundOptions.includes(body.maxRounds)) fail('Invalid game length.');
        room.settings.maxRounds = body.maxRounds;
        break;
      }
      case 'addLocal': {
        if (!isHost) fail('Only the host can add local players.', 403);
        if (room.game) fail('The game has started.');
        if (room.seats.length >= RULES.maxPlayers) fail('The room is full.');
        addLocalSeat(room, body.key, clean(body.name, `Player ${room.seats.length + 1}`));
        break;
      }
      case 'setName':
        room.seats[me].name = uniqueName({ seats: room.seats.filter((_, i) => i !== me) }, clean(body.name, room.seats[me].name));
        break;
      case 'setToken':
        if (room.game) fail('The game has started.');
        if (!TOKENS.some((t) => t.id === body.token)) fail('Unknown token.');
        if (room.seats.some((s, i) => i !== me && s.token === body.token)) fail('Someone already has that token.');
        room.seats[me].token = body.token;
        break;
      case 'addBot': {
        if (!isHost) fail('Only the host can add bots.', 403);
        if (room.game) fail('The game has started.');
        if (room.seats.length >= RULES.maxPlayers) fail('The room is full.');
        const used = new Set(room.seats.map((s) => s.name));
        const name = BOT_NAMES.find((n) => !used.has(n)) || 'Bot';
        room.seats.push(makeSeat(room, { name, type: 'bot' }));
        break;
      }
      case 'removeSeat': {
        if (!isHost) fail('Only the host can remove players.', 403);
        if (room.game) fail('The game has started.');
        const i = body.index;
        if (!Number.isInteger(i) || !room.seats[i] || i === room.host) fail('Invalid seat.');
        const gone = room.seats[i];
        const sharing = room.seats.find((s, j) => j !== i && s.key && s.key === gone.key);
        if (sharing) { for (const res of gone.streams) sharing.streams.add(res); } // a local seat: its browser stays connected
        else for (const res of gone.streams) { res.write('event: kicked\ndata: {}\n\n'); res.end(); }
        room.seats.splice(i, 1);
        if (room.host > i) room.host--;
        break;
      }
      case 'toBot': {
        if (!isHost) fail('Only the host can do that.', 403);
        const i = body.index;
        const s = room.seats[i];
        if (!Number.isInteger(i) || !s || s.type !== 'human' || s.key === body.key) fail('Invalid seat.');
        if (!room.game) fail('Remove the player instead.');
        convertToBot(room, i);
        break;
      }
      case 'start': {
        if (!isHost) fail('Only the host can start the game.', 403);
        if (room.game) fail('Already started.');
        if (room.seats.length < 2) fail('You need at least 2 players. Add a bot!');
        const hostKey = hostSeat(room).key;
        for (let i = room.seats.length - 1; i > 0; i--) { // random turn order
          const j = crypto.randomInt(i + 1);
          [room.seats[i], room.seats[j]] = [room.seats[j], room.seats[i]];
        }
        room.host = room.seats.findIndex((s) => s.key === hostKey);
        room.game = new Game({
          players: room.seats.map((s, i) => ({ name: s.name, color: PLAYER_COLORS[i], token: s.token, ai: s.type === 'bot' })),
          rules: { maxRounds: room.settings.maxRounds },
        });
        room.trade = null;
        break;
      }
      case 'rematch':
        if (!isHost) fail('Only the host can do that.', 403);
        if (!room.game || room.game.phase !== 'gameover') fail('The game is still going.');
        {
          const hostKey = hostSeat(room).key;
          room.game = null; room.trade = null; room.snapshot = null;
          room.seats = room.seats.filter((s) => s.type === 'bot' || s.connected);
          room.host = Math.max(0, room.seats.findIndex((s) => s.key === hostKey));
        }
        break;
      default:
        fail('Unknown lobby action.');
    }
    afterChange(room);
    return { ok: true };
  },

  'POST /api/action'(body) {
    const room = getRoom(body.room);
    const me = actorSeat(room, body);
    const g = room.game;
    if (!g) fail('The game has not started.');
    const name = String(body.action);

    if (name === 'proposeTrade' || name === 'counterTrade') {
      const counter = name === 'counterTrade';
      let to = body.to;
      if (counter) { // the player being offered a trade answers with different terms (back to the proposer)
        if (!room.trade || room.trade.to !== me) fail('That offer is no longer open.');
        to = room.trade.from;
      } else {
        if (room.trade) fail('Another trade offer is already open.');
        if (g.current !== me) fail("It's not your turn.");
        if (!Number.isInteger(to) || !g.players[to]) fail('Pick a trade partner.');
      }
      const give = cleanOffer(body.give), get = cleanOffer(body.get);
      const err = g.validateTrade(me, to, give, get);
      if (err) fail(err); // checked before touching the original offer, so a bad counter doesn't lose it
      if (counter) {
        g.say(`${g.players[me].name} makes a counter offer to ${g.players[to].name}.`, me);
        room.trade = null;
      }
      if (isBotControlled(room, to)) {
        const verdict = AI.assessTrade(g, to, get, give);
        if (verdict.ok) {
          g.executeTrade(me, to, give, get);
        } else {
          const hint = AI.declineHint(verdict); // tell the player what would change the bot's mind
          g.say(`${g.players[to].name} declines the offer from ${g.players[me].name} (${hint}).`, to);
          toast(room, me, `${g.players[to].name} declined: ${hint}.`);
        }
      } else {
        openTrade(room, { from: me, to, give, get });
      }
      afterChange(room);
      return { ok: true };
    }

    if (name === 'respondTrade' || name === 'cancelTrade') {
      const t = room.trade;
      if (!t) fail('That offer is no longer open.');
      if (name === 'cancelTrade') {
        if (me !== t.from) fail('Not your offer.', 403);
        room.trade = null;
      } else {
        if (me !== t.to) fail('Not your offer.', 403);
        room.trade = null;
        if (body.accept) {
          try { g.executeTrade(t.from, t.to, t.give, t.get); } catch (e) {
            toast(room, t.to, e.message); toast(room, t.from, `Trade failed: ${e.message}`);
          }
        } else {
          g.say(`${g.players[t.to].name} declines the offer from ${g.players[t.from].name}.`, t.to);
          toast(room, t.from, `${g.players[t.to].name} declined your offer.`);
        }
      }
      afterChange(room);
      return { ok: true };
    }

    const spec = GAME_ACTIONS[name];
    if (!spec) fail('Unknown action.');
    const args = spec.map((kind, k) => {
      const v = Array.isArray(body.args) ? body.args[k] : undefined;
      return Number.isInteger(v) ? v : fail('Invalid arguments.');
    });
    try { g[name](me, ...args); } catch (e) { fail(e.message); }
    afterChange(room);
    return { ok: true };
  },
};

function addLocalSeat(room, key, name) {
  const seat = makeSeat(room, { name, type: 'human' });
  seat.key = key;
  seat.local = true;
  seat.connected = room.seats.some((s) => s.key === key && s.connected);
  room.seats.push(seat);
  return seat;
}

// Everyone behind one browser key leaves (one person, or a whole local co-op group).
function leaveKey(room, key) {
  const idxs = keyGroup(room, key).reverse();
  for (const i of idxs) {
    const s = room.seats[i];
    if (room.game) { convertToBot(room, i); continue; }
    for (const res of s.streams) res.end();
    room.seats.splice(i, 1);
    if (room.host === i) room.host = Math.max(0, room.seats.findIndex((x) => x.type === 'human'));
    else if (room.host > i) room.host--;
  }
  ensureHost(room);
  if (!humanSeats(room).length) return destroyRoom(room);
  afterChange(room);
}

function convertToBot(room, i) {
  const s = room.seats[i];
  for (const res of s.streams) { res.write('event: kicked\ndata: {}\n\n'); res.end(); }
  s.streams.clear();
  s.type = 'bot'; s.key = null; s.connected = true;
  if (room.game) {
    room.game.players[i].ai = true;
    room.game.say(`${s.name} has been replaced by a bot.`, i);
  }
}

// The host needs to be a connected human so someone can start/restart the game.
function ensureHost(room) {
  const h = hostSeat(room);
  if (h && h.type === 'human' && (h.connected || Date.now() - h.lastSeen < 30000)) return;
  const next = room.seats.findIndex((s) => s.type === 'human' && s.connected);
  if (next >= 0 && next !== room.host) { room.host = next; return true; }
}

function destroyRoom(room) {
  clearTimeout(room.botTimer);
  for (const s of room.seats) for (const res of s.streams) res.end();
  rooms.delete(room.code);
}

// ---------------------------------------------------------------- SSE
function handleEvents(req, res, url) {
  const ip = clientIp(req);
  if (LIMITS_ON && (streamsByIp.get(ip) || 0) >= MAX_STREAMS_PER_IP) fail('Too many open connections from your network.', 429);
  const room = getRoom(url.searchParams.get('room'));
  const me = authSeat(room, url.searchParams.get('key'));
  const seat = room.seats[me];
  const key = seat.key;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');
  seat.streams.add(res);
  streamsByIp.set(ip, (streamsByIp.get(ip) || 0) + 1);
  res.on('close', () => { const n = (streamsByIp.get(ip) || 1) - 1; if (n > 0) streamsByIp.set(ip, n); else streamsByIp.delete(ip); });
  setKeyConnected(room, key, true); // every seat behind this browser counts as connected
  res.write(`event: state\ndata: ${JSON.stringify(viewFor(room, me))}\n\n`);
  broadcast(room); // let others see this player is back
  scheduleBot(room);
  req.on('close', () => {
    seat.streams.delete(res);
    if (!rooms.has(room.code) || streamsOfKey(room, key).length) return;
    setKeyConnected(room, key, false);
    ensureHost(room);
    broadcast(room);
    scheduleBot(room); // may need to schedule a takeover
  });
}

// ---------------------------------------------------------------- build id
// Changes whenever any front-end file changes; lets open browser tabs notice a new version.
let buildCache = { at: 0, id: '0' };
function buildId() {
  if (Date.now() - buildCache.at < 1000) return buildCache.id;
  const h = crypto.createHash('md5');
  const files = ['index.html', ...['css', 'js'].flatMap((d) => fs.readdirSync(path.join(ROOT, d)).map((f) => `${d}/${f}`))];
  for (const f of files) {
    try { const st = fs.statSync(path.join(ROOT, f)); h.update(`${f}:${st.size}:${st.mtimeMs};`); } catch { /* ignore */ }
  }
  buildCache = { at: Date.now(), id: h.digest('hex').slice(0, 10) };
  return buildCache.id;
}

// ---------------------------------------------------------------- static files
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg',
  '.wav': 'audio/wav', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
};
const PUBLIC_DIRS = ['css', 'js', 'assets'];

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/') rel = '/index.html';
  const parts = rel.split('/').filter(Boolean);
  const allowed = rel === '/index.html' || PUBLIC_DIRS.includes(parts[0]);
  const file = path.normalize(path.join(ROOT, rel));
  if (!allowed || !file.startsWith(ROOT + path.sep)) { res.writeHead(404); return res.end('Not found'); }
  if (rel === '/index.html') { // templated so assets get a ?v=<build> suffix
    return fs.readFile(file, 'utf8', (err, text) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      const body = Buffer.from(text.replace(/__BUILD__/g, buildId()));
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Content-Length': body.length, 'Cache-Control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : body);
    });
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': parts[0] === 'assets' ? 'public, max-age=30' : 'no-cache',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

// ---------------------------------------------------------------- server
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 20000) { reject(new HttpError('Request too large.', 413)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(new HttpError('Invalid JSON.')); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  const send = (status, obj) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
  };
  try {
    if (url.pathname === '/api/events' && req.method === 'GET') return handleEvents(req, res, url);
    if (url.pathname === '/api/health') {
      if (process.env.DEBUG_HEADERS) { // diagnostics for setting up a proxy/CDN: shows what the proxy forwards (off by default)
        const keep = Object.entries(req.headers).filter(([k]) => /^(x-|ar-|cf-|forwarded|via|true-client|client-ip|cdn)/.test(k));
        console.log('DEBUG_HEADERS peer=' + req.socket.remoteAddress + ' ' + JSON.stringify(Object.fromEntries(keep)));
      }
      return send(200, { ok: true, rooms: rooms.size });
    }
    const route = routes[`${req.method} ${url.pathname}`];
    if (route) {
      rateLimit(req, url.pathname === '/api/create' ? 'create' : url.pathname === '/api/join' ? 'join' : 'api');
      if (!(req.headers['content-type'] || '').includes('application/json')) fail('Expected JSON.', 415);
      return send(200, route(await readBody(req)));
    }
    if (url.pathname.startsWith('/api/')) fail('Not found.', 404);
    if (req.method !== 'GET' && req.method !== 'HEAD') fail('Method not allowed.', 405);
    serveStatic(req, res, url.pathname);
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    if (!res.headersSent) send(e.status || 500, { error: e instanceof HttpError ? e.message : 'Server error.' });
  }
});

// Keep SSE connections alive through proxies, and clean up abandoned rooms/seats.
setInterval(() => {
  for (const room of [...rooms.values()]) {
    for (const s of room.seats) for (const res of s.streams) res.write(': ping\n\n');
    // Lobby seats whose browser disappeared are dropped; in a running game they stay (bot takeover handles turns).
    if (!room.game) {
      for (let i = room.seats.length - 1; i >= 0; i--) {
        const s = room.seats[i];
        if (s.type === 'human' && !s.connected && Date.now() - s.lastSeen > 60000) {
          room.seats.splice(i, 1);
          if (room.host === i) room.host = 0; else if (room.host > i) room.host--;
        }
      }
    }
    const hostChanged = ensureHost(room);
    if (!connectedHumans(room).length && Date.now() - room.lastActivity > ROOM_IDLE_MS) destroyRoom(room);
    else if (hostChanged) broadcast(room);
  }
}, 15000).unref();

if (require.main === module) {
  server.listen(PORT, () => console.log(`Game server running on http://localhost:${PORT}`));
  process.on('SIGTERM', () => process.exit(0));
}
module.exports = { server, rooms };
