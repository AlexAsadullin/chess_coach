/**
 * App settings and AI API keys, stored in the user-data folder:
 *   settings.json – plain preferences
 *   ai-keys.json  – API keys, encrypted with the OS keychain (Electron safeStorage).
 * The renderer never receives a full key: it gets a masked preview, and
 * "copy" happens here in the main process.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULTS = {
  board: { theme: 'green', pieces: 'cburnett', coordinates: true, animation: 'fast' },
  sound: { enabled: true, volume: 60 },
  analysis: { depth: 20, bestArrow: true, linePlies: 26 },
  ai: { activeKeyId: null },
};

const ALLOWED = {
  'board.theme': ['green', 'brown', 'blue', 'gray'],
  'board.pieces': ['cburnett', 'neo', 'chessnut', 'merida'],
  'board.animation': ['off', 'fast', 'normal'],
  'analysis.depth': [16, 20, 24],
  'analysis.linePlies': [10, 16, 26, 40, 60],
};
const PROVIDERS = ['OpenAI', 'Anthropic', 'Google', 'Mistral', 'Other'];

function merge(base, extra) {
  const out = { ...base };
  for (const [k, v] of Object.entries(extra || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' ? merge(base[k], v) : v;
  }
  return out;
}

/** Keep only known keys with valid values. */
function sanitize(s) {
  const out = merge(DEFAULTS, {});
  for (const [group, fields] of Object.entries(DEFAULTS)) {
    for (const [key, def] of Object.entries(fields)) {
      const v = s?.[group]?.[key];
      const allowed = ALLOWED[`${group}.${key}`];
      if (v === undefined) continue;
      if (allowed) { if (allowed.includes(v)) out[group][key] = v; }
      else if (typeof def === 'boolean') out[group][key] = Boolean(v);
      else if (typeof def === 'number') out[group][key] = Math.max(0, Math.min(100, Number(v) || 0));
      else if (key === 'activeKeyId') out[group][key] = typeof v === 'string' ? v : null;
    }
  }
  return out;
}

function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

class SettingsStore {
  /** @param safeStorage Electron's safeStorage (injected so tests can fake it) */
  constructor(dir, safeStorage) {
    this.file = path.join(dir, 'settings.json');
    this.keysFile = path.join(dir, 'ai-keys.json');
    this.safe = safeStorage;
    fs.mkdirSync(dir, { recursive: true });
    this.settings = sanitize(this.#read(this.file, {}));
    this.keys = this.#read(this.keysFile, { keys: [] }).keys || [];
    this.listeners = new Set();
  }

  #read(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
  }

  onChange(fn) { this.listeners.add(fn); }

  #emit() {
    const snap = this.snapshot();
    for (const fn of this.listeners) fn(snap);
  }

  get() { return this.settings; }

  /** Settings + masked key list, safe to send to the UI. */
  snapshot() {
    return {
      settings: this.settings,
      keys: this.keys.map(({ id, name, provider, preview, createdAt }) => ({
        id, name, provider, preview, createdAt, active: id === this.settings.ai.activeKeyId,
      })),
      providers: PROVIDERS,
      encrypted: this.#canEncrypt(),
    };
  }

  update(partial) {
    this.settings = sanitize(merge(this.settings, partial));
    writeAtomic(this.file, this.settings);
    this.#emit();
    return this.snapshot();
  }

  // ---------- API keys ----------
  #canEncrypt() {
    try { return Boolean(this.safe?.isEncryptionAvailable()); } catch { return false; }
  }

  #encrypt(text) {
    if (this.#canEncrypt()) return { enc: 'safe', data: this.safe.encryptString(text).toString('base64') };
    return { enc: 'plain', data: Buffer.from(text, 'utf8').toString('base64') };
  }

  #decrypt(k) {
    const buf = Buffer.from(k.data, 'base64');
    return k.enc === 'safe' ? this.safe.decryptString(buf) : buf.toString('utf8');
  }

  #saveKeys() {
    writeAtomic(this.keysFile, { keys: this.keys });
  }

  addKey({ name, provider, key }) {
    const secret = String(key || '').trim();
    if (secret.length < 8) throw new Error('That key looks too short');
    if (/\s/.test(secret)) throw new Error('API keys cannot contain spaces');
    const entry = {
      id: crypto.randomUUID(),
      name: String(name || '').trim().slice(0, 60) || `${provider || 'API'} key`,
      provider: PROVIDERS.includes(provider) ? provider : 'Other',
      preview: `${secret.slice(0, Math.min(4, secret.length - 4))}…${secret.slice(-4)}`,
      createdAt: new Date().toISOString(),
      ...this.#encrypt(secret),
    };
    this.keys.push(entry);
    this.#saveKeys();
    // the first key becomes the active one automatically
    if (!this.settings.ai.activeKeyId) return this.update({ ai: { activeKeyId: entry.id } });
    this.#emit();
    return this.snapshot();
  }

  renameKey(id, name) {
    const k = this.keys.find((x) => x.id === id);
    if (k && String(name).trim()) {
      k.name = String(name).trim().slice(0, 60);
      this.#saveKeys();
      this.#emit();
    }
    return this.snapshot();
  }

  removeKey(id) {
    this.keys = this.keys.filter((x) => x.id !== id);
    this.#saveKeys();
    if (this.settings.ai.activeKeyId === id) return this.update({ ai: { activeKeyId: this.keys[0]?.id || null } });
    this.#emit();
    return this.snapshot();
  }

  setActiveKey(id) {
    if (!this.keys.some((x) => x.id === id)) return this.snapshot();
    return this.update({ ai: { activeKeyId: id } });
  }

  /** Full secret (main process only: used for clipboard copy and future AI calls). */
  revealKey(id) {
    const k = this.keys.find((x) => x.id === id);
    return k ? this.#decrypt(k) : null;
  }

  activeKey() {
    const id = this.settings.ai.activeKeyId;
    const k = this.keys.find((x) => x.id === id);
    return k ? { name: k.name, provider: k.provider, key: this.#decrypt(k) } : null;
  }
}

module.exports = { SettingsStore, DEFAULTS, PROVIDERS };
