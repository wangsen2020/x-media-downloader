# 方案：重复检测 · 按作者归档 · Media 页批量下载

状态：已批准，待实施。分两个版本交付：**1.3.0**（阶段 A）和 **1.4.0**（阶段 B）。
阶段 B 依赖阶段 A，必须等 A 验收合并后才能开始。

## 背景

竞品对比（Plucker XBD，约 3 万用户）后决定只补以下三项：批量下载、重复检测、按作者分目录。
预览侧边栏**不做**，因为 Media 页本身就是预览墙。
我们的定位不变：快、准、安静，图标原生，开源且无追踪。所有新增 UI 都要服从这个定位。

## 全局约束（两个阶段都适用）

- 纯 ES module，无构建步骤、无依赖。`npm run lint` 必须通过。
- **CSS 不写 `!important`**，用作用域选择器提高特异性（见 `src/content.css` 头部注释）。
- 注入 X 页面的按钮**只放图标**，文字放在 `title` / `aria-label` 里。状态文本（进度数字）可以显示。
- **插件自己不调用 X 的任何 API**。不构造、不重放 GraphQL 请求，数据只从 X 自己发出的请求里被动收集（`src/injected.js` 的 fetch/XHR 钩子）。
- 不新增权限，除非方案里写明。
- 每个阶段结束都 bump 版本号（`manifest.json` 和 `package.json`），并写 `CHANGELOG.md`。
- 代码注释风格和现有代码一致：英文，解释"为什么"。

---

## 阶段 A — 1.3.0：存储加锁 · 重复检测 · 目录变量

### A1. 存储写入串行化（先做，其余功能都依赖它）

问题：`src/lib/store.js` 的 `addHistoryEntry` 和 `updateHistoryEntry` 都是先读整个列表、改完再整个写回，没有锁。
多个下载同时进行、`downloads.onChanged` 连续触发时，会互相覆盖，导致记录丢失。

- 在 `store.js` 里实现一个模块级的 promise 队列 `withLock(fn)`。所有对 `history`、`settings` 和新增 `downloaded` 索引的"读-改-写"操作都经过它。
- 只读的 getter 不用加锁。
- 验收：写一个测试，用内存版的 `chrome.storage.local` 模拟，并发调用 50 次 `addHistoryEntry` 后必须得到 50 条记录。

### A2. 历史上限

- `maxHistory` 从 500 提高到 **3000**。每条约 600 字节，约 2 MB，在 `storage.local` 的 10 MB 限额内。

### A3. 重复检测

**媒体身份键**，与帖子 ID 无关，因为同一个视频可能被多个帖子复用：

- 视频 / GIF：从变体 URL 提取，`/(amplify_video|ext_tw_video|tweet_video)/(\d+)/` 得到 `v:<id>`。GIF（`tweet_video/<name>.mp4`）没有数字 ID，用文件名得到 `v:<name>`。
- 图片：`pbs.twimg.com/(media|card_img)/<name>` 得到 `i:<name>`（不含查询参数）。
- 写成 `src/lib/media.js` 里的纯函数 `mediaKeyFromUrl(url)`，并写单元测试。

**索引**：`chrome.storage.local` 键 `downloaded`，结构为 `{ [mediaKey]: { at, filename, downloadId, quality } }`。

- 只在下载**完成**（`downloads.onChanged` 状态变为 `complete`）时写入，开始时不写。
- 最多保留 20000 条，超出时按 `at` 淘汰最旧的。
- 不随"清空历史"一起清空。选项页"清空历史"旁边加一个独立的"清除已下载记录"按钮。

**命中后的行为**：

| 入口 | 命中重复时 |
|---|---|
| 左键单击下载 | **不下载**。toast 显示 "Already downloaded · {日期}"，并带一个 **Download again** 操作，点了再下。 |
| 右键菜单选某个清晰度 | **照常下载**，因为这是明确的意图。 |
| 历史页"重新下载" | **照常下载**（`force: true`）。 |
| 批量下载（阶段 B） | **静默跳过**，计入"跳过"数。 |

- 文件被用户删除的情况：命中时如果有 `downloadId`，用 `chrome.downloads.search({id})` 检查 `exists`。文件已经不存在就视为未下载。
- 消息协议：`xvd:download` 增加可选字段 `force: boolean`。命中重复时返回 `{ ok: false, duplicate: true, at, filename }`。

### A4. 目录变量 + 默认按作者归档

- `buildFilename` 里的 subfolder 也做 token 替换，和文件名模板用同一套 token（`{user}` `{date}` 等），替换后再按 `/` 拆分并清洗。
- 默认 `subfolder` 改为 **`X Media Downloader/{user}`**。
- 迁移：老用户已保存的 `subfolder` 如果**恰好等于**旧默认值 `X Media Downloader`，一次性升级为新默认值。用 `settings.schemaVersion` 标记，避免重复迁移。用户自定义过的值不动。
- 选项页 subfolder 的说明文字补上可用 token 列表，并加上与文件名一致的实时预览。

### A 的验收标准（由 Claude 复核）

1. `npm run lint` 通过。新增 `npm test`（`node --test`），覆盖以下内容并全部通过：`mediaKeyFromUrl`、带 token 的 subfolder、`withLock` 并发、迁移逻辑。
2. 真实浏览器中：同一个视频左键点两次，第二次出现 "Already downloaded" toast，不产生 `(1)` 副本；点 Download again 能下载；右键选清晰度能直接下载。
3. 新文件落在 `Downloads/X Media Downloader/<作者>/`。
4. 删掉已下载的文件后再点，能正常重新下载。

