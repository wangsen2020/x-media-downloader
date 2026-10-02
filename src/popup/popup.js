import { QUALITY_OPTIONS } from '../lib/media.js';
import { mediaUserFromUrl } from '../lib/batch.js';
import { getSettings, getHistory } from '../lib/store.js';
import { t, localize, uiLang, qualityLabel } from '../lib/i18n.js';

document.documentElement.lang = uiLang();
document.documentElement.dir = t('@@bidi_dir') === 'rtl' ? 'rtl' : 'ltr';
localize();

const $ = (id) => document.getElementById(id);
const detected = $('detected');
const empty = $('empty');
const qualitySel = $('quality');
const statusEl = $('status');

let current = null;
let record = null;

init();

async function init() {
  $('openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('viewAll').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('download').addEventListener('click', doDownload);

  const settings = await getSettings();
  renderRecent();

  const tab = await activeTab();
  const batchUser = tab && mediaUserFromUrl(tab.url || '');
  if (batchUser) mountBatch(tab.id, batchUser);

  if (!tab || !/^https?:\/\/([^/]+\.)?(x|twitter)\.com\//.test(tab.url || '')) {
    return showEmpty();
  }

  let ctx;
  try {
    ctx = await chrome.tabs.sendMessage(tab.id, { type: 'xvd:page-context' });
  } catch (_) {
    if (!batchUser) showEmpty();
    return;
  }
  if (!ctx || !ctx.current) {
    if (!batchUser) showEmpty();
    return;
  }

  current = ctx.current;
  record = ctx.record;

  if (!record) {
    // Ask the worker (cache or syndication fallback).
    try {
      const r = await chrome.runtime.sendMessage({
        type: 'xvd:get-media',
        tweetId: current.tweetId,
      });
      if (r && r.ok) record = r.record;
    } catch (_) {
      /* ignore */
    }
  }

  buildQualityOptions(settings.defaultQuality);
  $('tweetUser').textContent = '@' + (current.screenName || 'unknown');
  const link = $('tweetLink');
  link.href = `https://x.com/${current.screenName}/status/${current.tweetId}`;
  if (record && record.poster) {
    const p = $('poster');
    p.src = record.poster;
    p.hidden = false;
  }
  detected.hidden = false;
  empty.hidden = true;

  if (!record) {
    statusEl.textContent = t('popupNoCapture');
  }
}

function buildQualityOptions(defaultQuality) {
  qualitySel.innerHTML = '';
  if (record && record.variants && record.variants.length) {
    const auto = document.createElement('option');
    auto.value = defaultQuality;
    auto.textContent = t(
      'popupQualityDefault',
      qualityLabel(defaultQuality) || defaultQuality,
    );
    qualitySel.appendChild(auto);
    for (const v of record.variants) {
      const o = document.createElement('option');
      o.value = String(v.height || 'highest');
      o.textContent = v.height
        ? t('popupVariant', v.height, Math.round((v.bitrate || 0) / 1000))
        : t('popupVariantBitrate', Math.round((v.bitrate || 0) / 1000));
      qualitySel.appendChild(o);
    }
  } else {
    for (const o of QUALITY_OPTIONS) {
      const el = document.createElement('option');
      el.value = o.value;
      el.textContent = qualityLabel(o.value);
      el.selected = o.value === defaultQuality;
      qualitySel.appendChild(el);
    }
  }
}

function mountBatch(tabId, user) {
  const section = $('batch');
  const btn = $('batchDownload');
  btn.textContent = t('popupBatchDownload', user);
  section.hidden = false;
  btn.addEventListener('click', () => startBatch(tabId, btn));
}

async function startBatch(tabId, btn) {
  const status = $('batchStatus');
  btn.disabled = true;
  status.className = 'pp-status';
  status.textContent = t('popupBatchStarting');
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: 'xvd:batch-start' });
    if (res && res.ok) {
      status.className = 'pp-status ok';
      status.textContent = res.already
        ? t('popupBatchAlready')
        : t('popupBatchStarted');
    } else {
      status.className = 'pp-status err';
      status.textContent = (res && res.error) || t('popupBatchFailed');
    }
  } catch (_) {
    status.className = 'pp-status err';
    status.textContent = t('popupBatchReload');
  } finally {
    btn.disabled = false;
  }
}

async function doDownload() {
  if (!current) return;
  const btn = $('download');
  btn.disabled = true;
  statusEl.className = 'pp-status';
  statusEl.textContent = t('popupPreparing');
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'xvd:download',
      tweetId: current.tweetId,
      screenName: current.screenName,
      tweetUrl: `https://x.com/${current.screenName}/status/${current.tweetId}`,
      quality: qualitySel.value,
      record,
    });
    if (res && res.ok) {
      statusEl.className = 'pp-status ok';
      statusEl.textContent = t('popupDownloading', res.label, res.filename);
      renderRecent();
    } else {
      statusEl.className = 'pp-status err';
      statusEl.textContent = t('popupFailed', (res && res.error) || t('popupUnknownError'));
    }
  } catch (e) {
    statusEl.className = 'pp-status err';
    statusEl.textContent = t('popupFailed', e.message || e);
  } finally {
    btn.disabled = false;
  }
}

async function renderRecent() {
  const list = (await getHistory()).slice(0, 4);
  const ul = $('recentList');
  ul.innerHTML = '';
  if (!list.length) {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.className = 'empty';
    span.textContent = t('popupRecentEmpty');
    li.appendChild(span);
    ul.appendChild(li);
    return;
  }
  for (const rec of list) {
    const li = document.createElement('li');
    const dot = document.createElement('span');
    dot.className = 'dot ' + rec.state;
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = `@${rec.screenName} · ${rec.quality || 'video'}`;
    name.title = rec.filename || rec.tweetUrl;
    li.appendChild(dot);
    li.appendChild(name);
    ul.appendChild(li);
  }
}

function showEmpty() {
  empty.hidden = false;
  detected.hidden = true;
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}
