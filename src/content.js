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

  function requestDownload(info, choice) {
    const isImage = info.kind === 'image';
    toast('Preparing download…');
    const msg = {
      type: 'xvd:download',
      kind: info.kind || 'video',
      tweetId: info.tweetId,
      screenName: info.screenName,
      tweetUrl: `${origin}/${info.screenName}/status/${info.tweetId}`,
      text: info.text || '',
    };
    if (isImage) {
      // Re-scan now: X lazy-loads / upgrades <img> src after the button was drawn.
      const fresh = info.article ? articleMedia(info.article) : null;
      msg.images = (fresh && fresh.images) || info.images || [];
      msg.size = choice || 'orig';
    } else {
      msg.quality = choice || settings.defaultQuality;
      msg.record = mediaByTweet.get(info.tweetId) || null;
    }
    try {
      chrome.runtime.sendMessage(msg, (res) => {
        if (chrome.runtime.lastError) {
          toast('Download failed: ' + chrome.runtime.lastError.message, 'error');
          return;
        }
        if (!res || !res.ok) {
          toast(
            `Could not find a downloadable ${isImage ? 'image' : 'video'} for this tweet` +
              (res && res.error ? ` (${res.error})` : ''),
            'error',
          );
        } else if (res.count > 1) {
          toast(`Downloading ${res.count} images → ${res.folder || 'Downloads'}`, 'ok');
        } else {
          toast(`Downloading ${res.label || ''} → ${res.filename || 'file'}`, 'ok');
        }
      });
    } catch (_) {
      /* extension context invalidated (reloaded while page open) */
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
  function openQualityMenu(anchor, info, point) {
    closeMenu();
    const menu = document.createElement('div');
    menu.className = 'xvd-menu';
    menu.setAttribute('role', 'menu');

    const isImage = info.kind === 'image';
    const title = document.createElement('div');
    title.className = 'xvd-menu__title';
    const rows = [];

    if (isImage) {
      const fresh = info.article ? articleMedia(info.article) : null;
      const n = ((fresh && fresh.images) || []).length;
      title.textContent = n > 1 ? `Download ${n} images` : 'Download image';
      rows.push({ label: 'Original size', choice: 'orig' });
      rows.push({ label: 'Large', choice: 'large' });
      rows.push({ label: 'Medium', choice: 'medium' });
    } else {
      title.textContent = 'Download video';
      const rec = mediaByTweet.get(info.tweetId);
      if (rec && rec.variants && rec.variants.length) {
        // parseVariants already returns these best-first.
        for (const v of rec.variants) {
          rows.push({
            label: v.height ? v.height + 'p' : Math.round(v.bitrate / 1000) + 'kbps',
            badge: v.height >= 2160 ? '4K' : v.height >= 1080 ? 'HD' : '',
            choice: String(v.height || 'highest'),
          });
        }
      } else {
        // No API capture yet - the worker will resolve via syndication.
        rows.push({ label: 'Highest', choice: 'highest' });
        rows.push({ label: '720p', choice: '720' });
        rows.push({ label: '480p', choice: '480' });
        rows.push({ label: '360p', choice: '360' });
      }
    }
    menu.appendChild(title);

    // Tick whichever row a plain left-click would have downloaded, so the menu
    // doubles as an answer to "what am I getting by default?".
    const def = isImage ? 'orig' : settings.defaultQuality;
    let current = rows.findIndex((r) => r.choice === def);
    if (current < 0 && def === 'highest') current = 0;
    if (current < 0 && def === 'lowest') current = rows.length - 1;

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
        requestDownload(info, r.choice);
      });
      menu.appendChild(b);
    });

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
    const what = info.kind === 'image' ? 'image' : 'video';
    // Icon-only means the tooltip is the only place the interaction can be
    // explained, so it has to name both gestures.
    btn.title = `Download ${what} · right-click to pick quality`;
    btn.setAttribute('aria-label', `Download ${what}`);
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
      openQualityMenu(btn, info, point);
    });
    return btn;
  }

  // pbs.twimg.com/media/... = attached photos; .../card_img/... = the image on
  // a link-preview card. Both are downloadable; profile_images / emoji are not.
  const MEDIA_URL_RE = /pbs\.twimg\.com\/(media|card_img)\//;

  // Returns { kind:'video' } | { kind:'image', images:[url,...] } | null
  function articleMedia(article) {
    if (
      article.querySelector(
        '[data-testid="videoPlayer"], [data-testid="videoComponent"], video, [data-testid="playButton"]',
      )
    ) {
      return { kind: 'video' };
    }
    const imgs = [];
    for (const img of article.querySelectorAll(
      '[data-testid="tweetPhoto"] img, a[href*="/photo/"] img, [data-testid^="card."] img',
    )) {
      const src = img.currentSrc || img.src || '';
      if (MEDIA_URL_RE.test(src) && !imgs.includes(src)) imgs.push(src);
    }
    return imgs.length ? { kind: 'image', images: imgs } : null;
  }

  function tweetText(article) {
    const el = article.querySelector('[data-testid="tweetText"]');
    return el ? el.textContent.trim() : '';
  }

  function decorate(article) {
    if (!settings.showTimelineButton) return;
    if (article.querySelector(':scope .xvd-btn')) return;
    const media = articleMedia(article);
    if (!media) return;
    const info = statusInfoFromArticle(article);
    if (!info) return;
    info.kind = media.kind;
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
