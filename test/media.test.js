import test from 'node:test';
import assert from 'node:assert/strict';
import { mediaKeyFromUrl, buildFilename, sanitizePart } from '../src/lib/media.js';

test('video identity ignores quality, query strings, and hosting post', () => {
  for (const kind of ['amplify_video', 'ext_tw_video', 'tweet_video']) {
    assert.equal(mediaKeyFromUrl(`https://video.twimg.com/${kind}/123/vid/720x720/a.mp4?tag=1`), 'v:123');
    assert.equal(mediaKeyFromUrl(`https://video.twimg.com/${kind}/123/vid/1080x1080/b.mp4`), 'v:123');
  }
  assert.equal(mediaKeyFromUrl('https://video.twimg.com/tweet_video/AbC_9.mp4?tag=2'), 'v:AbC_9');
});

test('image identity ignores size, format, and legacy extension', () => {
  for (const kind of ['media', 'card_img']) {
    assert.equal(mediaKeyFromUrl(`https://pbs.twimg.com/${kind}/AbC?format=jpg&name=orig`), 'i:AbC');
    assert.equal(mediaKeyFromUrl(`https://pbs.twimg.com/${kind}/AbC.jpg:large`), 'i:AbC');
  }
});

test('unsupported and malformed URLs have no identity', () => {
  for (const url of [null, undefined, '', 'bad', 'https://example.com/media/a',
    'https://video.twimg.com.evil.test/ext_tw_video/123/a.mp4',
    'https://pbs.twimg.com/profile_images/123/a.jpg']) {
    assert.equal(mediaKeyFromUrl(url), null);
  }
});

test('subfolder expands the same tokens as filenames before cleaning segments', () => {
  const ctx = { user: 'NASA', id: '123', postDate: new Date(2024, 4, 6, 7, 8, 9),
    text: 'hello world', height: 720, bitrate: 1000, index: 1, count: 2 };
  const filename = buildFilename('{id}_{index}', ctx,
    'X Media Downloader/{user}/{date}/{time}/{datetime}/{text}/{quality}/{height}/{bitrate}/{index}/{count}/{id}');
  assert.equal(filename, 'X_Media_Downloader/NASA/2024-05-06/070809/20240506-070809/hello_world/720p/720/1000/2/2/123/123_2.mp4');
  assert.equal(buildFilename('{id}', { ...ctx, count: 1 }, ''), '123.mp4');
  assert.equal(buildFilename('{id}', { ...ctx, count: 1, user: '../bad:name' }, 'root/{user}'),
    'root/x-video/bad_name/123.mp4');
  assert.equal(sanitizePart('a\x00b\x1fc'), 'a_b_c');
});


test('filename sanitizer removes invisible characters before collapsing separators', () => {
  assert.equal(sanitizePart('dai_hui30485_\u2764\uFE0F_\u6e2f\u53f0'), 'dai_hui30485_\u6e2f\u53f0');
  const invisible = '\u200B\u200C\u200D\u2060\uFEFF\u200E\u202E';
  const selectors = Array.from({ length: 16 }, (_, i) => String.fromCharCode(0xFE00 + i)).join('');
  assert.equal(sanitizePart(`a_${invisible}${selectors}_b`), 'a_b');
  assert.equal(sanitizePart('caf\u00e9_e\u0301'), 'caf\u00e9_e\u0301');
  const ctx = { user: 'dai_hui30485', id: '123', text: '\u2764\uFE0F \u6e2f\u53f0', count: 1 };
  for (const ext of ['mp4', 'jpg']) {
    assert.equal(buildFilename('{user}_{text}_{id}', { ...ctx, ext }), `dai_hui30485_\u6e2f\u53f0_123.${ext}`);
  }
});
