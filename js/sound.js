// Sound effects. Everything is synthesised with the Web Audio API so no audio files are
// needed. To use real recordings instead, drop files into assets/sounds/ named
// dice | cash-in | cash-out | jail  (.mp3, .ogg or .wav); they replace the synthesised version.
(function () {
  'use strict';

  const NAMES = ['dice', 'cash-in', 'cash-out', 'jail', 'buy', 'win', 'card', 'start'];
  const EXTS = ['mp3', 'ogg', 'wav'];
  const buffers = new Map(); // name -> decoded AudioBuffer (user-supplied recordings)
  const noiseCache = new WeakMap();
  let ctx = null, master = null, enabled = true, toggle = null;
  try { enabled = localStorage.getItem('tycoon.sound') !== 'off'; } catch { /* private mode */ }

  // ---- synthesis helpers: all take (ctx, destination, startTime)
  function noise(c) {
    if (!noiseCache.has(c)) {
      const b = c.createBuffer(1, c.sampleRate, c.sampleRate);
      const d = b.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      noiseCache.set(c, b);
    }
    return noiseCache.get(c);
  }
  function burst(c, out, t, dur, freq, q, gain, type = 'bandpass') {
    const s = c.createBufferSource();
    s.buffer = noise(c);
    const f = c.createBiquadFilter();
    f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = c.createGain();
    g.gain.setValueAtTime(Math.max(gain, 0.0002), t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f); f.connect(g); g.connect(out);
    s.start(t, Math.random() * 0.5);
    s.stop(t + dur + 0.02);
  }
  function tone(c, out, t, f0, dur, { type = 'sine', gain = 0.3, f1 = null, attack = 0.004 } = {}) {
    const o = c.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(Math.max(gain, 0.0002), t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(out);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  const SYNTH = {
    // Rattle while the dice tumble, then four bounces that line up with the throw animation.
    dice(c, o, t, v) {
      for (let k = 0; k < 24; k++) {
        const x = k / 24;
        burst(c, o, t + x * 0.95 + Math.random() * 0.02, 0.03, 1500 + Math.random() * 2500, 3, 0.45 * (1 - x * 0.7) * v);
      }
      [[0.52, 1], [0.73, 0.7], [0.9, 0.5], [1.0, 0.35]].forEach(([at, k]) => {
        tone(c, o, t + at, 210, 0.09, { f1: 70, gain: 0.6 * k * v });
        burst(c, o, t + at, 0.05, 900, 1.2, 0.5 * k * v);
      });
    },
    // Coin "ching" (a third rising note for big amounts, like passing Start).
    'cash-in'(c, o, t, v, opts) {
      tone(c, o, t, 1319, 0.35, { type: 'triangle', gain: 0.28 * v });
      tone(c, o, t, 2637, 0.25, { gain: 0.1 * v });
      tone(c, o, t + 0.08, 1976, 0.5, { type: 'triangle', gain: 0.28 * v });
      tone(c, o, t + 0.08, 3951, 0.3, { gain: 0.08 * v });
      burst(c, o, t, 0.03, 6000, 2, 0.2 * v);
      if (opts.big) tone(c, o, t + 0.17, 2637, 0.7, { type: 'triangle', gain: 0.25 * v });
    },
    // Lower, falling clink for paying out.
    'cash-out'(c, o, t, v) {
      tone(c, o, t, 988, 0.2, { type: 'triangle', gain: 0.22 * v, f1: 700 });
      tone(c, o, t + 0.09, 740, 0.32, { type: 'triangle', gain: 0.22 * v, f1: 520 });
      burst(c, o, t, 0.04, 5000, 3, 0.25 * v);
      burst(c, o, t + 0.09, 0.04, 4200, 3, 0.2 * v);
    },
    // Game start: a gong, then a bright rising "ready, set, go" and a held chord.
    start(c, o, t, v) {
      [[98, 1.8, 0.4], [147, 1.5, 0.22], [233, 1.2, 0.14], [351, 1.0, 0.08]].forEach(([f, d, g]) => tone(c, o, t, f, d, { gain: g * v }));
      burst(c, o, t, 0.35, 500, 0.7, 0.35 * v, 'lowpass'); // the strike
      burst(c, o, t, 0.15, 6000, 1, 0.1 * v, 'highpass');
      [392, 494, 587, 784].forEach((f, k) => {
        tone(c, o, t + 0.45 + k * 0.13, f, 0.32, { type: 'triangle', gain: 0.2 * v });
        tone(c, o, t + 0.45 + k * 0.13, f * 2, 0.2, { gain: 0.04 * v });
      });
      [784, 988, 1175].forEach((f) => tone(c, o, t + 1.0, f, 1.1, { type: 'triangle', gain: 0.13 * v }));
      tone(c, o, t + 1.0, 196, 1.2, { gain: 0.22 * v });
    },
    // Card drawn: a quick swish as it slides out, a flip-snap, then a soft chime
    // (brighter for Chance, warmer for Community Chest).
    card(c, o, t, v, opts) {
      const s = c.createBufferSource();
      s.buffer = noise(c);
      const f = c.createBiquadFilter();
      f.type = 'bandpass'; f.Q.value = 1.4;
      f.frequency.setValueAtTime(500, t);
      f.frequency.exponentialRampToValueAtTime(5200, t + 0.16);
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.35 * v, t + 0.06);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
      s.connect(f); f.connect(g); g.connect(o);
      s.start(t, Math.random() * 0.5); s.stop(t + 0.25);
      burst(c, o, t + 0.2, 0.035, 4500, 1.5, 0.5 * v, 'highpass'); // snap as it flips
      burst(c, o, t + 0.24, 0.03, 3000, 2, 0.3 * v);
      const [a, b] = opts.deck === 'chest' ? [1047, 1319] : [1568, 2093];
      tone(c, o, t + 0.26, a, 0.55, { gain: 0.16 * v });
      tone(c, o, t + 0.26, a * 2, 0.35, { gain: 0.04 * v });
      tone(c, o, t + 0.36, b, 0.7, { gain: 0.16 * v });
      tone(c, o, t + 0.36, b * 2, 0.4, { gain: 0.04 * v });
    },
    // Victory fanfare: rising C-major arpeggio, a held chord with bass, and falling sparkles.
    win(c, o, t, v) {
      [[523.25, 0], [659.25, 0.15], [783.99, 0.3], [1046.5, 0.45]].forEach(([f, at]) => {
        tone(c, o, t + at, f, 0.3, { type: 'triangle', gain: 0.2 * v });
        tone(c, o, t + at, f, 0.26, { type: 'square', gain: 0.045 * v });
        tone(c, o, t + at, f * 2, 0.22, { gain: 0.05 * v });
      });
      [523.25, 659.25, 783.99, 1046.5, 1318.5].forEach((f) => {
        tone(c, o, t + 0.7, f, 1.6, { type: 'triangle', gain: 0.13 * v });
        tone(c, o, t + 0.7, f, 1.2, { type: 'square', gain: 0.025 * v });
      });
      tone(c, o, t + 0.7, 130.8, 1.7, { gain: 0.3 * v });
      burst(c, o, t + 0.7, 0.25, 7000, 1, 0.12 * v, 'highpass'); // cymbal shimmer
      for (let k = 0; k < 14; k++) tone(c, o, t + 0.75 + k * 0.1 + Math.random() * 0.04, 2200 + Math.random() * 2600, 0.3, { gain: 0.05 * v * (1 - k / 18) });
    },
    // Property bought: rubber-stamp thump + paper slap, then a cash-register bell.
    buy(c, o, t, v) {
      tone(c, o, t, 140, 0.13, { f1: 55, gain: 0.75 * v });
      burst(c, o, t, 0.07, 1800, 1, 0.45 * v);
      burst(c, o, t + 0.03, 0.2, 5000, 0.7, 0.12 * v, 'highpass');
      burst(c, o, t + 0.15, 0.05, 4500, 2, 0.25 * v); // drawer "ka"
      tone(c, o, t + 0.17, 2093, 0.6, { type: 'triangle', gain: 0.24 * v });
      tone(c, o, t + 0.17, 3136, 0.5, { gain: 0.1 * v });
      tone(c, o, t + 0.27, 2637, 0.8, { type: 'triangle', gain: 0.24 * v });
      tone(c, o, t + 0.27, 5274, 0.35, { gain: 0.05 * v });
    },
    // Cell door slam: thump + clang, lock click, then a sad falling tone.
    jail(c, o, t, v) {
      tone(c, o, t, 150, 0.3, { f1: 42, gain: 0.9 * v });
      burst(c, o, t, 0.14, 700, 0.8, 0.7 * v, 'lowpass');
      [[410, 0.9], [617, 0.8], [1010, 0.5], [1530, 0.3]].forEach(([f, d]) => tone(c, o, t + 0.015, f, d, { type: 'square', gain: 0.07 * v }));
      burst(c, o, t + 0.015, 0.08, 3200, 2, 0.35 * v);
      burst(c, o, t + 0.4, 0.02, 3800, 4, 0.4 * v); // lock click
      burst(c, o, t + 0.46, 0.02, 2600, 4, 0.3 * v);
      tone(c, o, t + 0.6, 330, 0.55, { type: 'sawtooth', gain: 0.16 * v, f1: 150 });
    },
  };

  // ---- playback
  function ensure() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try {
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.9;
      master.connect(ctx.destination);
      loadRecordings();
    } catch { ctx = null; }
    return ctx;
  }

  // Look for user-supplied recordings (HEAD first so missing files don't download anything).
  async function loadRecordings() {
    for (const name of NAMES) {
      for (const ext of EXTS) {
        try {
          const url = `assets/sounds/${name}.${ext}`;
          const head = await fetch(url, { method: 'HEAD' });
          if (!head.ok || !/audio|ogg|mpeg|wav/.test(head.headers.get('content-type') || '')) continue;
          const data = await (await fetch(url)).arrayBuffer();
          buffers.set(name, await ctx.decodeAudioData(data));
          break;
        } catch { /* try next extension */ }
      }
    }
  }

  function play(name, opts = {}) {
    if (!enabled) return;
    const c = ensure();
    if (!c) return;
    if (c.state === 'suspended') c.resume();
    const v = opts.volume == null ? 1 : opts.volume;
    const buf = buffers.get(name);
    if (buf) {
      const s = c.createBufferSource();
      s.buffer = buf;
      const g = c.createGain();
      g.gain.value = v;
      s.connect(g); g.connect(master);
      s.start();
    } else if (SYNTH[name]) {
      SYNTH[name](c, master, c.currentTime + 0.01, v, opts);
    }
  }

  // ---- mute button (bottom-left on every screen)
  function setEnabled(on) {
    enabled = on;
    try { localStorage.setItem('tycoon.sound', on ? 'on' : 'off'); } catch { /* ignore */ }
    if (toggle) toggle.textContent = on ? 'Sound: on' : 'Sound: off';
  }
  function mount() {
    toggle = document.createElement('button');
    toggle.id = 'sound-toggle';
    toggle.className = 'btn small';
    toggle.addEventListener('click', () => { setEnabled(!enabled); if (enabled) play('cash-in', { volume: 0.5 }); });
    document.body.append(toggle);
    setEnabled(enabled);
  }
  // Browsers only allow audio after a user gesture.
  for (const ev of ['pointerdown', 'keydown']) document.addEventListener(ev, ensure, { once: true });
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);

  window.Sfx = { play, setEnabled, isEnabled: () => enabled, _synth: SYNTH };
})();
