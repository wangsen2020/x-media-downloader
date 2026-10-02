# 方案：界面国际化（1.5.0）

状态：已实施，于 1.5.0 交付（1.5.1 修复混合媒体帖）。中文界面已在真实浏览器验收；阿拉伯语和法语回退只经过单元测试和代码审查。

## 问题

`_locales/` 里只翻译了 `extName` 和 `extDesc`。popup、选项页、注入 X 页面的 tooltip / toast / 批量面板、
右键清晰度菜单全部是写死的英文。所以无论浏览器是什么语言，装上后界面都是英文。

## 目标

界面跟随浏览器 UI 语言（`chrome.i18n`）自动切换。没有对应语言时回退到英文（`default_locale: "en"`，这是 Chrome 的内置行为）。

支持的语言：`en`、`zh_CN`、`zh_TW`（新增）、`ja`、`ko`、`es`、`es_419`、`pt_BR`、`ar`。

## 实现要求

### 1. 公共 helper `src/lib/i18n.js`

- `t(key, ...subs)` 包装 `chrome.i18n.getMessage`。key 不存在时返回 key 本身，并 `console.warn`，避免界面上出现空白。
- `localize(root = document)` 处理以下属性：
  - `data-i18n` 写入 textContent
  - `data-i18n-title` 写入 title
  - `data-i18n-aria-label` 写入 aria-label
  - `data-i18n-placeholder` 写入 placeholder
- `uiLang()` 返回 `chrome.i18n.getUILanguage()`。所有日期和数字格式化都改用它，不再用 `undefined` 或系统 locale。

### 2. 各界面

- **popup / options 的 HTML**：所有可见文字、title、aria-label、placeholder 都改为 `data-i18n*` 属性。HTML 里保留英文作为兜底文字。
  页面加载时执行 `localize()`，设置 `<html lang>` 为 `uiLang()`，并设置 `dir="__MSG_@@bidi_dir__"`（用 `t('@@bidi_dir')` 设置），保证阿拉伯语从右到左显示。
  检查 CSS 里的 `left` / `right`、`margin-left` 等在 RTL 下是否错乱，优先改成逻辑属性（`inset-inline-start`、`margin-inline-start`）。
- **JS 动态生成的文字**：包括 popup.js、options.js、content.js、content-batch.js、background.js（如果有面向用户的文字），全部改用 `t()`。
  - content script 和动态 import 的 `content-batch.js` 都运行在隔离世界里，可以直接用 `chrome.i18n`。
  - `content.js` 不能有顶层 import（见 `test/content-script.test.js`）。可以在 content.js 里内联一个最小的 `t()`，也可以通过已有的动态 import 加载 i18n.js，任选其一。
- **注入 X 页面的部分**：tooltip 和 aria-label 要翻译。批量面板要跟随 **X 页面本身的方向**，不要因为扩展的语言是 ar 就把面板翻转。也就是说，面板只翻译文字，不设置 `dir`。
- **不翻译**：
  - 文件名模板 token（`{user}` `{date}` …）
  - 默认 subfolder `X Media Downloader/{user}`，因为这是磁盘路径，改了会破坏已有目录
  - 发送给 X 的参数，如 `media.js` 里 syndication 请求的 `lang=en`
  - console 日志

### 3. 文案

- key 用 camelCase，并按区域加前缀：`popup*`、`options*`、`toast*`、`batch*`、`menu*`、`tip*`。
  每条都要写 `description` 说明出现位置，供译者参考。
- 有数字的地方用 `placeholders`（`$COUNT$` 这种写法），**不要用字符串拼接**，因为不同语言的语序不同。
- Chrome i18n 不支持复数形式，所以文案要写成不依赖单复数的形式。例如用 "Downloaded: $1 / $2"，不要用 "1 file / 2 files"。
- 语气：简短、像 X 自己的界面。不写营销语，不用感叹号。

### 4. 测试（`test/i18n.test.js`）

1. 每个 locale 的 key 集合必须和 `en` 完全一致，不能多也不能少。
2. 每条 message 的 `$N` / `$NAME$` 占位符必须和 `en` 一致。
3. 源码里 `t('…')` 和 `data-i18n*="…"` 引用的 key 必须都在 `en` 里存在。反过来，`en` 里不能有未被使用的 key（`extName`、`extDesc` 除外）。
4. popup.html 和 options.html 中，凡是含有拉丁字母的文本节点或 title/aria-label/placeholder 属性，必须带对应的 `data-i18n*` 属性。用简单的正则扫描即可，不引入依赖。

## 分工

| 步骤 | 执行 | 内容 |
|---|---|---|
| 1 | Grok（原定 Codex，因订阅到期改派） | helper、改造所有界面、写 `en` 和 `zh_CN` 全量文案、RTL、测试；新增 `zh_TW` 目录，但只放 extName/extDesc 和 en 的 key 占位（第 2 步补全） |
| 2 | Grok | 依据 `en` + `description`，补全 `zh_TW`、`ja`、`ko`、`es`、`es_419`、`pt_BR`、`ar` 的全部 key；es 与 es_419 要有区分（如 es_419 用 "descargar video" 的拉美习惯用词，避免西班牙本土用语） |
| 3 | Claude | 代码审查、测试、真实浏览器里切换语言（`--lang=zh-CN`、`--lang=ar` 启动）截图验收 |

执行方只改代码、写测试、写 CHANGELOG，**不 commit、不 push、不发布**。

## 版本

`manifest.json` 和 `package.json` 都改为 1.5.0。CHANGELOG 写一条："The interface now follows your browser language (9 languages)."

## 验收标准

1. `npm run lint` 和 `npm test` 全部通过。
2. 浏览器语言设为中文时，popup、选项页、X 页面上的 tooltip / toast / 右键菜单 / 批量面板都显示中文，没有遗漏的英文。
3. 浏览器语言设为阿拉伯语时，popup 和选项页从右到左排版且不错位；X 页面上注入的元素位置不变。
4. 浏览器语言设为法语（没有对应 locale）时，回退到英文。
