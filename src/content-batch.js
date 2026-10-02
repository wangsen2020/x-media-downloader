// Media-tab batch controller. It lives in the content script because the
// service worker can be discarded at any time; the queue has to survive that.
// Scrolling only moves the page. Files come from responses X already made.
import { mediaKeyFromUrl } from './lib/media.js';
import {
  BATCH_LIMITS,
  nextScrollDelayMs,
  scrollDeltaPx,
  isPageBottom,
  nextEmptyStreak,
  collectionStatus,
  startGapMs,
  retryDelayMs,
  isRetryableDownloadError,
  queueDecision,
  mediaUserFromPath,
  sameAuthor,
} from './lib/batch.js';
import { t } from './lib/i18n.js';

const PAUSE_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M7 5h3.2v14H7V5Zm6.8 0H17v14h-3.2V5Z"/></svg>';
const PLAY_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M8 5.5v13l11-6.5L8 5.5Z"/></svg>';
const STOP_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M6.5 6.5h11v11h-11v-11Z"/></svg>';

const wakers = new Set();

function wakeWaiters() {
  for (const wake of [...wakers]) wake();
}

function sleep(ms) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (interrupted) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      wakers.delete(wake);
      resolve(interrupted);
    };
    const wake = () => settle(true);
    const timer = setTimeout(() => settle(false), ms);
    wakers.add(wake);
  });
}

function waitUntil(pred) {
  if (pred()) return Promise.resolve();
  return new Promise((resolve) => {
    const wake = () => {
      if (!pred()) return;
      wakers.delete(wake);
      resolve();
    };
    wakers.add(wake);
  });
}

function newBatchId() {
  const rand = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);
  return `b-${Date.now().toString(36)}-${rand}`;
}

