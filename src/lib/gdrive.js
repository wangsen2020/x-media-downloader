// Google Drive REST API v3 client (ES module).
// Uses optional_permissions ("identity") + drive.file scope so existing users
// update silently without permission warnings.

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const FOLDER_MIME = 'application/vnd.google-apps.folder';
export const DEFAULT_FOLDER_NAME = 'X Media Downloader';
export const MULTIPART_LIMIT_BYTES = 5 * 1024 * 1024;
export const CHUNK_SIZE = 4 * 1024 * 1024; // 4 MiB (multiple of 256 KiB)

export const GDRIVE_PERMISSIONS = {
  permissions: ['identity'],
  origins: [
    'https://www.googleapis.com/*',
    'https://video.twimg.com/*',
    'https://pbs.twimg.com/*',
  ],
};

const FILES_API = 'https://www.googleapis.com/drive/v3/files';
const MULTIPART_UPLOAD_API =
  'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,webViewLink,sha256Checksum';
const RESUMABLE_UPLOAD_API =
  'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,mimeType,webViewLink,sha256Checksum';

const FOLDER_CACHE_KEY = 'gdriveFolderCache';
const WEB_TOKEN_CACHE_KEY = 'gdriveWebAuthToken';
const PLACEHOLDER_CLIENT_ID = 'YOUR_GOOGLE_OAUTH_CLIENT_ID.apps.googleusercontent.com';
const WEB_AUTH_CLIENT_ID =
  '51782706977-lan42tu980ttnm3ga78sbhen9113kf95.apps.googleusercontent.com';

const folderInflight = new Map();

export function isAuthCancelError(err) {
  if (!err) return false;
  if (err.code === 'AUTH_CANCELLED' || err.cancelled === true) return true;
  const msg = String(err.message || err || '');
  return /user did not approve|user_cancelled|access_denied|canceled|cancelled|closed the window|authorization page could not be loaded|interrupted/i.test(
    msg,
  );
}

function makeCancelError(rawErr) {
  const e = new Error('Google authorization cancelled');
  e.code = 'AUTH_CANCELLED';
  e.cancelled = true;
  e.cause = rawErr;
  return e;
}

function hasPlaceholderClientId() {
  try {
    const m = chrome?.runtime?.getManifest?.();
    const cid = m?.oauth2?.client_id;
    return !cid || cid === PLACEHOLDER_CLIENT_ID || cid.startsWith('YOUR_GOOGLE_OAUTH_CLIENT_ID');
  } catch (_) {
    return false;
  }
}

export async function hasOptionalPermissions() {
  if (typeof chrome === 'undefined' || !chrome.permissions?.contains) return false;
  try {
    return await chrome.permissions.contains(GDRIVE_PERMISSIONS);
  } catch (_) {
    return false;
  }
}

export async function requestOptionalPermissions() {
  if (typeof chrome === 'undefined' || !chrome.permissions?.request) {
    throw new Error('chrome.permissions.request is unavailable');
  }
  return await chrome.permissions.request(GDRIVE_PERMISSIONS);
}

export async function removeOptionalPermissions() {
  await setCachedWebToken('', 0);
  await clearFolderCache();
  if (typeof chrome !== 'undefined' && chrome.identity?.clearAllCachedAuthTokens) {
    try {
      await new Promise((res) => chrome.identity.clearAllCachedAuthTokens(() => res()));
    } catch (_) {
      /* ignore */
    }
  }
  if (typeof chrome !== 'undefined' && chrome.permissions?.remove) {
    try {
      await chrome.permissions.remove(GDRIVE_PERMISSIONS);
    } catch (_) {
      /* ignore */
    }
  }
}

export async function isDriveAuthorized() {
  if (!(await hasOptionalPermissions())) return false;
  try {
    await ensureToken({ interactive: false });
    return true;
  } catch (_) {
    return false;
  }
}

