// Content script (isolated world). Bridges the page hook to the service worker
// and adds a download button to every video in the timeline.
(function () {
  'use strict';

  const origin = window.location.origin;

  // 1. Inject the page-context hook as early as possible.
  try {
    const s = document.createElement('script');
    s.src = chrome.runtime.getURL('src/injected.js');
    s.async = false;
    (document.head || document.documentElement).appendChild(s);
    s.onload = () => s.remove();
  } catch (_) {
    /* ignore */
  }

  // tweetId -> record captured from the API
  const mediaByTweet = new Map();

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || ev.origin !== origin) return;
    const data = ev.data;
    if (!data || data.__src !== 'xvd' || data.kind !== 'media') return;
    for (const rec of data.records || []) {
      if (!rec || !rec.tweetId) continue;
      mediaByTweet.set(rec.tweetId, rec);
    }
    try {
      chrome.runtime.sendMessage({ type: 'xvd:media', records: data.records });
    } catch (_) {
      /* service worker asleep is fine, it also listens itself */
    }
    // A late capture might belong to a button we already drew.
    refreshButtons();
  });

  // --- settings (kept in sync) ------------------------------------------------
  let settings = {
    showTimelineButton: true,
    clickDownloadsImmediately: true,
    defaultQuality: 'highest',
  };
  chrome.storage.local.get('settings').then((g) => {
    if (g.settings) settings = { ...settings, ...g.settings };
    scheduleScan();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
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

  function toast(text, kind) {
    const el = document.createElement('div');
    el.className = 'xvd-toast' + (kind ? ' xvd-toast--' + kind : '');
    el.textContent = text;
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add('xvd-toast--in'));
    setTimeout(() => {
      el.classList.remove('xvd-toast--in');
      setTimeout(() => el.remove(), 300);
    }, 3200);
  }

  function requestDownload(info, quality) {
    toast('Preparing download…');
    chrome.runtime.sendMessage(
      {
        type: 'xvd:download',
        tweetId: info.tweetId,
        screenName: info.screenName,
        tweetUrl: `${origin}/${info.screenName}/status/${info.tweetId}`,
        quality: quality || settings.defaultQuality,
        record: mediaByTweet.get(info.tweetId) || null,
      },
      (res) => {
        if (chrome.runtime.lastError) {
          toast('Download failed: ' + chrome.runtime.lastError.message, 'error');
          return;
        }
        if (!res || !res.ok) {
          toast('Could not find a downloadable video for this tweet' + (res && res.error ? ` (${res.error})` : ''), 'error');
        } else {
          toast(`Downloading ${res.label || ''} → ${res.filename || 'file'}`, 'ok');
        }
      },
    );
  }

  function openQualityMenu(anchor, info) {
    closeMenu();
    const rec = mediaByTweet.get(info.tweetId);
    const menu = document.createElement('div');
    menu.className = 'xvd-menu';
    const rows = [];
    if (rec && rec.variants && rec.variants.length) {
      for (const v of rec.variants) {
        rows.push({ label: (v.height ? v.height + 'p' : Math.round(v.bitrate / 1000) + 'kbps'), quality: String(v.height || 'highest') });
      }
    } else {
      rows.push({ label: 'Highest', quality: 'highest' });
      rows.push({ label: '720p', quality: '720' });
      rows.push({ label: '480p', quality: '480' });
      rows.push({ label: '360p', quality: '360' });
    }
    for (const r of rows) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'xvd-menu__item';
      b.textContent = r.label;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        closeMenu();
        requestDownload(info, r.quality);
      });
      menu.appendChild(b);
    }
    document.body.appendChild(menu);
    const box = anchor.getBoundingClientRect();
    menu.style.top = `${window.scrollY + box.bottom + 6}px`;
    menu.style.left = `${window.scrollX + box.left}px`;
    setTimeout(() => document.addEventListener('click', closeMenu, { once: true }), 0);
  }

  function closeMenu() {
    document.querySelectorAll('.xvd-menu').forEach((m) => m.remove());
  }

  function makeButton(info) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'xvd-btn';
    btn.title = 'Download video (Alt-click for quality menu)';
    btn.innerHTML =
      '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">' +
      '<path fill="currentColor" d="M12 3a1 1 0 0 1 1 1v9.59l3.3-3.3a1 1 0 1 1 1.4 1.42l-5 5a1 1 0 0 1-1.4 0l-5-5a1 1 0 1 1 1.4-1.42l3.3 3.3V4a1 1 0 0 1 1-1Z"/>' +
      '<path fill="currentColor" d="M5 19a1 1 0 0 1 1-1h12a1 1 0 1 1 0 2H6a1 1 0 0 1-1-1Z"/></svg>' +
      '<span class="xvd-btn__label">Download</span>';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.altKey || !settings.clickDownloadsImmediately) openQualityMenu(btn, info);
      else requestDownload(info);
    });
    return btn;
  }

  function articleHasVideo(article) {
    return !!article.querySelector(
      '[data-testid="videoPlayer"], [data-testid="videoComponent"], video, [data-testid="playButton"]',
    );
  }

  function decorate(article) {
    if (!settings.showTimelineButton) return;
    if (article.querySelector(':scope .xvd-btn')) return;
    if (!articleHasVideo(article)) return;
    const info = statusInfoFromArticle(article);
    if (!info) return;
    const group = article.querySelector('[role="group"]');
    if (!group) return;
    const holder = document.createElement('div');
    holder.className = 'xvd-slot';
    holder.appendChild(makeButton(info));
    group.appendChild(holder);
  }

  function scan() {
    document.querySelectorAll('article').forEach(decorate);
  }

  function refreshButtons() {
    // Enable quality menus that now have data; nothing else to do.
  }

  let scanTimer = 0;
  function scheduleScan() {
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

  const mo = new MutationObserver(scheduleScan);
  function startObserver() {
    if (!document.body) return void requestAnimationFrame(startObserver);
    mo.observe(document.body, { childList: true, subtree: true });
    scheduleScan();
  }
  startObserver();

  // --- popup / background queries ----------------------------------------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg) return;
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
  });
})();
