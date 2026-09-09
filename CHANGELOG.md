# Changelog

## 1.0.0

Initial release — a full rewrite.

- Download videos and GIFs from X / Twitter (progressive MP4 renditions).
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
- Configurable filename template with tokens.
- No analytics or external servers.
