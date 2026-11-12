/** Game library: import + sortable column list of saved games. */
import { UI_ICONS } from './icons.js';
import { api } from './api.js';
import { toast, escapeHtml, formatDate } from './util.js';
import { confirmDialog, formatBytes } from './modal.js';
import { openSettings } from './settings-view.js';
import { Chess } from '../vendor/chess.js';
import { Board } from './board.js';

const SORT_KEY = 'library.sort';
const PIN_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m16 3 5 5-4 1-4 4 1 4-2 2-4-6-6-4 2-2 4 1 4-4z"/><path d="m8 16-5 5"/></svg>';
const COLUMNS = [
  { key: 'name', label: 'Name' },
  { key: 'movesCount', label: 'Moves' },
  { key: 'date', label: 'Date' },
];

function loadSort() {
  try {
    const s = JSON.parse(localStorage.getItem(SORT_KEY));
    if (s && ['name', 'movesCount', 'date', 'lastOpenedAt'].includes(s.key)) return s;
  } catch { /* ignore */ }
  return { key: 'lastOpenedAt', dir: 'desc' };
}

export class LibraryView {
  constructor(root, { onOpen, onPlayBot, onResumeBot }) {
    this.root = root;
    this.onOpen = onOpen;
    this.onPlayBot = onPlayBot;
    this.onResumeBot = onResumeBot;
    this.games = [];
    this.sort = loadSort();
    this.filter = '';
  }

  async show() {
    const [games, cache] = await Promise.all([api.listGames(), api.cacheInfo?.() ?? null]);
    this.games = games;
    this.cache = cache;
    this.render();
  }

  async importFile() {
    const res = await api.importDialog();
    if (res) this.#afterImport(res);
  }

  async importDropped(files) {
    this.#afterImport(await api.importFiles(files));
  }

