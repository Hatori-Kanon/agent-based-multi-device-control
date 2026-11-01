# 前端 v2「墨金」修复复核

> 复核对象：`apps/desktop/src/ui/{style.css,play.html,play.js,phone.html,index.html,app.js}` 与 `apps/desktop/tests/dashboard.spec.ts`。
> 方式：只读审查 + 47833 进行中预览 + 47825 无内容包页 + 无头 Chrome/CDP 实测。没有修改源码、测试或预览脚本，也没有做 git 写操作。
> 审查基准：`analysis/ui-review-play.md`（B1–B4 / S1–S9）、`analysis/ui-review-code.md`（阻塞 1–4 / 应修 1–10）。
> 本轮证据截图都在 `.ui-shots/rr-*.png`；测试截图只用于复核，不影响最终交付。

## 结论

**原始报告列出的阻塞故障都已修复，但修复本身引入了新的功能性回归，因此现在不建议直接交付。** 原报告 8 个阻塞中，`style.css` 跟踪属于提交动作（按任务说明不计入本轮）；其余 7 个的原始触发路径均已通过实测（去重竞态的失败分支另见新 1）。Lead 的 19 条声称中，**15 条已修，3 条部分，1 条未复核**。

但第 2、14、12 条修复各带出一个新问题，其中第一个建议按阻塞处理：

1. **发送/选择失败时仍把玩家台词写进历史，并清空未发送的草稿**：现在不仅会丢失输入，失败后“现在”卡还会与历史重复（截图 `.ui-shots/rr-send-fail.png`、`.ui-shots/rr-choice-fail.png`）。这是“去重竞态”修复在失败分支上的回归。
2. **控制台设备卡只要内部任意元素有焦点就停止重建**：包括点过的按钮；点「试跑」或「停止」后，输出百分比/「输出中」会冻结，直到焦点移出设备卡（同轮 DOM eval 数据，截图 `.ui-shots/rr-console-button-focus2.png`）。
3. **`#sessionState` 加了 `aria-live`，但每 500ms 仍无条件重写文本**：2.6 秒内实测 6 次 DOM mutation，读屏有重复播报风险。

补充：测试套件仍为 **162 tests**（与基准相同），没有检索到与本轮 19 条对应的新增静态断言；`dashboard.spec.ts` 的 mtime（01:31）也早于本轮源码修复（01:49–01:52）。因此 Lead 声称的“测试加了 3 条静态断言”在当前工作树中无法证实。

### 建议的交付条件

1. 修发送/选择的失败回滚：失败时不要留下伪造的玩家气泡，恢复草稿；同时不要留下“同一句旁白既在历史又在现在卡”的状态。
2. 把设备卡的焦点跳过范围收窄到真正的编辑控件（`input`/`select`/`textarea`），或在按钮聚焦时也做局部更新。
3. `#sessionState` 只在文本变化时写 `textContent`。
4. 补上对应回归测试；`style.css` 的 `git add` 仍需由 Lead 完成（本轮未复核）。

## 逐条复核表

