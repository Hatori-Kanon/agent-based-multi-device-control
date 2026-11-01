# 前端 v2「墨金」代码/契约审查

> 审查对象：`apps/desktop/src/ui/index.html`、`app.js`、`play.html`、`play.js`、`phone.html`、
> `apps/desktop/src/renderer/index.html`；只读参考 `main/dashboard.ts`、`dev-server.ts`、
> `tests/dashboard.spec.ts`。
>
> 审查方式：`git show HEAD:` 对比、静态 grep/脚本核对、无头 Chrome 实测。
> **没有修改任何被审源码、测试或服务端文件，也没有执行 git 写操作。**
> 实测过程中在 47833 预览会话里发送了 2 条内容（仅内存会话），并生成了若干 `.ui-shots/review-*.png` 截图。

## 结论

**不能直接合入（阻塞问题 4 个）。**

- 功能主体可用：静态白名单、ID、轮询节奏、面板开关、上限/急停/波形接口都基本保持原语义；
- 但本次新增的「现在台词入历史」逻辑存在可复现的竞态，会把下一句旁白放进玩家发言之前并重复显示；
- 手机页急停失败后按钮会被永久禁用，而手机页又是带外急停通道；
- 手机页 CSP 相对 `HEAD` 确实被放宽；
- 最关键的设计系统文件 `src/ui/style.css` 当前是 **未跟踪文件**，直接提交本次 diff 会丢失整套样式。

测试和类型检查本身全绿（162 tests / tsc exit 0），但它们没有覆盖上述运行时竞态和手机页失败路径。

## 阻塞级

### 1. `style.css` 未纳入版本控制，提交后页面会 404

- 位置：`apps/desktop/src/ui/style.css`（`git status --short` 显示 `?? apps/desktop/src/ui/style.css`）。
- 为什么是阻塞：`index.html:8`、`play.html:22`、`phone.html:28` 都依赖 `/style.css`；`dashboard.ts:383`
  虽然已把 `style.css` 放进 `STATIC_FILES`，但在干净 checkout 里文件不存在时静态路由会返回 404。
  页面不会报错，只会静默退化成无样式 HTML，正好复现改造前要解决的问题。工作树测试通过是因为文件就在本地。
- 怎么修：合入时显式 `git add apps/desktop/src/ui/style.css`（以及设计文档 `前端界面设计.md`，如要随本次提交），
  并在干净工作树/干净 checkout 上跑一次 `dashboard.spec.ts` 和页面截图。
- 备注：这不是代码逻辑问题，但按当前 diff 直接提交会导致交付物不完整，因此计入阻塞。

### 2. `play.js` 的「现在台词去重」存在顺序竞态（新增逻辑）

- 位置：`apps/desktop/src/ui/play.js:852-866`（发送）、`876-894`（选项）、`677-687`（轮询转录）、`436-441`（flush）。
- 问题：`sendMessage()` / `pickChoice()` 在 `await api(...)` **之后**才调用 `flushPendingLine()`。
  而 `refreshTranscript()` 由 500ms 轮询驱动，会与这个 POST 并发。服务端在
  `play.ts` 的 `runOneTurn()` 里先 `recentEntries.push(...)`（约 810 行），之后才做
  `onSettle` 快照/审计落盘并返回 HTTP 响应；也就是说响应返回前的窗口里，转录轮询很可能已经拿到下一句旁白。
  一旦轮询先拿到下一句：
  1. `refreshTranscript` 把 `pendingLine` 更新为下一句；
  2. POST 返回后 `flushPendingLine()` 把「下一句」当作上一句追加；
  3. 再追加玩家这句；
  4. `applySession(next)` 又让「现在」卡显示同一句。
  结果是对话流顺序变成「旁白(下一句) → 玩家」，并且「现在」卡与历史重复。
