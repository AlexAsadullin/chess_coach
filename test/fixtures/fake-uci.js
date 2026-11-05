#!/usr/bin/env node
// Minimal fake UCI engine for tests: instantly "finds" the first legal move.
// FAKE_UCI_DELAY (ms) slows every search down so tests can interrupt it.
const path = require('path');
const { Chess } = require(path.join(__dirname, '..', '..', 'node_modules', 'chess.js'));

const delay = Number(process.env.FAKE_UCI_DELAY || 0);
let buf = '';
let fen = new Chess().fen();
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line.startsWith('position fen ')) fen = line.slice('position fen '.length);
    else if (line === 'uci') process.stdout.write('id name FakeFish\nuciok\n');
    else if (line === 'isready') process.stdout.write('readyok\n');
    else if (line.startsWith('go')) {
      const depth = Number((/depth (\d+)/.exec(line) || [])[1] || 1);
      const moves = new Chess(fen).moves({ verbose: true }).map((m) => m.from + m.to + (m.promotion || ''));
      const out = moves.length
        ? `info depth ${depth} multipv 1 score cp 25 pv ${moves[0]}\n` +
          (moves[1] ? `info depth ${depth} multipv 2 score cp 10 pv ${moves[1]}\n` : '') +
          `bestmove ${moves[0]}\n`
        : 'info depth 0 score mate 0\nbestmove (none)\n';
      setTimeout(() => process.stdout.write(out), delay);
    } else if (line === 'quit') process.exit(0);
  }
});
