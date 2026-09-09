import { QUALITY_OPTIONS, buildFilename } from '../lib/media.js';
import {
  DEFAULT_SETTINGS,
  getSettings,
  saveSettings,
  getHistory,
  removeHistoryEntry,
  clearHistory,
  importHistory,
} from '../lib/store.js';

const $ = (id) => document.getElementById(id);
const REPO_URL = 'https://github.com/YOUR_GITHUB_USERNAME/x-video-downloader';

$('repoLink').href = REPO_URL;

// --- tabs ---------------------------------------------------------------
document.querySelectorAll('.tab').forEach((t) => {
  t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('is-active', x === t));
    $('tab-history').hidden = t.dataset.tab !== 'history';
    $('tab-settings').hidden = t.dataset.tab !== 'settings';
    location.hash = t.dataset.tab;
  });
});
if (location.hash === '#settings') {
  document.querySelector('.tab[data-tab="settings"]').click();
}

// --- settings ---------------------------------------------------------------
const settingEls = {
  defaultQuality: $('defaultQuality'),
  filenameTemplate: $('filenameTemplate'),
  subfolder: $('subfolder'),
  askWhereToSave: $('askWhereToSave'),
  showTimelineButton: $('showTimelineButton'),
  clickDownloadsImmediately: $('clickDownloadsImmediately'),
  maxHistory: $('maxHistory'),
};

for (const opt of QUALITY_OPTIONS) {
  const o = document.createElement('option');
  o.value = opt.value;
  o.textContent = opt.label;
  settingEls.defaultQuality.appendChild(o);
}

function updatePreview(s) {
  $('filenamePreview').textContent = buildFilename(
    s.filenameTemplate,
    {
      user: 'nasa',
      id: '1789012345678901234',
      height: 720,
      bitrate: 2176000,
      quality: '720p',
      index: 0,
      count: 1,
      date: Date.now(),
      text: 'Launch highlights',
    },
    s.subfolder,
  );
}

async function loadSettings() {
  const s = await getSettings();
  settingEls.defaultQuality.value = s.defaultQuality;
  settingEls.filenameTemplate.value = s.filenameTemplate;
  settingEls.subfolder.value = s.subfolder;
  settingEls.askWhereToSave.checked = s.askWhereToSave;
  settingEls.showTimelineButton.checked = s.showTimelineButton;
  settingEls.clickDownloadsImmediately.checked = s.clickDownloadsImmediately;
  settingEls.maxHistory.value = s.maxHistory;
  updatePreview(s);
}

function currentSettingsFromForm() {
  return {
    defaultQuality: settingEls.defaultQuality.value,
    filenameTemplate: settingEls.filenameTemplate.value.trim() || DEFAULT_SETTINGS.filenameTemplate,
    subfolder: settingEls.subfolder.value.trim(),
    askWhereToSave: settingEls.askWhereToSave.checked,
    showTimelineButton: settingEls.showTimelineButton.checked,
    clickDownloadsImmediately: settingEls.clickDownloadsImmediately.checked,
    maxHistory: Math.min(5000, Math.max(10, Number(settingEls.maxHistory.value) || DEFAULT_SETTINGS.maxHistory)),
  };
}

let savedTimer = 0;
async function persist() {
  const s = currentSettingsFromForm();
  await saveSettings(s);
  updatePreview(s);
  const note = $('savedNote');
  note.hidden = false;
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => (note.hidden = true), 1400);
}

Object.values(settingEls).forEach((el) => {
  el.addEventListener('change', persist);
  if (el.type === 'text') el.addEventListener('input', () => updatePreview(currentSettingsFromForm()));
});

$('resetBtn').addEventListener('click', async () => {
  await saveSettings({ ...DEFAULT_SETTINGS });
  await loadSettings();
  const note = $('savedNote');
  note.hidden = false;
  setTimeout(() => (note.hidden = true), 1400);
});

// --- history ---------------------------------------------------------------
let historyCache = [];

