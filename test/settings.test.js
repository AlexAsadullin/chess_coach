// Settings persistence, validation and API-key handling (with a fake keychain).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SettingsStore } = require('../src/main/settings');

// stands in for Electron's safeStorage: "encrypts" by reversing + base64
const fakeSafe = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`ENC:${[...s].reverse().join('')}`),
  decryptString: (b) => [...b.toString().slice(4)].reverse().join(''),
};
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cc-settings-'));

test('defaults, validation and persistence', () => {
  const dir = tmp();
  try {
    const a = new SettingsStore(dir, fakeSafe);
    assert.strictEqual(a.get().analysis.depth, 20);
    assert.strictEqual(a.get().analysis.linePlies, 26);
    a.update({ board: { theme: 'blue', animation: 'nonsense' }, sound: { volume: 250 }, analysis: { depth: 24, linePlies: 40 } });
    a.update({ analysis: { linePlies: 33 } }); // not an offered option: ignored
    const b = new SettingsStore(dir, fakeSafe); // restart
    assert.strictEqual(b.get().board.theme, 'blue');
    assert.strictEqual(b.get().board.animation, 'fast', 'invalid value ignored');
    assert.strictEqual(b.get().sound.volume, 100, 'clamped');
    assert.strictEqual(b.get().analysis.depth, 24);
    assert.strictEqual(b.get().analysis.linePlies, 40);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('API keys: add, encrypt at rest, mask, activate, rename, copy, delete', () => {
  const dir = tmp();
  try {
    const s = new SettingsStore(dir, fakeSafe);
    let snap = s.addKey({ name: 'Work', provider: 'OpenAI', key: 'sk-proj-ABCDEFGH12345678' });
    const first = snap.keys[0];
    assert.strictEqual(first.active, true, 'first key becomes active');
    assert.strictEqual(first.preview, 'sk-p…5678');
    assert.ok(!JSON.stringify(snap).includes('ABCDEFGH'), 'snapshot never contains the secret');
    assert.ok(!fs.readFileSync(path.join(dir, 'ai-keys.json'), 'utf8').includes('ABCDEFGH'), 'not stored in plain text');

    snap = s.addKey({ name: 'Personal', provider: 'Anthropic', key: 'sk-ant-api03-zzzzzzzzzz' });
    assert.strictEqual(snap.keys.filter((k) => k.active).length, 1);
    const second = snap.keys[1];
    snap = s.setActiveKey(second.id);
    assert.strictEqual(snap.keys.find((k) => k.active).id, second.id);
    snap = s.renameKey(second.id, 'Home');
    assert.strictEqual(snap.keys[1].name, 'Home');
    assert.strictEqual(s.revealKey(first.id), 'sk-proj-ABCDEFGH12345678');

    const reopened = new SettingsStore(dir, fakeSafe);
    assert.strictEqual(reopened.activeKey().key, 'sk-ant-api03-zzzzzzzzzz');
    snap = reopened.removeKey(second.id);
    assert.deepStrictEqual(snap.keys.map((k) => k.name), ['Work']);
    assert.strictEqual(snap.keys[0].active, true, 'active falls back to a remaining key');
    assert.throws(() => reopened.addKey({ name: 'x', key: 'short' }), /too short/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
