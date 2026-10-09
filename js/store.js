// Saves rooms (lobby seats + the whole game) to disk so they survive server restarts.
// One JSON file per room under <dir>/rooms/. Writes are atomic (temp file, then rename), so a crash
// in the middle of a save can never leave a half-written room behind. Node only.
'use strict';
const fs = require('fs');
const path = require('path');

function createStore(dir) {
  const roomsDir = path.join(dir, 'rooms');
  let enabled = false;
  try {
    fs.mkdirSync(roomsDir, { recursive: true, mode: 0o700 }); // the files contain players' secret keys
    fs.accessSync(roomsDir, fs.constants.W_OK);
    enabled = true;
  } catch (e) {
    console.warn(`Saving games is OFF (cannot write to ${roomsDir}): ${e.message}`);
  }
  const fileOf = (code) => path.join(roomsDir, `${code}.json`);
  const lastWritten = new Map(); // code -> text, so an unchanged room isn't rewritten

  function writeSync(code, record) {
    const text = JSON.stringify(record);
    if (lastWritten.get(code) === text) return;
    const tmp = `${fileOf(code)}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    fs.renameSync(tmp, fileOf(code));
    lastWritten.set(code, text);
  }

  return {
    get enabled() { return enabled; },
    dir: roomsDir,
    saveSync(code, record) { if (enabled) writeSync(code, record); },
    async save(code, record) {
      if (!enabled) return;
      const text = JSON.stringify(record);
      if (lastWritten.get(code) === text) return;
      const tmp = `${fileOf(code)}.${process.pid}.tmp`;
      await fs.promises.writeFile(tmp, text, { mode: 0o600 });
      await fs.promises.rename(tmp, fileOf(code));
      lastWritten.set(code, text);
    },
    remove(code) {
      lastWritten.delete(code);
      try { fs.unlinkSync(fileOf(code)); } catch { /* already gone */ }
    },
    // A file that can't be read is set aside as .bad (never silently deleted) so it can be inspected.
    quarantine(code) {
      try { fs.renameSync(fileOf(code), `${fileOf(code)}.bad`); } catch { /* ignore */ }
    },
    // Everything saved: [{ code, record }]. Leftover temp files from a crash are cleaned up.
    loadAll() {
      if (!enabled) return [];
      const out = [];
      for (const f of fs.readdirSync(roomsDir)) {
        const full = path.join(roomsDir, f);
        if (f.endsWith('.tmp')) { try { fs.unlinkSync(full); } catch { /* ignore */ } continue; }
        if (!f.endsWith('.json')) continue;
        const code = f.slice(0, -5);
        try { out.push({ code, record: JSON.parse(fs.readFileSync(full, 'utf8')) }); }
        catch (e) { console.error(`Saved room ${code} is unreadable (${e.message}); set aside as ${f}.bad`); this.quarantine(code); }
      }
      return out;
    },
  };
}

module.exports = { createStore };
