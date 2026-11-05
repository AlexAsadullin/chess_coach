// Analysis results are saved with the game and survive restarts / interruptions.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FAKE = path.join(__dirname, 'fixtures', 'fake-uci.js');
const skip = process.platform === 'win32' ? 'fake engine needs a shebang' : false;
const GAME = { id: '0123456789abcdef', sans: ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6'] };

function freshService(dir, env = {}) {
  Object.assign(process.env, { STOCKFISH_PATH: FAKE, FAKE_UCI_DELAY: '0' }, env);
  delete require.cache[require.resolve('../src/main/analysis-service')];
  const { AnalysisService } = require('../src/main/analysis-service');
  return new AnalysisService(dir);
}

function run(service, game) {
  return new Promise((resolve) => {
    const events = [];
    service.start(game, (ch, p) => {
      events.push([ch, p]);
      if (ch === 'analysis:done' || ch === 'analysis:error') resolve(events);
    });
  });
}

test('finished analysis is stored and reused after a restart', { skip }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-analysis-'));
  try {
    const a = freshService(dir);
    const first = await run(a, GAME);
    a.quit();
    assert.strictEqual(first.at(-1)[0], 'analysis:done');
    const file = path.join(dir, 'library', 'analysis', `${GAME.id}.json`);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(saved.positions.length, GAME.sans.length + 1);
    assert.ok(saved.positions.every((p) => p.depth >= 20));

    const b = freshService(dir); // "app restarted"
    const second = await run(b, GAME);
    b.quit();
    assert.strictEqual(second.length, 1, 'served from disk, no engine work');
    assert.strictEqual(second[0][0], 'analysis:done');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('interrupted analysis keeps its progress and resumes', { skip }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-analysis-'));
  try {
    const a = freshService(dir, { FAKE_UCI_DELAY: '30' });
    const seen = [];
    a.start(GAME, (ch, p) => { if (ch === 'analysis:position') seen.push(p.index); });
    while (seen.length < 4) await new Promise((r) => setTimeout(r, 10));
    a.quit(); // app closed mid-analysis
    const file = path.join(dir, 'library', 'analysis', `${GAME.id}.json`);
    const partial = JSON.parse(fs.readFileSync(file, 'utf8')).positions.filter(Boolean).length;
    assert.ok(partial >= 4, `saved ${partial} positions before quitting`);

    const b = freshService(dir);
    const events = await run(b, GAME);
    b.quit();
    assert.strictEqual(events.at(-1)[0], 'analysis:done');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('engine lines: 26 half-moves, streamed, cached with the game', { skip }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-analysis-'));
  let a;
  let b;
  try {
    a = freshService(dir);
    const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const steps = [];
    const line = await a.bestLine(fen, { firstMove: 'e2e4', gameId: GAME.id }, (p) => steps.push(p.moves.length));
    assert.strictEqual(line.moves.length, 26);
    assert.strictEqual(line.moves[0].san, 'e4', 'first move is the forced best move');
    assert.ok(steps.length >= 26 && steps.at(-1) === 26, 'progress streamed move by move');
    b = freshService(dir);
    const again = await b.bestLine(fen, { firstMove: 'e2e4', gameId: GAME.id });
    assert.deepStrictEqual(again, line);
    assert.strictEqual(b.interactive.proc, undefined, 'engine never started: answer came from disk');
  } finally {
    a?.quit();
    b?.quit();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('background prefetch fills the cache; a user request goes first', { skip }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-analysis-'));
  let a;
  try {
    a = freshService(dir, { FAKE_UCI_DELAY: '5' });
    const start = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const afterE4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
    a.prefetchLines(GAME.id, [{ fen: start, firstMove: 'd2d4' }, { fen: afterE4 }]);
    await new Promise((r) => setTimeout(r, 30)); // background has started
    const t0 = Date.now();
    const user = await a.bestLine(start, { firstMove: 'c2c4', gameId: GAME.id });
    const userMs = Date.now() - t0;
    assert.strictEqual(user.moves[0].san, 'c4');
    while (a.pumping) await new Promise((r) => setTimeout(r, 20));
    const file = JSON.parse(fs.readFileSync(path.join(dir, 'library', 'analysis', `${GAME.id}.json`), 'utf8'));
    assert.strictEqual(Object.keys(file.bestLines).length, 3, 'both prefetched lines + the user line saved');
    // the user line (27 engine calls) must not have waited for the 2 background lines (54 calls)
    assert.ok(userMs < 27 * 5 * 3, `user line took ${userMs} ms`);
  } finally {
    a?.quit();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('opening a line that is queued in the background does not stall', { skip }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-analysis-'));
  let a;
  try {
    a = freshService(dir, { FAKE_UCI_DELAY: '3' });
    const start = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const afterE4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
    const first = a.bestLine(start, { firstMove: 'e2e4', gameId: GAME.id }); // user is waiting for this
    a.prefetchLines(GAME.id, [{ fen: afterE4 }]); // the other tab, queued -> paused
    await new Promise((r) => setTimeout(r, 20));
    const t0 = Date.now();
    const [, second] = await Promise.all([first, a.bestLine(afterE4, { gameId: GAME.id })]); // user switches tab
    assert.strictEqual(second.moves.length, 26);
    assert.ok(Date.now() - t0 < 5000, 'finished promptly');
  } finally {
    a?.quit();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('line length follows Settings and can be extended from the end', { skip }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-analysis-'));
  let a;
  try {
    Object.assign(process.env, { STOCKFISH_PATH: FAKE, FAKE_UCI_DELAY: '0' });
    delete require.cache[require.resolve('../src/main/analysis-service')];
    const { AnalysisService } = require('../src/main/analysis-service');
    let setting = 10;
    a = new AnalysisService(dir, () => 20, () => setting);
    const start = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const first = await a.bestLine(start, { gameId: GAME.id });
    assert.strictEqual(first.moves.length, 10, 'uses the Settings length');
    // "calculate more": continue from the last position of the line
    const { Chess } = require('chess.js');
    const c = new Chess(start);
    first.moves.forEach((m) => c.move({ from: m.move.slice(0, 2), to: m.move.slice(2, 4), promotion: m.move[4] }));
    const more = await a.bestLine(c.fen(), { gameId: GAME.id });
    assert.strictEqual(more.moves.length, 10);
    setting = 16;
    assert.strictEqual((await a.bestLine(start, { gameId: GAME.id })).moves.length, 16, 'new setting, new line');
    assert.strictEqual((await a.bestLine(start, { gameId: GAME.id, plies: 4 })).moves.length, 4, 'explicit length wins');
  } finally {
    a?.quit();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
