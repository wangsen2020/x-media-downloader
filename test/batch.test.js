import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import {
  BATCH_LIMITS,
  jitterMs,
  nextScrollDelayMs,
  scrollDeltaPx,
  isPageBottom,
  nextEmptyStreak,
  collectionStatus,
  isRateLimited,
  isMediaTimelineOperation,
  startGapMs,
  retryDelayMs,
  isRetryableDownloadError,
  queueDecision,
  mediaUserFromPath,
  mediaUserFromUrl,
  sameAuthor,
} from '../src/lib/batch.js';

test('media operation detection agrees with MAIN-world copy', () => {
  const source = readFileSync(new URL('../src/injected.js', import.meta.url), 'utf8');
  const copy = source.slice(source.indexOf('  function isMediaTimelineOperation('), source.indexOf('  function postRateLimit('));
  const ctx = vm.createContext({ URL });
  vm.runInContext(copy, ctx);
  const base = 'https://x.com/i/api/graphql/5A9PzD08T6PbvC2QlEYxMg/';
  const cases = [
    [base + 'UserVideoTimeline?variables=...', true],
    [base + 'ViewerBadgeCounts?variables=%7B%7D', false],
    ...['UserMedia', 'UserTweets', 'UserTweetsAndReplies', 'HomeTimeline', 'SearchTimeline', 'UserExtraMedia'].map(op => [base + op, true]),
    ...['TweetDetail', 'UserByScreenName', 'ViewerBadgeCounts?UserTweets', 'UserTweetsExtraCountsTimelinePoll'].map(op => [base + op, op.startsWith('UserTweets')]),
    ['https://x.com/UserTweets', false],
    [base + 'ViewerBadgeCounts/UserTweets', false],
    [base + 'UserTweets/extra', false],
    [null, false],
    ['', false],
    ['/i/api/graphql/hash/UserMedia', true],
  ];
  for (const [url, expected] of cases) {
    assert.equal(isMediaTimelineOperation(url), expected, String(url));
    assert.equal(ctx.isMediaTimelineOperation(url), expected, String(url));
  }
});

test('page hook ignores badge quota failures but signals timeline failures', () => {
  const source = readFileSync(new URL('../src/injected.js', import.meta.url), 'utf8');
  const posts = [];
  function XHR() {}
  XHR.prototype.open = () => {};
  XHR.prototype.send = () => {};
  const ctx = vm.createContext({ URL, XMLHttpRequest: XHR, window: {
    location: { origin: 'https://x.com' }, postMessage: msg => posts.push(msg),
    fetch: async url => ({ url, status: url.includes('Badge') ? 429 : 200, clone: () => ({ text: async () => '{"errors":[{"code":88}]}' }) }),
  } });
  vm.runInContext(source, ctx);
  return (async () => {
    await ctx.window.fetch('https://x.com/i/api/graphql/hash/ViewerBadgeCounts');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(posts.length, 0);
    await ctx.window.fetch('https://x.com/i/api/graphql/hash/UserVideoTimeline');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(posts.length, 1);
    assert.equal(posts[0].kind, 'ratelimit');
  })();
});

function seq(values) {
  let i = 0;
  return () => {
    if (i >= values.length) throw new Error('random sequence exhausted');
    return values[i++];
  };
}

test('batch limits match the media-page collector spec', () => {
  assert.deepEqual(BATCH_LIMITS, {
    scrollMinMs: 2000,
    scrollMaxMs: 4000,
    pauseEvery: 20,
    pauseMinMs: 10000,
    pauseMaxMs: 20000,
    emptyScrollsToFinish: 3,
    maxFiles: 500,
    maxConcurrent: 3,
    startGapMinMs: 300,
    startGapMaxMs: 800,
    retryDelaysMs: [5000, 15000],
  });
});