---

## 阶段 B — 1.4.0：Media 页批量下载

### B1. 入口

- **只在作者主页的 Media 标签页**（`x.com/<user>/media`）可用。其他页面不提供批量入口。
- 入口放在 **popup**：当前标签页匹配 `^/([A-Za-z0-9_]{1,15})/media/?$` 时，显示按钮 "Download all media from @user"，否则不显示。页面里不注入入口按钮，因为 X 的主页头部 DOM 经常变，放在 popup 里更稳。
- popup 发消息给该标签页的 content script，由 content script 启动批量控制器。

### B2. 数据收集

- `injected.js` 现在只收集视频。需要扩展为也收集**图片**：`media.type === 'photo'` 时发出 `{ tweetId, screenName, type: 'photo', images: [media_url_https...], postDate, text }`。
- 这类记录**不能**进入现有的视频缓存（`background.js` 的 `cacheRecords` 已经要求有 `variants`，要确认没有被破坏）。content.js 里用单独的 `photosByTweet` Map 存放，不要覆盖 `mediaByTweet`，因为混合媒体帖子会同时有视频和图片。
- 批量控制器只收 `screenName` 与主页用户名一致（忽略大小写）的记录。
- 启动前页面已经捕获到的记录也要计入。

### B3. 自动滚动（节奏模仿真人）

- 每次 `window.scrollBy(0, innerHeight * 0.9)`，间隔 **2–4 秒随机**；每滚约 20 屏，额外停 **10–20 秒**。
- 结束条件：已经到达页面底部，且**连续 3 次**滚动没有新记录，判定为收集完毕。
- `document.hidden` 时暂停滚动（后台标签页 X 本来也不会加载），但已收集到的文件继续下载。
- **单次上限 500 个文件**，达到后停止收集，面板提示"继续下一批"。下一批从上次的位置继续，跳过已下载的内容。

### B4. 限流检测

- `injected.js` 钩子在 GraphQL 响应状态为 **429**，或响应体中 `errors[].code === 88` 时，post 一条 `{ __src:'xvd', kind:'ratelimit' }`。
- 批量控制器收到后**立即暂停滚动**，面板显示 "X is limiting requests — paused"，由用户手动继续。**不自动重试**。

### B5. 下载队列

- 队列放在 **content script**（批量控制器）里，不放在 service worker 里，因为 SW 可能随时被回收。
- **同时最多 3 个**下载，每个开始之间间隔 **300–800ms 随机**。
- 完成通知：`background.js` 在 `downloads.onChanged` 变为 `complete` 或 `interrupted` 时，用 `chrome.tabs.sendMessage` 通知发起下载的标签页 `{ type:'xvd:download-done', downloadId, state, error }`。发起方的 `tabId` 在收到 `xvd:download` 时从 `sender.tab.id` 记下，存在 `chrome.storage.session` 里，这样 SW 重启后仍能找到。
- 失败时：因网络或服务器错误中断的，退避 **5 秒 / 15 秒**各重试一次；仍然失败就在历史里标为 interrupted，计入"失败"数。
- 每个文件先走重复检测，命中的就跳过。
- 批量请求带 `batchId`，写进每条历史记录。

### B6. 页面内进度面板

- 固定在视口顶部居中的小卡片，样式对齐 X（圆角、阴影，适配深浅色）。选择器限定在 `#xvd-batch` 下，不写 `!important`。
- 内容：`已下载 37 / 120 · 跳过 5 · 失败 0`，加一个进度条。
- 控制按钮**只用图标**：暂停/继续、停止，文字放在 `title` 里。
- 完成后变为：`完成 115 个文件`，并提供两个链接 **View in history**（打开 `options.html#batch=<batchId>`，历史页按该批次筛选）和 **Open folder**（`chrome.downloads.show` 最后一个文件）。**不自动打开任何页面。**
- 扩展图标角标（`chrome.action.setBadgeText`，按 tabId 设置）显示剩余数量，完成后清除。

### B7. 选项页

- 历史页支持 `#batch=<id>` 筛选，顶部显示 "Showing batch from {时间} · Clear filter"。

### B 的验收标准（由 Claude 复核）

1. `npm run lint` 和 `npm test` 通过。新增的纯逻辑（节奏/抖动计算、结束判定、限流判定、身份键）都要有测试。
2. 在一个媒体数量不多（< 60）的真实账号 Media 页上跑完整流程：数量正确，全部落在 `<作者>/` 目录下，第二次运行全部跳过。
3. 滚动间隔实测落在 2–4 秒区间，并发不超过 3。
4. 模拟 429（在页面里伪造响应）时立即暂停。
5. 暂停、继续、停止都生效，切到后台标签页后下载继续。
6. 单帖左键下载和右键菜单行为不受影响（回归测试）。

---

## 分工

| 阶段 | 执行 | 复核验收 |
|---|---|---|
| A — 1.3.0 | Codex | Claude：代码审查 + 测试 + 真实浏览器验证 |
| B — 1.4.0 | Grok | Claude：同上 |

执行方只改代码、写测试、写 CHANGELOG，**不 commit、不 push、不发布**。复核通过后由 Claude 提交。