  async #playBot() {
    this.onPlayBot?.();
  }

  async #openImported(pgn) { const res=await api.importText(pgn); if(res.games?.[0]) { this.onOpen(res.games[0].id); return; } toast('Could not save this game for analysis','error'); }

  #createPosition() {
    let editorPrefs={moves:30,turn:'w'};try{editorPrefs={...editorPrefs,...JSON.parse(localStorage.getItem('customPosition.preferences')||'{}')};}catch{}
    const pieceSet=[['K','Q','R','B','N','P'],['k','q','r','b','n','p']];
    const glyph={K:'♔',Q:'♕',R:'♖',B:'♗',N:'♘',P:'♙',k:'♚',q:'♛',r:'♜',b:'♝',n:'♞',p:'♟'};
    const el=this.root; el.innerHTML=`<div class="review custom-position-screen"><header class="review-header"><button class="btn btn-ghost back-btn" id="positionBack">${UI_ICONS.back}<span>Games</span></button><div class="review-title"><span class="title-main">Create position</span><span class="title-sub">Set up a position for analysis</span></div></header><div class="review-body"><main class="review-main"><div class="coach"><div class="coach-head"><span class="coach-title">Create position</span><span class="coach-hint" id="positionHint">Place both kings to calculate.</span></div></div><div class="board-area"><div class="board-stack"><div id="positionBoard"></div></div></div><div class="review-actions"><button class="btn btn-secondary" id="savePosition">Save position</button><button class="btn btn-primary" id="analyzePosition">Calculate best moves</button></div></main><aside class="review-side"><div class="summary piece-palette"><section><h3>White</h3><div class="palette-grid">${pieceSet[0].map(p=>`<button class="palette-piece white-piece" data-piece="${p}" title="White ${p}">${glyph[p]}</button>`).join('')}</div></section><section><h3>Black</h3><div class="palette-grid">${pieceSet[1].map(p=>`<button class="palette-piece black-piece" data-piece="${p}" title="Black ${p}">${glyph[p]}</button>`).join('')}</div></section><button class="btn btn-secondary erase-piece" data-piece="erase">⌫ <span>Eraser</span></button><div class="position-turn"><span>Side to move</span><div class="seg"><button class="${editorPrefs.turn==='w'?'on':''}" data-turn="w">White</button><button class="${editorPrefs.turn==='b'?'on':''}" data-turn="b">Black</button></div></div><div class="position-calculation"><label for="positionMoveCount">Calculate best line for</label><div class="move-count-control"><input id="positionMoveCount" type="number" min="1" max="60" value="${editorPrefs.moves}"><span>full moves</span></div></div></div></aside></div></div>`;
    el.querySelector('#positionBack').onclick=()=>{resize.disconnect();this.show();};
    const board=new Board(el.querySelector('#positionBoard')); const piecesAt=new Map();
    const area=el.querySelector('.board-area'),stack=el.querySelector('.board-stack');const fit=()=>{const target=el.querySelector('#positionBoard');if(!target||!area.isConnected)return;const size=Math.max(240,Math.floor(Math.min(area.clientWidth,area.clientHeight)/8)*8);stack.style.width=`${size}px`;target.style.height=`${size}px`;};const resize=new ResizeObserver(fit);resize.observe(area);fit();
    let active='P',turn=editorPrefs.turn;
    const render=()=>board.render({pieces:[...piecesAt].map(([square,c])=>({id:square,square,color:c===c.toUpperCase()?'w':'b',type:c.toLowerCase()}))});
    el.querySelectorAll('[data-piece]').forEach(b=>b.onclick=()=>{active=b.dataset.piece;el.querySelectorAll('.palette-piece,.erase-piece').forEach(x=>x.classList.toggle('selected',x===b));});
    el.querySelector('.palette-piece').classList.add('selected');
    el.querySelectorAll('[data-turn]').forEach(b=>b.onclick=()=>{turn=b.dataset.turn;el.querySelectorAll('[data-turn]').forEach(x=>x.classList.toggle('on',x===b));this.#savePositionPrefs(el,turn);});
    el.querySelector('#positionMoveCount').onchange=()=>this.#savePositionPrefs(el,turn);
    el.querySelector('#savePosition').onclick=async()=>{try{const rows=[];for(let r=8;r>=1;r--){let row='',empty=0;for(const f of 'abcdefgh'){const p=piecesAt.get(f+r);if(p){if(empty)row+=empty;row+=p;empty=0;}else empty++;}if(empty)row+=empty;rows.push(row);}const fen=`${rows.join('/')} ${turn} - - 0 1`;new Chess(fen);const pgn=`[Event \"Saved custom position\"]\n[SetUp \"1\"]\n[FEN \"${fen}\"]\n[Result \"*\"]\n\n*`;const saved=await api.importText(pgn);if(!saved.games?.length)throw new Error(saved.errors?.[0]?.message||'Could not save position');toast('Position saved to games');await this.show();}catch(err){toast(`Invalid position: ${err.message}`,'error');}};
    el.querySelector('#positionBoard').onclick=e=>{const sq=e.target.closest('[data-square]')?.dataset.square;if(!sq)return;if(active==='erase')piecesAt.delete(sq);else piecesAt.set(sq,active);render();const kings=[...piecesAt.values()].filter(x=>x==='K').length===1&&[...piecesAt.values()].filter(x=>x==='k').length===1;el.querySelector('#positionHint').textContent=kings?'Position ready to analyze.':'Place exactly one white king and one black king to analyze.';};
    el.querySelector('#analyzePosition').onclick=async()=>{const button=el.querySelector('#analyzePosition'),hint=el.querySelector('#positionHint');try{const count=Number(el.querySelector('#positionMoveCount').value);if(!Number.isInteger(count)||count<1||count>60)throw new Error('Choose between 1 and 60 full moves.');this.#savePositionPrefs(el,turn);const fenRows=[];for(let r=8;r>=1;r--){let row='',empty=0;for(let f of 'abcdefgh'){const p=piecesAt.get(f+r);if(p){if(empty)row+=empty;row+=p;empty=0;}else empty++;}if(empty)row+=empty;fenRows.push(row);}const fen=`${fenRows.join('/')} ${turn} - - 0 1`;const chess=new Chess(fen);button.disabled=true;button.textContent='Calculating…';hint.textContent=`Stockfish is calculating up to ${count} moves for each side…`;const id=Math.random().toString(16).slice(2).padEnd(16,'0').slice(0,16);const line=await api.bestLine(fen,{gameId:id,plies:count*2});const sans=[];const replay=new Chess(fen);for(const step of line.moves||[]){const before=replay.fen().split(' ');const move=replay.move({from:step.move.slice(0,2),to:step.move.slice(2,4),promotion:step.move[4]||'q'});sans.push(`${before[1]==='w'?`${before[5]}.`:sans.length===0?`${before[5]}...`:''}${move.san}`);}if(!sans.length)throw new Error('Stockfish found no legal moves from this position.');const result=replay.isCheckmate()?(replay.turn()==='w'?'0-1':'1-0'):'*';const pgn=`[Event "Custom position · best line"]\n[SetUp "1"]\n[FEN "${fen}"]\n[Result "${result}"]\n\n${sans.join(' ')} ${result}`;await this.#openImported(pgn);}catch(err){button.disabled=false;button.textContent='Calculate best moves';hint.textContent=err.message;}};
    render();
  }

  #savePositionPrefs(el,turn) { try { localStorage.setItem('customPosition.preferences',JSON.stringify({moves:Number(el.querySelector('#positionMoveCount').value)||30,turn})); } catch {} }

  async #afterImport(res) {
    if (res.errors.length && !res.games.length) {
      toast(`Couldn't find a chess game in that file${res.errors[0]?.message ? ` (${res.errors[0].message})` : ''}.`, 'error');
      return;
    }
    if (res.errors.length) toast(`${res.errors.length} part(s) of the file could not be read.`, 'warn');
    if (res.games.length === 1) {
      this.onOpen(res.games[0].id);
      return;
    }
    const fresh = res.games.filter((g) => !g.duplicate).length;
    toast(`Imported ${res.games.length} games${fresh < res.games.length ? ` (${res.games.length - fresh} already in your library)` : ''}.`);
    await this.show();
  }

  #sorted() {
    const { key, dir } = this.sort;
    const f = this.filter.toLowerCase();
    const list = this.games.filter((g) => !f || `${g.name} ${g.event || ''}`.toLowerCase().includes(f));
    const val = (g) => {
      if (key === 'date') return `${g.date || g.importedAt?.slice(0, 10) || ''} ${g.time || ''}`;
      if (key === 'lastOpenedAt') return g.lastOpenedAt || g.importedAt || '';
      return g[key] ?? '';
    };
    list.sort((a, b) => {
      if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
      const va = val(a);
      const vb = val(b);
      const cmp = typeof va === 'number' && typeof vb === 'number'
        ? va - vb
        : String(va).localeCompare(String(vb), undefined, { sensitivity: 'base', numeric: true });
      return dir === 'asc' ? cmp : -cmp;
    });
    return list;
  }

  #setSort(key) {
    if (this.sort.key === key) this.sort = { key, dir: this.sort.dir === 'asc' ? 'desc' : 'asc' };
    else this.sort = { key, dir: key === 'name' ? 'asc' : 'desc' };
    try { localStorage.setItem(SORT_KEY, JSON.stringify(this.sort)); } catch { /* ignore */ }
    this.render();
  }

  render() {
    const games = this.#sorted();
    const head = COLUMNS.map((c) => {
      const active = this.sort.key === c.key;
      const arrow = active ? (this.sort.dir === 'asc' ? '▲' : '▼') : '';
      return `<button class="col-head col-${c.key} ${active ? 'active' : ''}" data-sort="${c.key}" aria-sort="${active ? (this.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}">${c.label}<span class="sort-arrow">${arrow}</span></button>`;
    }).join('');

    const rows = games.map((g) => `
      <div class="row ${g.pinned ? 'pinned-row' : ''}" data-id="${g.id}" tabindex="0" role="button">
        <div class="cell col-name">
          <button class="icon-btn pin-game ${g.pinned ? 'pinned' : ''}" data-pin="${g.id}" title="${g.pinned ? 'Unpin game' : 'Pin game'}" aria-label="${g.pinned ? 'Unpin game' : 'Pin game'}">${PIN_ICON}</button>
          <span class="result-dot result-${resultClass(g.result)}" title="${escapeHtml(g.result || '*')}"></span>
          <span class="name-text">
            <span class="name-main">${escapeHtml(g.name)}</span>
            <span class="name-sub">${escapeHtml([g.event, g.result].filter(Boolean).join(' · '))}${analysisBadge(g)}</span>
          </span>
        </div>
        <div class="cell col-movesCount">${g.movesCount}</div>
        <div class="cell col-date">${escapeHtml(formatDate(g.date || g.importedAt))}${g.time ? `<span class="time">${escapeHtml(g.time)}</span>` : ''}</div>
        <div class="cell col-actions">${g.source === 'play-bot' && g.inProgress ? `<button class="btn btn-secondary resume-bot" data-resume="${g.id}">Resume</button>` : ''}<button class="icon-btn danger" data-del="${g.id}" title="Delete ${g.source === 'play-bot' ? 'bot game' : 'game'}">${UI_ICONS.trash}</button></div>
      </div>`).join('');

    const recentActive = this.sort.key === 'lastOpenedAt';
    this.root.innerHTML = `
      <div class="library">
        <header class="lib-header">
          <div class="brand"><img class="logo" src="assets/icon.png" alt=""><span>Chess Coach</span></div>
          <button class="btn btn-ghost" id="settingsBtn" title="Settings">${UI_ICONS.settings}<span>Settings</span></button>
        </header>

        <section class="import-card" id="dropzone">
          <div class="import-text">
            <h1>Analyze a game</h1>
            <p>Choose a file with your game record. PGN works best, but any text file with moves will do. You can also drag a file here.</p>
          </div>
          <div class="import-actions">
            <button class="btn btn-primary btn-lg" id="importBtn">${UI_ICONS.upload}<span>Choose file</span></button>
            <button class="btn btn-secondary" id="pasteBtn">${UI_ICONS.clipboard}<span>Paste PGN</span></button>
            <button class="btn btn-secondary" id="playBotBtn"><span>Play bot</span></button>
            <button class="btn btn-secondary" id="createPositionBtn"><span>Create position</span></button>
          </div>
          <div class="paste-box" hidden>
            <textarea id="pasteText" spellcheck="false" placeholder="[Event &quot;…&quot;]&#10;1. e4 e5 2. Nf3 Nc6 …"></textarea>
            <div class="paste-actions">
              <button class="btn btn-ghost" id="pasteCancel">Cancel</button>
              <button class="btn btn-primary" id="pasteGo">Import</button>
            </div>
          </div>
        </section>

        <section class="games">
          <div class="games-toolbar">
            <h2>Recent games <span class="count">${this.games.length}</span></h2>
            <div class="toolbar-right">
              <button class="chip ${recentActive ? 'active' : ''}" id="recentSort" title="Sort by last opened">Recently opened${recentActive ? (this.sort.dir === 'desc' ? ' ▼' : ' ▲') : ''}</button>
              <label class="search">${UI_ICONS.search}<input id="filter" placeholder="Search" value="${escapeHtml(this.filter)}"></label>
            </div>
          </div>
          <div class="table" role="table">
            <div class="table-head">${head}<span class="col-actions"></span></div>
            <div class="table-body">${rows || emptyState(this.games.length > 0)}</div>
          </div>
        </section>

        ${this.cache ? `<section class="storage-card">
          <div class="storage-text">
            <h3>Analysis cache</h3>
            <p><b>${formatBytes(this.cache.bytes)}</b> · saved engine analysis for ${this.cache.games} game${this.cache.games === 1 ? '' : 's'}. Your imported games are not affected by clearing it.</p>
          </div>
          <button class="btn btn-secondary" id="clearCacheBtn" ${this.cache.games ? '' : 'disabled'}>${UI_ICONS.trash}<span>Clear analysis cache</span></button>
        </section>` : ''}
      </div>`;
    this.#bind();
  }

  #bind() {
    const $ = (s) => this.root.querySelector(s);
    $('#importBtn').onclick = () => this.importFile();
    $('#playBotBtn').onclick = () => this.#playBot();
    $('#createPositionBtn').onclick = () => this.#createPosition();
    $('#settingsBtn').onclick = () => openSettings();
    const clear = $('#clearCacheBtn');
    if (clear) {
      clear.onclick = async () => {
        const { bytes, games } = this.cache;
        const ok = await confirmDialog({
          title: 'Clear analysis cache?',
          message: `This deletes the saved engine analysis for <b>${games} game${games === 1 ? '' : 's'}</b> (<b>${formatBytes(bytes)}</b>).<br><br>Your imported games stay in the library. Their analysis will be calculated again the next time you open them.`,
          confirmLabel: `Delete ${formatBytes(bytes)}`,
          danger: true,
        });
        if (!ok) return;
        await api.clearCache();
        toast(`Cleared ${formatBytes(bytes)} of analysis`);
        await this.show();
      };
    }
    const pasteBox = $('.paste-box');
    $('#pasteBtn').onclick = () => { pasteBox.hidden = false; $('#pasteText').focus(); };
    $('#pasteCancel').onclick = () => { pasteBox.hidden = true; };
    $('#pasteGo').onclick = async () => {
      const text = $('#pasteText').value.trim();
      if (!text) return;
      this.#afterImport(await api.importText(text));
    };
    $('#recentSort').onclick = () => this.#setSort('lastOpenedAt');
    this.root.querySelectorAll('[data-sort]').forEach((b) => { b.onclick = () => this.#setSort(b.dataset.sort); });
    const filter = $('#filter');
    filter.oninput = () => {
      this.filter = filter.value;
      const pos = filter.selectionStart;
      this.render();
      const f = this.root.querySelector('#filter');
      f.focus();
      f.setSelectionRange(pos, pos);
    };
    this.root.querySelectorAll('.row').forEach((row) => {
      row.onclick = (e) => {
        if (e.target.closest('[data-del]')) return;
        this.onOpen(row.dataset.id);
      };
      row.onkeydown = (e) => { if (e.key === 'Enter' && !e.target.closest('button,input')) this.onOpen(row.dataset.id); };
    });
    this.root.querySelectorAll('[data-del]').forEach((b) => {
      b.onclick = async () => {
        const g = this.games.find((x) => x.id === b.dataset.del);
        const ok = await confirmDialog({
          title: 'Delete game?',
          message: `Remove <b>${escapeHtml(g?.name || 'this game')}</b> and its analysis from your library?`,
          confirmLabel: 'Delete',
          danger: true,
        });
        if (!ok) return;
        await api.removeGame(b.dataset.del);
        await this.show();
      };
    });
    this.root.querySelectorAll('[data-resume]').forEach((b) => { b.onclick = async (e) => { e.stopPropagation(); const game=await api.getGame(b.dataset.resume); if(game)this.onResumeBot?.(game); }; });
    this.root.querySelectorAll('[data-pin]').forEach((b) => { b.onclick = async (e) => { e.stopPropagation(); const scroll=this.root.querySelector('.library')?.scrollTop||0; const g=this.games.find(x=>x.id===b.dataset.pin); if(!g)return; await api.setPinned(g.id,!g.pinned); await this.show(); requestAnimationFrame(()=>{const page=this.root.querySelector('.library');if(page)page.scrollTop=scroll;}); }; });
  }
}