- 实测（47833 预览页，只延迟 `/api/session/message` 的响应 1.5 秒后发送一条消息）：
  - 追加了 `[回合5旁白, 回合6旁白, 玩家消息]`
  - 当前 `now` 是回合6旁白
  - 该旁白在 DOM 中出现 2 次（历史 + 现在）
  服务端没有 1.5 秒延迟，但这个竞态窗口是真实存在的：`recentEntries.push` 与 HTTP 响应之间还有
  `onSettle` 会话快照和审计落盘，即使只有几毫秒到几十毫秒，500ms 轮询也有概率撞上；1.5 秒只是把概率放大到必现。
- 怎么修：
  - 在 `await` 之前、`busy = true` 之后调用 `flushPendingLine()`；请求成功返回后只追加玩家这句，
    然后 `applySession(next)`。这样即使 POST 期间轮询拿到下一句，也会留在 `pendingLine`，等再下一句到来才入历史。
  - 或者在 flush 时对照 `next.lastLine`/`session.lastLine`，`pendingLine === next.lastLine` 时不要追加；
    但「先 flush 再请求」是最简单、语义最清楚的修法。
  - 选项路径同样处理；并补一个 fake timer / 延迟 fetch 的单测，固定这个顺序。
- 影响：正常本地响应很快时不容易触发；但既有 UI 轮询、又有落盘，属于设计上必须消除的竞态，且恰好破坏本次改动想保证的顺序。

### 3. 手机页急停失败后按钮永久禁用（安全）

- 位置：`apps/desktop/src/ui/phone.html:301-321`，配合 `261-293`。
- 问题：点击急停时先 `panicButton.disabled = true`。如果 `/api/panic` 网络失败（catch 分支），
  `finally` 只发起一个 `void refresh()`；而 `refresh()` 的 catch（287-292）只改状态文字，
  **不会调用 `renderLocked(false)`**。如果网络此时不可用，refresh 也失败，按钮就一直保持 disabled。
  手机页是带外急停通道，网络抖动后操作者无法再次点按，只能刷新页面。
- 实测：把 `window.fetch` 替换为 reject 后点击 `#panic-button`，1.8 秒后
  `{disabled: true, status: "连接失败：offline", pill: "连接失败"}`。
- 怎么修：在 `panic()` 的 catch/finally 中明确恢复可点击状态（除非已从 snapshot 确认 locked）；
  不要依赖 refresh 成功来解锁按钮；`refresh()` 失败时至少保留上一次已知的 locked 状态，并允许重试。
- 这条逻辑改造前就存在，但本次页面重做仍应一并修掉，否则急停页不能算可靠。

### 4. 手机页 CSP 相对 `HEAD` 被放宽

- 位置：`apps/desktop/src/ui/phone.html:25-26`。
- 对比 `git show HEAD:apps/desktop/src/ui/phone.html`：
  - 旧：`default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'`
  - 新：`default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'`
- 为什么是阻塞：`前端界面设计.md` §5.2 和任务要求都是「CSP 未被放宽」。
  新增的 `script-src 'self'`、`img-src 'self' data:` 并不是加载 `/style.css` 所必需的；
  `style-src 'self'` 才是共享样式表所必需。当前页面没有任何图片/外链脚本，`img-src` 完全多余。
  虽然只增加了同源权限，实际攻击面很小，但这是明确的契约偏差，且与实现记录里「CSP 未放宽」的说法不一致。
- 怎么修：最小集改为
  `script-src 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'`
  （去掉 `script-src 'self'` 和 `img-src`）；若要求与旧 `HEAD` 逐字一致，则不能外链 `/style.css`，
  需把共享样式内联或接受评审对 `style-src 'self'` 的例外。`index.html`、`play.html` 的 CSP 经逐字对比没有变化。

## 应该修

### 1. 开局默认把会话上限写成 100%，会覆盖上一次更低的上限（需产品确认）

- 位置：`play.html:106`（滑杆默认 `value="100"`）、`play.js:796-803`（每次 start 都带 `ceilingPercent`）。
- 服务端结论：`dashboard.ts:548-557` 接受该字段，`play.ts:372-380` 通过
  `setSessionCeilingByHuman` 写入，`play.ts:1298` 校验 0–100 整数；**「只能人类写」这一语义通过**。
