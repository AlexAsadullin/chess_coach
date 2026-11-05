/**
 * Turns arbitrary text (PGN preferred) into normalized game records.
 * Pure Node module — no Electron imports, so it is unit-testable.
 */
const crypto = require('crypto');
const { Chess } = require('chess.js');

/** Split a text that may contain many PGN games into one chunk per game. */
function splitGames(text) {
  const lines = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  const chunks = [];
  let cur = [];
  let seenMoves = false;
  for (const line of lines) {
    const isTag = /^\s*\[\w+\s+".*"\s*\]\s*$/.test(line);
    if (isTag && seenMoves) {
      chunks.push(cur.join('\n'));
      cur = [];
      seenMoves = false;
    }
    if (!isTag && line.trim()) seenMoves = true;
    cur.push(line);
  }
  if (cur.join('').trim()) chunks.push(cur.join('\n'));
  return chunks.flatMap(splitOnResults).map((c) => c.trim()).filter(Boolean);
}

/**
 * Games without tag headers (or glued together) are only separated by their
 * result token: "... 1-0 1. e4 ...". Split there. Text inside {comments} is
 * ignored while searching.
 */
function splitOnResults(chunk) {
  const parts = [];
  let start = 0;
  let depth = 0;
  const re = /[{}]|(?:^|\s)(1-0|0-1|1\/2-1\/2|\*)(?=\s+\d+\s*\.)/g;
  let m;
  while ((m = re.exec(chunk))) {
    if (m[0] === '{') depth++;
    else if (m[0] === '}') depth = Math.max(0, depth - 1);
    else if (depth === 0) {
      const end = m.index + m[0].length;
      parts.push(chunk.slice(start, end));
      start = end;
    }
  }
  parts.push(chunk.slice(start));
  return parts.filter((p) => p.trim());
}

/** Remove comments, variations, NAGs and annotation glyphs from movetext. */
function stripMovetext(movetext) {
  let s = movetext.replace(/\{[^}]*\}/g, ' ').replace(/;[^\n]*/g, ' ');
  // remove nested variations
  let prev;
  do {
    prev = s;
    s = s.replace(/\([^()]*\)/g, ' ');
  } while (s !== prev);
  return s
    .replace(/\$\d+/g, ' ')
    .replace(/[!?]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseHeaders(chunk) {
  const headers = {};
  const re = /^\s*\[(\w+)\s+"((?:[^"\\]|\\.)*)"\s*\]\s*$/gm;
  let m;
  while ((m = re.exec(chunk))) headers[m[1]] = m[2].replace(/\\"/g, '"');
  const movetext = chunk.replace(re, '').trim();
  return { headers, movetext };
}

/** Best-effort: replay SAN-ish tokens from any text. */
function movesFromLooseText(text, fen) {
  const chess = fen ? new Chess(fen) : new Chess();
  const tokens = stripMovetext(text)
    .replace(/\d+\.(\.\.)?/g, ' ')
    .split(/[\s,]+/)
    .filter((t) => t && !/^(1-0|0-1|1\/2-1\/2|\*)$/.test(t));
  const sans = [];
  for (const tok of tokens) {
    const clean = tok.replace(/0-0-0/g, 'O-O-O').replace(/0-0/g, 'O-O');
    try {
      const mv = chess.move(clean, { strict: false });
      sans.push(mv.san);
    } catch {
      if (sans.length) break; // movetext ended
    }
  }
  return sans;
}

function normalizeDate(d) {
  if (!d) return null;
  const m = /^(\d{4})[.\-/](\d{2}|\?\?)[.\-/](\d{2}|\?\?)/.exec(d);
  if (!m || m[2] === '??') return m ? `${m[1]}-01-01` : null;
  return `${m[1]}-${m[2]}-${m[3] === '??' ? '01' : m[3]}`;
}

function normalizeTime(t) {
  const m = /^(\d{1,2}):(\d{2})/.exec(t || '');
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null;
}

