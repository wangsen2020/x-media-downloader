// Service worker (ES module).
import {
  parseVariants,
  pickVariant,
  labelForVariant,
  buildFilename,
  syndicationUrl,
  parseSyndicationResponse,
} from './lib/media.js';
import {
  getSettings,
  addHistoryEntry,
  updateHistoryEntry,
  getHistory,
} from './lib/store.js';

const SESSION_PREFIX = 'media:';
const MAX_SESSION = 150;

// --- capture cache ---------------------------------------------------------

async function cacheRecords(records) {
  if (!records || !records.length) return;
  const items = {};
  for (const r of records) {
    if (r && r.tweetId && r.variants && r.variants.length) {
      items[SESSION_PREFIX + r.tweetId] = r;
    }
  }
  if (!Object.keys(items).length) return;
  await chrome.storage.session.set(items);

  const all = await chrome.storage.session.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith(SESSION_PREFIX));
  if (keys.length > MAX_SESSION) {
    keys
      .map((k) => [k, all[k].capturedAt || 0])
      .sort((a, b) => a[1] - b[1])
      .slice(0, keys.length - MAX_SESSION)
      .forEach(([k]) => chrome.storage.session.remove(k));
  }
}

async function fromCache(tweetId) {
  const got = await chrome.storage.session.get(SESSION_PREFIX + tweetId);
  return got[SESSION_PREFIX + tweetId] || null;
}

async function fromSyndication(tweetId) {
  const res = await fetch(syndicationUrl(tweetId), {
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`syndication ${res.status}`);
  const json = await res.json();
  const records = parseSyndicationResponse(json, tweetId);
  await cacheRecords(records);
  return records.find((r) => r.tweetId === String(tweetId)) || records[0] || null;
}

async function resolveMedia(tweetId, hint) {
  if (hint && Array.isArray(hint.variants) && hint.variants.length) {
    await cacheRecords([hint]);
    return hint;
  }
  const cached = await fromCache(tweetId);
  if (cached && cached.variants && cached.variants.length) return cached;
  return fromSyndication(tweetId);
}

// --- download ------------------------------------------------------------

async function startDownload(req) {
  const settings = await getSettings();
  const record = await resolveMedia(req.tweetId, req.record);
  if (!record) throw new Error('no media found');

  const variants =
    record.variants && record.variants.length
      ? record.variants
      : parseVariants(record.video_info || {});
  if (!variants.length) throw new Error('no mp4 variants');

  const quality = req.quality || settings.defaultQuality;
  const chosen = pickVariant(variants, quality) || variants[0];
  const label = labelForVariant(chosen);
  const realName = (n) => (n && n !== 'unknown' ? n : null);
  const screenName = realName(record.screenName) || realName(req.screenName) || 'unknown';
  const tweetUrl =
    req.tweetUrl || `https://x.com/${screenName}/status/${req.tweetId}`;

  const filename = buildFilename(
    settings.filenameTemplate,
    {
      user: screenName,
      id: req.tweetId,
      height: chosen.height,
      bitrate: chosen.bitrate,
      quality: label,
      index: 0,
      count: 1,
      date: Date.now(),
      text: record.text || '',
    },
    settings.subfolder,
  );

  const entry = await addHistoryEntry({
    tweetId: req.tweetId,
    screenName,
    tweetUrl,
    type: record.type || 'video',
    quality: label,
    height: chosen.height || 0,
    bitrate: chosen.bitrate || 0,
    poster: record.poster || '',
    filename,
    url: chosen.url,
    state: 'in_progress',
  });

  let downloadId;
  try {
    downloadId = await chrome.downloads.download({
      url: chosen.url,
      filename,
      saveAs: !!settings.askWhereToSave,
      conflictAction: 'uniquify',
    });
  } catch (e) {
    await updateHistoryEntry(
      { key: entry.key },
      { state: 'interrupted', error: String(e.message || e) },
    );
    throw e;
  }

  await updateHistoryEntry({ key: entry.key }, { downloadId });
  return { ok: true, filename, label, downloadId, key: entry.key };
}

// --- download progress -> history ---------------------------------------

chrome.downloads.onChanged.addListener(async (delta) => {
  const patch = {};
  if (delta.state) {
    if (delta.state.current === 'complete') patch.state = 'complete';
    else if (delta.state.current === 'interrupted') patch.state = 'interrupted';
  }
  if (delta.error) patch.error = delta.error.current || '';
  if (delta.filename && delta.filename.current) patch.filename = delta.filename.current;
  if (!Object.keys(patch).length) return;

  let updated = await updateHistoryEntry({ downloadId: delta.id }, patch);

  if (updated && patch.state === 'complete') {
    try {
      const [item] = await chrome.downloads.search({ id: delta.id });
      if (item) {
        await updateHistoryEntry(
          { downloadId: delta.id },
          { bytes: item.fileSize || item.totalBytes || 0, filename: item.filename || updated.filename },
        );
      }
    } catch (_) {
      /* ignore */
    }
  }
});

// --- messaging ---------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === 'xvd:media') {
    cacheRecords(msg.records);
    return; // no response
  }

  if (msg.type === 'xvd:get-media') {
    resolveMedia(msg.tweetId, msg.record)
      .then((rec) => sendResponse({ ok: !!rec, record: rec || null }))
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true;
  }

  if (msg.type === 'xvd:download') {
    startDownload(msg)
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true;
  }

  if (msg.type === 'xvd:redownload') {
    getHistory()
      .then((list) => {
        const rec = list.find((r) => r.key === msg.key);
        if (!rec) throw new Error('history entry gone');
        return startDownload({
          tweetId: rec.tweetId,
          screenName: rec.screenName,
          tweetUrl: rec.tweetUrl,
          quality: msg.quality || String(rec.height || 'highest'),
        });
      })
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true;
  }

  if (msg.type === 'xvd:show-file') {
    if (typeof msg.downloadId === 'number') chrome.downloads.show(msg.downloadId);
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'xvd:open-options') {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return true;
  }
});

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') chrome.runtime.openOptionsPage();
});