- 但行为与改造前不同：旧 `play.js` 的 start body 只有 `{ packId, plannedMinutes }`
  （`git show HEAD:...play.js` 可对比），服务端的 `ceilingPercent` 缺省语义是「保持已存上限」。
  新 UI 每次开局都发送滑杆值；如果上次把上限降到 20，下次打开大厅默认显示 100，直接开局就会把已存上限提升到 100。
  页面没有读取当前 policy ceiling 的接口，用户也不会被告知「这次会覆盖上次的 20」。
- 建议：读取当前会话上限并初始化滑杆；或只有用户显式改动滑杆后才发送 `ceilingPercent`，未改动时保持服务端旧行为；
  至少在大厅文案中明确「默认 100 会写入并提升已存上限」。这是安全边界，建议产品确认后再定稿。

### 2. 控制台 `editing` 集合可能永久卡住，导致设备卡停止刷新

- 位置：`app.js:196`（duration 输入 focus 时 `editing.add`）、`app.js:259-260`（`editing.size > 0` 直接 return）。
- 问题：用户点击（或 Tab 聚焦）时长输入框后，如果直接点别处而没有改值，`change` 不会触发，
  `editing` 永远不会删除；之后每次 500ms 的 `refresh()` 都在 `renderDevices()` 第一行返回。
  设备连接状态、锁横幅、顶部计数、错误面板里的设备信息都会停止更新，直到重新聚焦并成功改一次值或刷新页面。
- 实测：对 number 输入派发 `focus` 事件后等待 1.3 秒，输入节点仍是同一个（渲染被跳过）；真实鼠标聚焦会触发同一个 focus 监听。
- 另外：range 只在 `pointerdown` 加入 `editing`，键盘聚焦不受保护；500ms 重绘会销毁正在聚焦的 range/select（波形下拉会关闭、焦点丢失）。
- 怎么修：在 `focusout`/`blur` 时清理 `editing`（即使没有 change）；用 `focusin` 而不是仅 `pointerdown` 记录键盘编辑；
  或者不要每次轮询都重建整棵设备卡，改为按 signature 局部更新。`editing` 卡住不应导致整个控制台停止刷新。

### 3. 手机页把 HTTP 500/错误 JSON 当成「可输出」

- 位置：`phone.html:269-286`。
- 问题：`refresh()` 只特殊处理 401；500 且响应体是 JSON 时，`response.json()` 解析出 `{ok:false,error:...}`，
  随后 `snapshot.locked` 为 undefined，代码走 else 分支，把药丸设为「在线」、状态设为「可输出 · 0 台设备」。
  急停页在服务端故障时反而显示「可输出」，是危险的状态误导。
- 实测：伪造 500 JSON 后，`pill="在线"`、`status="可输出 · 0 台设备"`、`banner=none`。
- 怎么修：`if (!response.ok) throw new Error(...)`；保持上一次已知状态或明确显示「状态未知」，
  不要把非快照响应当成 unlocked 快照。

### 4. 没有请求超时；play.js 一次挂起的轮询会永久停掉全部轮询

- 位置：`app.js:73-91`、`play.js:195-220`、`play.js:768-780`。
- 问题：`api()` 没有 `AbortSignal.timeout`；`poll()` 的 `polling` 标志在 `refreshSession()` 挂起时永远不释放。
  一旦某个 fetch 既不 resolve 也不 reject，游玩页不会再轮询会话/台词/设备，也不会显示错误；
  控制台的 500ms interval 则会不断叠加挂起请求。
- 建议：所有 `api()` 加 5–8 秒超时（`AbortSignal.timeout`），区分超时/断网；`poll()` 用 `finally` 清理
  `polling`（已有），并确保超时后能继续下一轮。

### 5. 可用性与无障碍（按任务第 6 项）

