# Changelog

## 1.3.0

- Serialize storage updates to prevent concurrent downloads from losing history;
  raise the default history limit to 3000.
- Detect completed media across posts and qualities, check for deleted files,
  and offer an icon-only Download again action. Quality picks and history
  re-downloads bypass duplicate checks. Downloaded records can be cleared separately.
- Support filename tokens in subfolders and default to `X Media Downloader/{user}`.
  Migrate the old default once while preserving custom folders; add a live folder preview.
- Add dependency-free Node tests for media identity, folder tokens, storage
  concurrency, and settings migration.

## 1.2.3

- Added Latin American Spanish (`es_419`) as its own locale, so the Chrome Web
  Store can carry a separate es-419 listing written with Latin American
  wording (video, celular, computadora) alongside the Spain Spanish one.

## 1.2.2

- **Fixed: videos in posts that re-use another post's video could not be
  downloaded.** When a post embeds a video originally uploaded elsewhere, X
  tags the media with `source_status_id_str` pointing at the original post.
  The capture hook preferred that id, so the variants were filed under the
  original post while the button asked for the one on screen — a cache miss
  that fell through to the public API and failed. Records are now filed under
  the post that shows the video.
- **Fixed: `{user}` in filenames was always `unknown` for captured videos.** X
  moved `screen_name` from `user.legacy` to `user.core`; both are now read.

## 1.2.1

- **Fixed: videos that played but could not be downloaded when a post was
  opened directly by its link.** The page-context hook was injected with a
  `<script src>` tag, and an external script still has to be fetched even with
  `async = false`. On a fresh page load X's bundle could issue its TweetDetail
  request inside that window, so the variants were never seen. Scrolling the
  timeline always worked because the hook was long since installed — which is
  why this looked random. The hook is now declared in `manifest.json` as a
  `world: "MAIN"` content script at `document_start`, which the browser
  guarantees to run before any page script. The tag is kept as a fallback and
  is idempotent.
- Download failures now say what actually went wrong instead of
  `no media found`: a post the public fallback cannot read (it returns a
  tombstone for anything restricted to signed-in viewers) is now distinguished
  from a video X only publishes as an HLS playlist, which cannot be saved as a
  single file.
- Declared `minimum_chrome_version: 116`, which the extension already required
  for `chrome.storage.session` and module service workers.

## 1.2.0

- **Right-click the timeline button to pick a quality.** Left-click downloads
  straight away at your default (`Highest` out of the box); right-click opens a
  picker at the cursor listing every rendition X actually served for that post,
  best first, with `4K` / `HD` tags and a tick on whichever one a plain
  left-click would have taken. Alt-click still works, and the keyboard
  context-menu key opens the same picker anchored on the button.
- The picker now stays on screen: it flips above the button when there is no
  room below and clamps to the viewport on both axes. X's action bar is often
  near the bottom of the window, where the old menu was simply clipped.
- Picker styling: a header naming the action, X's dark-theme card colours, and
  the same host-proof specificity as the button.
- Timeline button now mirrors the DOM anatomy X gives its own action buttons,
  not just their colours: a flex layout wrapper, an unstyled `<button>`, a div
  carrying the colour, and an **absolutely positioned empty div that is the
  hover disc**. Because the disc overflows the button instead of being its
  background, the button's own layout box is 18.75px — the size of the icon —
  rather than 34.75px. A button sized to the circle takes more room in the
  action bar than X's do, which pushed the icon out of line with its
  neighbours. Measured: all five icons now share a vertical centre.
- Timeline button matches X's own action buttons: the same 34.75px
  circular hit-area, the same 18.75px glyph, the same muted grey at rest, and
  the same X-blue icon over a 10%-blue disc on hover.
- Redrew the download glyph so it fills its 24×24 viewBox at the weight X uses.
  The old one sat in about 70% of its box with lighter strokes, which made an
  identically-sized button read as visibly smaller than its neighbours — the
  size numbers had been right all along, the drawing was not.
- Dropped the button's wrapper `<div>`; it is now a direct child of the action
  bar.
- Follow X's dim/dark themes with the lighter action-icon grey.
- Published to the Chrome Web Store: <https://chromewebstore.google.com/detail/x-twitter-video-downloade/honcfokhpcchcffjhaahkcjiifkidolm>
- README: store install instructions and promo art, and fixed the language list
  (Arabic replaced German back in 1.1.0; the docs still said Deutsch).

## 1.1.0

- Localized the extension name/description into 7 languages via `_locales/`:
  English (default), 简体中文, 日本語, Español, Português (Brasil), 한국어,
  العربية (Arabic). Chrome shows the right one automatically based on the browser's
  UI language; this is what the Chrome Web Store listing search/snippet uses
  too. Rest of the interface (popup/options) stays English for now.

## 1.0.0

Initial release — a full rewrite.

- Download videos and GIFs from X / Twitter (progressive MP4 renditions).
- Download images from photo posts **and link‑preview cards** — read from the
  tweet's `<img>` tags (`pbs.twimg.com/media` and `.../card_img`), upgraded to
  original resolution, correct `jpg`/`png` extension, multi‑image posts
  numbered `_1`…`_4`. Alt‑click offers Original/Large/Medium.
- Timeline download icon is icon-only and sized to match X's native
  action-bar icons; label text is in the tooltip.
- **Download history** on the options page: thumbnail, account, quality,
  size, date, state; search, filter, re‑download, “show file”, remove,
  export / import JSON.
- **Folder control**: configurable subfolder inside Downloads, or
  “Ask where to save every time” (native Save‑As dialog).
- **Quality selection**: default quality setting (Highest / 1080 / 720 / 480 /
  360 / Lowest, “closest below” target) plus a per‑download picker in the popup
  and the in‑timeline button.
- Media resolution: live API capture → session cache →
  `cdn.syndication.twimg.com` fallback.
- Configurable filename template with tokens. Default
  `{user}_{text}_{datetime}_{id}` — tweet author, first words of the tweet,
  the tweet's own post time (from the snowflake id) and its id, so every
  file is descriptive and collision-proof. No more `video.mp4` overwrites.
- No analytics or external servers.