| # | 结论 | 证据 |
|---|---|---|
| 1 `style.css` 未跟踪 | **未复核（提交动作）** | 按任务说明不计入；交付前仍需 Lead 显式 `git add`。 |
| 2 去重竞态 / 玩家回显前置 | **部分：成功路径已修，失败路径新回归** | `play.js:891-893,917-918` 在 `await` 前 flush + 回显。延迟 `POST /api/session/message` 1.5s 后实测：历史 7 → 9，最后一条为玩家，且当前旁白没有作为新气泡追加；顺序是“上一句旁白 → 玩家 → 下一句留在现在卡”（`.ui-shots/rr-race2.png`）。但网络失败时同样会先 append 并清空输入：`before=7 / after=9 / input='' / last=player / nowSame=true`（`.ui-shots/rr-send-fail.png`）；选项失败同样 `before=7 / after=9 / last=player / nowSame=true`（`.ui-shots/rr-choice-fail.png`）。 |
| 3 手机急停失败可重试 | **已修** | 将 `window.fetch` 替换为 `reject('offline')` 后点击 `#panic-button`，1.5s 后 `{disabled:false, pill:"连接失败", status:"连接失败：offline"}`；`finally` 的恢复逻辑在 `phone.html:331-337`。 |
| 4 手机 CSP 收窄 | **已修** | 实际 meta 为 `default-src 'none'; script-src 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'`；与基准 HEAD 相比只多 `style-src 'self'`，无 `img-src`、无 `script-src 'self'`（`phone.html:25-26`）。`/style.css` 实测 200（40272 bytes），页面计算样式已加载。 |
| 5 空内容包下拉不空白 | **已修** | 47825 实测 `selectedIndex=0`、可见文本“（没有已安装的内容包）”、选项 disabled、开始按钮 disabled、空态提示可见；见 `.ui-shots/rr-lobby-empty.png`。 |
| 6 装饰引号 / 现在 eyebrow / 台词字号 | **已修（窄屏 19px 覆盖）** | 1600 下 `#currentLine` 字号 **24.8px**、行高 44.64px；`#nowEyebrow` 文本“现在”；伪元素内容为 `"”"`，已从顶部裁切改为底部淡出，截图不再只有两个圆点（`.ui-shots/rr-play-1600.png`、`.ui-shots/rr-play-390-top.png`）。窄屏 CSS 显式覆盖为 19px（`style.css:1913-1915`），与声称的 20–25px 不完全一致，但视觉比原 18.5px 好。 |
| 7 舞台 1040px / 右边界 / 顶部对齐 | **已修（有观感残留）** | 1600 实测 `.stage x=100 w=1040`，`now-card`、`choices`、`composer` 的右边界均为 **1140**；右轨 x=1236。去掉 `margin-top:auto` 后单气泡测试 offset=14px（thread 顶部 285 → 气泡 299），不再被压到底部（`.ui-shots/rr-thread-top.png`）。残留：气泡仍限 760px，选项仍占 1040px，两者右边界不统一。 |
| 8 窄屏 sticky / 堆叠 / panic 可见 | **已修** | 390×844 滚到底实测：`scrollWidth=390`、topbar `position:sticky`（0–97）、bottombar 底部 844、composer 可见（190–268）、`#panic` top=**46**、right=289，仍在视口内；截图 `.ui-shots/rr-play-390-scrolled.png`、`.ui-shots/rr-play-390-top.png`。 |
| 9 长选项不撑破 | **已修** | 1024×768 注入 140 个 A：`scrollWidth=1024`，choice 与 stage 同右界 688，右轨从 704 开始，`overflows=false`，标签高 42px（两行）；1600 同样 `scrollWidth=1600`、右界 1140、右轨 1236。见 `.ui-shots/rr-long-choice-1024.png`、`.ui-shots/rr-long-choice.png`。 |
| 10 对比度 | **已修** | `--faint: #7f8a9b`。WCAG 对比度：faint 在 ink-0 为 **5.70:1**、panel-1 为 5.04:1、panel-2 为 **4.68:1**；muted 分别为 7.91/7.00/6.49。`.hint`、`.bubble .who`、`.card-title small`、`.turn-chip` 已用 `--muted`。`.phone-note` 仍是 `--faint`，但手机深底上 5.70:1，达标，故不列为问题。 |
| 11 range 焦点环 / 22px 命中 | **已修** | 通过 CDP 发送真实 Tab 键后 `#ceiling` 为 `:focus-visible=true`，`box-shadow: rgba(247,217,122,.22) 0 0 0 4px`，高度 **22px**（`.ui-shots/rr-range-tab.png`）。 |
| 12 ARIA / 避免重复写 DOM | **部分：lock/currentLine 已修，sessionState 新增 churn** | `#lockBanner` 在 index/play 均为 `role="alert"`；`#currentLine` 观察 2.5s **0 次 mutation**，内容未变不重写。`#sessionState` 虽为 `aria-live="polite"`，但 `renderSessionPill` 每 500ms 无条件 `textContent = text`（`play.js:314-336`），2.6s 实测 **6 次 mutation**；见 `.ui-shots/rr-live-mutations.png`。 |
| 13 结束态 | **已修** | 用伪造 `state:'ended'` 快照实测：`nowCard.classList.contains('is-ended')=true`，文案为结束说明，eyebrow=“已结束”，timer=“—”，stage chip=“已结束”，右轨只剩 状态/内容包/边界 三项，选项隐藏（`.ui-shots/rr-ended.png`）。 |
| 14 控制台 editing 卡死 | **部分：卡死已修，焦点跳过范围过宽** | 聚焦设备卡内 number 输入后伪造 `locked:true` 快照：设备卡仍是同一节点，但 `#statLocked=已锁定`、锁横幅已更新；失焦 1.3s 后设备卡重建、`#statLocked=未锁定`（`.ui-shots/rr-console-focus.png`）。问题在 `app.js:283-285`：`el.devices.contains(document.activeElement)` 把按钮也算进去；聚焦「试跑」按钮时，伪快照的 `percent=42` 不显示，失焦后才显示 `输出中 · rr-test · 10s`（同轮 DOM eval 数据，截图 `.ui-shots/rr-console-button-focus2.png`）。 |
| 15 请求超时 / 控制台轮询顺序 | **已修** | `play.js:205-216` 默认 8s、动作 90s；`app.js:73-85` 默认 8s。把 fetch 改为挂起后，9s 内出现 `读取出词失败：signal timed out`，恢复 fetch 后页面继续显示当前台词（`.ui-shots/rr-timeout.png`）。控制台预注入挂起的 `/api/waveforms` 后仍有 **8 次 `/api/snapshot`** 请求，说明 `setInterval` 先装好、波形补拉不阻塞（`app.js:707-720`）。 |
| 16 手机 5xx / 非快照 / localStorage | **已修** | 500 响应实测 `pill=连接失败`、`status=连接失败：控制台返回 HTTP 500`，不会显示“在线/可输出”；200 `{}` 实测“连接失败：控制台返回了非快照响应”（`.ui-shots/rr-phone-500.png`、`.ui-shots/rr-phone-nonsnapshot.png`）。localStorage 读写都有 `try/catch`（`phone.html:230-232,248-249`，静态核对）。 |
| 17 控制台调试 403 跟随关闭 | **已修（下一拍收面板）** | 伪造 `POST /api/debug -> enabled:true`、`GET /api/debug/probes -> 403`：点击后 1.2s 时 `aria-pressed=false`，2.7s 时面板 `display:none`、`#err` 为空，没有反复 `fail()`（`.ui-shots/rr-console-403b.png`）。面板隐藏依赖下一次 2s 轮询，状态关闭是立即的。 |
| 18 IME Enter / 空格抢占 | **已修** | 在 `#message` 派发 `isComposing:true` 的 Enter：`defaultPrevented=false`，气泡数不变，输入值保留；在部位输入框派发同样事件：输入框保持焦点、事件未被 preventDefault；聚焦 `#send` 派发 Space：`defaultPrevented=false`、`#holdOverlay` 未出现。截图 `.ui-shots/rr-ime.png`。 |
| 19 切会话 turnId 守卫 | **已修** | 伪造新 `sessionId:'rr-switch'`、`turnId:1`、`lastLine:'切会话后的新旁白'`、空 transcript：1.6s 后显示新台词、`第 1 回合`、历史气泡 0（`.ui-shots/rr-switch.png`）。`applySession` 在 `switched` 时跳过 lower-turnId 守卫（`play.js:247-260`）。 |

