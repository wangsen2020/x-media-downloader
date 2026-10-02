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
};

const SETTINGS_KEY = 'settings';
const HISTORY_KEY = 'history';

const DOWNLOADED_KEY = 'downloaded';
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