- **弹窗没处理 Esc / 焦点**：`index.html:244-257` + `app.js:434-438` 只切换 `display`；
  `app.js` 没有 `keydown`/`Escape` 监听，打开时焦点仍在背后的「添加设备」按钮，`aria-modal="true"`
  没有对应的焦点陷阱或初始焦点。建议：Esc 关闭、打开时聚焦第一个可选项或确认按钮、关闭后把焦点还给 `#addDevice`、
  至少把背景设为 inert 或做 Tab 循环。
- **`aria-live` 用得过宽**：`index.html:182` 的 `#devices` 每 500ms 整棵重建；`phone.html:194` 的
  `.phone-state` 每秒把相同状态文字重新赋值；`play.html:136` 的 `#currentLine` 每 500ms 重设文本。
  这些区域会让读屏器反复朗读大段不变内容。建议只在内容实际变化时更新，或把 live region 限定到一行短状态。
- **空格拦截了按钮的原生激活**：`play.js:1020-1026` 对任何非输入目标都 `preventDefault()` 并开始长按；
  `isTypingTarget()`（935-939）没有排除 `button`/`a`/`[role=button]`。键盘用户聚焦「发送」「暂停」等按钮后按空格，
  不会激活按钮，反而会开始急停计时。建议：目标为可交互控件时放行空格；或者只在 `document.body`/非控件上启动长按。
- **`#lockBanner` 没有 alert 语义**：`index.html:146`、`play.html:74` 只是普通 div；手机页 `phone.html:183`
  已有 `role="alert"`。建议两个页面也加 `role="alert"`/`aria-live`，让锁存状态能被读屏器播报。
- **波形输入没有可访问名称**：`index.html:187,191` 只有 placeholder；`renderer/index.html:179,183` 同样。
  建议补 `aria-label` 或 `<label for>`（placeholder 不能作为稳定的可访问名称）。
- **IME 回车会提前发送/失焦**：`play.js:992-996` 的 Enter 发送没有检查 `event.isComposing`，
  `play.js:541-545` 的部位输入回车也没有。中文输入法用 Enter 确认候选词时会触发 `requestSubmit()`/`blur()`，
  把未完成的半句发出去。建议两个 keydown 都加 `if (event.isComposing || event.keyCode === 229) return`。
- **通过项**：没有 `tabindex` 打乱顺序；`Enter` 发送、`Shift+Enter` 换行已实现；`#message` 有 `aria-label`；
  游玩页内容包/时长/上限都有 `label for`；no tabindex regressions.

### 6. 无台词回合可能把上一句旁白留在 pending，永远不进历史

- 位置：`play.js:261-266`、`play.js:677-687`。
- 问题：`pendingLine` 只在「下一条转录 entry 到来」时 flush。若某一回合 `lastLine` 为空
  （模型只出 tool_call、无正文），`renderSession` 会把「现在」卡显示成「（本回合还没有台词）」，
  上一句仍然只在 `pendingLine` 里；如果紧接着结束会话，就再没有下一条 entry 来 flush 它，
  这句旁白既不在历史里、也不在「现在」卡里（刷新后转录会重新把它设为 pending，仍不显示）。
- 建议：当 `session.lastLine` 变为空或 `state === 'ended'` 时，若 `pendingLine` 非空且不等于当前 lastLine，
  主动 flush 到历史；或者让「现在」卡在无台词时回退显示 pending 的最后一句（不伪造新行）。

### 7. `applySession` 切换会话时先清空、再被 turnId 守卫拦下

- 位置：`play.js:234-244`。
- 问题：`if (nextId !== sessionId) resetStream()` 先清空流，随后 `next.turnId < session.turnId` 时直接 return。
  如果页面保持打开而宿主换成另一局（新 sessionId、turnId 1），会清空历史，但旧会话仍留在 `session` 变量里，
  之后每次轮询都重复这个动作，页面卡在旧回合和空对话流之间。