test('jitter stays inside the inclusive millisecond range', () => {
  assert.equal(jitterMs(2000, 4000, () => 0), 2000);
  assert.equal(jitterMs(2000, 4000, () => 0.999999), 4000);
  assert.equal(jitterMs(300, 800, () => 0), 300);
  assert.equal(jitterMs(300, 800, () => 0.999999), 800);
  for (let i = 0; i < 200; i++) {
    const n = jitterMs(2000, 4000);
    assert.ok(n >= 2000 && n <= 4000);
    assert.equal(Math.round(n), n);
  }
});

test('scroll delay is 2–4s, with a 10–20s rest after every 20th scroll', () => {
  assert.equal(nextScrollDelayMs(0, seq([0])), 2000);
  assert.equal(nextScrollDelayMs(1, seq([0.999999])), 4000);
  assert.equal(nextScrollDelayMs(19, seq([0])), 2000);
  assert.equal(nextScrollDelayMs(21, seq([0])), 2000);
  assert.equal(nextScrollDelayMs(20, seq([0, 0])), 12000);
  assert.equal(nextScrollDelayMs(40, seq([0.999999, 0.999999])), 24000);
  assert.equal(nextScrollDelayMs(20, seq([0, 0.999999])), 22000);
});

test('scroll step, bottom detection, and empty-scroll streak', () => {
  assert.equal(scrollDeltaPx(1000), 900);
  assert.equal(scrollDeltaPx(1001), 901);
  assert.equal(scrollDeltaPx(0), 0);
  assert.equal(isPageBottom(1000, 800, 1800), true);
  assert.equal(isPageBottom(1000, 800, 1804), true);
  assert.equal(isPageBottom(0, 800, 5000), false);
  assert.equal(nextEmptyStreak(2, true), 0);
  assert.equal(nextEmptyStreak(2, false), 3);
});

test('collection ends after 3 empty scrolls at the bottom, or at 500 files', () => {
  const base = { atBottom: true, emptyStreak: 3, filesCollected: 10 };
  assert.equal(collectionStatus(base), 'done');
  assert.equal(collectionStatus({ ...base, emptyStreak: 2 }), 'collecting');
  assert.equal(collectionStatus({ ...base, atBottom: false }), 'collecting');
  assert.equal(collectionStatus({ atBottom: false, emptyStreak: 0, filesCollected: 500 }), 'cap');
  assert.equal(collectionStatus({ atBottom: true, emptyStreak: 3, filesCollected: 500 }), 'cap');
  assert.equal(collectionStatus({ atBottom: true, emptyStreak: 3, filesCollected: 499 }), 'done');
});

test('rate limit is HTTP 429 or errors[].code === 88', () => {
  assert.equal(isRateLimited(429, null), true);
  assert.equal(isRateLimited(429, { errors: [{ code: 1 }] }), true);
  assert.equal(isRateLimited(200, { errors: [{ code: 63 }, { code: 88 }] }), true);
  assert.equal(isRateLimited(200, '{"errors":[{"code":88,"message":"Rate limit exceeded"}]}'), true);
  assert.equal(isRateLimited(200, { errors: [{ code: 87 }] }), false);
  assert.equal(isRateLimited(200, { errors: [{ code: '88' }] }), false);
  assert.equal(isRateLimited(503, { errors: [] }), false);
  assert.equal(isRateLimited(200, 'not json'), false);
  assert.equal(isRateLimited(200, { data: { errors: [{ code: 88 }] } }), false);
  assert.equal(isRateLimited(200, null), false);
});

test('download starts stay at 3 concurrent and 300–800ms apart', () => {
  assert.equal(startGapMs(() => 0), 300);
  assert.equal(startGapMs(() => 0.999999), 800);
  assert.equal(queueDecision({ active: 3, pending: 4, elapsedMs: 1000, gapMs: 300 }), 'idle');
  assert.equal(queueDecision({ active: 1, pending: 0, elapsedMs: 1000, gapMs: 300 }), 'idle');
  assert.equal(queueDecision({ active: 0, pending: 2, paused: true, elapsedMs: 1000, gapMs: 0 }), 'idle');
  assert.equal(queueDecision({ active: 1, pending: 2, elapsedMs: 299, gapMs: 300 }), 'wait');
  assert.equal(queueDecision({ active: 1, pending: 2, elapsedMs: 300, gapMs: 300 }), 'start');
  assert.equal(queueDecision({ active: 0, pending: 1, elapsedMs: Infinity, gapMs: 0 }), 'start');
});

