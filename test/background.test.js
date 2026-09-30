import test from 'node:test';
import assert from 'node:assert/strict';

test('download completion, duplicates, force, deleted files, and history re-download', async () => {
  const local = {};
  const session = {};
  const items = new Map();
  let message;
  let changed;
  let nextId = 0;
  let deletedFile = false;
  let existenceCheckTriggered = false;
  const searches = [];
  const storage = (data) => ({
    async get(key) { return structuredClone(key == null ? data : { [key]: data[key] }); },
    async set(values) { Object.assign(data, structuredClone(values)); },
    async remove(key) { delete data[key]; },
  });
  globalThis.chrome = {
    storage: { local: storage(local), session: storage(session) },
    downloads: {
      async download(options) {
        const id = nextId++;
        items.set(id, { id, state: 'in_progress', exists: true, filename: options.filename });
        return id;
      },
      async search({ id }) {
        searches.push(id);
        const item = items.get(id);
        if (!item) return [];
        if (id === 0 && deletedFile) {
          const exists = !existenceCheckTriggered;
          existenceCheckTriggered = true;
          return [{ ...item, exists }];
        }
        return [{ ...item }];
      },
      onChanged: { addListener(fn) { changed = fn; } },
    },
    runtime: {
      onMessage: { addListener(fn) { message = fn; } },
      onInstalled: { addListener() {} },
    },
  };
  await import('../src/background.js');
  const send = (request) => new Promise((resolve) => message(request, {}, resolve));
  const req = { type: 'xvd:download', tweetId: '123', screenName: 'NASA', record: {
    tweetId: '123', screenName: 'NASA', variants: [
      { url: 'https://video.twimg.com/ext_tw_video/99/vid/720x720/a.mp4', height: 720 },
    ],
  } };
  const first = await send(req);
  assert.equal(first.ok, true);
  assert.equal(first.downloadId, 0);
  assert.deepEqual(local.downloaded || {}, {});
  items.get(0).state = 'complete';
  await changed({ id: 0, state: { current: 'complete' } });
  assert.equal(local.downloaded['v:99'].downloadId, 0);
  const duplicate = await send({ ...req, tweetId: '456' });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.ok, false);
  assert.equal(nextId, 1);
  assert.equal((await send({ ...req, force: true })).ok, true);
  assert.equal(nextId, 2);
  items.get(0).exists = false;
  assert.equal((await send(req)).ok, true);
  assert.equal(nextId, 3);
  items.get(0).exists = true;
  assert.equal((await send({ type: 'xvd:redownload', key: first.key })).ok, true);
  assert.equal(nextId, 4);

  const image = { type: 'xvd:download', kind: 'image', tweetId: '789', screenName: 'NASA',
    images: ['https://pbs.twimg.com/media/Photo?format=jpg&name=small'] };
  assert.equal((await send(image)).ok, true);
  items.get(4).state = 'complete';
  await changed({ id: 4, state: { current: 'complete' } });
  assert.equal((await send(image)).duplicate, true);
  assert.equal((await send({ ...image, force: true })).ok, true);
  const interrupted = await send({ ...req, force: true });
  await changed({ id: interrupted.downloadId, state: { current: 'interrupted' } });
  assert.equal(local.downloaded['v:99'].downloadId, 0);
});
