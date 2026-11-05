const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseText } = require('../src/main/pgn-import');
const { GameStore } = require('../src/main/storage');

const SAMPLE = `[Event "Play vs Bot"]
[Site "Chess.com"]
[Date "2026.11.04"]
[White "AlexAsad"]
[Black "Maria-BOT"]
[Result "1-0"]
[WhiteElo "570"]
[BlackElo "1000"]

1. e4 e5 2. Nf3 Nc6 3. Nc3 Nf6 4. Bc4 Nxe4 5. Nxe4 d5 6. Bxd5 Qxd5 1-0
`;

test('parses a chess.com PGN', () => {
  const { games, errors } = parseText(SAMPLE, 'a.pgn');
  assert.deepStrictEqual(errors, []);
  const g = games[0];
  assert.strictEqual(g.name, 'AlexAsad vs Maria-BOT');
  assert.strictEqual(g.plies, 12);
  assert.strictEqual(g.movesCount, 6);
  assert.strictEqual(g.date, '2026-11-04');
  assert.strictEqual(g.whiteElo, '570');
});

test('splits multi-game files', () => {
  const two = `${SAMPLE}\n${SAMPLE.replace('Maria-BOT', 'Other')}`;
  assert.strictEqual(parseText(two).games.length, 2);
});

test('handles comments, variations, NAGs and CRLF', () => {
  const { games } = parseText('1. e4 {best by test} e5 (1... c5 2. Nf3) 2. Nf3!? $1 Nc6\r\n3. Bb5 a6 *');
  assert.deepStrictEqual(games[0].sans, ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6']);
});

test('reads loose move lists from plain text', () => {
  const { games } = parseText('my game:\ne4 e5\nNf3 Nc6\n0-0 is not legal here');
  assert.deepStrictEqual(games[0].sans, ['e4', 'e5', 'Nf3', 'Nc6']);
});

test('reports text without moves', () => {
  const { games, errors } = parseText('hello world');
  assert.strictEqual(games.length, 0);
  assert.strictEqual(errors.length, 1);
});

test('store persists across instances and dedupes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chess-store-'));
  try {
    const a = new GameStore(dir);
    const [g] = a.add(parseText(SAMPLE).games);
    a.add(parseText(SAMPLE).games); // re-import
    const b = new GameStore(dir); // "app restart"
    assert.strictEqual(b.list().length, 1);
    assert.strictEqual(b.get(g.id).sans.length, 12);
    b.remove(g.id);
    assert.strictEqual(new GameStore(dir).list().length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('multi-game chess.com export: every game, in order, with times', () => {
  const game = (w, b, time, moves, result) => `[Event "Live Chess"]\n[Site "Chess.com"]\n[Date "2026.11.03"]\n[White "${w}"]\n[Black "${b}"]\n[Result "${result}"]\n[EndTime "${time} GMT+0000"]\n\n${moves} ${result}\n`;
  const text = [
    game('A', 'B', '19:43:16', '1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7#', '1-0'),
    game('A', 'C', '19:57:47', '1. e3 Nf6 2. d4 Ng8 3. Nf3', '1-0'),
    game('D', 'A', '20:08:15', '1. f3 e5 2. g4 Qh4#', '0-1'),
  ].join('\n');
  const { games, errors } = parseText(text);
  assert.deepStrictEqual(errors, []);
  assert.deepStrictEqual(games.map((g) => g.name), ['A vs B', 'A vs C', 'D vs A']);
  assert.deepStrictEqual(games.map((g) => g.plies), [7, 5, 4]);
  assert.strictEqual(games[0].time, '19:43');
  assert.strictEqual(new Set(games.map((g) => g.id)).size, 3);
});

test('header-less games separated only by results', () => {
  const { games } = parseText('1. e4 e5 2. Nf3 Nc6 1-0 1. d4 d5 2. c4 0-1\n1. c4 e5 1/2-1/2');
  assert.deepStrictEqual(games.map((g) => g.sans.length), [4, 3, 2]);
  assert.deepStrictEqual(games.map((g) => g.result), ['1-0', '0-1', '1/2-1/2']);
});

test('multi-game import keeps file order for "recently opened"', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chess-store-'));
  try {
    const store = new GameStore(dir);
    const { games } = parseText(`${SAMPLE}\n${SAMPLE.replace('Maria-BOT', 'Other')}`);
    const added = store.add(games);
    assert.ok(added.every((g) => g.lastOpenedAt === null));
    assert.ok(added[1].importedAt > added[0].importedAt);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
