// Settings + download-history persistence (ES module, chrome.storage.local).
import { DEFAULT_FILENAME_TEMPLATE } from './media.js';

export const DEFAULT_SETTINGS = {
  defaultQuality: 'highest',        // see QUALITY_OPTIONS in media.js
  filenameTemplate: DEFAULT_FILENAME_TEMPLATE, // {user}_{text}_{datetime}_{id}
  subfolder: 'X Media Downloader/{user}',
  schemaVersion: 1,
  askWhereToSave: false,            // chrome.downloads saveAs dialog
  showTimelineButton: true,         // inject a button on each video in the feed
  clickDownloadsImmediately: true,  // false -> timeline button opens a quality menu
  maxHistory: 3000,
  gdriveFolder: 'X Media Downloader',
  gdriveByUser: true,
};

const SETTINGS_KEY = 'settings';
const HISTORY_KEY = 'history';

const DOWNLOADED_KEY = 'downloaded';
const GDRIVE_TASKS_KEY = 'gdriveTasks';
const GDRIVE_UPLOADED_KEY = 'gdriveUploaded';
const MAX_GDRIVE_TASKS = 200;
let lock = Promise.resolve();

// Keep failed writes from poisoning the queue for later downloads.
export function withLock(fn) {
  const result = lock.then(fn);
  lock = result.catch(() => {});
  return result;
}

async function readSettings() {
  const got = await chrome.storage.local.get(SETTINGS_KEY);
  return got[SETTINGS_KEY] || {};
}