function callGetAuthToken(interactive) {
  return new Promise((resolve, reject) => {
    if (typeof chrome === 'undefined' || !chrome.identity?.getAuthToken) {
      reject(new Error('chrome.identity.getAuthToken is unavailable'));
      return;
    }
    let settled = false;
    const finish = (err, val) => {
      if (settled) return;
      settled = true;
      if (err) return reject(err);
      const token = typeof val === 'string' ? val : (val && val.token) || '';
      resolve(token);
    };
    try {
      const ret = chrome.identity.getAuthToken({ interactive: !!interactive }, (token) => {
        const lastErr = chrome.runtime?.lastError;
        if (lastErr) finish(new Error(lastErr.message || String(lastErr)));
        else finish(null, token);
      });
      if (ret && typeof ret.then === 'function') {
        ret.then(
          (val) => finish(null, val),
          (err) => finish(err),
        );
      }
    } catch (e) {
      finish(e);
    }
  });
}

async function getCachedWebToken() {
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      const obj = await chrome.storage.local.get(WEB_TOKEN_CACHE_KEY);
      const rec = obj?.[WEB_TOKEN_CACHE_KEY];
      if (rec?.token && (!rec.expiresAt || rec.expiresAt > Date.now())) {
        return rec.token;
      }
    }
  } catch (_) {
    /* ignore */
  }
  return '';
}

async function setCachedWebToken(token, expiresInSec) {
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      if (!token) {
        await chrome.storage.local.remove(WEB_TOKEN_CACHE_KEY);
        return;
      }
      const ttl = Math.max(60, (Number(expiresInSec) || 3600) - 60) * 1000;
      await chrome.storage.local.set({
        [WEB_TOKEN_CACHE_KEY]: { token, expiresAt: Date.now() + ttl },
      });
    }
  } catch (_) {
    /* ignore */
  }
}

function callLaunchWebAuthFlow(interactive) {
  return new Promise((resolve, reject) => {
    if (typeof chrome === 'undefined' || !chrome.identity?.launchWebAuthFlow) {
      reject(new Error('chrome.identity.launchWebAuthFlow is unavailable'));
      return;
    }
    const redirectUri = chrome.identity.getRedirectURL
      ? chrome.identity.getRedirectURL()
      : `https://${chrome.runtime?.id || ''}.chromiumapp.org/`;
    const authUrl =
      'https://accounts.google.com/o/oauth2/v2/auth?' +
      new URLSearchParams({
        client_id: WEB_AUTH_CLIENT_ID,
        response_type: 'token',
        redirect_uri: redirectUri,
        scope: DRIVE_SCOPE,
        prompt: interactive ? 'select_account' : 'none',
      }).toString();

    let settled = false;
    const finish = (err, responseUrl) => {
      if (settled) return;
      settled = true;
      if (err) return reject(err);
      const raw = String(responseUrl || '');
      const hashIdx = raw.indexOf('#');
      const queryIdx = raw.indexOf('?');
      const frag = hashIdx >= 0 ? raw.slice(hashIdx + 1) : queryIdx >= 0 ? raw.slice(queryIdx + 1) : '';
      const params = new URLSearchParams(frag);
      const oauthErr = params.get('error');
      if (oauthErr) return reject(new Error(oauthErr));
      const token = params.get('access_token') || '';
      const expiresIn = Number(params.get('expires_in')) || 3600;
      if (!token) return reject(new Error('empty token from launchWebAuthFlow'));
      setCachedWebToken(token, expiresIn).then(
        () => resolve(token),
        () => resolve(token),
      );
    };

    try {
      const ret = chrome.identity.launchWebAuthFlow(
        { url: authUrl, interactive: !!interactive },
        (respUrl) => {
          const lastErr = chrome.runtime?.lastError;
          if (lastErr) finish(new Error(lastErr.message || String(lastErr)));
          else finish(null, respUrl);
        },
      );
      if (ret && typeof ret.then === 'function') {
        ret.then(
          (val) => finish(null, val),
          (err) => finish(err),
        );
      }
    } catch (e) {
      finish(e);
    }
  });
}

