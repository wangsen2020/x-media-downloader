import { QUALITY_OPTIONS, buildFilename } from '../lib/media.js';
import {
  DEFAULT_SETTINGS,
  getSettings,
  saveSettings,
  getHistory,
  removeHistoryEntry,
  clearHistory,
  clearDownloaded,
  importHistory,
  getGDriveTasks,
  updateGDriveTask,
  updateGDriveTasksWhere,
  removeGDriveTask,
  clearCompletedGDriveTasks,
  clearGDriveUploaded,
  recordGDriveUploaded,
} from '../lib/store.js';
import {
  DEFAULT_FOLDER_NAME,
  hasOptionalPermissions,
  requestOptionalPermissions,
  removeOptionalPermissions,
  ensureToken,
  ensureFolderPath,
  streamToDrive,
  abortResumableSession,
  isAuthCancelError,
  defaultWebViewLink,
} from '../lib/gdrive.js';
import { t, localize, uiLang, qualityLabel } from '../lib/i18n.js';

document.documentElement.lang = uiLang();
document.documentElement.dir = t('@@bidi_dir') === 'rtl' ? 'rtl' : 'ltr';
localize();

const $ = (id) => document.getElementById(id);
const REPO_URL = 'https://github.com/wangsen2020/x-media-downloader';

$('repoLink').href = REPO_URL;

// --- tabs ---------------------------------------------------------------
function batchIdFromHash() {
  const match = /^#batch=([^&]+)/.exec(location.hash || '');
  if (!match) return '';
  try {
    return decodeURIComponent(match[1]);
  } catch (_) {
    return '';
  }
}

let batchFilter = location.hash === '#settings' || location.hash.startsWith('#uploads') ? '' : batchIdFromHash();

function activeTabFromHash() {
  if (location.hash === '#settings') return 'settings';
  if (location.hash.startsWith('#uploads')) return 'uploads';
  return 'history';
}

function focusUploadTargetFromHash() {
  const mFocus = /[&?]focus=([^&]+)/.exec(location.hash || '');
  const mTweet = /[&?]tweet=([^&]+)/.exec(location.hash || '');
  const focusId = mFocus ? decodeURIComponent(mFocus[1]) : '';
  const tweetId = mTweet ? decodeURIComponent(mTweet[1]) : '';
  if (!focusId && !tweetId) return;
  const target = [...document.querySelectorAll('#uploadList .card')].find((el) =>
    (focusId && el.dataset.taskId === focusId) || (tweetId && el.dataset.tweetId === tweetId),
  );
  if (!target) return;
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  target.classList.add('is-highlight');
  setTimeout(() => target.classList.remove('is-highlight'), 2400);
}

function syncFromHash() {
  const current = activeTabFromHash();
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.classList.toggle('is-active', tab.dataset.tab === current);
  });
  $('tab-history').hidden = current !== 'history';
  $('tab-uploads').hidden = current !== 'uploads';
  $('tab-settings').hidden = current !== 'settings';
  batchFilter = current === 'history' ? batchIdFromHash() : '';
  if (typeof renderHistory === 'function' && current === 'history') renderHistory();
  if (typeof renderUploads === 'function' && current === 'uploads') renderUploads();
}

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    const next = '#' + tab.dataset.tab;
    if (location.hash === next) syncFromHash();
    else location.hash = tab.dataset.tab;
  });
});
window.addEventListener('hashchange', syncFromHash);

// --- settings ---------------------------------------------------------------
const settingEls = {
  defaultQuality: $('defaultQuality'),
  filenameTemplate: $('filenameTemplate'),
  subfolder: $('subfolder'),
  askWhereToSave: $('askWhereToSave'),
  showTimelineButton: $('showTimelineButton'),
  clickDownloadsImmediately: $('clickDownloadsImmediately'),
  maxHistory: $('maxHistory'),
  gdriveFolder: $('gdriveFolder'),
  gdriveByUser: $('gdriveByUser'),
};

for (const opt of QUALITY_OPTIONS) {
  const o = document.createElement('option');
  o.value = opt.value;
  o.textContent = qualityLabel(opt.value);
  settingEls.defaultQuality.appendChild(o);
}

