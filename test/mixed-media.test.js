import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { mediaKind } from '../src/lib/media.js';

const source = readFileSync(new URL('../src/content.js', import.meta.url), 'utf8');
function functionSource(name, next) {
  return source.slice(source.indexOf(`  ${name}`), source.indexOf(next, source.indexOf(`  ${name}`)));
}

test('fresh media classification covers empty, video, image and mixed snapshots', () => {
  assert.equal(mediaKind(false), null);
  assert.equal(mediaKind(true), 'video');
  assert.equal(mediaKind(false, ['photo']), 'image');
  assert.equal(mediaKind(true, ['photo']), 'mixed');
});

test('article scan keeps deduplicated photos when a video mounts later', () => {
  let hasVideo = false;
  const url = 'https://pbs.twimg.com/media/photo?format=jpg&name=small';
  const article = {
    querySelector: () => hasVideo ? {} : null,
    querySelectorAll: () => [{ src: url, closest: () => null }, { currentSrc: url, closest: () => null }, { src: 'https://pbs.twimg.com/profile_images/avatar.jpg', closest: () => null }],
  };
  const ctx = vm.createContext({ mediaKind, MEDIA_URL_RE: /pbs\.twimg\.com\/(media|card_img)\// });
  vm.runInContext(functionSource('function articleMedia', '  function tweetText'), ctx);
  assert.equal(ctx.articleMedia(article).kind, 'image');
  hasVideo = true;
  const result = ctx.articleMedia(article);
  assert.equal(result.kind, 'mixed');
  assert.equal(result.hasVideo, true);
  assert.deepEqual(Array.from(result.images), [url]);
});

function downloadHarness(fresh, responses) {
  const requests = [];
  const toasts = [];
  const ctx = vm.createContext({
    contextValid: () => true,
    mediaReady: Promise.resolve(), articleMedia: () => fresh,
    settings: { defaultQuality: '720' }, origin: 'https://x.com',
    mediaByTweet: new Map([['123', { variants: [{ url: 'video' }] }]]),
    t: (key, ...subs) => [key, ...subs].join(':'), uiLang: () => 'en',
    toast: (...args) => toasts.push(args),
    chrome: { runtime: { sendMessage: (msg, callback) => {
      requests.push(msg);
      callback(responses[msg.kind] || { ok: true, filename: msg.kind });
    } } },
  });
  vm.runInContext(functionSource('async function requestDownload', "  // X's action bar"), ctx);
  return { ctx, requests, toasts };
}

test('late mixed snapshot downloads video at default quality and original photos with one result toast', async () => {
  const h = downloadHarness({ kind: 'mixed', hasVideo: true, images: ['photo'] }, {});
  await h.ctx.requestDownload({ article: {}, kind: 'image', tweetId: '123', screenName: 'user' });
  assert.deepEqual(h.requests.map((r) => r.kind), ['video', 'image']);
  assert.equal(h.requests[0].quality, '720');
  assert.equal(h.requests[0].force, false);
  assert.equal(h.requests[1].size, 'orig');
  assert.deepEqual(Array.from(h.requests[1].images), ['photo']);
  assert.equal(h.toasts.length, 2); // preparing, then one combined result
  assert.match(h.toasts[1][0], /video.*image/);
});

test('mixed duplicate retry only repeats skipped video and explicit menu targets stay separate', async () => {
  const h = downloadHarness({ kind: 'mixed', images: ['photo'] }, { video: { duplicate: true, at: 0 } });
  const info = { article: {}, tweetId: '123', screenName: 'user' };
  await h.ctx.requestDownload(info);
  h.toasts[1][2]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.requests.map((r) => r.kind), ['video', 'image', 'video']);
  assert.equal(h.requests[2].force, true);
  await h.ctx.requestDownload(info, 'orig', true, 'image');
  assert.equal(h.requests.at(-1).kind, 'image');
});

for (const kind of ['video', 'image']) {
  test(`${kind}-only keeps one request and the original result toast`, async () => {
    const h = downloadHarness({ kind, images: kind === 'image' ? ['photo'] : [] }, {});
    await h.ctx.requestDownload({ article: {}, tweetId: '123', screenName: 'user' });
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].kind, kind);
    assert.equal(h.toasts[1][0], `toastDownloading::${kind}`);
  });
}