export async function removeCachedToken(token) {
  await setCachedWebToken('', 0);
  if (!token || typeof chrome === 'undefined' || !chrome.identity?.removeCachedAuthToken) return;
  await new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    try {
      const ret = chrome.identity.removeCachedAuthToken({ token }, done);
      if (ret && typeof ret.then === 'function') ret.then(done, done);
    } catch (_) {
      done();
    }
  });
}

export async function ensureToken(opts = {}) {
  const interactive = opts.interactive !== false;
  let silentErr = null;
  if (!hasPlaceholderClientId()) {
    try {
      const cached = await callGetAuthToken(false);
      if (cached) return { token: cached, interactiveUsed: false };
    } catch (e) {
      silentErr = e;
    }
  }

  const cachedWeb = await getCachedWebToken();
  if (cachedWeb) return { token: cachedWeb, interactiveUsed: false };

  if (!interactive) {
    throw silentErr || new Error('No cached Google Drive auth token');
  }

  if (typeof opts.onInteractiveStart === 'function') {
    try {
      opts.onInteractiveStart();
    } catch (_) {
      /* ignore */
    }
  }

  if (!hasPlaceholderClientId()) {
    try {
      const token = await callGetAuthToken(true);
      if (!token) throw makeCancelError(new Error('empty token'));
      return { token, interactiveUsed: true };
    } catch (err) {
      if (isAuthCancelError(err)) throw makeCancelError(err);
      // Fall through to launchWebAuthFlow when getAuthToken is unsupported.
    }
  }

  if (typeof chrome !== 'undefined' && chrome.identity?.launchWebAuthFlow) {
    try {
      const webToken = await callLaunchWebAuthFlow(true);
      if (!webToken) throw makeCancelError(new Error('empty token'));
      return { token: webToken, interactiveUsed: true };
    } catch (webErr) {
      if (isAuthCancelError(webErr)) throw makeCancelError(webErr);
      throw webErr instanceof Error ? webErr : new Error(String(webErr || 'Google auth failed'));
    }
  }

  throw silentErr || new Error('Google authorization unavailable');
}

export async function fetchWithAuth(url, init = {}, opts = {}) {
  const fetchFn = opts.fetchImpl || fetch;
  let token = opts.token || '';
  if (!token) {
    const r = await ensureToken({
      interactive: opts.interactive !== false,
      onInteractiveStart: opts.onInteractiveStart,
    });
    token = r.token;
  }

  const doReq = (tk) => {
    const headers = { ...(init.headers || {}), Authorization: 'Bearer ' + tk };
    return fetchFn(url, { ...init, headers });
  };

  let resp = await doReq(token);
  if (resp && resp.status === 401) {
    await removeCachedToken(token);
    const refreshed = await ensureToken({
      interactive: opts.interactive !== false,
      onInteractiveStart: opts.onInteractiveStart,
    });
    token = refreshed.token;
    resp = await doReq(token);
  }
  return { resp, token };
}

async function parseDriveError(resp) {
  let detail = '';
  let reason = '';
  try {
    const data = await resp.json();
    detail = data?.error?.message || '';
    reason = data?.error?.errors?.[0]?.reason || '';
  } catch (_) {
    try {
      detail = await resp.text();
    } catch (_2) {
      /* ignore */
    }
  }
  return { detail, reason, raw: detail ? `HTTP ${resp.status}: ${detail}` : `HTTP ${resp.status}` };
}

async function makeDriveError(prefix, resp) {
  const { raw, reason } = await parseDriveError(resp);
  if (resp?.status === 403 && /storageQuotaExceeded/i.test(reason + ' ' + raw)) {
    const err = new Error(raw);
    err.code = 'QUOTA_EXCEEDED';
    return err;
  }
  if (
    resp?.status === 403 &&
    /drive\.googleapis\.com|has not been used in project|accessNotConfigured/i.test(raw)
  ) {
    const err = new Error(raw);
    err.code = 'DRIVE_API_DISABLED';
    return err;
  }
  const err = new Error(prefix ? `${prefix}: ${raw}` : raw);
  err.status = resp?.status;
  return err;
}

