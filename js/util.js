// Small browser helpers: DOM builder, money format, image-or-emoji icons, modal, toasts.
(function () {
  'use strict';
  const { THEME } = window.MonopolyData;

  // h('div', {class:'x', onclick: fn}, child, [children], 'text')
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style') el.style.cssText = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat(Infinity)) {
      if (c == null || c === false) continue;
      el.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  const money = (n) => '$' + Number(n).toLocaleString('en-US');

  // ---- icons: <img> if assets/<base>.(png|svg|jpg|webp) exists, otherwise the fallback text
  const found = new Map();   // base -> url | null
  const pending = new Map(); // base -> Promise
  function probe(base) {
    if (pending.has(base)) return pending.get(base);
    const p = (async () => {
      for (const ext of THEME.assetExtensions) {
        const url = `${base}.${ext}`;
        const ok = await new Promise((resolve) => {
          const im = new Image();
          im.onload = () => resolve(true);
          im.onerror = () => resolve(false);
          im.src = url;
        });
        if (ok) { found.set(base, url); return url; }
      }
      found.set(base, null);
      return null;
    })();
    pending.set(base, p);
    return p;
  }
  function icon(base, fallback, cls) {
    const el = h('span', { class: 'icon ' + (cls || '') });
    const set = (url) => {
      el.textContent = '';
      if (url) el.append(h('img', { src: url, alt: '', draggable: 'false' }));
      else el.textContent = fallback || '';
    };
    if (found.has(base)) set(found.get(base));
    else { set(null); probe(base).then(set); }
    return el;
  }

  // ---- modal (one at a time). `build` is re-run by refreshModal() for live content.
  let spec = null;
  function renderModal() {
    const root = document.getElementById('modal');
    root.replaceChildren();
    root.hidden = !spec;
    if (!spec) return;
    const backdrop = h('div', { class: 'backdrop', onmousedown: (e) => { if (e.target === backdrop && spec.closable) closeModal(); } },
      h('div', { class: 'modal-box ' + (spec.cls || ''), role: 'dialog' }, spec.build()));
    root.append(backdrop);
  }
  function openModal(build, opts = {}) {
    spec = { build, closable: opts.closable !== false, kind: opts.kind || '', live: opts.live !== false, cls: opts.cls, onClose: opts.onClose };
    renderModal();
  }
  function closeModal() {
    const s = spec;
    spec = null;
    renderModal();
    if (s && s.onClose) s.onClose();
  }
  const modalKind = () => (spec ? spec.kind : null);
  function refreshModal() { if (spec && spec.live) renderModal(); }

  function toast(text, ms = 3500) {
    const t = h('div', { class: 'toast' }, text);
    document.getElementById('toasts').append(t);
    setTimeout(() => t.remove(), ms);
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  window.U = { h, money, icon, probe, openModal, closeModal, refreshModal, redrawModal: renderModal, modalKind, toast, sleep };
})();
