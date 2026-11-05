// Classification rules, tested with hand-made engine output (no Stockfish needed).
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const R = path.join(__dirname, '..', 'src', 'renderer');
const load = async () => ({
  ...(await import(path.join(R, 'js/analysis/classify.js'))),
  ...(await import(path.join(R, 'js/timeline.js'))),
  OPENINGS: (await import(path.join(R, 'data/openings.js'))).OPENINGS,
});

const line = (move, score, pv = [move]) => ({ move, score, pv, depth: 20 });
const cp = (v) => ({ cp: v });

test('grades by expected points lost', async () => {
  const { classifyGame, buildTimeline } = await load();
  // 1. a4 (white), black replies; give engine data for position 0 and 1
  const t = buildTimeline({ sans: ['a4', 'e5'] });
  const positions = [
    { lines: [line('e2e4', cp(30)), line('d2d4', cp(28))] }, // before a4 (white to move)
    { lines: [line('e7e5', cp(20))] },                       // after a4, black to move: black +0.2
    { lines: [line('g1f3', cp(25))] },
  ];
  const r = classifyGame(t, positions, {}); // no opening book
  // a4: best E(+0.30) vs played E(-0.20) for white => ~0.046 loss => good
  assert.strictEqual(r.moves[0].classification, 'good');
  // e5 is the engine's top move => best
  assert.strictEqual(r.moves[1].classification, 'best');
});

test('blunder, mistake and inaccuracy thresholds', async () => {
  const { classifyGame, buildTimeline } = await load();
  const t = buildTimeline({ sans: ['h4'] });
  // whiteAfter: evaluation after h4 from white's point of view (engine reports black's)
  const mk = (whiteAfter) => classifyGame(t, [
    { lines: [line('e2e4', cp(30))] },
    { lines: [line('e7e5', cp(-whiteAfter))] },
  ], {}).moves[0].classification;
  assert.strictEqual(mk(30), 'best');         // no loss
  assert.strictEqual(mk(15), 'excellent');    // ~0.014
  assert.strictEqual(mk(-60), 'inaccuracy');  // ~0.08
  assert.strictEqual(mk(-150), 'mistake');    // ~0.16
  assert.strictEqual(mk(-600), 'blunder');
});

test('book moves come from the opening database', async () => {
  const { classifyGame, buildTimeline, OPENINGS } = await load();
  const t = buildTimeline({ sans: ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5'] });
  const r = classifyGame(t, [], OPENINGS);
  assert.ok(r.moves.every((m) => m.classification === 'book'));
  assert.match(r.moves[4].opening.name, /Ruy Lopez/);
});

test('forced: the only legal move', async () => {
  const { classifyGame, buildTimeline } = await load();
  // black king on a8, rooks on b2/c1: Ka7 is the only legal move
  const t = buildTimeline({ startFen: 'k7/8/8/8/8/8/1R6/2R4K b - - 0 1', sans: ['Ka7'] });
  const r = classifyGame(t, [
    { lines: [line('a8a7', { mate: -2 })] },
    { lines: [line('c1c7', { mate: 2 })] },
  ], {});
  assert.strictEqual(r.moves[0].classification, 'forced');
});

test('great: the only good move', async () => {
  const { classifyGame, buildTimeline } = await load();
  const t = buildTimeline({ sans: ['d4'] });
  const r = classifyGame(t, [
    { lines: [line('d2d4', cp(150)), line('e2e4', cp(-200))] },
    { lines: [line('d7d5', cp(-150))] },
  ], {});
  assert.strictEqual(r.moves[0].classification, 'great');
});

test('brilliant: Legal\'s mate queen sacrifice', async () => {
  const { classifyGame, buildTimeline } = await load();
  const sans = ['e4', 'e5', 'Nf3', 'd6', 'Bc4', 'Bg4', 'Nc3', 'g6', 'Nxe5'];
  const t = buildTimeline({ sans });
  const positions = [];
  positions[8] = { lines: [line('f3e5', { mate: 3 }), line('h2h3', cp(50))] };
  positions[9] = { lines: [line('g4d1', { mate: -2 }, ['g4d1', 'c4f7', 'e8e7', 'c3d5'])] };
  const r = classifyGame(t, positions, {});
  assert.strictEqual(r.moves[8].classification, 'brilliant');
});

test('miss: failing to punish a blunder', async () => {
  const { classifyGame, buildTimeline } = await load();
  const t = buildTimeline({ sans: ['e4', 'f6', 'a3'] });
  const r = classifyGame(t, [
    { lines: [line('e2e4', cp(30))] },
    { lines: [line('e7e5', cp(-30))] },             // black to move, roughly equal
    { lines: [line('d1h5', cp(400))] },             // after f6?: white could win big
    { lines: [line('e7e5', cp(-40))] },             // after a3: back to ~equal
  ], {});
  assert.strictEqual(r.moves[1].classification, 'blunder');
  assert.strictEqual(r.moves[2].classification, 'miss');
});

test('checkmate final position and accuracy', async () => {
  const { classifyGame, buildTimeline } = await load();
  const t = buildTimeline({ sans: ['f3', 'e5', 'g4', 'Qh4#'] });
  const positions = [
    { lines: [line('e2e4', cp(30))] },
    { lines: [line('e7e5', cp(-60))] },
    { lines: [line('e2e4', cp(-50))] },
    { lines: [line('d8h4', { mate: 1 })] },
    { lines: [] },
  ];
  const r = classifyGame(t, positions, {});
  assert.deepStrictEqual(r.moves[3].evalAfter, { mate: 0, winner: 'b' });
  assert.strictEqual(r.moves[3].classification, 'best');
  assert.strictEqual(r.moves[2].classification, 'blunder');
  assert.ok(r.accuracy.b > r.accuracy.w);
  assert.ok(r.complete);
});

test('brilliant is rarer: a piece that was already hanging is no sacrifice', async () => {
  const { classifyGame, buildTimeline, BRILLIANT_RULES_V1 } = await load();
  // 1.e4 d5 2.a3?! — the e4 pawn... use a knight: after 1.Nc3 d5 2.Nf3 d4, the c3 knight
  // is attacked; 3.a3 leaves it hanging (it already was) and dxc3 takes it.
  const t = buildTimeline({ sans: ['Nc3', 'd5', 'Nf3', 'd4', 'a3'] });
  const positions = [];
  positions[4] = { lines: [line('a2a3', cp(40)), line('c3e4', cp(20))] }; // engine likes a3 (fake data)
  positions[5] = { lines: [line('d4c3', cp(-40), ['d4c3', 'd2c3'])] };
  const old = classifyGame(t, positions, {}, { brilliant: BRILLIANT_RULES_V1 }).moves[4].classification;
  const now = classifyGame(t, positions, {}).moves[4].classification;
  assert.strictEqual(old, 'brilliant', 'the first version called this brilliant');
  assert.notStrictEqual(now, 'brilliant');
});