// --- Folder cache & management -------------------------------------------

async function getFolderCache() {
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      const obj = await chrome.storage.local.get(FOLDER_CACHE_KEY);
      return obj?.[FOLDER_CACHE_KEY] || {};
    }
  } catch (_) {
    /* ignore */
  }
  return {};
}

async function setFolderCacheEntry(cacheKey, id) {
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      const map = await getFolderCache();
      if (id) map[cacheKey] = id;
      else delete map[cacheKey];
      await chrome.storage.local.set({ [FOLDER_CACHE_KEY]: map });
    }
  } catch (_) {
    /* ignore */
  }
}

export async function clearFolderCache(cacheKey) {
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      if (!cacheKey) await chrome.storage.local.remove(FOLDER_CACHE_KEY);
      else await setFolderCacheEntry(cacheKey, '');
    }
  } catch (_) {
    /* ignore */
  }
}

function escapeDriveQuery(val) {
  return String(val || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function ensureSingleFolder(name, parentId, opts = {}) {
  const cleanName = String(name || DEFAULT_FOLDER_NAME).trim() || DEFAULT_FOLDER_NAME;
  const cacheKey = `${parentId || 'root'}::${cleanName}`;
  if (!opts.forceRefresh) {
    const cache = await getFolderCache();
    if (cache[cacheKey]) return { folderId: cache[cacheKey], token: opts.token || '' };
    if (folderInflight.has(cacheKey)) return folderInflight.get(cacheKey);
  }

  const run = (async () => {
    const parentClause = parentId ? ` and '${escapeDriveQuery(parentId)}' in parents` : ` and 'root' in parents`;
    const q = `mimeType='${FOLDER_MIME}' and name='${escapeDriveQuery(cleanName)}' and trashed=false${parentClause}`;
    const listUrl = `${FILES_API}?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=1&spaces=drive`;
    const { resp: listResp, token } = await fetchWithAuth(listUrl, { method: 'GET' }, opts);
    if (!listResp.ok) throw await makeDriveError('Failed to query Google Drive folder', listResp);
    const listData = await listResp.json();
    const existing = listData?.files?.[0];
    if (existing?.id) {
      await setFolderCacheEntry(cacheKey, existing.id);
      return { folderId: existing.id, token };
    }

    const body = { name: cleanName, mimeType: FOLDER_MIME };
    if (parentId) body.parents = [parentId];
    const { resp: createResp, token: token2 } = await fetchWithAuth(
      `${FILES_API}?fields=id,name`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=UTF-8' },
        body: JSON.stringify(body),
      },
      { ...opts, token },
    );
    if (!createResp.ok) {
      throw await makeDriveError('Failed to create Google Drive folder', createResp);
    }
    const created = await createResp.json();
    if (!created?.id) throw new Error('Google Drive returned no folder id');
    await setFolderCacheEntry(cacheKey, created.id);
    return { folderId: created.id, token: token2 };
  })();

  if (!opts.forceRefresh) {
    folderInflight.set(cacheKey, run);
    try {
      return await run;
    } finally {
      if (folderInflight.get(cacheKey) === run) folderInflight.delete(cacheKey);
    }
  }
  return run;
}

export async function ensureFolderPath({ rootName = DEFAULT_FOLDER_NAME, subfolder = '', ...opts } = {}) {
  const rootRes = await ensureSingleFolder(rootName, '', opts);
  const sub = String(subfolder || '').trim();
  if (!sub) return rootRes;
  return ensureSingleFolder(sub, rootRes.folderId, { ...opts, token: rootRes.token });
}

// --- Multipart & Resumable uploads ---------------------------------------

export function buildMultipartPayload({ metadata = {}, mediaContentType = 'application/octet-stream', mediaBody, boundary }) {
  const b =
    boundary || 'xmd_mp_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
  const enc = new TextEncoder();
  const preamble = enc.encode(
    `--${b}\r\n` +
      `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
      `${JSON.stringify(metadata)}\r\n` +
      `--${b}\r\n` +
      `Content-Type: ${mediaContentType}\r\n\r\n`,
  );
  const bodyBytes =
    mediaBody instanceof Uint8Array
      ? mediaBody
      : mediaBody instanceof ArrayBuffer
        ? new Uint8Array(mediaBody)
        : enc.encode(String(mediaBody ?? ''));
  const epilogue = enc.encode(`\r\n--${b}--`);
  const merged = new Uint8Array(preamble.length + bodyBytes.length + epilogue.length);
  merged.set(preamble, 0);
  merged.set(bodyBytes, preamble.length);
  merged.set(epilogue, preamble.length + bodyBytes.length);
  return { contentType: `multipart/related; boundary=${b}`, body: merged };
}

export function defaultWebViewLink(id) {
  return id ? `https://drive.google.com/file/d/${encodeURIComponent(id)}/view` : '';
}

export function parseRangeHeader(rangeVal) {
  const m = /bytes=0-(\d+)/i.exec(String(rangeVal || ''));
  return m ? Number(m[1]) + 1 : 0;
}

export async function computeSha256Hex(data) {
  if (typeof crypto === 'undefined' || !crypto.subtle?.digest) return '';
  const buf =
    data instanceof Uint8Array
      ? data
      : data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : data && typeof data.arrayBuffer === 'function'
          ? new Uint8Array(await data.arrayBuffer())
          : null;
  if (!buf) return '';
  const hashBuf = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(hashBuf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function findExistingDriveFile({ folderId, name, mediaKey, sha256, ...opts } = {}) {
  const clauses = [];
  if (sha256) clauses.push(`sha256Checksum='${escapeDriveQuery(sha256)}'`);
  if (mediaKey) {
    clauses.push(`appProperties has { key='xmdMediaKey' and value='${escapeDriveQuery(mediaKey)}' }`);
  }
  if (name && folderId) {
    clauses.push(`(name='${escapeDriveQuery(name)}' and '${escapeDriveQuery(folderId)}' in parents)`);
  } else if (name) {
    clauses.push(`name='${escapeDriveQuery(name)}'`);
  }
  if (!clauses.length) return null;

  const q = `(${clauses.join(' or ')}) and trashed=false and mimeType!='${FOLDER_MIME}'`;
  const url = `${FILES_API}?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType,webViewLink,sha256Checksum)&pageSize=1&spaces=drive`;
  const { resp, token } = await fetchWithAuth(url, { method: 'GET' }, opts);
  if (!resp.ok) return null;
  const data = await resp.json().catch(() => null);
  const f = data?.files?.[0];
  if (!f?.id) return null;
  return {
    id: f.id,
    name: f.name || name || '',
    mimeType: f.mimeType || '',
    webViewLink: f.webViewLink || defaultWebViewLink(f.id),
    sha256Checksum: f.sha256Checksum || sha256 || '',
    deduped: true,
    token,
  };
}

export async function uploadMultipart({ folderId, name, mimeType, bytes, appProperties, ...opts }) {
  const metadata = {
    name,
    mimeType,
    ...(folderId ? { parents: [folderId] } : {}),
    ...(appProperties ? { appProperties } : {}),
  };
  const mp = buildMultipartPayload({ metadata, mediaContentType: mimeType, mediaBody: bytes });
  const { resp, token } = await fetchWithAuth(
    MULTIPART_UPLOAD_API,
    {
      method: 'POST',
      headers: { 'Content-Type': mp.contentType },
      body: mp.body,
      signal: opts.signal,
    },
    opts,
  );
  if (!resp.ok) throw await makeDriveError('Multipart upload failed', resp);
  const data = await resp.json();
  if (!data?.id) throw new Error('Google Drive returned no file id');
  return {
    id: data.id,
    name: data.name || name,
    mimeType: data.mimeType || mimeType,
    webViewLink: data.webViewLink || defaultWebViewLink(data.id),
    token,
  };
}

export async function initResumableSession({ folderId, name, mimeType, totalBytes, appProperties, ...opts }) {
  const metadata = {
    name,
    ...(folderId ? { parents: [folderId] } : {}),
    ...(appProperties ? { appProperties } : {}),
  };
  const headers = {
    'Content-Type': 'application/json; charset=UTF-8',
    'X-Upload-Content-Type': mimeType || 'application/octet-stream',
  };
  if (totalBytes > 0) headers['X-Upload-Content-Length'] = String(totalBytes);
  const { resp, token } = await fetchWithAuth(
    RESUMABLE_UPLOAD_API,
    {
      method: 'POST',
      headers,
      body: JSON.stringify(metadata),
      signal: opts.signal,
    },
    opts,
  );
  if (!resp.ok) throw await makeDriveError('Failed to start resumable upload', resp);
  const sessionUrl = resp.headers?.get?.('Location') || resp.headers?.get?.('location') || '';
  if (!sessionUrl) throw new Error('Missing resumable upload Location header');
  return { sessionUrl, token };
}

export async function queryResumableOffset({ sessionUrl, totalBytes, ...opts }) {
  const { resp, token } = await fetchWithAuth(
    sessionUrl,
    {
      method: 'PUT',
      headers: {
        'Content-Range': `bytes */${totalBytes || '*'}`,
      },
      signal: opts.signal,
    },
    opts,
  );
  if (resp.status === 308) {
    const offset = parseRangeHeader(resp.headers?.get?.('Range') || resp.headers?.get?.('range'));
    return { done: false, expired: false, offset, token };
  }
  if (resp.status === 200 || resp.status === 201) {
    const data = await resp.json();
    return {
      done: true,
      expired: false,
      file: {
        id: data.id,
        name: data.name || '',
        mimeType: data.mimeType || '',
        webViewLink: data.webViewLink || defaultWebViewLink(data.id),
      },
      token,
    };
  }
  if (resp.status === 404 || resp.status === 410) {
    return { done: false, expired: true, offset: 0, token };
  }
  throw await makeDriveError('Failed to check resumable upload status', resp);
}

export async function uploadResumableChunk({ sessionUrl, chunkBytes, start, end, totalBytes, ...opts }) {
  const { resp, token } = await fetchWithAuth(
    sessionUrl,
    {
      method: 'PUT',
      headers: {
        'Content-Type': opts.mimeType || 'application/octet-stream',
        'Content-Range': `bytes ${start}-${end}/${totalBytes}`,
      },
      body: chunkBytes,
      signal: opts.signal,
    },
    opts,
  );
  if (resp.status === 308) {
    const rangeOffset = parseRangeHeader(resp.headers?.get?.('Range') || resp.headers?.get?.('range'));
    return { done: false, offset: rangeOffset || end + 1, token };
  }
  if (resp.status === 200 || resp.status === 201) {
    const data = await resp.json();
    return {
      done: true,
      offset: totalBytes,
      file: {
        id: data.id,
        name: data.name || '',
        mimeType: data.mimeType || '',
        webViewLink: data.webViewLink || defaultWebViewLink(data.id),
      },
      token,
    };
  }
  throw await makeDriveError('Chunk upload failed', resp);
}

export async function abortResumableSession({ sessionUrl, ...opts }) {
  if (!sessionUrl) return;
  try {
    await fetchWithAuth(
      sessionUrl,
      { method: 'DELETE' },
      { ...opts, interactive: false },
    );
  } catch (_) {
    /* ignore cleanup failure */
  }
}

export async function streamToDrive({
  mediaUrl,
  mediaKey = '',
  rootName = DEFAULT_FOLDER_NAME,
  subfolder = '',
  name,
  mimeType = 'application/octet-stream',
  task = {},
  chunkSize = CHUNK_SIZE,
  multipartLimit = MULTIPART_LIMIT_BYTES,
  onCheckpoint,
  onProgress,
  signal,
  fetchImpl,
  token: initialToken,
}) {
  const f = fetchImpl || fetch;
  let { folderId, token } = await ensureFolderPath({
    rootName,
    subfolder,
    token: initialToken,
    fetchImpl: f,
  });

  // Layer 1 (zero-bandwidth): check Drive by xmdMediaKey or filename before fetching media.
  if (!task.uploadSessionUrl && (mediaKey || name)) {
    const existing = await findExistingDriveFile({
      folderId,
      name,
      mediaKey,
      token,
      fetchImpl: f,
      signal,
    }).catch(() => null);
    if (existing) {
      onProgress?.(1, 1);
      return existing;
    }
  }

  const mediaResp = await f(mediaUrl, { signal });
  if (!mediaResp.ok) {
    const err = new Error(`Media fetch failed: HTTP ${mediaResp.status}`);
    err.status = mediaResp.status;
    err.code = mediaResp.status === 403 || mediaResp.status === 404 || mediaResp.status === 410 ? 'MEDIA_EXPIRED' : 'MEDIA_FETCH_FAILED';
    throw err;
  }

  const contentLength = Number(mediaResp.headers?.get?.('content-length') || 0);
  const buildAppProps = (sha256) => {
    const p = {};
    if (mediaKey) p.xmdMediaKey = String(mediaKey).slice(0, 120);
    if (sha256) p.xmdSha256 = sha256;
    return Object.keys(p).length ? p : undefined;
  };

  // Small media (<= multipartLimit) with known length: hash + dedup + single multipart upload.
  if (contentLength > 0 && contentLength <= multipartLimit) {
    const bytes = new Uint8Array(await mediaResp.arrayBuffer());
    const sha256 = await computeSha256Hex(bytes).catch(() => '');
    if (sha256) {
      const existingByHash = await findExistingDriveFile({ sha256, token, fetchImpl: f, signal }).catch(() => null);
      if (existingByHash) {
        onProgress?.(bytes.length, bytes.length);
        return existingByHash;
      }
    }
    onProgress?.(bytes.length, bytes.length);
    const appProperties = buildAppProps(sha256);
    try {
      const file = await uploadMultipart({
        folderId,
        name,
        mimeType,
        bytes,
        appProperties,
        signal,
        token,
        fetchImpl: f,
      });
      return file;
    } catch (e) {
      if (e.status === 404) {
        await clearFolderCache();
        const rebuilt = await ensureFolderPath({ rootName, subfolder, forceRefresh: true, token, fetchImpl: f });
        return uploadMultipart({
          folderId: rebuilt.folderId,
          name,
          mimeType,
          bytes,
          appProperties,
          signal,
          token: rebuilt.token,
          fetchImpl: f,
        });
      }
      throw e;
    }
  }

  // If Content-Length is missing, buffer as Blob so we know totalBytes for Content-Range.
  let blob = null;
  let totalBytes = contentLength;
  if (!totalBytes || !mediaResp.body?.getReader) {
    blob = await mediaResp.blob();
    totalBytes = blob.size;
    if (totalBytes <= multipartLimit) {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const sha256 = await computeSha256Hex(bytes).catch(() => '');
      if (sha256) {
        const existingByHash = await findExistingDriveFile({ sha256, token, fetchImpl: f, signal }).catch(() => null);
        if (existingByHash) {
          onProgress?.(bytes.length, bytes.length);
          return existingByHash;
        }
      }
      onProgress?.(bytes.length, bytes.length);
      return uploadMultipart({
        folderId,
        name,
        mimeType,
        bytes,
        appProperties: buildAppProps(sha256),
        signal,
        token,
        fetchImpl: f,
      });
    }
  }

  // Resumable upload path (> 5 MiB)
  let sessionUrl = task.uploadSessionUrl || '';
  let committedOffset = 0;

  if (sessionUrl) {
    const check = await queryResumableOffset({ sessionUrl, totalBytes, signal, token, fetchImpl: f });
    token = check.token || token;
    if (check.done && check.file) {
      onProgress?.(totalBytes, totalBytes);
      return check.file;
    }
    if (check.expired) {
      sessionUrl = '';
      committedOffset = 0;
    } else {
      committedOffset = check.offset || 0;
    }
  }

  if (!sessionUrl) {
    try {
      const init = await initResumableSession({
        folderId,
        name,
        mimeType,
        totalBytes,
        appProperties: buildAppProps(''),
        signal,
        token,
        fetchImpl: f,
      });
      sessionUrl = init.sessionUrl;
      token = init.token;
    } catch (e) {
      if (e.status === 404) {
        await clearFolderCache();
        const rebuilt = await ensureFolderPath({ rootName, subfolder, forceRefresh: true, token, fetchImpl: f });
        const init = await initResumableSession({
          folderId: rebuilt.folderId,
          name,
          mimeType,
          totalBytes,
          appProperties: buildAppProps(''),
          signal,
          token: rebuilt.token,
          fetchImpl: f,
        });
        sessionUrl = init.sessionUrl;
        token = init.token;
      } else {
        throw e;
      }
    }
    await onCheckpoint?.({
      uploadSessionUrl: sessionUrl,
      committedOffset: 0,
      chunkSize,
      sessionCreatedAt: Date.now(),
      bytesTotal: totalBytes,
    });
  }

  onProgress?.(committedOffset, totalBytes);

  if (blob) {
    let offset = committedOffset;
    while (offset < totalBytes) {
      const end = Math.min(offset + chunkSize, totalBytes) - 1;
      const sliceBytes = new Uint8Array(await blob.slice(offset, end + 1).arrayBuffer());
      const res = await uploadResumableChunk({
        sessionUrl,
        chunkBytes: sliceBytes,
        start: offset,
        end,
        totalBytes,
        mimeType,
        signal,
        token,
        fetchImpl: f,
      });
      token = res.token || token;
      offset = res.offset;
      onProgress?.(offset, totalBytes);
      await onCheckpoint?.({
        uploadSessionUrl: sessionUrl,
        committedOffset: offset,
        bytesUploaded: offset,
        bytesTotal: totalBytes,
      });
      if (res.done) return res.file;
    }
    throw new Error('Resumable upload ended without completion');
  }

  // Streaming reader path: keep RAM bounded to ~chunkSize.
  const reader = mediaResp.body.getReader();
  let streamPos = 0;
  let pending = new Uint8Array(0);

  const appendBuf = (a, b) => {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
  };

  while (true) {
    const { done, value } = await reader.read();
    if (value && value.length) {
      // Skip bytes already committed before resume point.
      if (streamPos + value.length <= committedOffset) {
        streamPos += value.length;
        continue;
      }
      let slice = value;
      if (streamPos < committedOffset) {
        slice = value.subarray(committedOffset - streamPos);
        streamPos = committedOffset;
      } else {
        streamPos += value.length;
      }
      pending = appendBuf(pending, slice);
    }

    while (pending.length >= chunkSize || (done && pending.length > 0)) {
      const sendLen = done ? Math.min(chunkSize, pending.length) : chunkSize;
      const chunkBytes = pending.subarray(0, sendLen);
      pending = pending.subarray(sendLen);
      const start = committedOffset;
      const end = start + sendLen - 1;
      const res = await uploadResumableChunk({
        sessionUrl,
        chunkBytes,
        start,
        end,
        totalBytes,
        mimeType,
        signal,
        token,
        fetchImpl: f,
      });
      token = res.token || token;
      committedOffset = res.offset;
      onProgress?.(committedOffset, totalBytes);
      await onCheckpoint?.({
        uploadSessionUrl: sessionUrl,
        committedOffset,
        bytesUploaded: committedOffset,
        bytesTotal: totalBytes,
      });
      if (res.done) return res.file;
    }

    if (done) break;
  }

  throw new Error('Resumable upload stream ended unexpectedly');
}
