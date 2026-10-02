import test from 'node:test';
import assert from 'node:assert/strict';

test('download completion, duplicates, force, deleted files, and history re-download', async () => {
  const local = {};
  const session = {};
  const items = new Map();
  let message;
  let changed;
  let nextId = 0;
  const tabMessages = [];
  let badge = null;
  let createdUrl = '';
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
      getURL(path) { return 'chrome-extension://test/' + path; },
    },
    tabs: {
      sendMessage(tabId, msg) {
        tabMessages.push({ tabId, msg });
        return Promise.resolve();
      },
      async create(opts) { createdUrl = opts.url; return opts; },
    },
    action: {
      setBadgeText(opts) { badge = opts; },
      setBadgeBackgroundColor() {},
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

  message({ type: 'xvd:media', records: [
    { tweetId: '555', type: 'photo', images: ['https://pbs.twimg.com/media/Z.jpg'] },
    { tweetId: '556', variants: [{ url: 'https://video.twimg.com/ext_tw_video/7/vid/1x1/a.mp4', bitrate: 1 }] },
  ] }, {}, () => {});
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(session['media:555'], undefined);
  assert.equal(session['media:556'].tweetId, '556');

  const batched = await new Promise((resolve) => message({
    ...req, force: true, batchId: 'batch-1', clientId: 'c-1',
  }, { tab: { id: 42 } }, resolve));
  assert.equal(batched.ok, true);
  assert.equal(local.history.find((r) => r.key === batched.key).batchId, 'batch-1');
  assert.deepEqual(session['dl:' + batched.downloadId], { tabId: 42, clientId: 'c-1' });
  items.get(batched.downloadId).state = 'complete';
  await changed({ id: batched.downloadId, state: { current: 'complete' } });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(tabMessages.length, 1);
  assert.deepEqual(tabMessages[0], {
    tabId: 42,
    msg: { type: 'xvd:download-done', downloadId: batched.downloadId, state: 'complete', error: '', clientId: 'c-1' },
  });

  const batchedImage = await new Promise((resolve) => message({
    type: 'xvd:download', kind: 'image', tweetId: '790', screenName: 'NASA', batchId: 'batch-1',
    clientId: 'c-img', force: true,
    images: ['https://pbs.twimg.com/media/Other?format=jpg&name=small'],
  }, { tab: { id: 42 } }, resolve));
  assert.equal(batchedImage.ok, true);
  assert.equal(batchedImage.downloadId, nextId - 1);
  assert.equal(local.history.find((r) => r.downloadId === batchedImage.downloadId).batchId, 'batch-1');

  await new Promise((resolve) => message({ type: 'xvd:badge', text: '12' }, { tab: { id: 3 } }, resolve));
  assert.deepEqual(badge, { text: '12', tabId: 3 });
  await new Promise((resolve) => message({ type: 'xvd:badge', text: '' }, { tab: { id: 3 } }, resolve));
  assert.equal(badge.text, '');
  await new Promise((resolve) => message({ type: 'xvd:open-batch', batchId: 'b 1' }, {}, resolve));
  assert.equal(createdUrl, 'chrome-extension://test/src/options/options.html#batch=b%201');
});