export function attachBatch({ getVideos, getPhotos, getSettings }) {
  let batch = null;
  let active = 0;
  let lastStartAt = 0;
  let nextGap = 0;
  let pumpTimer = 0;
  let badgeText = '';
  const clients = new Map();

  document.addEventListener('visibilitychange', wakeWaiters);

  function countsLine() {
    return t(
      'batchCounts',
      batch.downloaded,
      batch.collected,
      batch.skipped,
      batch.failed,
    );
  }

  function remaining() {
    if (!batch) return 0;
    return batch.pending.length + active + batch.delayed;
  }

  function updateBadge() {
    const text = remaining() > 0 ? String(Math.min(remaining(), 999)) : '';
    if (text === badgeText) return;
    badgeText = text;
    try {
      chrome.runtime.sendMessage({ type: 'xvd:badge', text }).catch(() => {});
    } catch (_) {
      /* extension reloaded */
    }
  }

  function ensurePanel() {
    let root = document.getElementById('xvd-batch');
    if (root) return root;
    root = document.createElement('div');
    root.id = 'xvd-batch';
    root.setAttribute('role', 'region');
    root.setAttribute('aria-label', t('batchAria'));
    root.innerHTML =
      '<div class="xvd-batch__row">' +
      '<p class="xvd-batch__status" role="status"></p>' +
      '<div class="xvd-batch__controls">' +
      `<button type="button" class="xvd-batch__btn" data-act="toggle">${PAUSE_SVG}</button>` +
      `<button type="button" class="xvd-batch__btn" data-act="stop">${STOP_SVG}</button>` +
      `<button type="button" class="xvd-batch__btn" data-act="continue" hidden>${PLAY_SVG}</button>` +
      '</div></div>' +
      '<div class="xvd-batch__track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">' +
      '<div class="xvd-batch__fill"></div></div>' +
      '<p class="xvd-batch__note" hidden></p>' +
      '<p class="xvd-batch__links" hidden>' +
      '<a class="xvd-batch__link" data-act="history" href="#"></a>' +
      '<a class="xvd-batch__link" data-act="folder" href="#"></a>' +
      '</p>';
    const stop = root.querySelector('[data-act="stop"]');
    stop.title = t('batchStop');
    stop.setAttribute('aria-label', t('batchStop'));
    const cont = root.querySelector('[data-act="continue"]');
    cont.title = t('batchContinue');
    cont.setAttribute('aria-label', t('batchContinue'));
    root.querySelector('[data-act="history"]').textContent = t('batchHistory');
    root.querySelector('[data-act="folder"]').textContent = t('batchFolder');
    root.addEventListener('click', onPanelClick);
    (document.body || document.documentElement).appendChild(root);
    return root;
  }

  function render() {
    if (!batch) return;
    const root = ensurePanel();
    const status = root.querySelector('.xvd-batch__status');
    const note = root.querySelector('.xvd-batch__note');
    const track = root.querySelector('.xvd-batch__track');
    const fill = root.querySelector('.xvd-batch__fill');
    const controls = root.querySelector('.xvd-batch__controls');
    const toggle = root.querySelector('[data-act="toggle"]');
    const stop = root.querySelector('[data-act="stop"]');
    const cont = root.querySelector('[data-act="continue"]');
    const links = root.querySelector('.xvd-batch__links');
    const folder = root.querySelector('[data-act="folder"]');
    const finished = batch.phase === 'finished' || batch.phase === 'stopped';
    const held = batch.rateLimited || batch.userPaused;

    if (batch.phase === 'finished') {
      status.textContent = t('batchFinished', batch.downloaded);
    } else if (batch.phase === 'stopped') {
      status.textContent = t('batchStopped', batch.downloaded);
    } else {
      status.textContent = countsLine();
    }

    note.hidden = true;
    if (batch.rateLimited) {
      note.hidden = false;
      note.textContent = t('batchRateLimited');
    } else if (batch.phase === 'capped') {
      note.hidden = false;
      note.textContent = t('batchCapped', BATCH_LIMITS.maxFiles);
    } else if (finished && (batch.skipped || batch.failed)) {
      note.hidden = false;
      note.textContent = t('batchSkippedFailed', batch.skipped, batch.failed);
    }

    const settled = batch.downloaded + batch.skipped + batch.failed;
    const total = Math.max(batch.collected, settled, 1);
    const pct = batch.collected ? Math.min(100, Math.round((settled / total) * 100)) : 0;
    track.hidden = finished;
    track.setAttribute('aria-valuenow', String(pct));
    fill.style.width = pct + '%';

    controls.hidden = finished;
    toggle.hidden = finished;
    stop.hidden = finished;
    toggle.innerHTML = held ? PLAY_SVG : PAUSE_SVG;
    const toggleLabel = held ? t('batchResume') : t('batchPause');
    toggle.title = toggleLabel;
    toggle.setAttribute('aria-label', toggleLabel);
    cont.hidden = batch.phase !== 'capped' || batch.rateLimited;

    links.hidden = !finished;
    folder.hidden = batch.lastDownloadId == null;
    updateBadge();
  }

  function onPanelClick(event) {
    const el = event.target.closest('[data-act]');
    const root = document.getElementById('xvd-batch');
    if (!el || !root || !root.contains(el)) return;
    event.preventDefault();
    event.stopPropagation();
    const act = el.dataset.act;
    if (act === 'toggle') togglePause();
    else if (act === 'stop') stopBatch();
    else if (act === 'continue') continueBatch();
    else if (act === 'history') openHistory();
    else if (act === 'folder') openFolder();
  }

  function videoItem(rec) {
    const url = rec.variants[0] && rec.variants[0].url;
    if (!url) return null;
    return {
      seenKey: mediaKeyFromUrl(url) || `tweet:${rec.tweetId}`,
      kind: 'video',
      tweetId: rec.tweetId,
      screenName: rec.screenName,
      text: rec.text || '',
      record: rec,
      failures: 0,
    };
  }

  function photoItems(rec) {
    const items = [];
    const seen = new Set();
    for (const url of rec.images || []) {
      if (typeof url !== 'string' || !url || seen.has(url)) continue;
      seen.add(url);
      items.push({
        seenKey: mediaKeyFromUrl(url) || `img:${url.split('?')[0]}`,
        kind: 'image',
        tweetId: rec.tweetId,
        screenName: rec.screenName,
        text: rec.text || '',
        postDate: rec.postDate || 0,
        url,
        failures: 0,
      });
    }
    return items;
  }

  function consider(item) {
    if (!item || batch.seen.has(item.seenKey)) return 'dup';
    // `collected` is the session total shown in the panel. `runCount` is this
    // 500-file slice, so Continue can take the next slice without zeroing progress.
    if (batch.runCount >= BATCH_LIMITS.maxFiles) {
      if (batch.phase === 'running') {
        batch.phase = 'capped';
        wakeWaiters();
      }
      return 'cap';
    }
    batch.seen.add(item.seenKey);
    batch.collected++;
    batch.runCount++;
    item.batchId = batch.id;
    batch.pending.push(item);
    if (batch.runCount >= BATCH_LIMITS.maxFiles && batch.phase === 'running') {
      batch.phase = 'capped';
      wakeWaiters();
    }
    return 'added';
  }

  function ingest(records) {
    if (!batch || (batch.phase !== 'running' && batch.phase !== 'draining')) return 0;
    let added = 0;
    for (const rec of records || []) {
      if (!rec || !sameAuthor(rec.screenName, batch.user)) continue;
      const items = rec.type === 'photo' ? photoItems(rec) : rec.variants && rec.variants.length ? [videoItem(rec)] : [];
      for (const item of items) {
        const result = consider(item);
        if (result === 'cap') {
          render();
          pump();
          return added;
        }
        if (result === 'added') added++;
      }
    }
    if (added) {
      render();
      pump();
    }
    return added;
  }

  function seed() {
    ingest([...(getVideos() || new Map()).values(), ...(getPhotos() || new Map()).values()]);
  }

  function releaseActive() {
    active = Math.max(0, active - 1);
  }

  function failItem(item, error) {
    item.failures = (item.failures || 0) + 1;
    releaseActive();
    const delay = batch && batch.phase !== 'stopped' && isRetryableDownloadError(error)
      ? retryDelayMs(item.failures)
      : null;
    if (delay == null || !batch) {
      if (batch) batch.failed++;
      pump();
      return;
    }
    const session = batch;
    batch.delayed++;
    setTimeout(() => {
      if (batch !== session || session.phase === 'stopped') return;
      session.delayed = Math.max(0, session.delayed - 1);
      item.settled = false;
      item.clientId = null;
      session.pending.unshift(item);
      pump();
    }, delay);
    // The failed slot is free; other files should not wait out this backoff.
    pump();
  }

  function buildMessage(item, clientId) {
    const msg = {
      type: 'xvd:download',
      clientId,
      batchId: item.batchId,
      tweetId: item.tweetId,
      screenName: item.screenName,
      tweetUrl: `${location.origin}/${item.screenName}/status/${item.tweetId}`,
      text: item.text || '',
    };
    if (item.kind === 'image') {
      msg.kind = 'image';
      msg.images = [item.url];
      msg.size = 'orig';
      msg.postDate = item.postDate || 0;
    } else {
      const settings = getSettings() || {};
      msg.kind = 'video';
      msg.quality = settings.defaultQuality || 'highest';
      // The captured record already has variants, so the worker must not fall
      // through to the public syndication request.
      msg.record = item.record;
    }
    return msg;
  }

  async function launch(item) {
    // Stop + a new run replaces `batch` while this request is still open.
    // The response has to settle on the run that started it.
    const session = batch;
    const clientId = crypto.randomUUID ? crypto.randomUUID() : newBatchId();
    item.clientId = clientId;
    item.settled = false;
    clients.set(clientId, item);
    let res;
    try {
      res = await chrome.runtime.sendMessage(buildMessage(item, clientId));
    } catch (e) {
      clients.delete(clientId);
      if (batch === session && !item.settled) failItem(item, e && e.message);
      return;
    }
    if (item.settled || batch !== session) return;
    if (res && res.duplicate) {
      clients.delete(clientId);
      releaseActive();
      batch.skipped++;
      pump();
      return;
    }
    if (!res || !res.ok || res.downloadId == null) {
      clients.delete(clientId);
      failItem(item, res && res.error);
      return;
    }
    item.downloadId = res.downloadId;
  }

  function pump() {
    if (!batch) return;
    clearTimeout(pumpTimer);
    while (batch.phase !== 'stopped') {
      const elapsed = lastStartAt ? Date.now() - lastStartAt : Infinity;
      const decision = queueDecision({
        active,
        pending: batch.pending.length,
        paused: batch.userPaused,
        elapsedMs: elapsed,
        gapMs: nextGap,
      });
      if (decision !== 'start') {
        if (decision === 'wait') {
          pumpTimer = setTimeout(pump, Math.max(0, nextGap - elapsed));
        }
        break;
      }
      const item = batch.pending.shift();
      active++;
      lastStartAt = Date.now();
      nextGap = startGapMs();
      launch(item);
    }
    maybeFinish();
    render();
  }

  function maybeFinish() {
    if (!batch) return;
    const idle = batch.pending.length === 0 && active === 0 && batch.delayed === 0;
    if (idle && batch.phase === 'draining') batch.phase = 'finished';
  }

  function onDownloadDone(msg) {
    if (!msg || !msg.clientId) return;
    const item = clients.get(msg.clientId);
    if (!item || item.settled) return;
    item.settled = true;
    clients.delete(msg.clientId);
    if (!batch) return;
    if (msg.state === 'complete') {
      batch.downloaded++;
      batch.lastDownloadId = msg.downloadId;
      releaseActive();
      pump();
      return;
    }
    failItem(item, msg.error || '');
  }

  function scrollable() {
    return batch && batch.gen && batch.phase === 'running' && !document.hidden && !batch.userPaused && !batch.rateLimited;
  }

  let scrollLoopGen = 0;

  async function runScroll(gen) {
    scrollLoopGen = gen;
    try {
      while (batch && batch.gen === gen && batch.phase !== 'stopped' && batch.phase !== 'finished') {
        if (!scrollable()) {
          await waitUntil(() => !batch || batch.gen !== gen || batch.phase === 'stopped' || scrollable());
          continue;
        }
        const pageUser = mediaUserFromPath(location.pathname);
        // X changes the URL without reloading. Stop collecting once we leave
        // this author's Media tab; files already queued still download.
        if (!sameAuthor(pageUser, batch.user)) {
          batch.phase = 'draining';
          break;
        }
        const before = batch.collected;
        const beforeY = window.scrollY;
        window.scrollBy(0, scrollDeltaPx(window.innerHeight));
        batch.scrolls++;
        const interrupted = await sleep(nextScrollDelayMs(batch.scrolls));
        if (!batch || batch.gen !== gen) return;
        if (interrupted || !scrollable()) continue;
        const scrolling = document.scrollingElement || document.documentElement;
        // A scroll that does not move is the bottom, even when a footer makes
        // scrollHeight a few pixels taller than the viewport math.
        const atBottom = window.scrollY <= beforeY + 1 ||
          isPageBottom(window.scrollY, window.innerHeight, scrolling.scrollHeight);
        batch.emptyStreak = nextEmptyStreak(batch.emptyStreak, batch.collected > before);
        const status = collectionStatus({
          atBottom,
          emptyStreak: batch.emptyStreak,
          filesCollected: batch.runCount,
        });
        if (status === 'cap') batch.phase = 'capped';
        else if (status === 'done') batch.phase = 'draining';
        render();
        if (batch.phase === 'draining') break;
      }
    } finally {
      if (scrollLoopGen === gen) scrollLoopGen = 0;
    }
    pump();
  }

  function togglePause() {
    if (!batch || batch.phase === 'finished' || batch.phase === 'stopped') return;
    if (batch.rateLimited || batch.userPaused) {
      batch.rateLimited = false;
      batch.userPaused = false;
      wakeWaiters();
      pump();
    } else {
      batch.userPaused = true;
      clearTimeout(pumpTimer);
      wakeWaiters();
      render();
    }
  }

  function stopBatch() {
    if (!batch || batch.phase === 'finished' || batch.phase === 'stopped') return;
    batch.phase = 'stopped';
    batch.gen++;
    batch.pending.length = 0;
    batch.delayed = 0;
    clearTimeout(pumpTimer);
    wakeWaiters();
    if (active === 0) batch.phase = 'stopped';
    maybeFinish();
    render();
  }

  function continueBatch() {
    if (!batch || batch.phase !== 'capped' || batch.rateLimited) return;
    batch.phase = 'running';
    batch.runCount = 0;
    batch.emptyStreak = 0;
    batch.userPaused = false;
    // Rows captured while the cap was holding are already in the maps.
    seed();
    if (scrollLoopGen !== batch.gen) runScroll(batch.gen);
    wakeWaiters();
    pump();
  }

  function openHistory() {
    if (!batch) return;
    try {
      chrome.runtime.sendMessage({ type: 'xvd:open-batch', batchId: batch.id }).catch(() => {});
    } catch (_) {
      /* ignore */
    }
  }

  function openFolder() {
    if (!batch || batch.lastDownloadId == null) return;
    try {
      chrome.runtime.sendMessage({ type: 'xvd:show-file', downloadId: batch.lastDownloadId }).catch(() => {});
    } catch (_) {
      /* ignore */
    }
  }

  function busy() {
    return batch && batch.phase !== 'finished' && batch.phase !== 'stopped';
  }

  function start() {
    const user = mediaUserFromPath(location.pathname);
    if (!user) return { ok: false, error: t('batchNeedMediaTab') };
    if (busy()) return { ok: true, already: true, batchId: batch.id };
    clearTimeout(pumpTimer);
    active = 0;
    lastStartAt = 0;
    nextGap = 0;
    clients.clear();
    badgeText = '';
    const gen = (batch && batch.gen ? batch.gen : 0) + 1;
    batch = {
      id: newBatchId(),
      gen,
      user,
      phase: 'running',
      collected: 0,
      downloaded: 0,
      skipped: 0,
      failed: 0,
      emptyStreak: 0,
      scrolls: 0,
      runCount: 0,
      pending: [],
      delayed: 0,
      seen: new Set(),
      userPaused: false,
      rateLimited: false,
      lastDownloadId: null,
    };
    ensurePanel();
    seed();
    render();
    pump();
    runScroll(gen);
    return { ok: true, batchId: batch.id };
  }

  function onRateLimit() {
    if (!batch || batch.phase === 'finished' || batch.phase === 'stopped') return;
    if (batch.rateLimited) return;
    batch.rateLimited = true;
    wakeWaiters();
    render();
  }

  // content.js answers xvd:batch-start. This module may still be loading
  // when the popup clicks, so the listener has to live in the classic script.
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== 'xvd:download-done') return;
    onDownloadDone(msg);
  });

  return { ingest, onRateLimit, start };
}
