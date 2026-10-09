// One-off helper: cuts the two AI-generated sprite sheets in assets/ into the individual
// transparent PNGs the game loads by name (assets/icons, assets/tokens, assets/cards).
//
//   npm i --no-save sharp        (dev-only; the game itself has no dependencies)
//   node tools/slice-assets.js
//
// Boxes are in the coordinates of the 2000px-wide preview of each 2752px sheet.
'use strict';
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

const ASSETS = path.join(__dirname, '..', 'assets');
const SHEET_ICONS = path.join(ASSETS, 'Gemini_Generated_Image_umw552umw552umw5.jpg');
const SHEET_CARDS = path.join(ASSETS, 'Gemini_Generated_Image_cpkkcrcpkkcrcpkk.jpg');
const SHEET_UI = path.join(ASSETS, 'Gemini_Generated_Image_937vjh937vjh937v.jpg');
const SCALE = 2752 / 2000;

const COLS = [208, 530, 852, 1165, 1483, 1800];
const ROWS = [[140, 350], [395, 594], [645, 826], [885, 1062]];
const HALF = 152;

// [row, col] -> output files (relative to assets/)
const ICONS = [
  [0, 0, ['icons/go']], [0, 1, ['icons/parking']], [0, 2, ['icons/jail']], [0, 3, ['icons/go-to-jail']],
  [0, 4, ['icons/chance-1', 'icons/chance-2', 'icons/chance-3']],
  [0, 5, ['icons/chest-1', 'icons/chest-2', 'icons/chest-3']],
  [1, 0, ['icons/north-station', 'icons/east-station', 'icons/south-station', 'icons/west-station']],
  [1, 1, ['icons/power-company']], [1, 2, ['icons/water-company']],
  [1, 3, ['icons/income-tax']], [1, 4, ['icons/luxury-tax']], [1, 5, ['icons/mortgaged']],
  [2, 0, ['icons/chance-card']], [2, 1, ['icons/chest-card']],
  [2, 2, ['icons/house']], [2, 3, ['icons/hotel']], [2, 4, ['icons/dice']], [2, 5, ['icons/money']],
  [3, 0, ['tokens/hat']], [3, 1, ['tokens/dog']], [3, 2, ['tokens/car']],
  [3, 3, ['tokens/ship']], [3, 4, ['tokens/thimble']], [3, 5, ['tokens/boot']],
];
const CARDS = [
  ['cards/chance', [90, 240, 955, 1005]],
  ['cards/chest', [1040, 240, 1910, 1005]],
];

// The sheet background is dark navy with a slightly lighter grid.
const isBg = (r, g, b) => b > r + 25 && b > g + 10 && r < 95 && g < 115 && b < 160;
// Second sheet: near-black blue-grey panels (pure black outlines have b ~ r so are kept).
const isDarkBg = (r, g, b) => b - r >= 8 && r < 70 && g < 80 && b < 95;
// Logo: also swallow the sheet's lighter frame line and dark glow (edge-connected only).
const isLogoBg = (r, g, b) => b - r >= 8 && r < 105 && g < 118 && b < 140;

// Make background transparent: everything bg-coloured reachable from the crop edge,
// plus big enclosed bg pockets (e.g. between jail bars).
function removeBackground(data, w, h, test, pockets = true) {
  const bg = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) bg[i] = test(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]) ? 1 : 0;
  const clear = new Uint8Array(w * h);
  const flood = (seeds) => {
    const stack = seeds.slice();
    while (stack.length) {
      const p = stack.pop();
      if (clear[p] || !bg[p]) continue;
      clear[p] = 1;
      const x = p % w, y = (p - x) / w;
      if (x > 0) stack.push(p - 1);
      if (x < w - 1) stack.push(p + 1);
      if (y > 0) stack.push(p - w);
      if (y < h - 1) stack.push(p + w);
    }
  };
  const edge = [];
  for (let x = 0; x < w; x++) { edge.push(x, (h - 1) * w + x); }
  for (let y = 0; y < h; y++) { edge.push(y * w, y * w + w - 1); }
  flood(edge);
  // interior pockets
  const seen = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) {
    if (!bg[p] || clear[p] || seen[p]) continue;
    const comp = [], stack = [p];
    while (stack.length) {
      const q = stack.pop();
      if (seen[q] || clear[q] || !bg[q]) continue;
      seen[q] = 1; comp.push(q);
      const x = q % w, y = (q - x) / w;
      if (x > 0) stack.push(q - 1);
      if (x < w - 1) stack.push(q + 1);
      if (y > 0) stack.push(q - w);
      if (y < h - 1) stack.push(q + w);
    }
    if (pockets && comp.length > 250) for (const q of comp) clear[q] = 1;
  }
  // soften the fringe: dark-bluish pixels touching removed area become transparent too
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x;
      if (clear[p]) continue;
      const nearClear = clear[p - 1] || clear[p + 1] || clear[p - w] || clear[p + w];
      if (nearClear && data[p * 4 + 2] > data[p * 4] + 12 && data[p * 4] < 110 && data[p * 4 + 1] < 130) data[p * 4 + 3] = 90;
    }
  }
  for (let p = 0; p < w * h; p++) if (clear[p]) data[p * 4 + 3] = 0;
}

