// Pure batch-download policy. No Chrome, DOM, or network access: the content
// script applies these decisions, and the tests can run them under node.

export const BATCH_LIMITS = {
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
};

// Inclusive integer range. Math.random() is [0, 1), so the top value is reachable.
export function jitterMs(min, max, random = Math.random) {
  const lo = Math.ceil(min);
  const hi = Math.floor(max);
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return lo || 0;
  const unit = Math.min(Math.max(Number(random()) || 0, 0), 0.999999999999);
  return lo + Math.floor(unit * (hi - lo + 1));
}

// `scrollsCompleted` is how many scroll steps have already happened. Every 20th
// step adds a longer rest so a long Media timeline is not one continuous fling.
export function nextScrollDelayMs(scrollsCompleted, random = Math.random) {
  const base = jitterMs(BATCH_LIMITS.scrollMinMs, BATCH_LIMITS.scrollMaxMs, random);
  const n = Number(scrollsCompleted) || 0;
  if (n > 0 && n % BATCH_LIMITS.pauseEvery === 0) {
    return base + jitterMs(BATCH_LIMITS.pauseMinMs, BATCH_LIMITS.pauseMaxMs, random);
  }
  return base;
}

export function scrollDeltaPx(innerHeight) {
  const h = Number(innerHeight);
  if (!Number.isFinite(h) || h <= 0) return 0;
  return Math.round(h * 0.9);
}

export function isPageBottom(scrollY, viewport, scrollHeight, slackPx = 8) {
  const y = Number(scrollY) || 0;
  const vh = Number(viewport) || 0;
  const sh = Number(scrollHeight) || 0;
  return y + vh >= sh - slackPx;
}

export function nextEmptyStreak(emptyStreak, sawNew) {
  if (sawNew) return 0;
  return (Number(emptyStreak) || 0) + 1;
}

// 'cap' stops collection but leaves the queue running. 'done' means the timeline
// stopped producing new rows. Anything else keeps scrolling.
export function collectionStatus({ atBottom = false, emptyStreak = 0, filesCollected = 0 } = {}) {
  if (filesCollected >= BATCH_LIMITS.maxFiles) return 'cap';
  if (atBottom && emptyStreak >= BATCH_LIMITS.emptyScrollsToFinish) return 'done';
  return 'collecting';
}

// HTTP 429 or Twitter error 88. Status wins even when the body is unreadable.
// Code comparison is strict: the string "88" is a different failure.
export function isRateLimited(status, body) {
  if (Number(status) === 429) return true;
  let data = body;
  if (typeof body === 'string') {
    const trimmed = body.trim();
    if (!trimmed || trimmed[0] !== '{') return false;
    try {
      data = JSON.parse(trimmed);
    } catch (_) {
      return false;
    }
  }
  const errors = data && data.errors;
  return Array.isArray(errors) && errors.some((e) => e && e.code === 88);
}

export function startGapMs(random = Math.random) {
  return jitterMs(BATCH_LIMITS.startGapMinMs, BATCH_LIMITS.startGapMaxMs, random);
}

// `failureCount` is how many times this file has already failed. The third
// failure has no delay: the caller records it as interrupted.
export function retryDelayMs(failureCount) {
  const delay = BATCH_LIMITS.retryDelaysMs[(Number(failureCount) || 0) - 1];
  return delay == null ? null : delay;
}

export function isRetryableDownloadError(error) {
  const code = String(error || '').trim().toUpperCase();
  return code.startsWith('NETWORK_') || code.startsWith('SERVER_');
}

// 'start' consumes one pending file. 'wait' means a slot is free but the gap
// since the previous start has not elapsed. 'idle' means nothing can start.
export function queueDecision({ active = 0, pending = 0, paused = false, elapsedMs = 0, gapMs = 0 } = {}) {
  if (paused || pending <= 0 || active >= BATCH_LIMITS.maxConcurrent) return 'idle';
  if (elapsedMs < gapMs) return 'wait';
  return 'start';
}

// Author Media tab only. Query strings are not part of `pathname`.
const MEDIA_PATH = /^\/([A-Za-z0-9_]{1,15})\/media\/?$/;

export function mediaUserFromPath(pathname) {
  const match = MEDIA_PATH.exec(String(pathname || ''));
  return match ? match[1] : null;
}

const MEDIA_HOST = /^(?:(?:mobile|pro)\.)?(?:x|twitter)\.com$/;

export function mediaUserFromUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    if (!MEDIA_HOST.test(parsed.hostname)) return null;
    return mediaUserFromPath(parsed.pathname);
  } catch (_) {
    return null;
  }
}

export function sameAuthor(recordName, pageUser) {
  if (!pageUser || !recordName) return false;
  return String(recordName).toLowerCase() === String(pageUser).toLowerCase();
}

// GraphQL operation name only: query variables cannot turn badge polls into timelines.
export function isMediaTimelineOperation(url) {
  try {
    const path = new URL(url, 'https://x.com').pathname;
    const match = /^\/i\/api\/graphql\/[^/]+\/([^/]+)\/?$/.exec(path);
    if (!match) return false;
    const operation = match[1];
    return operation.endsWith('Timeline') ||
      (operation.startsWith('User') && /Tweets|Media/.test(operation));
  } catch (_) {
    return false;
  }
}
