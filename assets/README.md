# Artwork

Every image is optional. The game looks for `<name>.png`, then `.svg`, `.jpg`, `.webp`; if none
exists, nothing is shown (the game never uses emoji). Transparent PNGs work best. Refresh to see changes.

| Folder    | Files |
|-----------|-------|
| `icons/`  | one per board space id (see `js/data.js`): `go`, `jail`, `parking`, `go-to-jail`, `chance-1..3`, `chest-1..3`, `income-tax`, `luxury-tax`, `north-station`, `east-station`, `south-station`, `west-station`, `power-company`, `water-company` |
| `icons/`  | one per street id: `old-town`, `harbor-road`, `maple-street`, `cedar-avenue`, `birch-boulevard`, `sunset-plaza`, `rosewood-court`, `lakeview-drive`, `market-square`, `gallery-row`, `opera-lane`, `cherry-hill`, `riverside-walk`, `crimson-way`, `golden-gate`, `amber-avenue`, `sunflower-park`, `emerald-row`, `pine-heights`, `garden-avenue`, `grand-plaza`, `skyline-tower` |
| `icons/`  | UI: `house`, `hotel`, `mortgaged`, `chance-card`, `chest-card`, `money`, `dice` (roll button), `crown` (host), `bot`, `trophy` (winner), `jail-card` |
| `tokens/` | `hat`, `car`, `dog`, `ship`, `thimble`, `boot`, `cat`, `plane` |
| `cards/`  | `chance`, `chest` — blank card faces shown when a card is drawn |
| `dice/`   | `1` … `6` (svg or png) |
| (root)    | `logo.png` — title in the middle of the board and on the home screen |

The `Gemini_Generated_Image_*.jpg` sprite sheets are the originals. `node tools/slice-assets.js`
(needs `npm i --no-save sharp`) cuts them into the files above; the street -> picture assignment
is the `STREETS` table at the top of that script (the sheet has 20 pictures for 22 streets, so a
few are reused). Dice come from `inverted-dice-N.svg`.

## Sounds (optional)

`sounds/dice`, `sounds/cash-in`, `sounds/cash-out`, `sounds/buy`, `sounds/jail`, `sounds/card`, `sounds/start`, `sounds/win` as `.mp3`, `.ogg` or `.wav`.
Without them the game plays built-in synthesised effects (see `js/sound.js`).