// Card templates have ruled dashed lines on the parchment; erase them so the face is blank.
// Lines are found as short dark bands between the parchment's top and bottom borders, then
// filled by interpolating the parchment from just above and just below each band.
function eraseCardLines(data, w, h) {
  const x0 = Math.round(w * 0.2), x1 = Math.round(w * 0.8);
  const lum = [];
  for (let y = 0; y < h; y++) {
    let sum = 0;
    for (let x = x0; x < x1; x++) { const i = (y * w + x) * 4; sum += 0.3 * data[i] + 0.59 * data[i + 1] + 0.11 * data[i + 2]; }
    lum.push(sum / (x1 - x0));
  }
  const base = lum.map((_, y) => { const a = lum.slice(Math.max(0, y - 14), Math.min(h, y + 15)).sort((p, q) => p - q); return a[Math.floor(a.length * 0.75)]; });
  const rows = [];
  for (let y = Math.round(h * 0.35); y < Math.round(h * 0.84); y++) if (base[y] - lum[y] > 3) rows.push(y);
  // group consecutive rows into bands
  const bands = [];
  for (const y of rows) {
    const last = bands[bands.length - 1];
    if (last && y - last[1] <= 2) last[1] = y; else bands.push([y, y]);
  }
  const xa = Math.round(w * 0.09), xb = Math.round(w * 0.91);
  for (const [top, bottom] of bands) {
    const a = top - 4, b = bottom + 4; // clean rows on either side
    for (let y = a + 1; y < b; y++) {
      const t = (y - a) / (b - a);
      for (let x = xa; x < xb; x++) {
        for (let c = 0; c < 3; c++) data[(y * w + x) * 4 + c] = Math.round(data[(a * w + x) * 4 + c] * (1 - t) + data[(b * w + x) * 4 + c] * t);
      }
    }
  }
  return bands.length;
}

// Drop stray fragments (leftover label letters etc.): keep components >= 2% of the biggest.
function keepMainParts(data, w, h) {
  const label = new Int32Array(w * h).fill(-1);
  const sizes = [];
  for (let p = 0; p < w * h; p++) {
    if (label[p] >= 0 || data[p * 4 + 3] === 0) continue;
    const id = sizes.length; let n = 0;
    const stack = [p];
    while (stack.length) {
      const q = stack.pop();
      if (label[q] >= 0 || data[q * 4 + 3] === 0) continue;
      label[q] = id; n++;
      const x = q % w, y = (q - x) / w;
      for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) { // bridge small gaps (sparkles, drips)
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && nx < w && ny >= 0 && ny < h) stack.push(ny * w + nx);
      }
    }
    sizes.push(n);
  }
  const max = Math.max(...sizes, 1);
  for (let p = 0; p < w * h; p++) if (label[p] >= 0 && sizes[label[p]] < max * 0.02) data[p * 4 + 3] = 0;
}

async function cut(sheet, box, outs, { maxSize = 256, keepParts = true, test = isBg, pockets = true, eraseLines = false } = {}) {
  const [x0, y0, x1, y1] = box.map((v) => Math.round(v * SCALE));
  const { data, info } = await sharp(sheet).extract({ left: x0, top: y0, width: x1 - x0, height: y1 - y0 })
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  removeBackground(data, info.width, info.height, test, pockets);
  if (keepParts) keepMainParts(data, info.width, info.height);
  if (eraseLines) console.log('erased', eraseCardLines(data, info.width, info.height), 'ruled lines from', outs[0]);
  let img = sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } });
  img = sharp(await img.png().toBuffer()).trim({ threshold: 1 }); // crop to visible pixels
  const png = await img.resize(maxSize, maxSize, { fit: 'inside' }).png().toBuffer();
  for (const out of outs) {
    const file = path.join(ASSETS, out + '.png');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, png);
  }
}