function updatePreview(s) {
  const filename = buildFilename(
    s.filenameTemplate,
    {
      user: 'NASA',
      id: '1789012345678901234',
      height: 720,
      bitrate: 2176000,
      quality: '720p',
      index: 0,
      count: 1,
      date: Date.now(),
      text: 'We are go for launch — Artemis II crew heads to the pad',
    },
    s.subfolder,
  );
  $('filenamePreview').textContent = filename;
  $('subfolderPreview').textContent = filename.includes('/')
    ? filename.slice(0, filename.lastIndexOf('/')) : t('optionsFolderDownloads');
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
  settingEls.gdriveFolder.value = s.gdriveFolder || DEFAULT_SETTINGS.gdriveFolder;
  settingEls.gdriveByUser.checked = s.gdriveByUser !== false;
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
    gdriveFolder: settingEls.gdriveFolder.value.trim() || DEFAULT_SETTINGS.gdriveFolder,
    gdriveByUser: settingEls.gdriveByUser.checked,
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
  const u = [t('optionsByteB'), t('optionsByteKB'), t('optionsByteMB'), t('optionsByteGB')];
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
  return d.toLocaleString(uiLang(), {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function stateLabel(state) {
  if (state === 'complete') return t('optionsStateComplete');
  if (state === 'in_progress') return t('optionsStateInProgress');
  if (state === 'interrupted') return t('optionsStateInterrupted');
  return state || '';
}

function typeLabel(type) {
  if (type === 'image') return t('optionsTypeImage');
  return t('optionsTypeVideo');
}

function renderBatchBanner() {
  const banner = $('batchBanner');
  if (!batchFilter) {
    banner.hidden = true;
    return;
  }
  banner.hidden = false;
  const times = historyCache
    .filter((r) => r.batchId === batchFilter)
    .map((r) => r.createdAt)
    .filter((ts) => ts);
  $('batchWhen').textContent = times.length
    ? t('optionsBatchShowingFrom', fmtDate(Math.min(...times)))
    : t('optionsBatchShowing');
}

function renderHistory() {
  const q = $('search').value.trim().toLowerCase();
  const stateF = $('stateFilter').value;
  renderBatchBanner();
  const rows = historyCache.filter((r) => {
    if (batchFilter && r.batchId !== batchFilter) return false;
    if (stateF && r.state !== stateF) return false;
    if (!q) return true;
    return (
      (r.screenName || '').toLowerCase().includes(q) ||
      (r.filename || '').toLowerCase().includes(q) ||
      (r.tweetId || '').includes(q)
    );
  });

  $('historyCount').textContent = rows.length
    ? t('optionsHistoryCount', rows.length, historyCache.length)
    : '';
  $('historyEmpty').hidden = historyCache.length !== 0;

  const list = $('historyList');
  list.innerHTML = '';
  for (const r of rows) {
    const card = document.createElement('div');
    card.className = 'card';
    card.dataset.taskId = r.id || '';
    card.dataset.tweetId = r.tweetId || '';

    const thumb = document.createElement('img');
    thumb.className = 'thumb';
    thumb.alt = '';
    thumb.loading = 'lazy';
    if (r.poster) thumb.src = r.poster;
    card.appendChild(thumb);

    const info = document.createElement('div');
    info.className = 'info';
    info.innerHTML = `
      <div class="who"><bdi dir="ltr">@${escapeHtml(r.screenName || 'unknown')}</bdi>
        <span class="badge ${r.state}">${escapeHtml(stateLabel(r.state))}</span></div>
      <div class="file"><bdi dir="ltr">${escapeHtml(r.filename || r.url || '')}</bdi></div>
      <div class="meta">
        <span>${escapeHtml(typeLabel(r.type))}</span>
        <bdi dir="ltr">${escapeHtml(r.height ? r.height + 'p' : (r.quality || ''))}</bdi>
        ${r.bitrate ? `<span>${escapeHtml(t('popupVariantBitrate', Math.round(r.bitrate / 1000)))}</span>` : ''}
        ${r.bytes ? `<span>${human(r.bytes)}</span>` : ''}
        <span>${escapeHtml(fmtDate(r.createdAt))}</span>
        ${r.error ? `<span title="${escapeHtml(r.error)}">⚠ ${escapeHtml(r.error)}</span>` : ''}
      </div>`;
    card.appendChild(info);

    const actions = document.createElement('div');
    actions.className = 'actions';
    actions.appendChild(
      mkBtn(t('optionsOpenTweet'), () => window.open(r.tweetUrl, '_blank', 'noreferrer')),
    );
    if (r.state === 'complete' && r.downloadId != null) {
      actions.appendChild(
        mkBtn(t('optionsShowFile'), () =>
          chrome.runtime.sendMessage({ type: 'xvd:show-file', downloadId: r.downloadId }),
        ),
      );
    }
    actions.appendChild(
      mkBtn(t('optionsRedownload'), async (btn) => {
        btn.disabled = true;
        btn.textContent = '…';
        const res = await chrome.runtime.sendMessage({
          type: 'xvd:redownload',
          force: true,
          key: r.key,
          quality: String(r.height || 'highest'),
        });
        btn.disabled = false;
        btn.textContent = res && res.ok ? t('optionsRedownloadStarted') : t('optionsRedownloadFailed');
        setTimeout(() => (btn.textContent = t('optionsRedownload')), 1500);
      }),
    );
    actions.appendChild(
      mkBtn(t('optionsRemove'), async () => {
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
$('clearBatchFilter').addEventListener('click', () => {
  location.hash = 'history';
});

$('clearBtn').addEventListener('click', async () => {
  if (!historyCache.length) return;
  if (!confirm(t('optionsConfirmClearAll', historyCache.length))) return;
  await clearHistory();
});

$('clearDownloadedBtn').addEventListener('click', async () => {
  if (!confirm(t('optionsConfirmClearDownloaded'))) return;
  await clearDownloaded();
});

$('exportBtn').addEventListener('click', async () => {
  const data = JSON.stringify(await getHistory(), null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `x-media-downloader-history-${new Date().toISOString().slice(0, 10)}.json`;
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
    alert(t('optionsImportOk', n));
  } catch (err) {
    alert(t('optionsImportFailed', err.message || err));
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
  if (changes.gdriveTasks) {
    uploadTasksCache = changes.gdriveTasks.newValue || [];
    renderUploads();
  }
});

// --- Google Drive upload queue -------------------------------------------

let uploadTasksCache = [];
let uploadAuthorized = false;
let queueRunning = false;
let rootFolderIdCache = '';
const activeControllers = new Map();
const liveProgress = new Map(); // taskId -> { uploaded, total }

function uploadStateLabel(status) {
  if (status === 'awaiting_auth') return t('gdriveStateAwaitingAuth');
  if (status === 'queued') return t('gdriveStateQueued');
  if (status === 'fetching') return t('gdriveStateFetching');
  if (status === 'uploading') return t('gdriveStateUploading');
  if (status === 'paused') return t('gdriveStatePaused');
  if (status === 'complete') return t('optionsStateComplete');
  if (status === 'failed') return t('gdriveStateFailed');
  if (status === 'cancelled') return t('gdriveStateCancelled');
  return status || '';
}

function updateUploadsTabBadge() {
  const activeCount = uploadTasksCache.filter((r) =>
    ['awaiting_auth', 'queued', 'fetching', 'uploading'].includes(r.status),
  ).length;
  const tab = document.querySelector('.tab[data-tab="uploads"]');
  if (tab) {
    tab.textContent = activeCount > 0 ? `${t('optionsTabUploads')} (${activeCount})` : t('optionsTabUploads');
  }
}

async function refreshAuthUi() {
  const hasPerm = await hasOptionalPermissions();
  let hasToken = false;
  if (hasPerm) {
    try {
      await ensureToken({ interactive: false });
      hasToken = true;
    } catch (_) {
      hasToken = false;
    }
  }
  uploadAuthorized = hasPerm && hasToken;

  const authCard = $('gdriveAuthCard');
  const connectedBar = $('gdriveConnectedBar');
  const pendingEl = $('gdriveAuthPending');
  const settings = await getSettings();
  const folderName = settings.gdriveFolder || DEFAULT_FOLDER_NAME;

  if (uploadAuthorized) {
    authCard.hidden = true;
    connectedBar.hidden = false;
    $('gdriveConnectedText').textContent = t('gdriveConnectedAs', folderName);
    if (!rootFolderIdCache) {
      ensureFolderPath({ rootName: folderName, interactive: false })
        .then((res) => {
          rootFolderIdCache = res.folderId || '';
          const openBtn = $('gdriveOpenFolderBtn');
          if (openBtn) openBtn.hidden = !rootFolderIdCache;
        })
        .catch(() => {});
    } else {
      $('gdriveOpenFolderBtn').hidden = false;
    }
  } else {
    connectedBar.hidden = true;
    authCard.hidden = false;
    const waitingCount = uploadTasksCache.filter((r) => r.status === 'awaiting_auth').length;
    if (waitingCount > 0) {
      pendingEl.hidden = false;
      pendingEl.textContent = t('gdriveAuthPendingCount', waitingCount);
    } else {
      pendingEl.hidden = true;
    }
  }
}

function renderUploads() {
  updateUploadsTabBadge();
  const listEl = $('uploadList');
  const emptyEl = $('uploadEmpty');
  const countEl = $('uploadCount');
  const pendingEl = $('gdriveAuthPending');
  if (!listEl) return;

  if (pendingEl && !uploadAuthorized) {
    const waitingCount = uploadTasksCache.filter((r) => r.status === 'awaiting_auth').length;
    pendingEl.hidden = waitingCount === 0;
    if (waitingCount > 0) pendingEl.textContent = t('gdriveAuthPendingCount', waitingCount);
  }

  const activeCount = uploadTasksCache.filter((r) => ['queued', 'fetching', 'uploading'].includes(r.status)).length;
  countEl.textContent = uploadTasksCache.length
    ? t('gdriveQueueCount', uploadTasksCache.length, activeCount)
    : '';
  emptyEl.hidden = uploadTasksCache.length !== 0;

  listEl.innerHTML = '';
  for (const r of uploadTasksCache) {
    const prog = liveProgress.get(r.id) || { uploaded: r.bytesUploaded || 0, total: r.bytesTotal || 0 };
    const pct =
      r.status === 'complete'
        ? 100
        : prog.total > 0
          ? Math.min(100, Math.round((prog.uploaded / prog.total) * 100))
          : 0;

    const card = document.createElement('div');
    card.className = 'card';
    card.dataset.taskId = r.id || '';
    card.dataset.tweetId = r.tweetId || '';

    const thumb = document.createElement('img');
    thumb.className = 'thumb';
    thumb.alt = '';
    thumb.loading = 'lazy';
    if (r.poster) thumb.src = r.poster;
    card.appendChild(thumb);

    const info = document.createElement('div');
    info.className = 'info';

    let progressLine = '';
    if (r.status === 'uploading' || r.status === 'paused' || r.status === 'fetching') {
      progressLine = prog.total > 0
        ? `${human(prog.uploaded) || '0 B'} / ${human(prog.total)} · ${pct}%`
        : uploadStateLabel(r.status);
    } else if (r.status === 'complete') {
      progressLine = prog.total > 0 ? `${human(prog.total)} · 100%` : '100%';
    } else if (r.error) {
      progressLine = r.error;
    } else {
      progressLine = uploadStateLabel(r.status);
    }

    info.innerHTML = `
      <div class="who"><bdi dir="ltr">@${escapeHtml(r.screenName || 'unknown')}</bdi>
        <span class="badge ${r.status}">${escapeHtml(uploadStateLabel(r.status))}</span></div>
      <div class="file"><bdi dir="ltr">${escapeHtml(r.filename || r.mediaUrl || '')}</bdi></div>
      <div class="meta">
        <span>${escapeHtml(typeLabel(r.mediaKind))}</span>
        ${r.quality ? `<bdi dir="ltr">${escapeHtml(r.quality)}</bdi>` : ''}
        <span>${escapeHtml(fmtDate(r.createdAt))}</span>
      </div>
      <div class="upload-progress">
        <div class="upload-bar"><div class="upload-bar-fill ${r.status}" style="width:${pct}%"></div></div>
        <div class="upload-progress-text">${escapeHtml(progressLine)}</div>
      </div>`;
    card.appendChild(info);

    const actions = document.createElement('div');
    actions.className = 'actions';
    if (r.status === 'complete' && (r.webViewLink || r.driveFileId)) {
      const url = r.webViewLink || defaultWebViewLink(r.driveFileId);
      actions.appendChild(mkBtn(t('gdriveOpenFile'), () => window.open(url, '_blank', 'noreferrer')));
    }
    if (r.status === 'uploading' || r.status === 'fetching' || r.status === 'queued') {
      actions.appendChild(
        mkBtn(t('gdrivePause'), async () => {
          activeControllers.get(r.id)?.abort();
          await updateGDriveTask(r.id, { status: 'paused' });
        }),
      );
      actions.appendChild(
        mkBtn(t('gdriveCancel'), async () => {
          activeControllers.get(r.id)?.abort();
          if (r.uploadSessionUrl) await abortResumableSession({ sessionUrl: r.uploadSessionUrl });
          await updateGDriveTask(r.id, { status: 'cancelled', uploadSessionUrl: '' });
        }),
      );
    } else if (r.status === 'paused' || r.status === 'failed' || r.status === 'cancelled') {
      actions.appendChild(
        mkBtn(t('gdriveRetry'), async () => {
          await updateGDriveTask(r.id, { status: uploadAuthorized ? 'queued' : 'awaiting_auth', error: '' });
          if (uploadAuthorized) processUploadQueue();
        }),
      );
    }
    if (!['fetching', 'uploading'].includes(r.status)) {
      actions.appendChild(mkBtn(t('optionsRemove'), () => removeGDriveTask(r.id)));
    }
    card.appendChild(actions);
    listEl.appendChild(card);
  }
  focusUploadTargetFromHash();
}

async function runSingleUploadTask(task) {
  const ac = new AbortController();
  activeControllers.set(task.id, ac);
  const settings = await getSettings();
  const rootName = settings.gdriveFolder || DEFAULT_FOLDER_NAME;
  const subfolder = settings.gdriveByUser !== false && task.screenName ? `@${task.screenName}` : '';

  try {
    await updateGDriveTask(task.id, { status: 'fetching', error: '' });
    let mediaUrl = task.mediaUrl;
    let lastPersist = 0;

    const doUpload = (url) =>
      streamToDrive({
        mediaUrl: url,
        mediaKey: task.mediaKey || '',
        rootName,
        subfolder,
        name: task.filename,
        mimeType: task.mimeType,
        task,
        signal: ac.signal,
        onCheckpoint: async (cp) => {
          await updateGDriveTask(task.id, { status: 'uploading', ...cp });
        },
        onProgress: (uploaded, total) => {
          liveProgress.set(task.id, { uploaded, total });
          const now = Date.now();
          if (now - lastPersist > 800) {
            lastPersist = now;
            renderUploads();
          }
        },
      });

    let file;
    try {
      file = await doUpload(mediaUrl);
    } catch (err) {
      if (err.code === 'MEDIA_EXPIRED' && task.mediaKind !== 'image' && task.tweetId) {
        const res = await chrome.runtime.sendMessage({ type: 'xvd:get-media', tweetId: task.tweetId });
        const freshUrl = res?.record?.variants?.[0]?.url;
        if (freshUrl && freshUrl !== mediaUrl) {
          mediaUrl = freshUrl;
          await updateGDriveTask(task.id, { mediaUrl });
          file = await doUpload(mediaUrl);
        } else {
          throw err;
        }
      } else {
        throw err;
      }
    }

    await recordGDriveUploaded(task.mediaKey, {
      driveFileId: file.id,
      webViewLink: file.webViewLink,
      sha256Checksum: file.sha256Checksum || '',
      filename: task.filename,
    });
    liveProgress.delete(task.id);
    await updateGDriveTask(task.id, {
      status: 'complete',
      driveFileId: file.id,
      webViewLink: file.webViewLink,
      uploadSessionUrl: '',
      error: '',
    });
  } catch (err) {
    if (ac.signal.aborted) return;
    if (isAuthCancelError(err)) {
      uploadAuthorized = false;
      await updateGDriveTask(task.id, { status: 'awaiting_auth', error: '' });
      await refreshAuthUi();
      return;
    }
    if (err.code === 'QUOTA_EXCEEDED') {
      await updateGDriveTask(task.id, { status: 'failed', error: t('gdriveErrQuota') });
      await updateGDriveTasksWhere((r) => r.status === 'queued', { status: 'paused' });
      return;
    }
    await updateGDriveTask(task.id, { status: 'failed', error: String(err.message || err) });
  } finally {
    activeControllers.delete(task.id);
  }
}

async function processUploadQueue() {
  if (queueRunning || !uploadAuthorized || !navigator.onLine) return;
  queueRunning = true;
  try {
    while (uploadAuthorized && navigator.onLine) {
      const list = await getGDriveTasks();
      const next = [...list].reverse().find((r) => r.status === 'queued');
      if (!next) break;
      await runSingleUploadTask(next);
      // Pace uploads gently to avoid CDN/API rate limits.
      await new Promise((r) => setTimeout(r, 600));
    }
  } finally {
    queueRunning = false;
  }
}

$('gdriveConnectBtn')?.addEventListener('click', async () => {
  const btn = $('gdriveConnectBtn');
  const errEl = $('gdriveAuthError');
  errEl.hidden = true;
  btn.disabled = true;
  try {
    const granted = await requestOptionalPermissions();
    if (!granted) {
      errEl.hidden = false;
      errEl.textContent = t('gdriveAuthCancelled');
      return;
    }
    await ensureToken({ interactive: true });
    await updateGDriveTasksWhere((r) => r.status === 'awaiting_auth', { status: 'queued', error: '' });
    await refreshAuthUi();
    uploadTasksCache = await getGDriveTasks();
    renderUploads();
    processUploadQueue();
  } catch (err) {
    errEl.hidden = false;
    errEl.textContent = isAuthCancelError(err) ? t('gdriveAuthCancelled') : String(err.message || err);
  } finally {
    btn.disabled = false;
  }
});

$('gdriveOpenFolderBtn')?.addEventListener('click', () => {
  if (rootFolderIdCache) {
    window.open(`https://drive.google.com/drive/folders/${encodeURIComponent(rootFolderIdCache)}`, '_blank', 'noreferrer');
  }
});

$('gdriveDisconnectBtn')?.addEventListener('click', async () => {
  for (const ac of activeControllers.values()) ac.abort();
  await removeOptionalPermissions();
  await clearGDriveUploaded();
  rootFolderIdCache = '';
  uploadAuthorized = false;
  await updateGDriveTasksWhere((r) => ['queued', 'fetching', 'uploading'].includes(r.status), {
    status: 'awaiting_auth',
  });
  await refreshAuthUi();
  uploadTasksCache = await getGDriveTasks();
  renderUploads();
});

$('pauseAllUploadsBtn')?.addEventListener('click', async () => {
  for (const ac of activeControllers.values()) ac.abort();
  await updateGDriveTasksWhere((r) => ['queued', 'fetching', 'uploading'].includes(r.status), { status: 'paused' });
});

$('resumeAllUploadsBtn')?.addEventListener('click', async () => {
  await updateGDriveTasksWhere((r) => r.status === 'paused', {
    status: uploadAuthorized ? 'queued' : 'awaiting_auth',
    error: '',
  });
  if (uploadAuthorized) processUploadQueue();
});

$('clearDoneUploadsBtn')?.addEventListener('click', () => clearCompletedGDriveTasks());

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'xvd:gdrive-queue-updated') {
    refreshAuthUi().then(() => processUploadQueue());
  }
});

window.addEventListener('online', () => processUploadQueue());
window.addEventListener('offline', async () => {
  for (const ac of activeControllers.values()) ac.abort();
  await updateGDriveTasksWhere((r) => ['fetching', 'uploading'].includes(r.status), { status: 'paused' });
});
window.addEventListener('beforeunload', (e) => {
  if (activeControllers.size > 0) {
    e.preventDefault();
    e.returnValue = '';
  }
});

async function initUploads() {
  // Recover interrupted in-flight tasks from previous page session as paused.
  await updateGDriveTasksWhere((r) => r.status === 'fetching' || r.status === 'uploading', {
    status: 'paused',
  });
  uploadTasksCache = await getGDriveTasks();
  await refreshAuthUi();
  renderUploads();
  if (uploadAuthorized) processUploadQueue();
}

loadSettings();
loadHistory().then(() => syncFromHash());
initUploads();
