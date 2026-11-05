/**
 * Minimal UCI client for a native Stockfish process.
 * One search at a time; calls are queued.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const EXE = process.platform === 'win32' ? 'stockfish.exe' : 'stockfish';
const OS_NAME = { darwin: 'mac', win32: 'win', linux: 'linux' }[process.platform];

/** Where to find the engine: env override, packaged resources, dev folder. */
function findEngine() {
  const candidates = [
    process.env.STOCKFISH_PATH,
    process.resourcesPath && path.join(process.resourcesPath, 'engine', EXE),
    path.join(__dirname, '..', '..', 'engine', `${OS_NAME}-${process.arch}`, EXE),
  ].filter(Boolean);
  return candidates.find((p) => {
    try { return fs.statSync(p).isFile(); } catch { return false; }
  }) || null;
}

/** Parse one "info ..." line into {depth, multipv, score, pv} or null. */
function parseInfo(line) {
  if (!line.startsWith('info ') || !line.includes(' pv ')) return null;
  if (/ (lowerbound|upperbound)( |$)/.test(line)) return null;
  const tok = line.split(' ');
  const out = { multipv: 1 };
  for (let i = 1; i < tok.length; i++) {
    const t = tok[i];
    if (t === 'depth') out.depth = Number(tok[++i]);
    else if (t === 'multipv') out.multipv = Number(tok[++i]);
    else if (t === 'score') {
      const kind = tok[++i];
      const val = Number(tok[++i]);
      out.score = kind === 'mate' ? { mate: val } : { cp: val };
    } else if (t === 'pv') {
      out.pv = tok.slice(i + 1);
      break;
    }
  }
  return out.score && out.pv?.length ? out : null;
}

class UciEngine {
  constructor(exePath, { threads = 1, hash = 128 } = {}) {
    this.exePath = exePath;
    this.options = { Threads: threads, Hash: hash };
    this.queue = Promise.resolve();
    this.listeners = new Set();
    this.waiters = new Set();
    this.name = 'Stockfish';
  }

  async start() {
    if (this.proc) return;
    this.proc = spawn(this.exePath, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    const onGone = () => {
      this.proc = null;
      for (const w of [...this.waiters]) w.reject(new Error('engine exited'));
      this.waiters.clear();
      this.listeners.clear();
    };
    this.proc.on('exit', onGone);
    this.proc.on('error', onGone);
    let buf = '';
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line.startsWith('id name ')) this.name = line.slice(8);
        for (const l of [...this.listeners]) l(line);
      }
    });
    this.#send('uci');
    await this.#waitFor((l) => l === 'uciok');
    for (const [k, v] of Object.entries(this.options)) this.#send(`setoption name ${k} value ${v}`);
    this.#send('isready');
    await this.#waitFor((l) => l === 'readyok');
  }

  #send(cmd) {
    this.proc?.stdin.write(`${cmd}\n`);
  }

  #waitFor(pred, onLine) {
    return new Promise((resolve, reject) => {
      if (!this.proc) {
        reject(new Error('engine not running'));
        return;
      }
      const waiter = { reject };
      const fn = (line) => {
        onLine?.(line);
        if (pred(line)) {
          this.listeners.delete(fn);
          this.waiters.delete(waiter);
          resolve(line);
        }
      };
      this.listeners.add(fn);
      this.waiters.add(waiter);
    });
  }

  /**
   * Analyse one position.
   * @returns {Promise<{depth:number, lines:Array<{move, score, pv}>}>}
   *   score is from the side to move's point of view; lines = [] when the
   *   game is over in that position.
   */
  analyse(fen, { depth = 20, multipv = 1, movetime } = {}) {
    const job = async () => {
      await this.start();
      const best = new Map();
      this.#send(`setoption name MultiPV value ${multipv}`);
      this.#send(`position fen ${fen}`);
      this.#send(movetime ? `go movetime ${movetime}` : `go depth ${depth}`);
      let reached = 0;
      await this.#waitFor((l) => l.startsWith('bestmove'), (line) => {
        const info = parseInfo(line);
        if (!info) return;
        reached = Math.max(reached, info.depth || 0);
        best.set(info.multipv, { move: info.pv[0], score: info.score, pv: info.pv, depth: info.depth });
      });
      const lines = [...best.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
      return { depth: reached, lines };
    };
    const p = this.queue.then(job, job);
    this.queue = p.catch(() => {});
    return p;
  }

  quit() {
    if (!this.proc) return;
    this.#send('quit');
    const p = this.proc;
    setTimeout(() => p.kill(), 500);
    this.proc = null;
  }
}

module.exports = { UciEngine, findEngine, parseInfo };