- 说明：单进程只允许一局，正常路径很难触发（需要宿主重启且 token 不变）；但这是「切会话」边界，建议修：
  `nextId` 不同的时候应无条件应用新快照（或先不 reset，等确认接受后再 reset）。

### 8. 按钮 `type` 不完整

- 位置：
  - `play.html:69,70,76,110,184,185,186` 缺 `type="button"`；
  - `app.js:388-395` 动态生成的「存入库」按钮缺 `type`；
  - `renderer/index.html:166,170,180` 及 `renderer.js` 动态按钮也缺 `type`。
- 现状：这些按钮都不在 `<form>` 内（唯一的 composer 里，发送按钮已是 `type="submit"`），所以目前不会造成意外提交；
  `index.html` 和 `phone.html` 的静态按钮已全部带 `type`。
- 建议：按任务要求补齐；即使当前无表单，也避免以后把卡片/面板挪进表单时出现默认 submit。

### 9. 调试开关的 403 与启动波形请求的挂起

- `app.js:633-635`：如果另一个控制台把 `/api/debug` 关掉，本页仍认为开启，会每 2 秒请求
  `/api/debug/probes` 并收到 403，反复 `fail()`；`play.js:631-636` 已经会把 403 跟随关掉，控制台应一致。
- `app.js:673-683`：启动时新增的 `GET /api/waveforms` 普通失败会被 catch 忽略，不阻断控制台（这一点通过）；
  但它是 `await` 的，且没有超时。如果该请求一直挂起，后面的 `setInterval`（687-692）永远不会安装，控制台不会开始轮询。
  建议把波形加载放到 interval 之后，或给 `api()` 加超时；并确认旧版确实没有启动拉取（旧版只在 `call()` 返回
  `waveforms` 时刷新，内建波形不会在启动时出现，这点新代码是修复而非回归）。

### 10. 控制台的重复提交与按键保护

- `app.js:505-515` 的导入、`218-234` 的试跑/停止、`387-396` 的存入库都没有 busy 锁；快速双击会重复 POST。
  游玩页有 `busy` 锁（`play.js:852-874`、`876-894`），控制台没有。
- 建议：给导入/试跑/存入库加 in-flight 禁用；急停可保持可重复（幂等），但导入和试跑应防抖。

## 建议（可选）

- **Electron 主窗口文件实际未被加载**：`src/main/index.ts:166-168` 的 `createWindow()` 加载的是 dashboard 的 `/`
  （即 `src/ui/index.html`），不是 `src/renderer/index.html`；`renderer/index.html` 目前没有 `loadFile` 调用点，
  属于遗留页面。它的内联样式与 `renderer.js` 的类名**仍然是匹配的**（脚本核对无缺类），
  但改这个文件不会影响 Electron 主窗口，建议删除、接线或在文档中标注。
- `dev-server.ts` 的 bundle map 没有 `phone.html`（`44-50`）；当前依靠 `dashboard.ts` 的磁盘回退能找到
  `src/ui/phone.html`，所以 47832/47841 均返回 200。若希望 bundle「真的自包含」，把 `phone.html` 也放进 map。
- `style.css` 里 `.tab/页面` 注释与实际行数不一致（实现记录写约 900 行，实际 1800+），不影响运行，可顺手修正。
- 给 `play.js` 的 `pendingLine`/`flushPendingLine` 增加一个无浏览器 DOM 的单元测试：
  伪造 transcript 的两条记录和延迟的 `/api/session/message` 响应，断言「旁白→玩家→下一句」以及不重复。
- 手机页 `localStorage.getItem/setItem` 没有 try/catch；在存储被禁用/配额满的浏览器上会让整段内联脚本中断，
  急停页随之失效。手机页是安全通道，建议包一层。

## 已验证通过的项

### 契约

- `grep -n "localStorage\|console\." apps/desktop/src/ui/play.js`：无输出（exit 1）。`play.js` 没有
  `localStorage`，也没有 `console.`。