### 测试与类型检查

```text
cd apps/desktop
node node_modules/vitest/vitest.mjs run --pool=threads
→ Test Files 14 passed (14)
→ Tests      162 passed (162)

node ../../packages/core/node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
→ TSC_EXIT=0
```

`node --check apps/desktop/src/ui/play.js`、`app.js` 均通过。

**测试声称的疑点**：`grep` 没有找到 `flushPendingLine`、`AbortSignal`、`selectedIndex`、`unsafe-inline`、`is-ended` 等本轮修复对应的断言；`dashboard.spec.ts` 仍是 162 个测试，且 mtime 早于源码修改时间。不能据此说测试坏了，但“新增 3 条静态断言”在当前工作树中没有可定位证据。

## 新发现的问题（回归）

### 新 1（建议阻塞）失败发送/选择会伪造历史、丢草稿，并让当前台词重复

**位置**：`apps/desktop/src/ui/play.js:891-893`（message）、`917-918`（choice）、`901-906`（catch/finally）。

**复现**：页面内把 `/api/session/message` 或 `/api/session/choice` 的 fetch 改成 reject，再提交；1.2–1.6 秒后：

```text
message: before=7 after=9 input="" last=bubble--player:"失败草稿不应丢失"
         err="发送失败：offline" nowSame=true
choice:  before=7 after=9 last=bubble--player:"你走近窗边"
         err="选择失败：offline" nowSame=true
```

原因是 `flushPendingLine()` 和 `appendLine('player', ...)` 在 `await` 前无条件执行，失败分支没有回滚；`el.message.value=''` 也发生在请求成功之前。结果：

- 玩家看到一条服务端根本没收到的话；
- 输入框已清空，草稿丢失；
- 上一句旁白已被 flush 到历史，但“现在”卡仍显示它，出现历史/现在重复。

**建议**：不要用“先伪造后回滚”的方式解决竞态。更稳的做法是：动作 `busy` 期间暂停/串行化 `refreshTranscript`，等 POST 成功后再 flush + append；或在失败时同时移除本轮的 player/assistant 乐观气泡、恢复输入框并恢复 `pendingLine`。成功路径当前顺序本身是对的，但失败路径必须补齐。

### 新 2（应修，高优先级）控制台设备卡只要按钮有焦点就停止刷新

**位置**：`apps/desktop/src/ui/app.js:283-285`。

**证据**：聚焦设备卡内「试跑」按钮后，伪造快照 `channels[0].percent=42`；轮询继续，但设备卡仍显示“输出 0%”；失焦后同一轮询数据立刻变成“输出中 · rr-test · 10s”。状态栏/锁横幅仍会更新，冻结的只是 `#devices` 卡片。

