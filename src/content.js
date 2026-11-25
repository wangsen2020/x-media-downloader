// Content script (isolated world). Bridges the page hook to the service worker
// and adds a download button to every video in the timeline.
// This file stays a classic script. Chrome has no "type" key for
// content_scripts, so a top-level import throws and the button never runs.
(function () {
  'use strict';

  let mo;
  let scanTimer = 0;
  let batchApi;
  let contextTimer;
  let invalidated = false;
  function contextValid() {
    if (invalidated) return false;
    try {
      if (!chrome.runtime || !chrome.runtime.id) throw new Error();
      chrome.runtime.getURL('');
      return true;
    } catch (_) {
      invalidated = true;
      if (mo) mo.disconnect();
      cancelAnimationFrame(scanTimer);
      clearInterval(contextTimer);
      if (batchApi && batchApi.dispose) batchApi.dispose();
      return false;
    }
  }
  if (!contextValid()) return;
  contextTimer = setInterval(contextValid, 1000);

  const origin = window.location.origin;
  let mediaKind;
  const mediaReady = import(chrome.runtime.getURL('src/lib/media.js')).then((mod) => {
    mediaKind = mod.mediaKind;
    scheduleScan();
  });
  mediaReady.catch(() => {});

  function t(key, ...subs) {
    if (!contextValid()) return '';
    try {
      if (!chrome.i18n || !chrome.i18n.getMessage) return key;
      const msg = subs.length
        ? chrome.i18n.getMessage(key, subs.map((s) => String(s)))
        : chrome.i18n.getMessage(key);
      if (msg) return msg;
    } catch (_) {
      /* ignore */
    }
    if (!contextValid()) return '';
    console.warn('[i18n] missing message:', key);
    return key;
  }

  function uiLang() {
    if (!contextValid()) return;
    try {
      return (chrome.i18n && chrome.i18n.getUILanguage && chrome.i18n.getUILanguage()) || 'en';
    } catch (_) {
      return 'en';
    }
  }

  // 1. Fallback injection of the page-context hook.
  //
  // The hook is primarily registered in manifest.json as a `world: "MAIN"`
  // content script, which the browser guarantees to run at document_start
  // BEFORE any page script. This tag is only a safety net for builds where
  // that is unavailable: a dynamically inserted external script still has to
  // be fetched, and X's bundle can issue its TweetDetail request inside that
  // window - which is exactly how a directly-opened permalink ended up with
  // no captured variants while timeline browsing worked fine.
  // injected.js guards on window.__xvdInjected, so running twice is harmless.
  try {
    const s = document.createElement('script');
    s.src = chrome.runtime.getURL('src/injected.js');
    s.async = false;
    (document.head || document.documentElement).appendChild(s);
    s.onload = () => s.remove();
  } catch (_) {
    /* ignore */
  }

  // tweetId -> record captured from the API. Photos are kept apart so a mixed
  // post cannot replace the video variants the quality menu reads.
  const mediaByTweet = new Map();
  const photosByTweet = new Map();
  // Every captured video, not just the last one per tweet. The button still
  // reads mediaByTweet; a multi-video post must not drop renditions at batch start.
  const allVideos = new Map();

  function mergePhoto(prev, rec) {
    if (!prev) return rec;
    const images = prev.images ? prev.images.slice() : [];
    for (const url of rec.images || []) {
      if (url && !images.includes(url)) images.push(url);
    }
    return {
      ...prev,
      ...rec,
      images,
      screenName: rec.screenName && rec.screenName !== 'unknown' ? rec.screenName : prev.screenName,
      text: rec.text || prev.text,
      postDate: rec.postDate || prev.postDate,
    };
  }

  // No-ops until the controller module arrives. Page messages still fill the
  // maps above, so a single-post download never waits on that fetch.
  batchApi = {
    ingest() {},
    onRateLimit() {},
  };
  let settings = {
    showTimelineButton: true,
    clickDownloadsImmediately: true,
    defaultQuality: 'highest',
  };
  const batchReady = import(chrome.runtime.getURL('src/content-batch.js')).then((mod) => {
    if (!contextValid()) return { start: () => ({ ok: false }) };
    batchApi = mod.attachBatch({
      contextValid,
      getVideos: () => allVideos,
      getPhotos: () => photosByTweet,
      getSettings: () => settings,
    });
    return batchApi;
  });
  batchReady.catch(() => {});

  window.addEventListener('message', (ev) => {
    if (!contextValid()) return;
    if (ev.source !== window || ev.origin !== origin) return;
    const data = ev.data;
    if (!data || data.__src !== 'xvd') return;
    if (data.kind === 'ratelimit') {
      batchApi.onRateLimit();
      return;
    }
    if (data.kind !== 'media') return;
    const videos = [];
    for (const rec of data.records || []) {
      if (!rec || !rec.tweetId) continue;
      if (rec.type === 'photo') {
        photosByTweet.set(rec.tweetId, mergePhoto(photosByTweet.get(rec.tweetId), rec));
        continue;
      }
      if (rec.variants && rec.variants.length) {
        mediaByTweet.set(rec.tweetId, rec);
        // Query-stripped URL, not mediaKeyFromUrl: that helper lives in the
        // batch module, and this path must not wait for it. The queue dedupes.
        const url = rec.variants[0] && rec.variants[0].url;
        allVideos.set((url && url.split('?')[0]) || ('tweet:' + rec.tweetId), rec);
        videos.push(rec);
      }
    }
    if (videos.length) {
      try {
        chrome.runtime.sendMessage({ type: 'xvd:media', records: videos });
      } catch (_) {
        /* service worker asleep is fine, it also listens itself */
      }
    }
    batchApi.ingest(data.records);
    // A late capture might belong to a button we already drew.
    refreshButtons();
  });

  // --- settings (kept in sync) ------------------------------------------------
  chrome.storage.local.get('settings').then((g) => {
    if (!contextValid()) return;
    if (g.settings) settings = { ...settings, ...g.settings };
    scheduleScan();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (!contextValid()) return;
    if (area === 'local' && changes.settings) {
      settings = { ...settings, ...(changes.settings.newValue || {}) };
      document.querySelectorAll('.xvd-btn').forEach((b) => b.remove());
      scheduleScan();
    }
  });

  // --- tweet helpers -------------------------------------------------------

  function statusInfoFromArticle(article) {
    const links = article.querySelectorAll('a[href*="/status/"]');
    for (const a of links) {
      const m = (a.pathname || '').match(/^\/([^/]+)\/status\/(\d+)/);
      if (m && a.querySelector('time')) return { screenName: m[1], tweetId: m[2] };
    }
    for (const a of links) {
      const m = (a.pathname || '').match(/^\/([^/]+)\/status\/(\d+)/);
      if (m) return { screenName: m[1], tweetId: m[2] };
    }
    // Fallback: a tweet detail page.
    const p = window.location.pathname.match(/^\/([^/]+)\/status\/(\d+)/);
    return p ? { screenName: p[1], tweetId: p[2] } : null;
  }

  function toast(text, kind, action, extra = null) {
    const el = document.createElement('div');
    el.className = 'xvd-toast' + (kind ? ' xvd-toast--' + kind : '');
    el.setAttribute('role', 'status');
    let timerId = 0;
    let tickId = 0;
    let focusHandler = null;
    const dismiss = () => {
      if (timerId) clearTimeout(timerId);
      if (tickId) clearInterval(tickId);
      if (focusHandler) {
        window.removeEventListener('focus', focusHandler);
        document.removeEventListener('visibilitychange', focusHandler);
      }
      el.classList.remove('xvd-toast--in');
      setTimeout(() => el.remove(), 300);
    };

    if (extra && extra.onOpen) {
      const linkBtn = document.createElement('button');
      linkBtn.type = 'button';
      linkBtn.className = 'xvd-toast__link';
      linkBtn.textContent = text;
      linkBtn.title = t('toastDriveViewQueue');
      linkBtn.addEventListener('click', () => {
        dismiss();
        extra.onOpen();
      });
      el.appendChild(linkBtn);
    } else {
      const span = document.createElement('span');
      span.textContent = text;
      el.appendChild(span);
    }

    if (action) {
      const button = document.createElement('button');
      button.type = 'button';
      button.title = t('toastDownloadAgain');
      button.setAttribute('aria-label', t('toastDownloadAgain'));
      button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 4a8 8 0 1 0 8 8h-2a6 6 0 1 1-2-4.47L13 11h8V3l-3.57 3.57A7.97 7.97 0 0 0 12 4Z"/></svg>';
      button.addEventListener('click', () => {
        el.remove();
        action();
      }, { once: true });
      el.appendChild(button);
    }
    let timerEl = null;
    if (extra && extra.closable) {
      timerEl = document.createElement('span');
      timerEl.className = 'xvd-toast__timer';
      timerEl.textContent = '10s';
      el.appendChild(timerEl);

      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'xvd-toast__close';
      closeBtn.title = t('toastClose');
      closeBtn.setAttribute('aria-label', t('toastClose'));
      closeBtn.textContent = '×';
      closeBtn.addEventListener('click', dismiss, { once: true });
      el.appendChild(closeBtn);
    }
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add('xvd-toast--in'));
    const ttl = (action || (extra && extra.closable)) ? 10000 : 3200;
    const startCountdown = () => {
      if (timerId) return;
      let leftSec = Math.ceil(ttl / 1000);
      if (timerEl) {
        timerEl.textContent = `${leftSec}s`;
        tickId = setInterval(() => {
          leftSec = Math.max(0, leftSec - 1);
          if (timerEl) timerEl.textContent = `${leftSec}s`;
        }, 1000);
      }
      timerId = setTimeout(dismiss, ttl);
    };
    if (extra && extra.waitFocus && (!document.hasFocus() || document.visibilityState === 'hidden')) {
      focusHandler = () => {
        if (document.visibilityState === 'visible' && document.hasFocus()) {
          window.removeEventListener('focus', focusHandler);
          document.removeEventListener('visibilitychange', focusHandler);
          focusHandler = null;
          startCountdown();
        }
      };
      window.addEventListener('focus', focusHandler);
      document.addEventListener('visibilitychange', focusHandler);
    } else {
      startCountdown();
    }
  }

  async function requestDownload(info, choice, force = false, targetKind) {
    await mediaReady;
    const fresh = info.article ? articleMedia(info.article) : info;
    if (!fresh) return;
    const kinds = targetKind ? [targetKind]
      : fresh.kind === 'mixed' ? ['video', 'image'] : [fresh.kind];
    toast(t('toastPreparing'));
    const results = await Promise.all(kinds.map((kind) => new Promise((resolve) => {
      const msg = {
        type: 'xvd:download', force, kind,
        tweetId: info.tweetId,
        screenName: info.screenName,
        tweetUrl: `${origin}/${info.screenName}/status/${info.tweetId}`,
        text: info.text || '',
      };
      if (kind === 'image') {
        msg.images = fresh.images || [];
        msg.size = choice || 'orig';
      } else {
        msg.quality = choice || settings.defaultQuality;
        msg.record = mediaByTweet.get(info.tweetId) || null;
      }
      try {
        if (!contextValid()) return resolve({ ok: false });
        chrome.runtime.sendMessage(msg, (res) => {
          if (!contextValid()) return resolve({ ok: false });
          const error = chrome.runtime.lastError;
          resolve({ kind, res, error: error && error.message });
        });
      } catch (_) {
        resolve({ kind, error: t('toastFileFallback') });
      }
    })));
    const duplicates = [];
    let failed = false;
    const messages = results.map(({ kind, res, error }) => {
      if (error) {
        failed = true;
        return t('toastFailed', error);
      }
      if (res && res.duplicate) {
        duplicates.push(kind);
        return t('toastAlready', new Date(res.at).toLocaleDateString(uiLang()));
      }
      if (!res || !res.ok) {
        failed = true;
        return kind === 'image'
          ? (res && res.error ? t('toastNoImageError', res.error) : t('toastNoImage'))
          : (res && res.error ? t('toastNoVideoError', res.error) : t('toastNoVideo'));
      }
      return res.count > 1
        ? t('toastDownloadingImages', res.count, res.folder || t('optionsFolderDownloads'))
        : t('toastDownloading', res.label || '', res.filename || t('toastFileFallback'));
    });
    toast(messages.join(' · '), failed ? 'error' : duplicates.length ? '' : 'ok',
      duplicates.length ? () => {
        // Retry only skipped media, never a photo set already started successfully.
        requestDownload(info, choice, true, duplicates.length === 1 ? duplicates[0] : undefined);
      } : undefined);
  }

  function showDriveAuthModal(onConfirm) {
    document.getElementById('xvd-drive-modal')?.remove();
    const overlay = document.createElement('div');
    overlay.id = 'xvd-drive-modal';
    overlay.className = 'xvd-modal';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');

    const card = document.createElement('div');
    card.className = 'xvd-modal__card';

    const h = document.createElement('h3');
    h.className = 'xvd-modal__title';
    h.textContent = t('driveModalTitle');

    const p = document.createElement('p');
    p.className = 'xvd-modal__desc';
    p.textContent = t('driveModalDesc');

    const actions = document.createElement('div');
    actions.className = 'xvd-modal__actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'xvd-modal__btn';
    cancelBtn.textContent = t('driveModalCancel');

    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = 'xvd-modal__btn xvd-modal__btn--primary';
    okBtn.textContent = t('driveModalConfirm');

    const close = () => {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKey, true);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
    cancelBtn.addEventListener('click', close);
    okBtn.addEventListener('click', () => {
      close();
      onConfirm();
    });

    actions.appendChild(cancelBtn);
    actions.appendChild(okBtn);
    card.appendChild(h);
    card.appendChild(p);
    card.appendChild(actions);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    okBtn.focus();
  }

  async function requestDriveUpload(info, fresh, force = false, skipAuthPrompt = false) {
    await mediaReady;
    const snap = info.article ? articleMedia(info.article) : fresh;
    if (!snap) return;
    if (!skipAuthPrompt && contextValid()) {
      const auth = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'xvd:gdrive-check-auth' }, (r) => {
          resolve(r || { authorized: false });
        });
      });
      if (!auth.authorized) {
        showDriveAuthModal(() => requestDriveUpload(info, snap, force, true));
        return;
      }
    }
    const kinds = snap.kind === 'mixed' ? ['video', 'image'] : [snap.kind];
    toast(t('toastPreparing'));
    try {
      if (!contextValid()) return;
      const res = await new Promise((resolve) => {
        chrome.runtime.sendMessage(
          {
            type: 'xvd:gdrive-enqueue',
            force,
            kinds,
            tweetId: info.tweetId,
            screenName: info.screenName,
            tweetUrl: `${origin}/${info.screenName}/status/${info.tweetId}`,
            text: info.text || '',
            images: snap.images || [],
            quality: settings.defaultQuality,
            record: mediaByTweet.get(info.tweetId) || null,
          },
          (r) => {
            if (!contextValid()) return resolve(null);
            const error = chrome.runtime.lastError;
            resolve(error ? { ok: false, error: error.message } : r);
          },
        );
      });
      if (!res || !res.ok) {
        toast(t('toastFailed', (res && res.error) || t('popupUnknownError')), 'error');
        return;
      }
      const openQueue = () => chrome.runtime.sendMessage({ type: 'xvd:open-uploads', tweetId: info.tweetId });
      if (res.alreadyUploaded) {
        toast(
          t('toastDriveAlready'),
          '',
          () => requestDriveUpload(info, snap, true, true),
          { closable: true, onOpen: openQueue },
        );
        return;
      }
      if (res.awaitingAuth) {
        document.querySelectorAll('.xvd-toast').forEach((el) => el.remove());
        return;
      }
      document.querySelectorAll('.xvd-toast').forEach((el) => el.remove());
      toast(
        t('toastDriveQueued', res.count),
        'ok',
        undefined,
        { closable: true, onOpen: openQueue },
      );
    } catch (e) {
      toast(t('toastFailed', (e && e.message) || t('popupUnknownError')), 'error');
    }
  }

  // X's action bar often sits near the bottom of the viewport, where a menu
  // anchored below the button would be clipped. Flip above when there is no
  // room, and clamp to the viewport on both axes.
  function positionMenu(menu, anchor, point) {
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const box = anchor.getBoundingClientRect();
    let left = point ? point.x : box.left;
    let top = point ? point.y : box.bottom + 6;
    if (top + mh > vh - 8) {
      const above = (point ? point.y : box.top) - mh - 6;
      top = above >= 8 ? above : vh - mh - 8;
    }
    // Clamp both axes last. Flipping above is only better than overflowing if
    // the result is actually on screen.
    top = Math.min(Math.max(8, top), Math.max(8, vh - mh - 8));
    left = Math.min(Math.max(8, left), Math.max(8, vw - mw - 8));
    menu.style.top = `${window.scrollY + top}px`;
    menu.style.left = `${window.scrollX + left}px`;
  }

  // `point` = viewport coords to open at (right-click); omit to anchor on the
  // button (Alt-click, keyboard menu key).
  async function openQualityMenu(anchor, info, point, includeDrive = false) {
    await mediaReady;
    const fresh = info.article ? articleMedia(info.article) : info;
    if (!fresh) return;
    closeMenu();
    const menu = document.createElement('div');
    // Only one picker exists at a time (closeMenu runs first), so it can carry
    // an id -- that is what lets content.css win without !important.
    menu.id = 'xvd-menu';
    menu.className = 'xvd-menu';
    menu.setAttribute('role', 'menu');

    const isImage = fresh.kind === 'image';
    const title = document.createElement('div');
    title.className = 'xvd-menu__title';
    const rows = [];

    if (isImage) {
      const n = fresh.images.length;
      title.textContent = n > 1 ? t('menuDownloadImages', n) : t('menuDownloadImage');
      rows.push({ label: t('menuOriginal'), choice: 'orig' });
      rows.push({ label: t('menuLarge'), choice: 'large' });
      rows.push({ label: t('menuMedium'), choice: 'medium' });
    } else {
      title.textContent = t('menuDownloadVideo');
      const rec = mediaByTweet.get(info.tweetId);
      if (rec && rec.variants && rec.variants.length) {
        // parseVariants already returns these best-first.
        for (const v of rec.variants) {
          rows.push({
            label: v.height
              ? v.height + 'p'
              : t('popupVariantBitrate', Math.round(v.bitrate / 1000)),
            badge: v.height >= 2160 ? '4K' : v.height >= 1080 ? 'HD' : '',
            choice: String(v.height || 'highest'),
          });
        }
      } else {
        // No API capture yet - the worker will resolve via syndication.
        rows.push({ label: t('menuHighest'), choice: 'highest' });
        rows.push({ label: '720p', choice: '720' });
        rows.push({ label: '480p', choice: '480' });
        rows.push({ label: '360p', choice: '360' });
      }
    }
    const videoRowCount = rows.length;
    if (fresh.kind === 'mixed') {
      rows.push({
        label: fresh.images.length > 1 ? t('menuDownloadImages', fresh.images.length) : t('menuDownloadImage'),
        choice: 'orig', kind: 'image',
      });
    }
    menu.appendChild(title);

    // Tick whichever row a plain left-click would have downloaded, so the menu
    // doubles as an answer to "what am I getting by default?".
    const def = isImage ? 'orig' : settings.defaultQuality;
    let current = rows.findIndex((r) => r.choice === def);
    if (current < 0 && def === 'highest') current = 0;
    if (current < 0 && def === 'lowest') current = videoRowCount - 1;

    rows.forEach((r, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'xvd-menu__item';
      b.setAttribute('role', 'menuitem');

      const label = document.createElement('span');
      label.className = 'xvd-menu__label';
      label.textContent = r.label;
      b.appendChild(label);

      if (r.badge) {
        const badge = document.createElement('span');
        badge.className = 'xvd-menu__badge';
        badge.textContent = r.badge;
        b.appendChild(badge);
      }
      if (i === current) {
        const check = document.createElement('span');
        check.className = 'xvd-menu__check';
        check.textContent = '✓';
        b.appendChild(check);
      }

      b.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        closeMenu();
        requestDownload(info, r.choice, true, r.kind || (isImage ? 'image' : 'video'));
      });
      menu.appendChild(b);
    });

    if (includeDrive) {
      const sep = document.createElement('div');
      sep.className = 'xvd-menu__sep';
      menu.appendChild(sep);

      const driveBtn = document.createElement('button');
      driveBtn.type = 'button';
      driveBtn.className = 'xvd-menu__item';
      driveBtn.setAttribute('role', 'menuitem');
      const driveLabel = document.createElement('span');
      driveLabel.className = 'xvd-menu__label';
      driveLabel.textContent = t('menuUploadDrive');
      driveBtn.appendChild(driveLabel);
      driveBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        closeMenu();
        requestDriveUpload(info, fresh);
      });
      menu.appendChild(driveBtn);
    }

    document.body.appendChild(menu);
    positionMenu(menu, anchor, point);

    const onDocClick = (e) => {
      if (!menu.contains(e.target)) closeMenu();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') closeMenu();
    };
    const onScroll = () => closeMenu();
    menuCleanup = () => {
      document.removeEventListener('click', onDocClick, true);
      document.removeEventListener('contextmenu', onDocClick, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', onScroll, true);
    };
    // Deferred, or the very event that opened the menu would close it again.
    setTimeout(() => {
      document.addEventListener('click', onDocClick, true);
      document.addEventListener('contextmenu', onDocClick, true);
      document.addEventListener('keydown', onKey, true);
      window.addEventListener('scroll', onScroll, true);
    }, 0);
  }

  let menuCleanup = null;
  function closeMenu() {
    if (menuCleanup) {
      menuCleanup();
      menuCleanup = null;
    }
    document.querySelectorAll('.xvd-menu').forEach((m) => m.remove());
  }

  function makeButton(info) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'xvd-btn';
    // Icon-only: all wording lives in the tooltip, matching X's own icons.
    updateButton(btn, articleMedia(info.article));
    btn.setAttribute('aria-haspopup', 'menu');
    // Same anatomy X gives its own action buttons (bookmark / reply / like):
    // an unstyled <button>, a div carrying the colour, a positioning context,
    // an empty div that IS the hover disc, then the glyph. The disc is
    // absolutely positioned so it overflows the button, which keeps the
    // button's layout box the size of the ICON rather than the size of the
    // circle -- that is what makes the spacing in the action bar line up.
    btn.innerHTML =
      '<div class="xvd-btn__color">' +
      '<div class="xvd-btn__stack">' +
      '<div class="xvd-btn__disc"></div>' +
      '<svg viewBox="0 0 24 24" aria-hidden="true">' +
      '<path fill="currentColor" d="M12 2.25c.69 0 1.25.56 1.25 1.25v10.23l3.16-3.16a1.25 1.25 0 0 1 1.77 1.77l-5.29 5.3a1.25 1.25 0 0 1-1.78 0l-5.29-5.3a1.25 1.25 0 0 1 1.77-1.77l3.16 3.16V3.5c0-.69.56-1.25 1.25-1.25Z"/>' +
      '<path fill="currentColor" d="M3.6 19.35h16.8a1.2 1.2 0 0 1 0 2.4H3.6a1.2 1.2 0 0 1 0-2.4Z"/></svg>' +
      '</div></div>';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.altKey || !settings.clickDownloadsImmediately) openQualityMenu(btn, info);
      else requestDownload(info);
    });
    // Right-click opens the picker instead of the browser's own menu. The
    // keyboard context-menu key fires this same event with no useful
    // coordinates, so fall back to anchoring on the button in that case.
    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const point = e.clientX || e.clientY ? { x: e.clientX, y: e.clientY } : null;
      openQualityMenu(btn, info, point, true);
    });
    return btn;
  }

  // pbs.twimg.com/media/... = attached photos; .../card_img/... = the image on
  // a link-preview card. Both are downloadable; profile_images / emoji are not.
  const MEDIA_URL_RE = /pbs\.twimg\.com\/(media|card_img)\//;

  // Collect both media types, including when X mounts the video after photos.
  function articleMedia(article) {
    const hasVideo = !!article.querySelector(
      '[data-testid="videoPlayer"], [data-testid="videoComponent"], video, [data-testid="playButton"]',
    );
    const imgs = [];
    for (const img of article.querySelectorAll(
      '[data-testid="tweetPhoto"] img, a[href*="/photo/"] img, [data-testid^="card."] img',
    )) {
      // Video posters can use photo URLs and tweetPhoto wrappers too.
      if (img.closest('[data-testid="videoPlayer"], [data-testid="videoComponent"], video')) continue;
      const src = img.currentSrc || img.src || '';
      if (MEDIA_URL_RE.test(src) && !imgs.includes(src)) imgs.push(src);
    }
    const kind = mediaKind(hasVideo, imgs);
    return kind ? { kind, hasVideo, images: imgs } : null;
  }

  function tweetText(article) {
    const el = article.querySelector('[data-testid="tweetText"]');
    return el ? el.textContent.trim() : '';
  }

  function decorate(article) {
    if (!settings.showTimelineButton || !mediaKind) return;
    const existing = article.querySelector(':scope .xvd-btn');
    if (existing) {
      updateButton(existing, articleMedia(article));
      return;
    }
    const media = articleMedia(article);
    if (!media) return;
    const info = statusInfoFromArticle(article);
    if (!info) return;
    info.text = tweetText(article);
    info.article = article; // re-scanned at click time for freshly-loaded images
    const group = article.querySelector('[role="group"]');
    if (!group) return;
    // X wraps each action button in a flex-row layout div; match that so the
    // button sits in the bar the same way its neighbours do.
    const slot = document.createElement('div');
    slot.className = 'xvd-slot';
    slot.appendChild(makeButton(info));
    group.appendChild(slot);
  }

  function scan() {
    if (!contextValid()) return;
    document.querySelectorAll('article').forEach(decorate);
  }

  function updateButton(btn, media) {
    if (!media || btn.dataset.xvdKind === media.kind) return;
    btn.dataset.xvdKind = media.kind;
    const isImage = media.kind === 'image';
    btn.title = media.kind === 'mixed' ? t('tipDownloadMixed')
      : isImage ? t('tipDownloadImage') : t('tipDownloadVideo');
    const label = media.kind === 'mixed' ? t('ariaDownloadMixed')
      : isImage ? t('menuDownloadImage') : t('menuDownloadVideo');
    btn.setAttribute('aria-label', label);
  }

  function refreshButtons() {
    scheduleScan();
  }

  function scheduleScan() {
    if (!contextValid()) return;
    if (scanTimer) return;
    scanTimer = requestAnimationFrame(() => {
      scanTimer = 0;
      try {
        scan();
      } catch (_) {
        /* ignore */
      }
    });
  }

  mo = new MutationObserver(scheduleScan);
  function startObserver() {
    if (!contextValid()) return;
    if (!document.body) return void requestAnimationFrame(startObserver);
    mo.observe(document.body, { childList: true, subtree: true });
    scheduleScan();
  }
  startObserver();

  // --- popup / background queries ----------------------------------------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!contextValid() || !msg) return;
    if (msg.type === 'xvd:batch-start') {
      // Registered now, not after the import. return true holds the channel
      // open so a popup click during that fetch still gets start()'s answer.
      batchReady.then(
        (api) => sendResponse(api.start()),
        (err) => sendResponse({ ok: false, error: String((err && err.message) || err) }),
      );
      return true;
    }
    if (msg.type === 'xvd:page-context') {
      const p = window.location.pathname.match(/^\/([^/]+)\/status\/(\d+)/);
      let current = p ? { screenName: p[1], tweetId: p[2] } : null;
      if (!current) {
        const art = document.querySelector('article');
        if (art) current = statusInfoFromArticle(art);
      }
      const rec = current && mediaByTweet.get(current.tweetId);
      sendResponse({
        current,
        record: rec || null,
        captured: [...mediaByTweet.values()].slice(-20),
      });
      return true;
    }
    if (msg.type === 'xvd:toast') {
      toast(msg.text, msg.kind);
    }
    if (msg.type === 'xvd:drive-queued-toast') {
      document.querySelectorAll('.xvd-toast').forEach((el) => el.remove());
      toast(
        t('toastDriveQueued', msg.count || 1),
        'ok',
        undefined,
        {
          closable: true,
          waitFocus: true,
          onOpen: () => chrome.runtime.sendMessage({ type: 'xvd:open-uploads', tweetId: msg.tweetId || '' }),
        },
      );
    }
  });
})();