test('simulated queue never overlaps more than 3 starts inside the gap', () => {
  const gaps = [0, 300, 800, 300, 500];
  const duration = 5000;
  let t = 0;
  let nextGap = 0;
  let lastStart = -1e15;
  let pending = 5;
  const activeUntil = [];
  const starts = [];
  let guard = 0;
  while ((pending > 0 || activeUntil.length) && guard++ < 1000) {
    for (let i = activeUntil.length - 1; i >= 0; i--) {
      if (activeUntil[i] <= t) activeUntil.splice(i, 1);
    }
    if (pending === 0 && activeUntil.length === 0) break;
    const decision = queueDecision({
      active: activeUntil.length,
      pending,
      paused: false,
      elapsedMs: t - lastStart,
      gapMs: nextGap,
    });
    if (decision === 'start') {
      pending--;
      starts.push(t);
      activeUntil.push(t + duration);
      lastStart = t;
      nextGap = gaps[starts.length] ?? 300;
      assert.ok(activeUntil.length <= 3);
      continue;
    }
    let nextT = Infinity;
    for (const end of activeUntil) if (end > t && end < nextT) nextT = end;
    if (decision === 'wait') nextT = Math.min(nextT, lastStart + nextGap);
    if (!Number.isFinite(nextT)) break;
    t = nextT;
  }
  assert.deepEqual(starts, [0, 300, 1100, 5000, 5500]);
});

test('retries back off 5s then 15s and only for network or server interrupts', () => {
  assert.equal(retryDelayMs(1), 5000);
  assert.equal(retryDelayMs(2), 15000);
  assert.equal(retryDelayMs(3), null);
  assert.equal(retryDelayMs(0), null);
  for (const code of ['NETWORK_FAILED', 'NETWORK_DISCONNECTED', 'server_forbidden', 'SERVER_BAD_CONTENT']) {
    assert.equal(isRetryableDownloadError(code), true);
  }
  for (const code of ['', null, 'USER_CANCELED', 'FILE_FAILED', 'CRASH', 'Could not find a video']) {
    assert.equal(isRetryableDownloadError(code), false);
  }
});

test('batch entry is only the profile Media tab', () => {
  assert.equal(mediaUserFromPath('/nasa/media'), 'nasa');
  assert.equal(mediaUserFromPath('/AbC_123/media/'), 'AbC_123');
  assert.equal(mediaUserFromPath('/a/media'), 'a');
  for (const path of ['', '/media', '/nasa/status/1', '/nasa/media/grid', '/user-name/media',
    '/1234567890123456/media', '/nasa/likes']) {
    assert.equal(mediaUserFromPath(path), null);
  }
  assert.equal(mediaUserFromUrl('https://x.com/nasa/media'), 'nasa');
  assert.equal(mediaUserFromUrl('https://twitter.com/nasa/media/?lang=en'), 'nasa');
  assert.equal(mediaUserFromUrl('https://mobile.x.com/nasa/media'), 'nasa');
  assert.equal(mediaUserFromUrl('https://pro.x.com/NASA/media/'), 'NASA');
  for (const url of ['https://example.com/nasa/media', 'https://x.com.evil/nasa/media',
    'https://evil.com/x.com/nasa/media', 'https://x.com/nasa/likes', 'not a url']) {
    assert.equal(mediaUserFromUrl(url), null);
  }
  assert.equal(sameAuthor('NASA', 'nasa'), true);
  assert.equal(sameAuthor('other', 'nasa'), false);
  assert.equal(sameAuthor('', 'nasa'), false);
  assert.equal(sameAuthor('nasa', ''), false);
});
