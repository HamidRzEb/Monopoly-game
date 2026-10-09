# Tycoon — a Monopoly-like game for you, your friends and bots

Play in the browser. One person creates a room, shares the 4-letter code (or invite link),
friends join from their own devices, and the host can fill empty seats with bots.
2–8 players, any mix of humans and bots.

No dependencies — just Node 18+.

```bash
npm start            # http://localhost:3000
```

## Playing

1. Open the page, enter your name, **Create a room**.
2. Send friends the invite link (or the code). Pick your token by clicking it.
3. Host: **+ Add bot** to fill the table, then **Start game**.
4. Turn order is randomised. Everything standard is in: buying, auctions, rent, color sets,
   houses/hotels, mortgages, jail, Chance / Community Chest, taxes, bankruptcy, and
   **trading** (with humans and bots; bots also propose trades to complete their sets).
5. If a human drops out, a bot plays their turn after 45 s; they can rejoin by reopening the
   same tab/link. The host can also turn a missing player into a permanent bot.

## Playing online with friends

The server must be reachable by your friends. Easiest options:

* **Quick tunnel from your PC** (nothing to deploy):
  `npx cloudflared tunnel --url http://localhost:3000` (or `ngrok http 3000`)
  and share the https URL it prints.
* **Host it**: any Node host works (Render, Railway, Fly.io, a VPS…). Start command
  `npm start`; it listens on `$PORT`. A `Dockerfile` is included.
  Game state lives in server memory, so run a single instance (restarting ends games).

## Saved games

Games are saved to disk (`data/rooms/<CODE>.json`, one file per room, about a second after every change and again
when the server is stopped) and loaded again at startup. Restarting or updating the server therefore doesn't end
games: players' browsers reconnect by themselves with the keys they already hold, and the bots pick up where they left off.
A game nobody is in is kept for 72 hours, a finished one for 1 hour, an empty lobby for 10 minutes. A pending trade offer
is not kept. The files hold players' secret keys, so they're private (`0600`) and git-ignored. Settings: `DATA_DIR`,
`GAME_KEEP_HOURS`, `PERSIST=off`.

## Rejoining a game

Your seat is tied to a secret key that the browser remembers for 24 hours, so closing the tab or restarting the
browser doesn't lose it: reopen the invite link and you're back, or press **Rejoin** under "Your games" on the home
screen. From another device, enter the room code and your name and press Join: a started game shows the seats whose
players are disconnected (or that a bot took over) and you take yours back. A connected player's seat can't be taken,
and taking a seat back invalidates the old key.

## The bank

Players can borrow from the bank during their own turn (the **Bank** button). The bank lends up to half
of what you own (max $2,000, 3 loans at a time, $100 steps). At the start of each of your turns you pay a
fifth of each loan back plus 5% interest on what you still owe; you can also repay any amount early, which
saves interest. Unaffordable payments follow the normal debt rules (sell, mortgage, or go bankrupt), money
owed counts against your net worth, and a bankrupt player's loans are written off. Terms are in `js/data.js`.

## Game speed and keeping track

The host picks **Relaxed / Normal / Fast** (lobby, or any time in the game from the top bar). It controls how
long bots pause, and how long dice, walking and card animations take. A banner announces whose turn it is,
and when it becomes your turn a **While you were away** card recaps what everyone else did.

## Game length

Games can't run forever: the host picks a length in the lobby (Quick 60 / Standard 120 / Long 200
rounds). A round is everyone having had a turn. A counter shows the round, turns red for the last
10, and when time runs out the player with the highest net worth (cash + properties + buildings) wins.

## Putting it online

See [DEPLOY.md](DEPLOY.md) (Docker + automatic HTTPS, or systemd). The server rate-limits room
creation and joining per IP, and caps open connections.

## Artwork

Images are optional: anything missing is simply left blank (no emoji), so the game always works.
Drop files into `assets/` using the names in [assets/README.md](assets/README.md).
The two sprite sheets you supplied were cut into individual transparent PNGs with
`tools/slice-assets.js` (re-run it if you replace the sheets).

## Animations

Everything is animated with plain CSS and the Web Animations API (no libraries): dice are thrown,
tumble and settle; tokens hop square by square; the landing square flashes; claimed squares pop;
houses/hotels pop in; money counts up/down and bills fly from payer to receiver (or to the property you buy); drawn cards flip in; the winner gets a
bouncing trophy and confetti. Animations are skipped for people who prefer reduced motion.

## Sound

Dice rattle, coin "ching" / clink for money, a stamp-and-register sound when a property is bought, a cell-door slam for jail, a card-flip swish and chime when a Chance / Community Chest card is drawn, a gong-and-fanfare when the game starts, and a victory fanfare when someone wins. They are generated in
the browser (no audio files). Your own money plays at full volume, other players' more quietly.
There is a **Sound: on/off** button bottom-left (remembered). To use real recordings, put
`dice`, `cash-in`, `cash-out`, `buy`, `card`, `jail`, `start` and/or `win` (.mp3, .ogg or .wav) in `assets/sounds/`.

## Customising

* `js/data.js` — board spaces, prices, rents, cards, tokens, rules (starting cash, salary…), title.
* `js/ai.js` — bot behaviour.
* `css/style.css` — look and feel.

## Tests

```bash
node test/simulate.js 200   # 200 bot-only games, checks rule invariants
node test/online.js         # real server + HTTP/SSE clients play a full game
```

## How it works

`server.js` keeps the authoritative game (`js/engine.js`), applies every action after checking
it is that player's move, and streams state snapshots to all browsers over Server-Sent Events.
Browsers only send intents (`roll`, `buy`, `build`…), so nobody can cheat from the client.
