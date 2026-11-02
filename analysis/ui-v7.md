# ui-v7：自动运行、应用内确认、结束后回大厅（2026-11）

> 触发：产品负责人要求
> 1. 自动运行勾选框 + 间隔滑块，放在游玩界面（大厅）和正在游玩的界面；
> 2. 结束游玩不要浏览器原生弹窗，所有确认都在页面内；
> 3. 结束游玩后回到主界面，而不是停在 `ended` 舞台。
>
> 本文记录实现、契约变化与验证。

## 1. 自动运行

### 1.1 引擎

- `EngineSnapshot` 新增 `autopilot: { enabled, intervalSec, minSec, maxSec }`；
  `TurnEngine` 新增 `setAutopilotInterval(seconds)`：clamp 到 `config.autopilot`
  （默认 10–60，default 20），已 arm 的定时器立即重排，返回 adopted 值。
- 仍然只有 `setAutopilot(enabled)` 控制 P3 定时器；计划里的 `nextTurnAfterSec` 会像以前一样
  改变 adopted interval（所以 slider 是起点，不是永久锁）。
- 暂停取消 tick、resume 重新 arm（既有行为）；locked/ending/ended 由宿主拒绝。

### 1.2 宿主

- `POST /api/session/start` 新增可选 `autopilot: {enabled:boolean, intervalSec?:number}`；
  `PlaySession.openSession` 在开场回合结束后应用（避免 arm 一个马上被丢掉的 tick）。
- 新 `POST /api/session/autopilot` → 返回新 snapshot；`enabled` 非 boolean / intervalSec
  非正数 → 400；无会话/已结束/锁定 → 4xx。`PlayHost.setAutopilot` 走 `liveEngine()`，
  与 pause/resume/choice 同一套终态拒绝语义。
- 记录 `session_start` 审计时**没有**新增自动运行字段（它不影响安全边界，按现有 audit 口径）；
  如需审计可在后续加 `detail.autopilot`。

### 1.3 UI

- 大厅「开局」卡：`#autoLobbyEnabled` checkbox + `#autoLobbyInterval` slider（10–60，
  step 1）+ `#autoLobbyValue` 读数。只在本地保存，开局时随 start 请求提交。
- 进行中右轨新增「自动运行」卡（状态卡之后、设备与软上限之前）：
  `#autoRunEnabled` / `#autoRunInterval` / `#autoRunValue`。
  - `renderSession()` 调 `renderAutoRun()`：用 `snapshot.autopilot` 回写 enabled/interval，
    用 minSec/maxSec 更新 slider 边界；焦点在控件上时跳过（不打断拖动）。
  - checkbox change / slider change → `POST /api/session/autopilot`；`autoBusy` 防重；
    成功 `applySession`，失败 noteError 并回拉真值。
  - paused 可改；locked/ending/ended 禁用；结束后大厅沿用上一局设置（每 sessionId 一次，
    轮询不会覆盖玩家之后在大厅的手动修改）。
  - 自动运行时不生成/丢弃 choices（没有玩家可点，避免引擎停在选择菜单）；关闭后恢复。
- 自动运行不改变任何安全边界：它只触发 P3 回合，输出仍受每通道 policy/ceiling/LOCKED 约束。

## 2. 应用内确认

- `index.html` 新增应用内 `<dialog id="confirmDialog">`：
  `#confirmText`、`#confirmCancel`、`#confirmOk`；样式用 `--panel`/`--line`/`--shadow-pop`，
  `::backdrop` 半透明遮罩。
- `shell.js` 新增 `window.embodiedConfirm(message) → Promise<boolean>`：
  确定 true；取消/Esc/缺元素/无 `showModal` → false；不抛错。并发调用返回 false 保护。
- `play.js#endSession` 改为 `await window.embodiedConfirm('结束本局？')`；
  `app.js` 移除设备同样改用它。产品 UI 已无 `window.confirm/alert/prompt`（grep 验证）。

## 3. 结束后回大厅

