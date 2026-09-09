// Settings + download-history persistence (ES module, chrome.storage.local).
import { DEFAULT_FILENAME_TEMPLATE } from './media.js';

export const DEFAULT_SETTINGS = {
  defaultQuality: 'highest',        // see QUALITY_OPTIONS in media.js
  filenameTemplate: DEFAULT_FILENAME_TEMPLATE, // {user}_{text}_{datetime}_{id}
  subfolder: 'X Video Downloader',
  askWhereToSave: false,            // chrome.downloads saveAs dialog
  showTimelineButton: true,         // inject a button on each video in the feed
  clickDownloadsImmediately: true,  // false -> timeline button opens a quality menu
  maxHistory: 500,
};

const SETTINGS_KEY = 'settings';
const HISTORY_KEY = 'history';

export async function getSettings() {
  const got = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(got[SETTINGS_KEY] || {}) };
}

export async function saveSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

export async function getHistory() {
  const got = await chrome.storage.local.get(HISTORY_KEY);
  return Array.isArray(got[HISTORY_KEY]) ? got[HISTORY_KEY] : [];
}

async function setHistory(list) {
  await chrome.storage.local.set({ [HISTORY_KEY]: list });
}

export async function addHistoryEntry(entry) {
  const settings = await getSettings();
  const list = await getHistory();
  const record = {
    key: entry.key || `${entry.tweetId}-${Date.now()}`,
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
    downloadId: entry.downloadId || null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  list.unshift(record);
  if (list.length > settings.maxHistory) list.length = settings.maxHistory;
  await setHistory(list);
  return record;
}

export async function updateHistoryEntry(match, patch) {
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
}

export async function removeHistoryEntry(key) {
  const list = (await getHistory()).filter((r) => r.key !== key);
  await setHistory(list);
}

export async function clearHistory() {
  await setHistory([]);
}

export async function importHistory(entries, { replace = false } = {}) {
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
}