function human(bytes) {
  if (!bytes) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

function fmtDate(ts) {
  const d = new Date(ts);
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function renderHistory() {
  const q = $('search').value.trim().toLowerCase();
  const stateF = $('stateFilter').value;
  const rows = historyCache.filter((r) => {
    if (stateF && r.state !== stateF) return false;
    if (!q) return true;
    return (
      (r.screenName || '').toLowerCase().includes(q) ||
      (r.filename || '').toLowerCase().includes(q) ||
      (r.tweetId || '').includes(q)
    );
  });

  $('historyCount').textContent = rows.length
    ? `${rows.length} of ${historyCache.length} download${historyCache.length === 1 ? '' : 's'}`
    : '';
  $('historyEmpty').hidden = historyCache.length !== 0;

  const list = $('historyList');
  list.innerHTML = '';
  for (const r of rows) {
    const card = document.createElement('div');
    card.className = 'card';

    const thumb = document.createElement('img');
    thumb.className = 'thumb';
    thumb.alt = '';
    thumb.loading = 'lazy';
    if (r.poster) thumb.src = r.poster;
    card.appendChild(thumb);

    const info = document.createElement('div');
    info.className = 'info';
    info.innerHTML = `
      <div class="who">@${escapeHtml(r.screenName || 'unknown')}
        <span class="badge ${r.state}">${r.state.replace('_', ' ')}</span></div>
      <div class="file">${escapeHtml(r.filename || r.url || '')}</div>
      <div class="meta">
        <span>${r.type || 'video'}</span>
        <span>${r.height ? r.height + 'p' : (r.quality || '')}</span>
        ${r.bitrate ? `<span>${Math.round(r.bitrate / 1000)} kbps</span>` : ''}
        ${r.bytes ? `<span>${human(r.bytes)}</span>` : ''}
        <span>${fmtDate(r.createdAt)}</span>
        ${r.error ? `<span title="${escapeHtml(r.error)}">⚠ ${escapeHtml(r.error)}</span>` : ''}
      </div>`;
    card.appendChild(info);

    const actions = document.createElement('div');
    actions.className = 'actions';
    actions.appendChild(
      mkBtn('Open tweet', () => window.open(r.tweetUrl, '_blank', 'noreferrer')),
    );
    if (r.state === 'complete' && r.downloadId != null) {
      actions.appendChild(
        mkBtn('Show file', () =>
          chrome.runtime.sendMessage({ type: 'xvd:show-file', downloadId: r.downloadId }),
        ),
      );
    }
    actions.appendChild(
      mkBtn('Re‑download', async (btn) => {
        btn.disabled = true;
        btn.textContent = '…';
        const res = await chrome.runtime.sendMessage({
          type: 'xvd:redownload',
          key: r.key,
          quality: String(r.height || 'highest'),
        });
        btn.disabled = false;
        btn.textContent = res && res.ok ? 'Started ✓' : 'Failed';
        setTimeout(() => (btn.textContent = 'Re‑download'), 1500);
      }),
    );
    actions.appendChild(
      mkBtn('Remove', async () => {
        await removeHistoryEntry(r.key);
      }),
    );
    card.appendChild(actions);
    list.appendChild(card);
  }
}

function mkBtn(label, fn) {
  const b = document.createElement('button');
  b.className = 'btn';
  b.type = 'button';
  b.textContent = label;
  b.addEventListener('click', () => fn(b));
  return b;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

async function loadHistory() {
  historyCache = await getHistory();
  renderHistory();
}

$('search').addEventListener('input', renderHistory);
$('stateFilter').addEventListener('change', renderHistory);

$('clearBtn').addEventListener('click', async () => {
  if (!historyCache.length) return;
  if (!confirm(`Delete all ${historyCache.length} history entries? This does not delete downloaded files.`)) return;
  await clearHistory();
});

$('exportBtn').addEventListener('click', async () => {
  const data = JSON.stringify(await getHistory(), null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `x-video-downloader-history-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

$('importInput').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    const entries = Array.isArray(parsed) ? parsed : parsed.history || [];
    const n = await importHistory(entries, { replace: false });
    alert(`Imported. History now has ${n} entrie(s).`);
  } catch (err) {
    alert('Import failed: ' + (err.message || err));
  } finally {
    e.target.value = '';
  }
});

// Live refresh when the worker writes new history / settings.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.history) {
    historyCache = changes.history.newValue || [];
    renderHistory();
  }
  if (changes.settings) loadSettings();
});

loadSettings();
loadHistory();
