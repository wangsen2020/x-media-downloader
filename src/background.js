// Service worker (ES module).
import {
  mediaKeyFromUrl,
  parseVariants,
  pickVariant,
  labelForVariant,
  buildFilename,
  bestImageUrl,
  imageExt,
  syndicationUrl,
  parseSyndicationResponse,
} from './lib/media.js';
import {
  getSettings,
  addHistoryEntry,
  updateHistoryEntry,
  getHistory,
  getDownloaded,
  recordDownloaded,
} from './lib/store.js';
import { t } from './lib/i18n.js';
import { welcomeUrl, uninstallUrl } from './lib/site.js';

const SESSION_PREFIX = 'media:';
const DOWNLOAD_TAB_PREFIX = 'dl:';
const MAX_SESSION = 150;
// Chrome search triggers an asynchronous file-existence check; allow it to refresh.
const DOWNLOAD_EXISTS_REFRESH_DELAY_MS = 300;

// --- capture cache ---------------------------------------------------------

async function cacheRecords(records) {
  if (!records || !records.length) return;
  const items = {};
  for (const r of records) {
    // Photo records have no variants. Keeping them out of this cache leaves
    // the single-post video path reading only real renditions.
    if (r && r.tweetId && r.type !== 'photo' && r.variants && r.variants.length) {
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
  if (!res.ok) throw new Error(t('toastErrSyndication', res.status));
  const json = await res.json();

  // This endpoint is unauthenticated, so anything the author or X restricts to
  // signed-in viewers comes back as a tombstone rather than an error. The page
  // itself plays fine for the logged-in user, which makes a generic "no media"
  // message actively misleading - say what actually happened.
  if (json && (json.tombstone || json.__typename === 'TweetTombstone')) {
    throw new Error(t('toastErrTombstone'));
  }

  const records = parseSyndicationResponse(json, tweetId);

  // video_info present but nothing survived parseVariants = HLS only. X serves
  // some uploads as m3u8 playlists with no progressive MP4, and chrome.downloads
  // cannot save a playlist as one file. That is a limit, not a failure.
  if (!records.length) {
    const details = [].concat(json?.mediaDetails || [], json?.video ? [json.video] : []);
    if (details.some((d) => (d.video_info || d).variants)) {
      throw new Error(t('toastErrHls'));
    }
  }

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

// Which tab asked for a download. Session storage survives a service-worker
// restart; the map covers the gap before that write finishes.
const downloadOrigins = new Map();

async function rememberDownloadOrigin(downloadId, origin) {
  if (downloadId == null || !origin || origin.tabId == null) return;
  const info = { tabId: origin.tabId, clientId: origin.clientId || '' };
  downloadOrigins.set(downloadId, info);
  await chrome.storage.session.set({ [DOWNLOAD_TAB_PREFIX + downloadId]: info });
}

function notifyDownloadDone(downloadId, state, error) {
  const key = DOWNLOAD_TAB_PREFIX + downloadId;
  const cached = downloadOrigins.get(downloadId);
  const lookup = cached
    ? Promise.resolve(cached)
    : chrome.storage.session.get(key).then((got) => (got && got[key]) || null);
  // Not awaited. Waiting here while still answering xvd:download can deadlock
  // the content script that is blocked on our response.
  lookup.then((origin) => {
    if (!origin || origin.tabId == null || !chrome.tabs || !chrome.tabs.sendMessage) return null;
    return chrome.tabs.sendMessage(origin.tabId, {
      type: 'xvd:download-done',
      downloadId,
      state,
      error: error || '',
      clientId: origin.clientId || '',
    });
  }).then(() => {
    downloadOrigins.delete(downloadId);
    return chrome.storage.session.remove(key);
  }).catch(() => {});
}

async function duplicateResponse(url, force) {
  if (force) return null;
  const key = mediaKeyFromUrl(url);
  const saved = key && (await getDownloaded())[key];
  if (!saved) return null;
  if (saved.downloadId != null) {
    await chrome.downloads.search({ id: saved.downloadId });
    await new Promise((resolve) => setTimeout(resolve, DOWNLOAD_EXISTS_REFRESH_DELAY_MS));
    const [item] = await chrome.downloads.search({ id: saved.downloadId });
    if (item && item.exists === false) return null;
  }
  return { ok: false, duplicate: true, at: saved.at, filename: saved.filename };
}

// A small file can finish before its download id is attached to history.
async function attachDownload(entry, downloadId) {
  await updateHistoryEntry({ key: entry.key }, { downloadId });
  const [item] = await chrome.downloads.search({ id: downloadId });
  if (item && (item.state === 'complete' || item.state === 'interrupted')) {
    await updateDownload({ id: downloadId, state: { current: item.state } });
  }
}

async function startDownload(req, origin) {
  const settings = await getSettings();
  const record = await resolveMedia(req.tweetId, req.record);
  if (!record) throw new Error(t('toastErrNoVideo'));

  const variants =
    record.variants && record.variants.length
      ? record.variants
      : parseVariants(record.video_info || {});
  if (!variants.length) throw new Error(t('toastErrNoMp4'));

  const quality = req.quality || settings.defaultQuality;
  const chosen = pickVariant(variants, quality) || variants[0];
  const duplicate = await duplicateResponse(chosen.url, req.force);
  if (duplicate) return duplicate;
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
      postDate: record.postDate || 0,
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
    batchId: req.batchId || '',
  });

  let downloadId;
  try {
    downloadId = await chrome.downloads.download({
      url: chosen.url,
      filename,
      // A save dialog per file would stall the batch queue on the user.
      saveAs: !!settings.askWhereToSave && !req.batchId,
      conflictAction: 'uniquify',
    });
  } catch (e) {
    await updateHistoryEntry(
      { key: entry.key },
      { state: 'interrupted', error: String(e.message || e) },
    );
    throw e;
  }

  await rememberDownloadOrigin(downloadId, origin).catch(() => {});
  await attachDownload(entry, downloadId);
  return { ok: true, filename, label, downloadId, key: entry.key };
}

const SIZE_MAP = { orig: 'orig', large: 'large', medium: 'medium', small: 'small' };

async function startImageDownload(req, origin) {
  const settings = await getSettings();
  const realName = (n) => (n && n !== 'unknown' ? n : null);
  const screenName = realName(req.screenName) || 'unknown';
  const urls = (req.images || [])
    .filter(Boolean)
    .map((u) => {
      const best = bestImageUrl(u);
      const size = SIZE_MAP[req.size] || 'orig';
      return size === 'orig' ? best : best.replace(/([?&]name=)[^&]+/, `$1${size}`);
    });
  const uniq = [...new Set(urls)];
  if (!uniq.length) throw new Error(t('toastErrNoImages'));

  // Check the whole photo set before starting, so retrying cannot copy a partial set.
  for (const url of uniq) {
    const duplicate = await duplicateResponse(url, req.force);
    if (duplicate) return duplicate;
  }

  const tweetUrl =
    req.tweetUrl || `https://x.com/${screenName}/status/${req.tweetId}`;
  let started = 0;
  let firstName = '';
  const downloadIds = [];

  for (let i = 0; i < uniq.length; i++) {
    const url = uniq[i];
    const ext = imageExt(url);
    const filename = buildFilename(
      settings.filenameTemplate,
      {
        user: screenName,
        id: req.tweetId,
        quality: 'img',
        index: i,
        count: uniq.length,
        date: Date.now(),
        postDate: req.postDate || 0,
        text: req.text || '',
        ext,
      },
      settings.subfolder,
    );
    if (!firstName) firstName = filename;

    const entry = await addHistoryEntry({
      tweetId: req.tweetId,
      screenName,
      tweetUrl,
      type: 'image',
      quality: req.size || 'orig',
      poster: url,
      filename,
      url,
      state: 'in_progress',
      batchId: req.batchId || '',
    });
    try {
      const downloadId = await chrome.downloads.download({
        url,
        filename,
        saveAs: !!settings.askWhereToSave && !req.batchId && i === 0,
        conflictAction: 'uniquify',
      });
      await rememberDownloadOrigin(downloadId, origin).catch(() => {});
      await attachDownload(entry, downloadId);
      downloadIds.push(downloadId);
      started++;
    } catch (e) {
      await updateHistoryEntry(
        { key: entry.key },
        { state: 'interrupted', error: String(e.message || e) },
      );
    }
  }

  if (!started) throw new Error(t('toastErrImagesFailed'));
  const folder = firstName.includes('/')
    ? firstName.slice(0, firstName.lastIndexOf('/'))
    : t('optionsFolderDownloads');
  return {
    ok: true,
    count: started,
    filename: firstName,
    folder,
    label: t('toastImageLabel', started),
    downloadId: downloadIds[0],
    downloadIds,
  };
}

// --- download progress -> history ---------------------------------------

async function updateDownload(delta) {
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
        updated = await updateHistoryEntry(
          { downloadId: delta.id },
          { bytes: item.fileSize || item.totalBytes || 0, filename: item.filename || updated.filename },
        ) || updated;
      }
    } catch (_) {
      /* ignore */
    }
    const key = mediaKeyFromUrl(updated.url);
    if (key) {
      await recordDownloaded(key, {
        at: Date.now(), filename: updated.filename,
        downloadId: delta.id, quality: updated.quality,
      });
    }
  }
  if (patch.state === 'complete' || patch.state === 'interrupted') {
    notifyDownloadDone(delta.id, patch.state, patch.error || '');
  }
}