async function migrateSettings() {
  const saved = await readSettings();
  if ((saved.schemaVersion || 0) >= DEFAULT_SETTINGS.schemaVersion) {
    return { ...DEFAULT_SETTINGS, ...saved };
  }
  const next = { ...DEFAULT_SETTINGS, ...saved, schemaVersion: DEFAULT_SETTINGS.schemaVersion };
  if (saved.subfolder === 'X Media Downloader') next.subfolder = DEFAULT_SETTINGS.subfolder;
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

export async function getSettings() {
  const saved = await readSettings();
  if ((saved.schemaVersion || 0) < DEFAULT_SETTINGS.schemaVersion) {
    return withLock(migrateSettings);
  }
  return { ...DEFAULT_SETTINGS, ...saved };
}

export function saveSettings(patch) {
  return withLock(async () => {
    const next = { ...(await migrateSettings()), ...patch };
    await chrome.storage.local.set({ [SETTINGS_KEY]: next });
    return next;
  });
}

export async function getDownloaded() {
  const got = await chrome.storage.local.get(DOWNLOADED_KEY);
  return got[DOWNLOADED_KEY] || {};
}

export function recordDownloaded(mediaKey, record) {
  return withLock(async () => {
    const index = await getDownloaded();
    index[mediaKey] = record;
    const keys = Object.keys(index).sort((a, b) => index[a].at - index[b].at);
    for (const key of keys.slice(0, Math.max(0, keys.length - 20000))) delete index[key];
    await chrome.storage.local.set({ [DOWNLOADED_KEY]: index });
  });
}

export function clearDownloaded() {
  return withLock(() => chrome.storage.local.set({ [DOWNLOADED_KEY]: {} }));
}

export async function getHistory() {
  const got = await chrome.storage.local.get(HISTORY_KEY);
  return Array.isArray(got[HISTORY_KEY]) ? got[HISTORY_KEY] : [];
}

async function setHistory(list) {
  await chrome.storage.local.set({ [HISTORY_KEY]: list });
}

export async function addHistoryEntry(entry) {
  return withLock(async () => {
    const settings = await migrateSettings();
    const list = await getHistory();
    const record = {
      key: entry.key || `${entry.tweetId}-${crypto.randomUUID()}`,
      tweetId: entry.tweetId,
      screenName: entry.screenName || 'unknown',
      tweetUrl: entry.tweetUrl || `https://x.com/${entry.screenName || 'i'}/status/${entry.tweetId}`,
      type: entry.type || 'video',
      quality: entry.quality || '',
      height: entry.height || 0,
      bitrate: entry.bitrate || 0,
      poster: entry.poster || '',
      filename: entry.filename || '',
      url: entry.url || '',
      bytes: 0,
      state: entry.state || 'in_progress', // in_progress | complete | interrupted
      error: '',
      downloadId: entry.downloadId ?? null,
      batchId: entry.batchId || '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    list.unshift(record);
    if (list.length > settings.maxHistory) list.length = settings.maxHistory;
    await setHistory(list);
    return record;
  });
}

export async function updateHistoryEntry(match, patch) {
  return withLock(async () => {
    const list = await getHistory();
    let changed = null;
    for (const rec of list) {
      const hit = match.key
        ? rec.key === match.key
        : match.downloadId != null && rec.downloadId === match.downloadId;
      if (hit) {
        Object.assign(rec, patch, { updatedAt: Date.now() });
        changed = rec;
        break;
      }
    }
    if (changed) await setHistory(list);
    return changed;
  });
}

export async function removeHistoryEntry(key) {
  return withLock(async () => {
    const list = (await getHistory()).filter((r) => r.key !== key);
    await setHistory(list);
  });
}

export async function clearHistory() {
  return withLock(async () => {
    await setHistory([]);
  });
}

export async function importHistory(entries, { replace = false } = {}) {
  return withLock(async () => {
    const current = replace ? [] : await getHistory();
    const seen = new Set(current.map((r) => r.key));
    for (const e of entries) {
      if (!e || !e.key || seen.has(e.key)) continue;
      seen.add(e.key);
      current.push(e);
    }
    current.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    await setHistory(current);
    return current.length;
  });
}

// --- Google Drive queue & dedup index ------------------------------------

export async function getGDriveTasks() {
  const got = await chrome.storage.local.get(GDRIVE_TASKS_KEY);
  return Array.isArray(got[GDRIVE_TASKS_KEY]) ? got[GDRIVE_TASKS_KEY] : [];
}

async function setGDriveTasks(list) {
  await chrome.storage.local.set({ [GDRIVE_TASKS_KEY]: list });
}

export async function enqueueGDriveTasks(items) {
  return withLock(async () => {
    const list = await getGDriveTasks();
    const now = Date.now();
    const added = [];
    for (const item of items || []) {
      const rec = {
        id: item.id || `gd_${now}_${crypto.randomUUID().slice(0, 8)}`,
        tweetId: item.tweetId || '',
        screenName: item.screenName || 'unknown',
        tweetUrl: item.tweetUrl || '',
        mediaKind: item.mediaKind || 'video',
        mediaKey: item.mediaKey || '',
        mediaUrl: item.mediaUrl || '',
        poster: item.poster || '',
        filename: item.filename || '',
        mimeType: item.mimeType || 'application/octet-stream',
        quality: item.quality || '',
        status: item.status || 'queued', // awaiting_auth | queued | fetching | uploading | paused | complete | failed | cancelled
        chunkSize: item.chunkSize || 4 * 1024 * 1024,
        committedOffset: item.committedOffset || 0,
        uploadSessionUrl: item.uploadSessionUrl || '',
        sessionCreatedAt: item.sessionCreatedAt || 0,
        bytesUploaded: item.bytesUploaded || 0,
        bytesTotal: item.bytesTotal || 0,
        driveFileId: item.driveFileId || '',
        webViewLink: item.webViewLink || '',
        error: '',
        createdAt: now,
        updatedAt: now,
      };
      added.push(rec);
    }
    const next = [...added.reverse(), ...list].slice(0, MAX_GDRIVE_TASKS);
    await setGDriveTasks(next);
    return added;
  });
}

export async function updateGDriveTask(id, patch) {
  return withLock(async () => {
    const list = await getGDriveTasks();
    let updated = null;
    for (const rec of list) {
      if (rec.id === id) {
        Object.assign(rec, patch, { updatedAt: Date.now() });
        updated = rec;
        break;
      }
    }
    if (updated) await setGDriveTasks(list);
    return updated;
  });
}

export async function updateGDriveTasksWhere(predicate, patch) {
  return withLock(async () => {
    const list = await getGDriveTasks();
    let count = 0;
    const now = Date.now();
    for (const rec of list) {
      if (predicate(rec)) {
        Object.assign(rec, patch, { updatedAt: now });
        count++;
      }
    }
    if (count > 0) await setGDriveTasks(list);
    return count;
  });
}

async function pruneGDriveUploadedKeys(keys, remainingTasks) {
  const toDelete = [...new Set((keys || []).filter(Boolean))];
  if (!toDelete.length) return;
  const stillComplete = new Set(
    (remainingTasks || []).filter((r) => r.status === 'complete' && r.mediaKey).map((r) => r.mediaKey),
  );
  const map = await getGDriveUploaded();
  let changed = false;
  for (const k of toDelete) {
    if (!stillComplete.has(k) && k in map) {
      delete map[k];
      changed = true;
    }
  }
  if (changed) await chrome.storage.local.set({ [GDRIVE_UPLOADED_KEY]: map });
}

export async function removeGDriveTask(id) {
  return withLock(async () => {
    const prev = await getGDriveTasks();
    const removed = prev.filter((r) => r.id === id);
    const list = prev.filter((r) => r.id !== id);
    await setGDriveTasks(list);
    await pruneGDriveUploadedKeys(removed.map((r) => r.mediaKey), list);
  });
}

export async function clearCompletedGDriveTasks() {
  return withLock(async () => {
    const done = new Set(['complete', 'cancelled']);
    const prev = await getGDriveTasks();
    const removed = prev.filter((r) => done.has(r.status));
    const list = prev.filter((r) => !done.has(r.status));
    await setGDriveTasks(list);
    await pruneGDriveUploadedKeys(removed.map((r) => r.mediaKey), list);
  });
}

export async function clearGDriveUploaded() {
  return withLock(async () => {
    await chrome.storage.local.remove(GDRIVE_UPLOADED_KEY);
  });
}

export async function getGDriveUploaded() {
  const got = await chrome.storage.local.get(GDRIVE_UPLOADED_KEY);
  return got[GDRIVE_UPLOADED_KEY] || {};
}

export async function recordGDriveUploaded(mediaKey, info) {
  if (!mediaKey) return;
  return withLock(async () => {
    const map = await getGDriveUploaded();
    map[mediaKey] = { ...info, at: Date.now() };
    const keys = Object.keys(map).sort((a, b) => map[a].at - map[b].at);
    for (const k of keys.slice(0, Math.max(0, keys.length - 10000))) delete map[k];
    await chrome.storage.local.set({ [GDRIVE_UPLOADED_KEY]: map });
  });
}
