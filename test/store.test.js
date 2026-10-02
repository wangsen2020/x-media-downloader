import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, getSettings, saveSettings, withLock, addHistoryEntry,
  getHistory, updateHistoryEntry, getDownloaded, recordDownloaded, clearHistory,
  clearDownloaded } from '../src/lib/store.js';

let data;
let writes;
beforeEach(() => {
  data = {};
  writes = 0;
  globalThis.chrome = { storage: { local: {
    async get(key) {
      const result = structuredClone({ [key]: data[key] });
      await new Promise((resolve) => setTimeout(resolve, 0));
      return result;
    },
    async set(values) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      Object.assign(data, structuredClone(values));
      writes++;
    },
  } } };
});

test('50 parallel history writes preserve all records and unique keys', async () => {
  await Promise.all(Array.from({ length: 50 }, () => addHistoryEntry({ tweetId: '123' })));
  const history = await getHistory();
  assert.equal(history.length, 50);
  assert.equal(new Set(history.map((r) => r.key)).size, 50);
  await Promise.all(history.map((r, i) => updateHistoryEntry({ key: r.key }, { downloadId: i })));
  assert.equal(new Set((await getHistory()).map((r) => r.downloadId)).size, 50);
});

test('lock recovers after rejection', async () => {
  await assert.rejects(withLock(() => { throw new Error('failed'); }));
  assert.equal(await withLock(() => 42), 42);
});

test('new settings default to author folders and 3000 history records', async () => {
  assert.deepEqual(await getSettings(), DEFAULT_SETTINGS);
  assert.equal(data.settings.maxHistory, 3000);
});

test('migration upgrades exactly the old default once, even with concurrent readers', async () => {
  data.settings = { subfolder: 'X Media Downloader', defaultQuality: '720' };
  const results = await Promise.all(Array.from({ length: 10 }, () => getSettings()));
  assert.ok(results.every((s) => s.subfolder === DEFAULT_SETTINGS.subfolder));
  assert.equal(writes, 1);
  assert.equal(data.settings.defaultQuality, '720');
  await saveSettings({ subfolder: 'X Media Downloader' });
  assert.equal((await getSettings()).subfolder, 'X Media Downloader');
});

test('migration preserves custom, empty, and near-default folders', async () => {
  for (const subfolder of ['custom/{date}', '', 'X Media Downloader ']) {
    data.settings = { subfolder };
    assert.equal((await getSettings()).subfolder, subfolder);
    assert.equal(data.settings.schemaVersion, DEFAULT_SETTINGS.schemaVersion);
  }
});

test('parallel settings patches preserve unrelated changes', async () => {
  await Promise.all([saveSettings({ defaultQuality: '360' }), saveSettings({ subfolder: 'custom' })]);
  assert.equal(data.settings.defaultQuality, '360');
  assert.equal(data.settings.subfolder, 'custom');
});

test('downloaded index survives history clearing and clears independently', async () => {
  await Promise.all(Array.from({ length: 20 }, (_, i) => recordDownloaded(`v:${i}`,
    { at: i, filename: 'file.mp4', downloadId: i, quality: '720p' })));
  await addHistoryEntry({ tweetId: '1' });
  await clearHistory();
  assert.equal(Object.keys(await getDownloaded()).length, 20);
  await addHistoryEntry({ tweetId: '2' });
  await clearDownloaded();
  assert.equal(Object.keys(await getDownloaded()).length, 0);
  assert.equal((await getHistory()).length, 1);
});

test('history entries keep their batch id', async () => {
  const rec = await addHistoryEntry({ tweetId: '1', batchId: 'b-1' });
  assert.equal(rec.batchId, 'b-1');
  assert.equal((await getHistory())[0].batchId, 'b-1');
  const plain = await addHistoryEntry({ tweetId: '2' });
  assert.equal(plain.batchId, '');
});

test('downloaded index evicts the oldest timestamp at 20000 records', async () => {
  data.downloaded = Object.fromEntries(Array.from({ length: 20000 }, (_, i) => [`v:${i}`, { at: i }]));
  await recordDownloaded('v:new', { at: 20000 });
  const index = await getDownloaded();
  assert.equal(Object.keys(index).length, 20000);
  assert.equal(index['v:0'], undefined);
  assert.equal(index['v:new'].at, 20000);
});
