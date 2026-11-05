/**
 * Persistent game library. Games are stored on disk inside the app's data
 * directory (independent of the original imported file):
 *   <userData>/library/index.json        – metadata for every game
 *   <userData>/library/games/<id>.json   – full game record (PGN, moves)
 * Writes are atomic (write temp file + rename) so a crash never corrupts data.
 */
const fs = require('fs');
const path = require('path');

const META_FIELDS = [
  'id', 'name', 'white', 'black', 'whiteElo', 'blackElo', 'result', 'event',
  'site', 'termination', 'date', 'time', 'plies', 'movesCount', 'source',
  'importedAt', 'lastOpenedAt', 'analysis',
];

function pick(obj, keys) {
  const out = {};
  for (const k of keys) out[k] = obj[k] ?? null;
  return out;
}

class GameStore {
  constructor(baseDir) {
    this.dir = path.join(baseDir, 'library');
    this.gamesDir = path.join(this.dir, 'games');
    this.indexPath = path.join(this.dir, 'index.json');
    fs.mkdirSync(this.gamesDir, { recursive: true });
    this.index = this.#loadIndex();
  }

  #loadIndex() {
    try {
      const data = JSON.parse(fs.readFileSync(this.indexPath, 'utf8'));
      return Array.isArray(data.games) ? data.games : [];
    } catch {
      return [];
    }
  }

  #writeAtomic(file, data) {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  }

  #saveIndex() {
    this.#writeAtomic(this.indexPath, { version: 1, games: this.index });
  }

  #gamePath(id) {
    if (!/^[a-f0-9]{16}$/.test(id)) throw new Error('bad game id');
    return path.join(this.gamesDir, `${id}.json`);
  }

  list() {
    return this.index.map((g) => ({ ...g }));
  }

  get(id) {
    return JSON.parse(fs.readFileSync(this.#gamePath(id), 'utf8'));
  }

  /**
   * Add parsed games. Re-importing an identical game keeps its history.
   * A multi-game file keeps file order: later games get a later importedAt,
   * and they count as "opened" only when the user opens them.
   */
  add(games) {
    const base = Date.now();
    const single = games.length === 1;
    const added = [];
    for (const [i, g] of games.entries()) {
      const existing = this.index.find((x) => x.id === g.id);
      const stamp = new Date(base + i).toISOString();
      const record = {
        ...g,
        analysis: existing?.analysis || null,
        importedAt: existing?.importedAt || stamp,
        lastOpenedAt: single ? stamp : existing?.lastOpenedAt || null,
      };
      this.#writeAtomic(this.#gamePath(g.id), record);
      const meta = pick(record, META_FIELDS);
      if (existing) Object.assign(existing, meta);
      else this.index.push(meta);
      added.push({ ...meta, duplicate: Boolean(existing) });
    }
    this.#saveIndex();
    return added;
  }

  /** Remember the result of a finished analysis (shown in the library). */
  setAnalysisSummary(id, summary) {
    const meta = this.index.find((x) => x.id === id);
    if (!meta) return;
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
    meta.analysis = {
      analyzedAt: new Date().toISOString(),
      engine: String(summary?.engine || 'Stockfish').slice(0, 40),
      accuracy: { w: num(summary?.accuracy?.w), b: num(summary?.accuracy?.b) },
    };
    this.#saveIndex();
  }

  clearAnalysisSummaries() {
    for (const g of this.index) g.analysis = null;
    this.#saveIndex();
  }

  touch(id) {
    const meta = this.index.find((x) => x.id === id);
    if (!meta) return;
    meta.lastOpenedAt = new Date().toISOString();
    this.#saveIndex();
  }

  rename(id, name) {
    const meta = this.index.find((x) => x.id === id);
    if (!meta || !String(name).trim()) return;
    meta.name = String(name).trim().slice(0, 200);
    const rec = this.get(id);
    rec.name = meta.name;
    this.#writeAtomic(this.#gamePath(id), rec);
    this.#saveIndex();
  }

  remove(id) {
    this.index = this.index.filter((x) => x.id !== id);
    this.#saveIndex();
    try { fs.unlinkSync(this.#gamePath(id)); } catch { /* already gone */ }
  }
}

module.exports = { GameStore };
