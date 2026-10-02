// Shared helpers for the service worker, popup and options page (ES module).

export const DEFAULT_FILENAME_TEMPLATE = '{user}_{text}_{datetime}_{id}';

export const QUALITY_OPTIONS = [
  { value: 'highest', label: 'Highest available' },
  { value: '1080', label: '1080p (or closest below)' },
  { value: '720', label: '720p (or closest below)' },
  { value: '480', label: '480p (or closest below)' },
  { value: '360', label: '360p (or closest below)' },
  { value: 'lowest', label: 'Lowest available' },
];

// A twimg progressive URL looks like:
//   https://video.twimg.com/ext_tw_video/123/pu/vid/avc1/1280x720/abcd.mp4?tag=12
//   https://video.twimg.com/amplify_video/123/vid/720x1280/abcd.mp4
export function heightFromUrl(url = '') {
  const m = url.match(/\/(\d+)x(\d+)\//);
  return m ? Number(m[2]) : 0;
}

// Identity ignores rendition and post ids because X can reuse the same media.
export function mediaKeyFromUrl(url) {
  try {
    const u = new URL(url);
    if (u.hostname === 'video.twimg.com') {
      const id = u.pathname.match(/\/(?:amplify_video|ext_tw_video|tweet_video)\/(\d+)\//);
      if (id) return `v:${id[1]}`;
      const gif = u.pathname.match(/^\/tweet_video\/([^/]+)\.mp4$/i);
      if (gif) return `v:${gif[1]}`;
    }
    if (u.hostname === 'pbs.twimg.com') {
      const image = u.pathname.match(/^\/(?:media|card_img)\/([^/]+)/);
      if (image) return `i:${image[1].replace(/\.(?:jpg|jpeg|png|gif|webp)(?::\w+)?$/i, '')}`;
    }
  } catch (_) {
    /* Unsupported URLs have no stable identity. */
  }
  return null;
}

// video_info.variants -> sorted (best first) list of progressive mp4 variants.
export function parseVariants(videoInfo) {
  const raw = (videoInfo && videoInfo.variants) || [];
  return raw
    .filter(
      (v) =>
        v &&
        v.url &&
        !/\.m3u8(\?|$)/i.test(v.url) &&
        (v.content_type === 'video/mp4' || /\.mp4(\?|$)/i.test(v.url)),
    )
    .map((v) => ({
      url: v.url,
      bitrate: Number(v.bitrate) || 0,
      height: heightFromUrl(v.url),
      contentType: v.content_type || 'video/mp4',
    }))
    .sort((a, b) => b.bitrate - a.bitrate || b.height - a.height);
}

// pref: 'highest' | 'lowest' | '<pixels>'
export function pickVariant(variants, pref = 'highest') {
  if (!variants || !variants.length) return null;
  if (pref === 'highest') return variants[0];
  if (pref === 'lowest') return variants[variants.length - 1];
  const target = Number(pref);
  if (!Number.isFinite(target) || target <= 0) return variants[0];
  const atOrBelow = variants.filter((v) => v.height && v.height <= target);
  if (atOrBelow.length) return atOrBelow[0]; // already sorted best-first
  // nothing at/below the target -> take the smallest we have
  return variants[variants.length - 1];
}

export function labelForVariant(v) {
  if (!v) return '';
  if (v.height) return `${v.height}p`;
  if (v.bitrate) return `${Math.round(v.bitrate / 1000)}kbps`;
  return 'video';
}

// --- filename building ---------------------------------------------------------

// Sanitise one path segment: drop filesystem-illegal characters, turn runs of
// punctuation/whitespace into single underscores, keep unicode letters/digits.
export function sanitizePart(s) {
  const cleaned = String(s == null ? '' : s)
    // Variation selectors are marks; format characters include zero-width joins.
    .replace(/[\p{Cf}\uFE00-\uFE0F\u200B-\u200D\u2060\uFEFF]/gu, '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ')
    .replace(/[^\p{L}\p{N}\p{M}._-]+/gu, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^[._\-\s]+|[._\-\s]+$/g, '')
    .slice(0, 120);
  return cleaned || 'x-video';
}

// X / Twitter snowflake ids encode their creation time (ms since this epoch).
const TWITTER_EPOCH_MS = 1288834974657;
export function tweetDateFromId(id) {
  try {
    const digits = String(id == null ? '' : id).replace(/\D/g, '');
    if (!digits) return null;
    const ms = Number((BigInt(digits) >> 22n) + BigInt(TWITTER_EPOCH_MS));
    // sanity: after Twitter launched, not absurdly in the future
    if (!Number.isFinite(ms) || ms < 1142899200000 || ms > Date.now() + 864e5) {
      return null;
    }
    return new Date(ms);
  } catch {
    return null;
  }
}

// First few meaningful words of the tweet text, for a human-readable slug.
export function textSlug(text, maxWords = 6, maxChars = 48) {
  const clean = String(text || '')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[\r\n]+/g, ' ')
    .replace(/[#@](\w)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return '';
  return clean.split(' ').slice(0, maxWords).join(' ').slice(0, maxChars).trim();
}

// pbs.twimg.com/media URLs carry a `?format=` and a `?name=` (size). Ask for
// the original pixels and remember the real extension.
export function bestImageUrl(url = '') {
  try {
    const u = new URL(url, 'https://pbs.twimg.com');
    if (u.searchParams.has('name')) u.searchParams.set('name', 'orig');
    else u.searchParams.append('name', 'orig');
    return u.toString();
  } catch {
    return url;
  }
}

export function imageExt(url = '') {
  const m = url.match(/[?&]format=(\w+)/i) || url.match(/\.(\w{3,4})(?:[?#]|$)/);
  const ext = (m && m[1] ? m[1] : 'jpg').toLowerCase();
  return ext === 'jpeg' ? 'jpg' : ext;
}

// ctx: { user, id, quality, height, bitrate, index, count, date, postDate, text, ext }
export function buildFilename(template, ctx, subfolder) {
  const pad = (n) => String(n).padStart(2, '0');
  // Prefer the tweet's own timestamp (explicit, or derived from the snowflake
  // id) so the same video always yields the same name across machines/re-runs.
  const postDate =
    (ctx.postDate && new Date(ctx.postDate)) ||
    tweetDateFromId(ctx.id) ||
    (ctx.date ? new Date(ctx.date) : new Date());
  const ymd = `${postDate.getFullYear()}${pad(postDate.getMonth() + 1)}${pad(
    postDate.getDate(),
  )}`;
  const hms = `${pad(postDate.getHours())}${pad(postDate.getMinutes())}${pad(
    postDate.getSeconds(),
  )}`;

  const tokens = {
    user: ctx.user || 'unknown',
    id: ctx.id || '0',
    quality: ctx.height ? `${ctx.height}p` : ctx.quality || 'video',
    height: ctx.height || '',
    bitrate: ctx.bitrate || '',
    index: ctx.count > 1 ? ctx.index + 1 : '',
    count: ctx.count || 1,
    date: `${postDate.getFullYear()}-${pad(postDate.getMonth() + 1)}-${pad(
      postDate.getDate(),
    )}`,
    time: hms,
    datetime: `${ymd}-${hms}`,
    text: textSlug(ctx.text),
  };

  const tpl = String(template || DEFAULT_FILENAME_TEMPLATE);
  const expand = (value) => String(value || '').replace(/\{(\w+)\}/g, (_, k) =>
    tokens[k] === undefined ? '' : String(tokens[k]),
  );
  let name = expand(tpl);
  // Multi-file tweet (e.g. 4 photos) but the template has no {index}: add one
  // so the files don't all land on the same name.
  if (ctx.count > 1 && !/\{index\}/.test(tpl)) {
    name += `_${(ctx.index || 0) + 1}`;
  }

  const splitClean = (str) =>
    String(str || '')
      .split('/')
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => sanitizePart(p));

  let nameParts = splitClean(name);
  // Guarantee uniqueness even if the template collapsed to nothing useful.
  const joined = nameParts.join('_');
  if (!nameParts.length || !/[0-9]/.test(joined) || joined === 'x-video') {
    nameParts = nameParts.concat(
      [tokens.user, tokens.datetime, String(tokens.id)].map(sanitizePart),
    );
  }
  name = nameParts.join('/');
  const ext = String(ctx.ext || 'mp4').replace(/^\.+/, '').toLowerCase() || 'mp4';
  name = name.replace(/\.(mp4|m4v|mov|jpg|jpeg|png|gif|webp)$/i, '') + '.' + ext;

  const folder = splitClean(expand(subfolder)).join('/');
  return folder ? `${folder}/${name}` : name;
}

// --- syndication fallback ----------------------------------------------------

// Public, unauthenticated endpoint used by embedded tweets. Needs a token that
// is a pure function of the tweet id (same algorithm react-tweet uses).
export function syndicationToken(id) {
  return ((Number(id) / 1e15) * Math.PI)
    .toString(6 ** 2)
    .replace(/(0+|\.)/g, '');
}

export function syndicationUrl(id) {
  return `https://cdn.syndication.twimg.com/tweet-result?id=${encodeURIComponent(
    id,
  )}&token=${syndicationToken(id)}&lang=en`;
}

// Normalise a syndication tweet-result payload into our media records.
export function parseSyndicationResponse(json, wantId) {
  if (!json || typeof json !== 'object') return [];
  const id = json.id_str || json.rest_id || wantId;
  const user = json.user && (json.user.screen_name || json.user.name);
  const details = []
    .concat(json.mediaDetails || [])
    .concat(json.video ? [json.video] : []);
  const out = [];
  for (const md of details) {
    const videoInfo = md.video_info || (md.type ? md : null);
    if (!videoInfo || !videoInfo.variants) continue;
    const variants = parseVariants(videoInfo);
    if (!variants.length) continue;
    out.push({
      tweetId: String(id),
      screenName: user || 'unknown',
      type: md.type === 'animated_gif' ? 'gif' : 'video',
      poster: md.media_url_https || md.poster || '',
      text: (json.text || '').trim(),
      postDate: json.created_at ? Date.parse(json.created_at) || 0 : 0,
      durationMs: videoInfo.duration_millis || 0,
      variants,
      capturedAt: Date.now(),
      source: 'syndication',
    });
  }
  return out;
}

// The DOM may gain a video after its photos; classify each fresh snapshot.
export function mediaKind(hasVideo, images = []) {
  return hasVideo ? (images.length ? 'mixed' : 'video') : images.length ? 'image' : null;
}