function analysisBadge(g) {
  const a = g.analysis;
  if (!a) return '';
  const fmt = (v) => (v == null ? '—' : v.toFixed(1));
  return ` <span class="analyzed" title="Analyzed with ${escapeHtml(a.engine)}: accuracy White ${fmt(a.accuracy.w)}, Black ${fmt(a.accuracy.b)}">✓ Analyzed · <b class="acc-mini w">${fmt(a.accuracy.w)}</b> <b class="acc-mini b">${fmt(a.accuracy.b)}</b></span>`;
}

function resultClass(r) {
  if (r === '1-0') return 'white';
  if (r === '0-1') return 'black';
  if (r === '1/2-1/2') return 'draw';
  return 'none';
}

function emptyState(filtered) {
  return `<div class="empty">${filtered ? 'No games match your search.' : 'No games yet. Import a PGN file to get started.'}</div>`;
}

export function logoSvg() {
  return `<svg class="logo" viewBox="0 0 40 40" aria-hidden="true"><rect width="40" height="40" rx="9" fill="#81b64c"/><path fill="#fff" d="M20 7a4 4 0 0 1 2.4 7.2c1.8 1 3.1 2.6 3.1 4.6h-11c0-2 1.3-3.6 3.1-4.6A4 4 0 0 1 20 7Zm-6.2 14h12.4l1.4 7H12.4l1.4-7ZM10 30h20v3H10v-3Z"/></svg>`;
}
