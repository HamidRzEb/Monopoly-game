# Game Night — Tycoon, Blackjack, Uno and Texas Hold'em for you, your friends and bots

Play in the browser. The home screen lists the games; pick one, create a room, share the 4-letter code
(or invite link), friends join from their own devices, and the host can fill empty seats with bots.
Any mix of humans and bots, online or on one shared screen.

| Game | Players | What it is |
|------|---------|------------|
| **Tycoon** | 2–8 | the Monopoly-like board game (rules below) |
| **Blackjack** | 1–6 | everyone plays against the dealer with chips; hit, stand, double down; blackjack pays 3:2 |
| **Uno** | 2–8 | the colour-matching card game; single round or first to 150/300 points |
| **Texas Hold'em** | 2–8 | no-limit poker with blinds, side pots and showdowns; 10, 25 or 50 hands |

Everything below that isn't about one game (rooms, bots, rejoining, saving, speed) works the same for all of them.

No dependencies — just Node 18+.

```bash
npm start            # http://localhost:3000
```

## Playing

1. Open the page, enter your name, pick a game, **Create online room** (or **Local co-op** to share one screen).
   To join a friend's room, type its code under "or join a friend's room".
   Each game has its own options in the lobby (rounds, hands, match length); the host sets them.
   The rest of this section describes Tycoon; the card games are described right after it.
2. Send friends the invite link (or the code). Pick your token by clicking it.
3. Host: **+ Add bot** to fill the table, then **Start game**.
4. Turn order is randomised. Everything standard is in: buying, auctions, rent, color sets,
   houses/hotels, mortgages, jail, Chance / Community Chest, taxes, bankruptcy, and
   **trading** (with humans and bots; bots also propose trades to complete their sets).
5. If a human drops out, a bot plays their turn after 45 s; they can rejoin by reopening the
   same tab/link. The host can also turn a missing player into a permanent bot.

### The card games

* **Blackjack**: everyone bets at the same time, then plays in turn. Hit, Stand, or Double (double the bet for
  exactly one more card). The dealer stands on 17 and checks for blackjack when showing an ace or ten. No splitting or
  insurance. The player with the most chips after the last round wins; if you can't cover the minimum bet you sit out.
* **Uno**: match the top card's colour or number/symbol. Skip, Reverse, Draw Two, Wild, Wild Draw Four (only when you
  hold no card of the current colour). No stacking, no challenges; UNO is called for you. Draw when stuck and play the
  card if it fits, or keep it. In a match the round winner scores the points left in the other hands.
* **Texas Hold'em**: no-limit, 1,000 chips each, blinds 10/20 doubling every 8 hands so a game always ends. After
  the last hand the biggest stack wins. Side pots, split pots and all-in run-outs are handled. Bots estimate their odds
  by simulation and bluff now and then.

Hidden cards stay hidden: the server only ever sends you your own hand (and the draw pile, shoe and deck never leave
it), and bots decide from exactly what a player in their seat would see. In local co-op the screen shows the hand of
whoever has to act, so hand it over when the "it's your move" message appears.

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

## Adding a game

A game is one engine file plus one screen, and everything else (rooms, seats, bots-on-disconnect, rejoining, saving,
the lobby, the game picker on the home screen) comes for free.

1. **`js/games/<id>.js`**, the engine. Copy `js/games/blackjack.js` and change it. It exports
   `{ meta, Engine, actions, decide, create }`:
   * `meta`: name, tagline, `minPlayers`/`maxPlayers`, `settings` (lobby options the host can change), `rules` (shown on the picker).
   * `Engine`: a class extending `BaseGame` (`js/games/core.js`). One method per action, called as `game.action(seat, ...intArgs)`,
     throwing an `Error` with a readable message when the move isn't allowed. Also `deciderId()` (who must act), `view(seat)`
     (what that seat may see: leave hidden cards out) and `fallbackMove(seat)`. The state must be plain JSON so saving works.
   * `actions`: `{ actionName: ['int', ...] }`, the whitelist of what clients may send.
   * `decide(snapshotEngine, seat)`: the bot. Returns `{ action, args }`; it only gets what a player in that seat sees.
2. **Register it** in `js/games/index.js` and add its `<script>` tags to `index.html`.
3. **`js/games/<id>-ui.js`**, the screen: `GameUI.register(id, { renderTable, renderPanel, panelKey, seatSummary, standings })`
   (see the comment at the top of `js/gameui.js`; `blackjack-ui.js` is the shortest example). Playing cards and chips are in `GameUI`.
4. **A test**: add the game to `test/cardgames.js` (rules + full bot-vs-bot games with invariants) and it is picked up by `test/hub.js`
   (a full game over HTTP, hidden-information check, restart check) once it is listed in the registry.

Optional tile artwork for the picker: `assets/games/<id>.png`.

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
