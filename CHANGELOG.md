# Changelog

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
- Timeline button now matches X's own action buttons exactly: the same 34.75px
  circular hit-area, the same 18.75px glyph, the same muted grey at rest, and
  the same X-blue icon over a 10%-blue disc on hover.
- Redrew the download glyph so it fills its 24×24 viewBox at the weight X uses.
  The old one sat in about 70% of its box with lighter strokes, which made an
  identically-sized button read as visibly smaller than its neighbours — the
  size numbers had been right all along, the drawing was not.
- Dropped the button's wrapper `<div>`; it is now a direct child of the action
  bar.
- Hardened the styles against the host page. `!important` on its own is not
  enough: when two author-origin `!important` declarations collide the more
  specific selector wins, so a rule like `button.xvd-btn:hover` (0,2,1) in X's
  stylesheet beats `.xvd-btn:hover` (0,2,0). The class is repeated to reach
  (0,3,1), sizes are pinned, and `::before` / `::after` are shut off so nothing
  can draw a second disc behind the icon. Verified by injecting both attacks
  and reading computed styles with `:hover` force-enabled.
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
