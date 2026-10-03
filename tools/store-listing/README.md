# Chrome Web Store listing

- `desc_<locale>.txt` — the store **description** per language, as submitted. The title and
  summary come from `_locales/*/messages.json` (`extName`, `extDesc`), not from here.
- `screenshots/global_{1,2,3}.jpg` — the default screenshots (1280x800).

Per-language screenshots override the global ones completely, so each language's set is:
its poster from `tools/poster` (`out/<locale>_landscape.png`) first, then `global_1..3`.
