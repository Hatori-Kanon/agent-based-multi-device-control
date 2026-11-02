# ui-v8：单列会话流与正文修复（2026-11）

> 触发：
> 1. 用户截图显示回合正文是 `,"line":"…"}` 的 JSON 残片、`\n` 字面量、前三回合重复；
> 2. 要求整个会话做成从上到下的一列、可滚动、新消息在最下面且字号稍大；旁白不要
>    “旁白”标签、不要小子号，比新消息略小即可。

## 1. 后端配套（不是纯 UI 问题）

- **开场/正文**：`apply_plan.narration` + mandatory `protocol` prompt（详见
  `analysis/narration-and-opening.md`）。开场 turn 1 先写场景/背景。
- **自动运行空/坏回合**：无 playerText 的回合历史以 assistant 结尾，DeepSeek thinking
  mode 返回 400 `reasoning_content ... must be passed back`；adapter 把 400 当能力缺失，
  降级 tools→json_schema→text，产生 JSON envelope/raw `,"line"`/重复短句。修复：
  - 自动/检查点回合末尾补一条**系统续行 user 消息**（不进 transcript/审计）；
  - adapter 不把 `reasoning_content` 类 400 当能力拒绝，避免一次错误永久降级进程能力缓存；
  - 自动模式不生成 choices（宿主丢弃），避免引擎停在选择菜单。
- **真实模型验证**（修复后）：turn 1/2/3 均为不同、完整的正文，无 reasoning 400、无
  `pacing` 丢弃、无 JSON 残片。

## 2. UI

### 2.1 一列到底

- 删除 `now-card` / `currentLine` / “现在”眉标；`#lines` 成为唯一会话容器
  （`role="log" aria-live="polite"`），旁白、玩家、系统消息按时间从上到下。
- 最新一条加 `.is-latest`；不再有“当前卡 + 历史气泡”两套视觉。
- 内容不足一屏时 `thread > :first-child { margin-top:auto }` 让最新消息贴底；超过一屏时
  正常从顶部滚动。追加消息时若离底部 <80px 自动滚到底，用户向上翻时不抢滚动。
- 会话进行中 `body.in-session` 把 `.main-play` 的滚动收进舞台：`.stage height:100%`、
  `.thread flex:1; overflow-y:auto`，输入框/选项/右轨保持固定；窄屏 `<=980` 仍整页滚动，
  会话区 `max-height:min(62vh,640px)`。

### 2.2 字号与标签

- 旁白：无 `旁白` 标签、无气泡边框；正文用衬线，旧条目 `clamp(15.5–17px)`，
  最新条目 `clamp(18.5–21px)`（实测 1600 下 16.8px / 21px）。
- 玩家消息：右对齐、淡金气泡、无“你”标签文字；系统消息居中弱化。
- 文本先 `normalizeLineText`：把字面量 `\n`/`\r`/`\t` 还原成真实换行，避免正文里留转义符
  （后端已修复，这里兜底旧转录）。
- 每条消息上限 300 条（超出移除最旧），不做虚拟滚动。

### 2.3 转录与回显

- `refreshTranscript` 直接把每条新 entry 追加到同一列（不再用 pending/“现在卡”），
  按 `turnId` 去重；`lastAt` 仍用于增量查询。
- 玩家发送/选项点击先乐观追加一条 `.line--player`，失败只撤回这一条（不再回滚旁白）。
- 新会话 `resetStream` 清空对话、选项与去重游标；结束后回大厅同样清空。

## 3. 验证

- 真实模型 + `tentacle-shadow`（临时 dataDir）浏览器：
  - 开场 1 行 → 第 2 回合 2 行；`.line` 数 2，最新 `font-size:21px`、旧 `16.8px`，
    `旁白` 标签不存在，无 console error；
  - 截图 `.ui-shots/v8/v8-two-turns.png`、`.ui-shots/v8/v8-opening.png`。
- 静态：`#lines role="log"`、`#currentLine`/`#nowCard` 不存在；play.js 含 `is-latest`。
- core **682 tests** / desktop **214 tests**；tsc、esbuild、`node --check` 通过。

## 4. 限制

- 没有时间戳、Markdown 渲染或消息复制；长会话只保留最近 300 条 DOM。
- 旧会话里已经写入的 JSON 残片不会自动修复（新局/新回合才会用新协议）；UI 只兜底
  字面量换行。
- 自动运行仍不替玩家做选择：自动模式不生成 choices；关闭自动运行后是否出选项仍由模型
  决定（导演职责）。