function buildPgn(headers, sans, startFen) {
  const order = ['Event', 'Site', 'Date', 'Round', 'White', 'Black', 'Result'];
  const keys = [...order.filter((k) => k in headers), ...Object.keys(headers).filter((k) => !order.includes(k))];
  const head = keys.map((k) => `[${k} "${String(headers[k]).replace(/"/g, '\\"')}"]`).join('\n');
  const ply0 = startFen ? (startFen.split(' ')[1] === 'b' ? 1 : 0) : 0;
  const fullMove0 = startFen ? parseInt(startFen.split(' ')[5] || '1', 10) : 1;
  const parts = [];
  sans.forEach((san, i) => {
    const ply = i + ply0;
    const num = fullMove0 + Math.floor(ply / 2);
    if (ply % 2 === 0) parts.push(`${num}. ${san}`);
    else if (i === 0) parts.push(`${num}... ${san}`);
    else parts.push(san);
  });
  parts.push(headers.Result || '*');
  return `${head}\n\n${parts.join(' ')}\n`;
}

/** Parse one chunk into a game record, or throw. */
function parseGame(chunk, sourceName) {
  const { headers, movetext } = parseHeaders(chunk);
  const startFen = headers.SetUp === '1' || headers.FEN ? headers.FEN : undefined;
  let sans = [];
  try {
    const chess = new Chess();
    chess.loadPgn(chunk, { strict: false });
    sans = chess.history();
  } catch {
    // retry with comments/variations stripped, then a loose token scan
    try {
      const chess = new Chess();
      const head = Object.entries(headers).map(([k, v]) => `[${k} "${v}"]`).join('\n');
      chess.loadPgn(`${head}\n\n${stripMovetext(movetext)}`, { strict: false });
      sans = chess.history();
    } catch {
      sans = movesFromLooseText(movetext, startFen);
    }
  }
  if (!sans.length) throw new Error('No legal chess moves found');

  const white = headers.White && headers.White !== '?' ? headers.White : 'White';
  const black = headers.Black && headers.Black !== '?' ? headers.Black : 'Black';
  const tail = /(1-0|0-1|1\/2-1\/2|\*)\s*$/.exec(movetext.replace(/\{[^}]*\}/g, ' ').trim());
  const result = headers.Result || tail?.[1] || '*';
  const cleanHeaders = { ...headers, White: white, Black: black, Result: result };
  const pgn = buildPgn(cleanHeaders, sans, startFen);
  const t = headers.UTCTime || headers.StartTime || headers.EndTime;
  const when = `${headers.Date || ''}${t ? `|${t}` : ''}`; // ids of games without a time stay stable
  const id = crypto.createHash('sha1').update(`${white}|${black}|${when}|${startFen || ''}|${sans.join(' ')}`).digest('hex').slice(0, 16);
  return {
    id,
    name: `${white} vs ${black}`,
    white,
    black,
    whiteElo: headers.WhiteElo && headers.WhiteElo !== '?' ? headers.WhiteElo : null,
    blackElo: headers.BlackElo && headers.BlackElo !== '?' ? headers.BlackElo : null,
    result,
    event: headers.Event || null,
    site: headers.Site || null,
    termination: headers.Termination || null,
    date: normalizeDate(headers.Date || headers.UTCDate || headers.EndDate),
    time: normalizeTime(headers.UTCTime || headers.StartTime || headers.EndTime || headers.Time),
    startFen: startFen || null,
    plies: sans.length,
    movesCount: Math.ceil(sans.length / 2),
    sans,
    pgn,
    source: sourceName || null,
  };
}

/**
 * Parse any text. Returns { games, errors } where errors lists chunks that
 * could not be read (so the UI can tell the user).
 */
function parseText(text, sourceName) {
  const games = [];
  const errors = [];
  for (const [i, chunk] of splitGames(text).entries()) {
    try {
      games.push(parseGame(chunk, sourceName));
    } catch (e) {
      errors.push({ index: i, message: e.message });
    }
  }
  return { games, errors };
}

module.exports = { parseText, parseGame, splitGames, stripMovetext, normalizeDate };
