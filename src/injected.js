// Runs in the PAGE context (not the content-script sandbox).
// Hooks fetch + XHR so we can read X's own API responses and harvest any
// video_info.variants they contain. Nothing is sent anywhere except a
// window.postMessage back to our content script.
(function () {
  'use strict';
  if (window.__xvdInjected) return;
  window.__xvdInjected = true;

  const TAG = 'xvd';
  const API_HINT = /\/(graphql|2\/timeline|1\.1\/(statuses|guide|search)|i\/api)\//i;

  function post(records) {
    if (!records || !records.length) return;
    try {
      window.postMessage({ __src: TAG, kind: 'media', records }, window.location.origin);
    } catch (_) {
      /* ignore */
    }
  }

  function heightFromUrl(url = '') {
    const m = url.match(/\/(\d+)x(\d+)\//);
    return m ? Number(m[2]) : 0;
  }

  function variantsOf(videoInfo) {
    return (videoInfo.variants || [])
      .filter((v) => v && v.url && v.content_type === 'video/mp4')
      .map((v) => ({ url: v.url, bitrate: Number(v.bitrate) || 0, height: heightFromUrl(v.url) }))
      .sort((a, b) => b.bitrate - a.bitrate || b.height - a.height);
  }

  // Walk an arbitrary JSON tree, collecting tweet-like nodes that carry media.
  function scan(root) {
    const out = [];
    const seenTweets = new Set();
    const stack = [{ node: root, tweetId: null, screen: null, text: null, created: 0 }];
    let budget = 60000;

    while (stack.length && budget-- > 0) {
      const { node, tweetId, screen, text, created } = stack.pop();
      if (!node || typeof node !== 'object') continue;

      let curId = tweetId;
      let curScreen = screen;
      let curText = text;
      let curCreated = created;

      // Recognise a legacy tweet object.
      const legacy = node.legacy && typeof node.legacy === 'object' ? node.legacy : node;
      if (legacy) {
        if (legacy.id_str && /^\d+$/.test(legacy.id_str)) curId = legacy.id_str;
        else if (legacy.conversation_id_str) curId = curId || legacy.conversation_id_str;
        if (typeof legacy.full_text === 'string') curText = legacy.full_text;
        if (typeof legacy.created_at === 'string') {
          const t = Date.parse(legacy.created_at);
          if (t) curCreated = t;
        }
      }
      if (node.rest_id && /^\d+$/.test(node.rest_id)) curId = node.rest_id || curId;

      const userLegacy =
        (node.core && node.core.user_results && node.core.user_results.result &&
          node.core.user_results.result.legacy) ||
        (node.user && node.user.legacy) ||
        (node.user_results && node.user_results.result && node.user_results.result.legacy);
      if (userLegacy && userLegacy.screen_name) curScreen = userLegacy.screen_name;

      // Media containers.
      const mediaLists = [];
      if (legacy && legacy.extended_entities && Array.isArray(legacy.extended_entities.media))
        mediaLists.push(legacy.extended_entities.media);
      if (legacy && legacy.entities && Array.isArray(legacy.entities.media))
        mediaLists.push(legacy.entities.media);

      for (const list of mediaLists) {
        for (const media of list) {
          if (!media || !media.video_info || !media.video_info.variants) continue;
          const id =
            (media.source_status_id_str) ||
            curId ||
            (media.expanded_url && (media.expanded_url.match(/status\/(\d+)/) || [])[1]);
          if (!id) continue;
          const variants = variantsOf(media.video_info);
          if (!variants.length) continue;
          const dedupe = id + ':' + variants[0].url;
          if (seenTweets.has(dedupe)) continue;
          seenTweets.add(dedupe);
          out.push({
            tweetId: String(id),
            screenName: curScreen || 'unknown',
            type: media.type === 'animated_gif' ? 'gif' : 'video',
            poster: media.media_url_https || '',
            text: (curText || '').trim(),
            postDate: curCreated || 0,
            durationMs: media.video_info.duration_millis || 0,
            variants,
            capturedAt: Date.now(),
            source: 'api',
          });
        }
      }

      for (const k in node) {
        const v = node[k];
        if (v && typeof v === 'object') {
          stack.push({
            node: v,
            tweetId: curId,
            screen: curScreen,
            text: curText,
            created: curCreated,
          });
        }
      }
    }
    return out;
  }

  function handleText(url, text) {
    if (!text || text.length < 20) return;
    if (!API_HINT.test(url) && text.indexOf('video_info') === -1) return;
    if (text.indexOf('video_info') === -1) return;
    let json;
    try {
      json = JSON.parse(text);
    } catch (_) {
      return;
    }
    try {
      post(scan(json));
    } catch (_) {
      /* ignore */
    }
  }

  // --- fetch ---------------------------------------------------------------
  const origFetch = window.fetch;
  window.fetch = function (...args) {
    return origFetch.apply(this, args).then((res) => {
      try {
        const url = (res && res.url) || (typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url)) || '';
        if (res && res.clone && (API_HINT.test(url) || url.indexOf('graphql') !== -1)) {
          res
            .clone()
            .text()
            .then((t) => handleText(url, t))
            .catch(() => {});
        }
      } catch (_) {
        /* ignore */
      }
      return res;
    });
  };

  // --- XHR ---------------------------------------------------------------
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__xvdUrl = url;
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    this.addEventListener('load', () => {
      try {
        const url = this.__xvdUrl || this.responseURL || '';
        const type = this.responseType;
        if (type === '' || type === 'text') handleText(url, this.responseText);
        else if (type === 'json' && this.response) handleText(url, JSON.stringify(this.response));
      } catch (_) {
        /* ignore */
      }
    });
    return origSend.apply(this, arguments);
  };
})();