- `applySession` 在 turnId 守卫之前拦截 `state === 'ended'`：
  1. 如果 `session` 已存在且 `sessionId` 不同 → 这是上一局迟到的 ended 快照，丢弃；
  2. 把 `next.autopilot` 的 enabled/interval 写回大厅控件（每个 sessionId 只写一次，
     `lobbyAutoSeeded`）；
  3. `applyNoSession()`：清 session、reset 对话流/选项，显示大厅，开局按钮恢复可用。
- 后端契约从 **“一进程一局”** 改为 **“一进程一个活动会话”**：
  `PlayHost.start` 遇到已 `ended` 的旧 session 会 `dispose()` 并替换（新 sessionId/turn 1）；
  `ending`（aftercare 尚未读完）仍拒绝新局，避免打断收尾。
- `refreshTranscript` 在 `session === null` 时直接跳过（请求返回后再查一次），
  避免大厅轮询把上一局台词塞回下一局；`startSession` 在 apply 前先 `resetStream()`。

## 4. 验证

- core：52 files / **682 tests**；desktop：17 files / **214 tests**；两边 `tsc --noEmit` 0 error；
  main/dev-server esbuild + `node --check` 通过。
  - 新增引擎测试：snapshot autopilot 字段、`setAutopilotInterval` clamp + 重排定时器。
  - 宿主测试：开局 autopilot 应用到 snapshot；`setAutopilot` 修改；ended 后新 start 成功
    （新 sessionId/turn 1），运行中仍 `SESSION_OPEN`；HTTP `/api/session/autopilot` 200/400。
  - 静态契约：HTML 含 auto/confirm/dialog ids；play.js 含 `/api/session/autopilot` 与
    `embodiedConfirm`、不含 `window.confirm`；app.js/shell.js 同样无原生弹窗。
- 真实浏览器（CDP + dev-server + 已安装 `tentacle-shadow`，无 LLM key 走 fallback）：
  - dialog 默认隐藏；`embodiedConfirm` 打开后 `:modal`、遮罩变暗、焦点在「确定」；
    取消/确定/Esc 的 Promise 值正确，全程无原生 dialog 事件（`Page.javascriptDialogOpening`=0）；
    760px 下 175×121 不溢出。截图 `.ui-shots/auto/02-confirm-dialog-open.png`。
  - 大厅 auto row 在开局卡内、10–60/step1/20 与 `20s` 正确；右轨卡片顺序
    [状态, 自动运行, 设备与软上限]；344/1024/760 无横向溢出。
  - **完整流程**（实际点击）：大厅勾选自动运行 + 15s → 开局 → 进行中右轨显示勾选/15s
    （截图 `.ui-shots/v7/01-session-auto.png`）→ 关闭自动运行并改 25s → 点「结束」弹出应用内
    dialog（焦点在确定）→ 取消仍在会话 → 再点结束并确定 → **回到大厅**（`sessionState=未开局`、
    开局按钮可用、大厅继承自动运行关闭/25s、对话流已清空）→ 再次开局得到新会话（第 1 回合、
    无上一局台词）；`Page.javascriptDialogOpening` 全程 0，无 console error。
- play-ui 的临时 DOM-stub 真实执行 play.js 的 35 条断言：大厅默认值与 start payload、
  快照同步/clamp/焦点保护、toggle/slider POST、失败回滚、disabled 规则、
  confirm 取消/确定、ended→lobby、stale ended 丢弃、transcript 守卫、连续 3 次开局。
- **未做**：真实 LLM key 下的完整回合；上述 e2e 的开场是宿主 fallback（无 key）路径，
  但自动运行/结束/回大厅的 UI 与宿主 API 均已实际执行。

## 5. 已知限制

- `aftercareMin > 0` 的包点「结束」后会先停在 `ending`（引擎 aftercare），等收尾时间结束
  才回大厅；当前没有“跳过 aftercare”的 UI。测试包建议 `aftercareMin: 0`。
- 自动运行设置只在本次页面/会话内存中：宿主重启或刷新页面后，大厅恢复默认（关闭/20s）；
  未持久化到 `state/`（避免把“自动输出”变成重启后默认开启）。
- 一个进程仍只允许一个活动会话；旧 `ended` 会话在新 `start` 时替换，没有“历史局重开”。
- 自动运行只触发回合，不改变安全边界；LOCKED/panic 仍立即生效。