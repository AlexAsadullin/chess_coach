/**
 * Runs Stockfish over every position of a game, streams results to the UI
 * and caches them on disk so a game is only analysed once.
 *
 * Two engine processes:
 *   - "review": full-game analysis (most CPU threads)
 *   - "interactive": on-demand requests (best-move lines for the Best button)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Chess } = require('chess.js');
const { UciEngine, findEngine } = require('./engine');

/**
 * Analysis settings. The deep-pass depth comes from the user's Settings
 * (16 / 20 / 24); results store the depth they reached, so changing it never
 * throws saved analysis away — a deeper setting just refines it.
 * Bump CACHE_VERSION only when the stored format or multipv changes.
 */
const SETTINGS = {
  quickDepth: 12,   // pass 1: whole game in seconds so the review is usable at once
  depth: 20,        // pass 2: per position; chess.com Game Review appears to use ~18-20
  multipv: 2,       // 2nd-best line is needed to detect "Great" (only-move) moves
  lineDepth: 18,     // per search for the first moves of Best / "what happens next" lines …
  lineTailDepth: 18, // … and for the rest of the line (16 is ~2x faster but less accurate)
  linePlies: 26,    // default length of those lines (half-moves; Settings can change it) …
  lineMaxPlies: 60, // … or longer when they end in a forced mate
};
const CACHE_VERSION = `sf19-m${SETTINGS.multipv}-v2`;
const COMPATIBLE_VERSIONS = new Set([CACHE_VERSION, 'sf19-d20-m2-v1']); // v1 files are the same format

class AnalysisService {
  /**
   * @param getDepth () => number — deep-pass depth from Settings
   * @param getLinePlies () => number — length of Best lines from Settings
   */
  constructor(baseDir, getDepth = () => SETTINGS.depth, getLinePlies = () => SETTINGS.linePlies) {
    this.getDepth = getDepth;
    this.getLinePlies = getLinePlies;
    this.cacheDir = path.join(baseDir, 'library', 'analysis');
    fs.mkdirSync(this.cacheDir, { recursive: true });
    this.exe = findEngine();
    this.job = null;
    this.caches = new Map(); // gameId -> cache object shared by the review job and best lines
    this.lines = new Map();   // in-flight engine lines by key
    this.prefetchQueue = [];
    this.foreground = 0;      // lines the user is waiting for
    this.idleWaiters = [];
    const cores = Math.max(1, os.cpus().length);
    if (this.exe) {
      this.review = new UciEngine(this.exe, { threads: Math.max(1, cores - 1), hash: 512 });
      // lines are what the user is actively waiting for: give them the whole CPU but one core
      this.interactive = new UciEngine(this.exe, { threads: Math.max(1, cores - 1), hash: 256 });
    }
  }

  status() {
    return {
      available: Boolean(this.exe),
      engine: this.review?.name || 'Stockfish',
      settings: { ...SETTINGS, depth: this.getDepth(), linePlies: this.getLinePlies() },
    };
  }

