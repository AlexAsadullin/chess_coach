/** Game library: import + sortable column list of saved games. */
import { UI_ICONS } from './icons.js';
import { api } from './api.js';
import { toast, escapeHtml, formatDate } from './util.js';
import { confirmDialog, formatBytes } from './modal.js';
import { openSettings } from './settings-view.js';

const SORT_KEY = 'library.sort';
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
  constructor(root, { onOpen }) {
    this.root = root;
    this.onOpen = onOpen;
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
      <div class="row" data-id="${g.id}" tabindex="0" role="button">
        <div class="cell col-name">
          <span class="result-dot result-${resultClass(g.result)}" title="${escapeHtml(g.result || '*')}"></span>
          <span class="name-text">
            <span class="name-main">${escapeHtml(g.name)}</span>
            <span class="name-sub">${escapeHtml([g.event, g.result].filter(Boolean).join(' · '))}${analysisBadge(g)}</span>
          </span>
        </div>
        <div class="cell col-movesCount">${g.movesCount}</div>
        <div class="cell col-date">${escapeHtml(formatDate(g.date || g.importedAt))}${g.time ? `<span class="time">${escapeHtml(g.time)}</span>` : ''}</div>
        <div class="cell col-actions"><button class="icon-btn danger" data-del="${g.id}" title="Delete game">${UI_ICONS.trash}</button></div>
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
      row.onkeydown = (e) => { if (e.key === 'Enter') this.onOpen(row.dataset.id); };
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