test('mixed menu adds original photos after video qualities and lowest tick remains on video', async () => {
  class Element {
    children = [];
    listeners = {};
    appendChild(child) { this.children.push(child); }
    setAttribute() {}
    addEventListener(name, fn) { this.listeners[name] = fn; }
  }
  const body = new Element();
  const requests = [];
  const ctx = vm.createContext({
    mediaReady: Promise.resolve(), articleMedia: () => ({ kind: 'mixed', images: ['photo'] }),
    closeMenu() {}, document: { createElement: () => new Element(), body },
    t: (key) => key, mediaByTweet: new Map(), settings: { defaultQuality: 'lowest' },
    positionMenu() {}, setTimeout() {}, window: {},
    requestDownload: (...args) => requests.push(args),
  });
  vm.runInContext(functionSource('async function openQualityMenu', '  let menuCleanup'), ctx);
  const info = { article: {}, kind: 'image', tweetId: '123' };
  await ctx.openQualityMenu({}, info);
  const menu = body.children[0];
  assert.equal(menu.children[0].textContent, 'menuDownloadVideo');
  const rows = menu.children.slice(1);
  assert.deepEqual(rows.map((r) => r.children[0].textContent), ['menuHighest', '720p', '480p', '360p', 'menuDownloadImage']);
  assert.equal(rows[3].children.at(-1).className, 'xvd-menu__check');
  assert.equal(rows[4].children.length, 1);
  const event = { preventDefault() {}, stopPropagation() {} };
  rows[0].listeners.click(event);
  rows[4].listeners.click(event);
  assert.equal(requests[0][3], 'video');
  assert.equal(requests[1][3], 'image');
  assert.equal(requests[1][1], 'orig');
});

test('existing icon button refreshes title and aria label after video mounts', () => {
  const ctx = vm.createContext({ t: (key) => key });
  vm.runInContext(functionSource('function updateButton', '  function refreshButtons'), ctx);
  const attrs = {};
  const btn = { dataset: {}, setAttribute: (key, value) => { attrs[key] = value; } };
  ctx.updateButton(btn, { kind: 'image' });
  assert.equal(btn.title, 'tipDownloadImage');
  ctx.updateButton(btn, { kind: 'mixed' });
  assert.equal(btn.title, 'tipDownloadMixed');
  assert.equal(attrs['aria-label'], 'ariaDownloadMixed');
  ctx.updateButton(btn, { kind: 'video' });
  assert.equal(btn.title, 'tipDownloadVideo');
  assert.equal(attrs['aria-label'], 'menuDownloadVideo');
});

test('article scan excludes posters under either video wrapper and retains mixed photos', () => {
  for (const wrapper of ['videoPlayer', 'videoComponent']) {
    let photos = [];
    const poster = { src: 'https://pbs.twimg.com/media/cover.jpg', closest: (selector) => {
      assert.ok(selector.includes(`[data-testid="${wrapper}"]`));
      return {};
    } };
    const article = { querySelector: () => ({}), querySelectorAll: () => [poster, ...photos] };
    const ctx = vm.createContext({ mediaKind, MEDIA_URL_RE: /pbs\.twimg\.com\/(media|card_img)\// });
    vm.runInContext(functionSource('function articleMedia', '  function tweetText'), ctx);
    assert.equal(ctx.articleMedia(article).kind, 'video');
    assert.deepEqual(Array.from(ctx.articleMedia(article).images), []);
    photos = [{ src: 'https://pbs.twimg.com/media/photo.jpg', closest: () => null }];
    assert.equal(ctx.articleMedia(article).kind, 'mixed');
    assert.deepEqual(Array.from(ctx.articleMedia(article).images), [photos[0].src]);
  }
});