  #cachePath(id) {
    if (!/^[a-f0-9]{16}$/.test(id)) throw new Error('bad game id');
    return path.join(this.cacheDir, `${id}.json`);
  }

  #readCache(id) {
    try {
      const c = JSON.parse(fs.readFileSync(this.#cachePath(id), 'utf8'));
      if (!COMPATIBLE_VERSIONS.has(c.version)) return null;
      c.version = CACHE_VERSION;
      return c;
    } catch {
      return null;
    }
  }

  /** The game's analysis (engine results per position + computed best lines). */
  #load(id) {
    if (!this.caches.has(id)) {
      const c = this.#readCache(id) || { version: CACHE_VERSION, positions: [] };
      c.bestLines ||= {};
      this.caches.set(id, c);
    }
    return this.caches.get(id);
  }

  #writeCache(id, data) {
    const file = this.#cachePath(id);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
  }

  /** Disk space used by saved analyses. */
  cacheInfo() {
    let bytes = 0;
    let games = 0;
    for (const f of fs.readdirSync(this.cacheDir)) {
      try {
        bytes += fs.statSync(path.join(this.cacheDir, f)).size;
        if (f.endsWith('.json')) games++;
      } catch { /* vanished */ }
    }
    return { bytes, games };
  }

  /** Delete every saved analysis (imported games are not touched). */
  clearCache() {
    if (this.job) {
      this.job.deleted = true;
      this.job.cancelled = true;
    }
    this.caches.clear();
    for (const f of fs.readdirSync(this.cacheDir)) {
      try { fs.unlinkSync(path.join(this.cacheDir, f)); } catch { /* ignore */ }
    }
    return this.cacheInfo();
  }

  deleteCache(id) {
    if (this.job?.gameId === id) this.job.deleted = true; // its loop must not write the file back
    this.caches.delete(id);
    try { fs.unlinkSync(this.#cachePath(id)); } catch { /* none */ }
  }

  /**
   * Analyse a game. `send(event, payload)` streams to the renderer:
   *   analysis:position {gameId, index, total, result}
   *   analysis:done     {gameId, positions, engine}
   *   analysis:error    {gameId, message}
   * Starting a new game cancels the previous job (its partial results are kept).
   */
  async start(game, send) {
    const fens = fensOf(game);
    const cached = this.#load(game.id);
    const reached = (r, depth) => Boolean(r) && (r.lines.length === 0 || r.depth >= depth);
    const countAt = (depth) => fens.reduce((n, _, i) => n + (reached(cached.positions[i], depth) ? 1 : 0), 0);
    const deepDepth = this.getDepth();
    const complete = countAt(deepDepth) === fens.length;
    if (complete) {
      send('analysis:done', { gameId: game.id, positions: cached.positions, engine: cached.engine });
      return { cached: true };
    }
    if (!this.exe) {
      send('analysis:error', { gameId: game.id, message: 'Stockfish engine not found. Run "npm run fetch-engine".' });
      return { cached: false };
    }
    const stages = [['quick', SETTINGS.quickDepth], ['deep', deepDepth]];

    // Re-opening the game that is still being analysed: keep that job running
    // and just send it the results so far (nothing is recomputed or lost).
    if (this.job && this.job.gameId === game.id && !this.job.cancelled) {
      const j = this.job;
      j.send = send;
      j.cached.positions.forEach((r, index) => {
        if (r) send('analysis:position', { gameId: game.id, total: fens.length, stage: j.stage, completed: j.countAt(j.depth), index, result: r });
      });
      return { cached: false, resumed: true };
    }
    if (this.job) this.#stopJob(this.job);
    const job = { gameId: game.id, cancelled: false, cached, send, countAt, stage: 'quick', depth: SETTINGS.quickDepth, lastSave: 0 };
    this.job = job;
    const progress = (stage, depth) => ({ gameId: game.id, total: fens.length, stage, completed: countAt(depth) });

    // stream already-known positions first (a resumed game may be in the deep pass already)
    const resumeStage = countAt(SETTINGS.quickDepth) === fens.length ? ['deep', deepDepth] : ['quick', SETTINGS.quickDepth];
    cached.positions.forEach((r, index) => {
      if (r) send('analysis:position', { ...progress(...resumeStage), index, result: r });
    });

    (async () => {
      try {
        for (const [stage, depth] of stages) {
          job.stage = stage;
          job.depth = depth;
          job.send('analysis:progress', progress(stage, depth));
          for (let i = 0; i < fens.length; i++) {
            if (job.cancelled) break;
            if (reached(cached.positions[i], depth)) continue;
            const r = await this.review.analyse(fens[i], { depth, multipv: SETTINGS.multipv });
            if (job.cancelled) break;
            cached.positions[i] = r;
            job.send('analysis:position', { ...progress(stage, depth), index: i, result: r });
            // save as we go (at most once a second) so nothing is lost if the
            // app is closed or another game is opened mid-analysis
            if (Date.now() - job.lastSave > 1000) this.#save(job);
          }
        }
        cached.engine = this.review.name;
        this.#save(job);
        if (!job.cancelled) {
          job.send('analysis:done', { gameId: game.id, positions: cached.positions, engine: cached.engine });
        }
      } catch (err) {
        this.#save(job);
        if (!job.cancelled) job.send('analysis:error', { gameId: game.id, message: err.message });
      } finally {
        if (this.job === job) this.job = null;
      }
    })();
    return { cached: false };
  }

  #save(job) {
    if (job.deleted) return;
    job.lastSave = Date.now();
    try {
      this.#writeCache(job.gameId, job.cached);
    } catch (err) {
      console.error('could not save analysis', err);
    }
  }

  #stopJob(job) {
    job.cancelled = true;
    this.#save(job);
  }

  /** Stop analysing a game (e.g. it was deleted). Results so far stay saved. */
  cancel(gameId) {
    if (this.job && (!gameId || this.job.gameId === gameId)) this.#stopJob(this.job);
  }

  /**
   * Engine line from a position, both sides playing the engine's best move.
   * The engine is asked again after every move (more accurate than one long
   * PV). Stops at game over, after `plies` half-moves (Settings), or — when a
   * forced mate is found — continues to the mate (up to lineMaxPlies).
   * Used for the Best button ("what should have happened", firstMove = the
   * best move) and for "what happens after the mistake" (no firstMove, from
   * the position after the played move).
   *
   * `onStep({ moves, done })` streams the line as it grows. Finished lines are
   * stored with the game's analysis. A request from the user always runs
   * first; background prefetching pauses while one is in progress.
   * @returns {Promise<{moves: Array<{move, san, scoreBefore}>, finalScore}>}
   *   scoreBefore is the engine score (side to move) of the position before that move.
   */
  async bestLine(fen, { firstMove, gameId, plies } = {}, onStep) {
    const cache = this.#lineCache(gameId);
    const n = this.#plies(plies);
    const key = lineKey(fen, firstMove, n);
    if (cache?.bestLines[key]) {
      onStep?.({ ...cache.bestLines[key], done: true });
      return cache.bestLines[key];
    }
    let job = this.lines.get(key);
    if (!job) job = this.#startLine(key, fen, firstMove, gameId, true, n);
    else if (!job.foreground) this.#promote(job);
    if (onStep) {
      job.listeners.add(onStep);
      if (job.moves.length) onStep({ moves: job.moves.slice(), finalScore: null, done: false });
    }
    try {
      return await job.promise;
    } finally {
      if (onStep) job.listeners.delete(onStep);
    }
  }

  /**
   * Queue lines to compute in the background. The UI only uses this for the
   * second tab of a move the user opened with Best (never game-wide).
   * `front` puts them before the rest. items: [{ fen, firstMove? }]
   */
  prefetchLines(gameId, items, { front = false } = {}) {
    if (!this.exe || !this.#lineCache(gameId)) return;
    const fresh = items
      .map((it) => ({ gameId, fen: String(it.fen), firstMove: it.firstMove || null, plies: this.#plies(it.plies) }))
      .filter((it) => !this.#lineCache(gameId).bestLines[lineKey(it.fen, it.firstMove, it.plies)]);
    const keys = new Set(fresh.map((it) => lineKey(it.fen, it.firstMove, it.plies)));
    const rest = this.prefetchQueue.filter((it) => !keys.has(lineKey(it.fen, it.firstMove, it.plies)));
    this.prefetchQueue = front ? [...fresh, ...rest] : [...rest, ...fresh];
    this.#pump();
  }

  /** Line length: requested value (2–120 half-moves) or the Settings value. */
  #plies(requested) {
    const n = Math.round(Number(requested));
    return Number.isFinite(n) && n >= 2 ? Math.min(120, n) : this.getLinePlies();
  }

  #lineCache(gameId) {
    return gameId && /^[a-f0-9]{16}$/.test(gameId) ? this.#load(gameId) : null;
  }

  async #pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.prefetchQueue.length) {
        const it = this.prefetchQueue.shift();
        const key = lineKey(it.fen, it.firstMove, it.plies);
        if (this.lines.has(key) || this.#lineCache(it.gameId)?.bestLines[key]) continue;
        await this.#startLine(key, it.fen, it.firstMove, it.gameId, false, it.plies).promise.catch(() => {});
      }
    } finally {
      this.pumping = false;
    }
  }

  #promote(job) {
    job.foreground = true;
    this.foreground++;
    this.#wakeWaiters(); // a paused background job that was just promoted continues at once
  }

  #wakeWaiters() {
    this.idleWaiters.splice(0).forEach((r) => r());
  }

  /** Background lines wait here while the user is waiting for another line. */
  async #idle(job) {
    while (!job.foreground && this.foreground > 0) {
      await new Promise((resolve) => this.idleWaiters.push(resolve));
    }
  }

  #startLine(key, fen, firstMove, gameId, foreground, plies) {
    const job = { key, plies, moves: [], listeners: new Set(), foreground: false };
    if (foreground) this.#promote(job);
    this.lines.set(key, job);
    job.promise = (async () => {
      try {
        const result = await this.#computeLine(job, fen, firstMove);
        const cache = this.#lineCache(gameId);
        if (cache && this.caches.get(gameId) === cache) {
          cache.bestLines[key] = result;
          try { this.#writeCache(gameId, cache); } catch (err) { console.error('could not save line', err); }
        }
        for (const l of job.listeners) l({ ...result, done: true });
        return result;
      } finally {
        this.lines.delete(key);
        if (job.foreground) {
          this.foreground--;
          if (this.foreground === 0) this.#wakeWaiters();
        }
      }
    })();
    return job;
  }

  async #computeLine(job, fen, firstMove) {
    if (!this.exe) throw new Error('Stockfish engine not found');
    const chess = new Chess(fen);
    let limit = job.plies;
    const analyse = async () => {
      await this.#idle(job);
      const depth = job.moves.length < 6 ? SETTINGS.lineDepth : SETTINGS.lineTailDepth;
      return this.interactive.analyse(chess.fen(), { depth, multipv: 1 });
    };
    while (job.moves.length < limit && !chess.isGameOver()) {
      const r = await analyse();
      const top = r.lines[0];
      if (!top) break;
      if (top.score.mate !== undefined) {
        limit = Math.min(Math.max(SETTINGS.lineMaxPlies, job.plies), Math.max(limit, job.moves.length + Math.abs(top.score.mate) * 2));
      }
      // Take the engine's move AND its expected reply from one search (the
      // reply comes from the same depth-18 principal variation), so each
      // search advances a full move: twice as fast as one search per ply.
      // The first move can be fixed (the best move found by the review); then
      // the PV no longer applies and only that move is taken.
      const forced = job.moves.length === 0 && firstMove && firstMove !== top.move;
      const plan = forced ? [firstMove] : top.pv.slice(0, 2);
      for (const [k, uci] of plan.entries()) {
        if (job.moves.length >= limit || chess.isGameOver()) break;
        let mv;
        try { mv = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }); } catch { break; }
        job.moves.push({ move: uci, san: mv.san, scoreBefore: k === 0 ? top.score : null });
      }
      for (const l of job.listeners) l({ moves: job.moves.slice(), finalScore: null, done: false });
    }
    // evaluation of the final position (side to move POV)
    let finalScore = null;
    if (!chess.isGameOver()) finalScore = (await analyse()).lines[0]?.score || null;
    return { moves: job.moves.slice(), finalScore };
  }

  quit() {
    if (this.job) this.#stopJob(this.job); // flush partial analysis to disk
    this.review?.quit();
    this.interactive?.quit();
  }
}

function fensOf(game) {
  const chess = game.startFen ? new Chess(game.startFen) : new Chess();
  const fens = [chess.fen()];
  for (const san of game.sans) {
    chess.move(san);
    fens.push(chess.fen());
  }
  return fens;
}

function lineKey(fen, firstMove, plies) {
  // lines saved with other depths are recalculated
  return `${fen}|${firstMove || ''}|${plies}|${SETTINGS.lineDepth}|${SETTINGS.lineTailDepth}`;
}

module.exports = { AnalysisService, SETTINGS, CACHE_VERSION, fensOf };