- `grep -rn "https\?://\|//cdn\|@import"` 覆盖六个被审页面 + `style.css`：无输出。
  `index/play/phone` 只加载同源 `/style.css` 和同源 `/app.js`、`/play.js`；没有外链字体、图片、CDN。
- CSP：
  - `index.html` 当前 line 6 与 `git show HEAD:...index.html` 逐字一致；
  - `play.html` 当前 19-20 与 `HEAD` 一致；
  - `phone.html` 与 `HEAD` 不一致，已列阻塞级第 4 条。
- token：
  - `app.js:5`、`play.js:15` 只在启动时从 `location.search` 读一次；`api()` 只放 `x-control-token`；
  - 两页都没有把 token 写入 DOM/localStorage/日志；
  - `app.js:649-651` 打开游玩页时把 token 放进新窗口 URL，这是既有的导航约定，不是持久化；
  - 手机页的 localStorage 用法是既有行为，按任务说明允许。
- `node --check apps/desktop/src/ui/app.js`、`node --check apps/desktop/src/ui/play.js`：均通过。

### ID / DOM 完整性

用脚本解析 HTML 与 JS（不是肉眼）：

| 文件对 | HTML id 数 | JS `getElementById` 引用数 | 缺失 | 重复 |
| --- | ---: | ---: | ---: | ---: |
| `index.html` / `app.js` | 36 | 35 | 0 | 0 |
| `play.html` / `play.js` | 35 | 35 | 0 | 0 |
| `phone.html` / 页内脚本 | 7 | 7 | 0 | 0 |
| `renderer/index.html` / `renderer.js` | 14 | 12（另有 `#wfTable` 走 querySelector） | 0 | 0 |

`index.html` 中 `addDialogTitle` 只被 `aria-labelledby` 引用，不是 JS 引用，属正常。
按钮 `type` 统计：`index.html` 13 个全有；`phone.html` 2 个全有；`play.html` 8 个中 7 个缺（见应该修第 8 条）；
`renderer/index.html` 3 个全缺（无表单，当前无提交风险）。

### 行为等价

- 轮询节奏与 `HEAD` 完全相同：
  - 控制台 `app.js:687-692`：refresh 500ms / audit 3s / errors 3s / logs 2s / sensors 3s / debug 2s；
  - 游玩页 `play.js:768-780`：会话/台词 500ms、设备/部位 2s、感知 2s、debug 2s、packs 30s；与旧 `poll()` 逐行一致。
- 面板开关：`#auditPanel`/`#logPanel`/`#debugPanel` 默认 `display:none` 保留；点击开关只切 `display`、`aria-pressed`
  与右栏入口卡；调试关闭时 `renderDebugProbes` 在请求前直接返回（`app.js:613-620`、`play.js:619-621`），确实停止 probes。
- 锁定/解锁：`/api/panic`、`/api/unlock`、`lockBanner.on`、`lockedNow()` 逻辑都保留；急停按钮仍常驻。
- 添加设备弹窗：四种协议、点击背景关闭、添加/取消处理器未改；`#addDialog` 的 id 保留。
- 通道上限：range/number 的 change 仍发 `POST /api/cap`，字段名 `maxPercent`/`maxWaveIntensity`/`maxDurationSec` 未改；
  新增的 `--fill` 只影响绘制。
- 试跑/停止：`/api/demo`、`/api/stop` 未变；试跑在 locked 时 disabled 保持。
- 波形：导入 `POST /api/waveforms/import`、存库 `POST /api/waveforms/promote`、选择 `/api/waveforms/select` 未变；
  启动时新增 `GET /api/waveforms` 是旧版缺失的可见性修复（旧版只在 `call()` 返回 `waveforms` 时刷新）。
- 游玩页 start：服务端接受 `ceilingPercent`；`PlaySession.start` 走 `setSessionCeilingByHuman`，仍是人类 HTTP 路由唯一入口
  （`dashboard.ts:548-557`、`play.ts:372-380`、`play.ts:1298`）。语义本身通过，但默认 100 的覆盖风险见「应该修」第 1 条。