这不是原来的 `editing` 卡死；它把保护范围从“正在编辑的 input/select”扩大到了“任意 activeElement”。按钮获得焦点（Tab 导航，或鼠标点击后浏览器保留焦点）就会触发。实际影响：点「试跑」或「停止」后，操作者看不到通道输出状态变化，直到焦点移出；「停止」后卡片甚至可能继续显示“输出中”。

**建议**：只对真正的编辑控件跳过重建：

```js
const active = document.activeElement
const editingControl = active instanceof Element
  && el.devices.contains(active)
  && active.matches('input, select, textarea')
if (editing.size > 0 || editingControl) return
```

或者改为局部更新 meter/输出文字，不做整卡重建。

### 新 3（应修，可访问性）`#sessionState` 的 live region 每 500ms 被重写

**位置**：`apps/desktop/src/ui/play.html:66`、`apps/desktop/src/ui/play.js:314-336`。

**证据**：对 `#sessionState` 加 MutationObserver，2.6s 内 **6 次 mutation**；同一时间 `#currentLine` 为 0 次。`renderSessionPill()` 每次轮询都执行：

```js
el.sessionState.className = `pill ${kind}`
el.sessionState.textContent = text
```

即使文本仍是“进行中”，`textContent` setter 也会替换文本节点。`aria-live="polite"` 因此有重复播报风险，正好是原报告对 `#currentLine` 提醒的同类问题。

**建议**：

```js
if (el.sessionState.textContent !== text) el.sessionState.textContent = text
```

### 新 4（流程风险）测试声称与工作树不一致

`dashboard.spec.ts` 仍为 162 tests；没有检索到本轮 19 条对应的断言，mtime 也早于源码修复。建议至少补：

- 延迟 `/api/session/message` 后“旁白 → 玩家 → 新旁白不重复”的 DOM 级或 fake timer 单测；
- fetch reject 时草稿保留、无伪造 player 气泡；
- 控制台按钮聚焦时输出状态仍更新，或编辑控件失焦后恢复重建；
- `#sessionState` 文本不变时不产生 mutation。

## 仍未修的原始建议（可延后，需记录为遗留）

以下是我确认仍未完成、但不构成本轮原始阻塞的项：

- **B1 的提示字号**：`#startHint` 仍是 11.5px（颜色已从 faint 提到 muted，对比度达标），没有按原建议加到 12px；不影响空态可读性，可延后。
- **S2 右轨仍偏表单**：卡头已改为“连接与部位”，部位输入也做了透明标签外观，但每个通道仍保留“部位（空=全身）”占位输入（`play.js:555-576`、`style.css:1526-1539`）；没有只读 chip/铅笔切换。可延后。
- **S8 字号层级仍密**：10.5 / 11 / 11.5 / 12 / 12.5 / 13 / 13.5 等半档仍在使用；本轮只提升了对比度和 now 字号，没有收敛成 5 档。可延后。
- **S9/B2 残留**：选项仍占满 1040px，气泡最大 760px，右边界仍不一致；底栏主控仍是三枚普通按钮。视觉方向已明显改善，但不属于功能阻塞。
- **Code 应修 1（产品决策）**：大厅滑杆仍默认 `value="100"`，每次开局仍发送 `ceilingPercent`；上次更低的上限可能被覆盖（`play.html:106`、`play.js:827-835`）。需要产品确认后再改。
- **Code 应修 5 的弹窗**：已补 Esc、打开时首焦点、关闭后回焦（`app.js:449-467`），但没有焦点陷阱/背景 `inert`；可延后。
- **Code 应修 8 的遗留页面**：`renderer/index.html` 的三个静态按钮仍无 `type`；该页当前未被 Electron 主窗口加载，可延后或直接标注废弃。
- **Code 应修 10**：控制台导入/试跑/停止/存入库仍没有 in-flight busy 锁，快速双击仍可能重复 POST；本轮未改。可延后。
- **无台词回合的 pending 收尾**：本轮代码已有 `pendingShown` 回退和 ended flush（`play.js:278-286`），逻辑上覆盖了原 Code 应修 6，但建议补测试防止以后回归。
- **测试/构建**：`style.css` 的提交跟踪仍需 Lead 处理；`.ui-shots/preview/` 的脚本本轮未改。

## 复核环境与限制

- 47833：进行中会话，token 来自 `.ui-shots/preview/urls.txt`；本轮在其内存会话里发送了 2 条玩家消息（第 8、9 回合附近），没有改服务端状态文件。
- 47825：未开局且无内容包，token 来自 `/tmp/dev-lead.log`。
- 竞态截图里的“当前旁白在历史中还能找到相同文字”是预览脚本化模型每 4 回合循环造成的文本重复，不是本轮去重 bug；判断以“历史新增气泡数、最后气泡角色、当前旁白没有作为新气泡追加”为准。
- 本轮没有重复做完整视觉/契约审查；只对照两份原始报告和 Lead 的 19 条声称。
