# Changelog

## 1.1.1

- Timeline button: redrew the download glyph so it fills its 24×24 box the way
  X's own action icons do, and nudged the rendered size from 18.75px to
  20.25px. The old glyph sat in ~70% of its box, which made an
  identically-sized button read as smaller than the icons beside it.
- Timeline button is now X blue (`#1d9bf0`) at rest instead of the muted grey
  of the native icons — it is the one control on that bar that isn't X's, so it
  should be findable at a glance.
- Dropped the button's wrapper `<div>`, its circular hit-area and the hover
  pill. The glyph is now the whole control: a bare blue icon in the action bar,
  with no background in any state. The circle made an injected control look
  heavier than X's own icons — the opposite of the intent.
- Every one of those declarations is now `!important` and spelled out for
  `:hover`, `:focus`, `:focus-visible` and `:active`. This markup lives inside
  X's page, so a single rule in their stylesheet matching `button` could
  otherwise paint the background back and it would read as a bug here.
  Verified against a rule deliberately trying to do exactly that.
- Published to the Chrome Web Store: <https://chromewebstore.google.com/detail/x-twitter-video-downloade/honcfokhpcchcffjhaahkcjiifkidolm>
- README: store install instructions, and fixed the language list (Arabic
  replaced German back in 1.1.0; the docs still said Deutsch).

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