// ---- sheet 3: logo, status icons, extra tokens, street pictures
const UI_CUTS = [
  [[80, 380, 270, 545], ['icons/crown']], [[300, 380, 490, 545], ['icons/bot']],
  [[85, 690, 268, 865], ['icons/trophy']], [[318, 685, 470, 870], ['icons/jail-card']],
  [[570, 382, 735, 545], ['tokens/cat']], [[780, 382, 950, 520], ['tokens/plane']],
];
// The street cards sheet has a 5x4 grid. Each street picks one (row, col); some are reused
// because the sheet has 20 pictures for 22 streets. Edit this table to re-assign.
const CARD_X = [[1035, 1187], [1208, 1376], [1397, 1568], [1588, 1750], [1772, 1918]];
const CARD_Y = [[383, 535], [556, 708], [729, 881], [901, 1053]];
const STREETS = {
  'old-town': [0, 0], 'harbor-road': [0, 0],
  'maple-street': [0, 1], 'cedar-avenue': [3, 3], 'birch-boulevard': [2, 4],
  'sunset-plaza': [0, 2], 'rosewood-court': [0, 2], 'lakeview-drive': [3, 0],
  'market-square': [0, 3], 'gallery-row': [2, 0], 'opera-lane': [0, 3],
  'cherry-hill': [1, 0], 'riverside-walk': [3, 0], 'crimson-way': [2, 0],
  'golden-gate': [1, 1], 'amber-avenue': [2, 1], 'sunflower-park': [3, 1],
  'emerald-row': [1, 2], 'pine-heights': [1, 3], 'garden-avenue': [2, 2],
  'grand-plaza': [0, 4], 'skyline-tower': [1, 4],
};

async function cutStreet(id, [row, col]) {
  const [x0, x1] = CARD_X[col], [y0, y1] = CARD_Y[row];
  // skip the printed header band (its text doesn't match our street names)
  const box = [x0 + 5, y0 + 38, x1 - 5, y1 - 5].map((v) => Math.round(v * SCALE));
  const png = await sharp(SHEET_UI).extract({ left: box[0], top: box[1], width: box[2] - box[0], height: box[3] - box[1] })
    .resize(256, 256, { fit: 'inside' }).png().toBuffer();
  fs.writeFileSync(path.join(ASSETS, 'icons', id + '.png'), png);
}

// The Start tile's arrow points right, but pieces travel LEFT along the bottom row. Mirror only the
// arrow (the "GO" lettering must stay readable). Coordinates are for the 256x236 trimmed icon.
async function fixGoArrow() {
  const file = path.join(ASSETS, 'icons', 'go.png');
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  if (w !== 256 || h !== 236) { console.warn(`go.png is ${w}x${h}, expected 256x236: arrow not flipped`); return; }
  // The lettering's pointed bottom tip dips into the arrow's top edge (a V from x 88-117 at y 168, closing by y ~181): keep it.
  const isTip = (x, y) => y >= 168 && y <= 181 && x >= 88 + (y - 167) && x <= 117 - (y - 167);
  const isArrow = (x, y) => !isTip(x, y) && (y >= 168 || (y >= 158 && x >= 170)); // shaft/tail + the head's tip beside the lettering
  const out = Buffer.alloc(data.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (isArrow(x, y)) continue; // arrow pixels are placed mirrored below
      data.copy(out, i, i, i + 4);
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!isArrow(x, y)) continue;
      const src = (y * w + x) * 4, dst = (y * w + (w - 1 - x)) * 4;
      if (data[src + 3] > 0) data.copy(out, dst, src, src + 4);
    }
  }
  await sharp(out, { raw: { width: w, height: h, channels: 4 } }).png().toFile(file);
  console.log('mirrored the Go arrow so it points the way pieces travel');
}

(async () => {
  for (const [box, outs] of UI_CUTS) await cut(SHEET_UI, box, outs, { test: isDarkBg });
  await cut(SHEET_UI, [685, 5, 1315, 265], ['logo'], { maxSize: 700, test: isLogoBg, keepParts: false, pockets: false });
  for (const [id, rc] of Object.entries(STREETS)) await cutStreet(id, rc);
  for (let n = 1; n <= 6; n++) { // dice faces supplied as inverted-dice-N.svg
    const src = path.join(ASSETS, `inverted-dice-${n}.svg`);
    if (fs.existsSync(src)) { fs.mkdirSync(path.join(ASSETS, 'dice'), { recursive: true }); fs.copyFileSync(src, path.join(ASSETS, 'dice', `${n}.svg`)); }
  }
  for (const [r, c, outs] of ICONS) {
    await cut(SHEET_ICONS, [COLS[c] - HALF, ROWS[r][0], COLS[c] + HALF, ROWS[r][1]], outs);
  }
  for (const [out, box] of CARDS) await cut(SHEET_CARDS, box, [out], { maxSize: 900, keepParts: false, eraseLines: true });
  await fixGoArrow();
  console.log('sliced', ICONS.length, 'icons and', CARDS.length, 'card templates');
})();