chrome.downloads.onChanged.addListener((delta) => {
  return updateDownload(delta).catch((e) => console.warn('Download history update failed:', e));
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
    const origin = { tabId: sender.tab && sender.tab.id, clientId: msg.clientId || '' };
    const run = msg.kind === 'image' ? startImageDownload(msg, origin) : startDownload(msg, origin);
    run
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true;
  }

  if (msg.type === 'xvd:redownload') {
    getHistory()
      .then((list) => {
        const rec = list.find((r) => r.key === msg.key);
        if (!rec) throw new Error(t('toastErrHistoryGone'));
        if (rec.type === 'image') {
          return startImageDownload({
            force: true,
            tweetId: rec.tweetId,
            screenName: rec.screenName,
            tweetUrl: rec.tweetUrl,
            text: '',
            images: [rec.url],
            size: rec.quality || 'orig',
          });
        }
        return startDownload({
          force: true,
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

  if (msg.type === 'xvd:open-batch') {
    // openOptionsPage() cannot carry a hash, and the history filter is the hash.
    const id = encodeURIComponent(String(msg.batchId || ''));
    chrome.tabs.create({ url: chrome.runtime.getURL('src/options/options.html') + '#batch=' + id });
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'xvd:badge') {
    const tabId = sender.tab && sender.tab.id;
    if (tabId != null) {
      const text = String(msg.text || '').slice(0, 4);
      chrome.action.setBadgeText({ text, tabId });
      if (text) chrome.action.setBadgeBackgroundColor({ color: '#1d9bf0', tabId });
    }
    sendResponse({ ok: true });
    return true;
  }
});

// --- product website ---------------------------------------------------

function siteDetails() {
  return {
    uiLang: chrome.i18n.getUILanguage(),
    version: chrome.runtime.getManifest().version,
  };
}

async function setUninstallUrl() {
  try {
    const { installedDate } = await chrome.storage.local.get('installedDate');
    await chrome.runtime.setUninstallURL(uninstallUrl({ ...siteDetails(), installed: installedDate }));
  } catch (_) {
    /* A website URL failure must not interrupt the worker. */
  }
}

// Refresh on every worker start, including browser restarts.
setUninstallUrl();

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    try {
      const { installedDate } = await chrome.storage.local.get('installedDate');
      if (!installedDate) {
        const now = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
        await chrome.storage.local.set({ installedDate: date });
      }
      await chrome.tabs.create({ url: welcomeUrl(siteDetails()) });
    } catch (e) {
      console.warn('Install welcome page failed:', e);
    }
  }
  if (details.reason === 'install' || details.reason === 'update') await setUninstallUrl();
});
