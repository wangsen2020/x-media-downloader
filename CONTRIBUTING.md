# Contributing

Thanks for helping out!

## Local setup

No build step. Clone, then load the folder as an unpacked extension
(`chrome://extensions` → Developer mode → Load unpacked). After editing, hit
**Reload** on the extension card. Reload the X tab too when changing
`content.js` / `injected.js`.

```bash
npm run lint    # syntax-check the worker/content/injected scripts
npm run icons   # regenerate icons/*.png
npm run zip     # build a store-ready zip
```

## Guidelines

- Keep it dependency‑free and MV3‑compliant.
- Match the existing style: small modules, plain DOM, no framework.
- The page hook (`injected.js`) must stay defensive — X changes its API shapes
  often. Prefer additive parsing (deep scan for `video_info.variants`) over
  hard‑coded query IDs.
- Don't add analytics, remote config, or new host permissions without a strong
  reason.
- Update `CHANGELOG.md` for user‑visible changes.

## Reporting bugs

Include your browser + version, whether the video was in the timeline or on a
tweet page, and any console errors from the service worker
(`chrome://extensions` → *Service worker* → Inspect).