- 正常发送顺序实测：已有 3 条历史 + 当前回合4台词；发送一条后追加
  `[回合4旁白, 玩家消息]`，当前卡显示回合5旁白，无重复——正常时序通过。异常时序复现见阻塞级第 2 条。
- 页面中局刷新：打开 47833 中局页面后，历史显示 1–4 回合、当前卡显示第 5 回合，符合「历史只缺最新一句」的预期。
- `#debugPanel` 的精确字符串 `id="debugPanel" style="display:none"`、`id="choices"`、`id="lockBanner"`、
  `id="panic"`、`会话上限` 都保留；dashboard 静态测试通过。

### 健壮性 / 无障碍（部分通过）

- `#err` toast：`.toast { pointer-events: none; opacity: 0 }` + `.on`，6/8 秒后移除，不会永久遮挡或拦截点击；
  普通请求失败都会走 `fail()`/`noteError()`。
- 游玩页 `sendMessage`/`pickChoice` 有 `busy` 同步锁，双击不会重复提交；发送失败保留输入框内容；成功后才清空。
- 游玩页设备部位编辑：`refreshSnapshot` 在 `#devices` 含 `document.activeElement` 时跳过重画，
  `focusout` 后补一次快照（`play.js:694-708, 1011-1018`），不会在输入时清空。
- 键盘：Enter 发送、Shift+Enter 换行已实现；没有 `tabindex` 打乱顺序。
- 长按空格急停的生命周期实测通过：keydown 后 `.hold-overlay.on` 出现且 `aria-hidden="false"`，
  150ms 后 keyup 能取消并恢复 `aria-hidden="true"`。
- 存在的问题已列在「应该修」第 2、5 条。

### 测试与类型

```text
cd apps/desktop && node node_modules/vitest/vitest.mjs run --pool=threads
→ Test Files  14 passed (14)
→ Tests       162 passed (162)
→ Duration    7.21s

cd apps/desktop && node ../../packages/core/node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
→ exit code 0
```

两处全绿。没有环境失败。需要说明：现有测试只断言 `play.js` 包含 `/api/session/transcript` 等字符串，
没有浏览器/DOM 级测试；上面的竞态和手机页失败路径都不会被现有套件捕获。

### 静态资源与打包

- `apps/desktop/src/main/dashboard.ts:383` 的 `STATIC_FILES` 已包含 `style.css`；`379` 有 `text/css` 类型；
  `862-884` 的静态分支按白名单返回。
- `apps/desktop/src/dev-server.ts:18` 导入 `style.css`，`44-50` 的 bundle map 包含 `style.css`；
  `EMBODIED_UI_FROM_DISK=1` 走 `dashboard.ts` 的磁盘回退（`readStaticFile`），同样能拿到。
- 实测运行中的两个实例：
  - 47832（`dist/dev-server-w2.mjs` 构建产物）`/style.css` → 200，37421 bytes；
  - 47841（`dist/dev-server-disk.mjs` 构建产物）`/style.css` → 200，37421 bytes；
  - 两个端口的 `/play`、`/phone` 也都是 200。代码上 bundle map 和磁盘回退两条路径都覆盖了 `style.css`。
- Electron 的 `renderer/index.html`：用脚本提取 `renderer.js` 的类名逐一对照内联 CSS，所有 `.device/.ch/.ch-name/.meter/.caps/.acts/.life/.tag/.scope-*` 等都有对应规则；没有缺类。
  唯一问题是这个文件当前未被主进程加载（见「建议」第一条），不是类名不匹配。

### 结论重申

如果只按「代码能否运行」看，测试/类型/静态白名单都通过；但按任务给出的契约与安全标准，**当前不建议合入**。
最小合入前动作：补跟踪 `style.css`、修 play 的 flush 时序、修手机页急停失败恢复、把手机页 CSP 收窄到旧基线；
其余「应该修」可在同一批或紧接着的提交处理。
