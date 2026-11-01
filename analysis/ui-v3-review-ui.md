# v3 单窗口 UI + 设备直控 + 通道软上限 — 独立审查（只读）

> 审查对象：`apps/desktop/src/ui/{index.html,shell.js,play.js,app.js,style.css}`、
> `apps/desktop/src/main/{dashboard.ts,bootstrap.ts}`、`apps/desktop/src/dev-server.ts`、
> `apps/desktop/tests/dashboard.spec.ts`；契约：`设备范围与单窗口界面-设计说明.md`、
> `前端界面设计.md`（§8）。
>
> 审查基线：当前工作区（2026-11-02）。`shell.js` 在审查过程中于 02:51 被更新为「深链优先」版本
> （85 行），本报告以该版本为准；更新后重新跑了 tsc + 全量 desktop 测试，仍全绿。
> 以下截图都在 `.ui-shots/review-*.png`，没有改动 `.ui-shots/preview/`。

---

## 结论

**不建议直接合入：阻塞 1 项，应该修 6 项（其中 S1 / S6 直接违反用户第 1 条与验收清单）；其余为打磨。**

改造主体是成立的：单窗口两视图、默认游玩、`/device` 深链、设备通道条（直控 + 强度/频率范围 + 时长 + 停止 + 波形）、
去掉「试跑」、游玩视图去全局 X、大厅/右轨软上限、CSP/无外链、token 约定、急停/长按空格/锁定横幅、
两视图轮询暂停，均已在真浏览器 + 真 API 上实测通过；`tsc` + 163 个 desktop 测试全绿（见 §7）。

但 **B1（直控拖到 0 不能停掉模型/别处发起的输出）** 是安全语义缺陷，契约 §1.4 与设计说明 §8.5
（`前端界面设计.md:247`）都写着「0 = 停止 / 0 立即停止」，必须修。**S1（`/play` 刷新丢掉上次视图）** 是
`前端界面设计.md` §8.5 验收清单的直接失败项；**S6（Electron 的 Ctrl+Alt+P 仍开第二个 /play 窗口）** 仍违反
用户第 1 条「同一个窗口，不再弹窗」（core 审查也独立发现，见 `analysis/ui-v3-review-core.md` 建议 2）。
S2–S5 是低成本、但会直接影响可达性或后续维护的项。

---

## 阻塞级

### B1 直控滑杆拖到 0，不能停止「不是本页刚刚发起的」输出

**文件：行**

- `apps/desktop/src/ui/app.js:255-270`，关键早退在 **262-265**：
  ```js
  // 已经是 0 且最后一次也发过 0：不再发送（0 没有需要续期的输出）。
  if (percent === 0 && state.sentPercent === 0) {
    stopKeepalive(state)
    return
  }
  ```
- `apps/desktop/src/ui/app.js:386`：滑块显示的是**实际输出**
  ```js
  const commanded = state.percent > 0 ? state.percent : (actual ?? 0)
  ```
- `apps/desktop/src/ui/app.js:412-420`：`input` / `change` → `scheduleLevel`。
- 对照契约：`设备范围与单窗口界面-设计说明.md` §1.4（`percent = 0` 即停止）、
  `前端界面设计.md:247`（「0 立即停止」）、`apps/desktop/src/ui/index.html:183`
  （「直控滑杆 0 = 停止」）。

**为什么会坏**

`state.sentPercent` 只记录**本页**最后一次发出的值。当输出是模型、另一台客户端或上一页留下的效果时，
`state.sentPercent` 仍是 0，而 `snapshot.percent`（实际输出）可能 > 0。用户把显示着 30% 的滑块拖到 0 时：

1. `paintLocal` 先把读数刷成 `0%`；
2. `flushLevel` 命中 262 行早退，**不发任何请求**；
3. 500ms 后的 `/api/snapshot` 轮询把读数重新刷回 30%，设备继续输出。

「0 = 停止」只在本页此前发过非零值时才成立。用户必须去点旁边的小「停止」按钮，但滑杆本身已经承诺了停止语义；
在真机上这是「界面说 0、设备还在动」的观感，属于安全/信任问题。

**复现（CDP，真 dev-server 47861）**

```text
先 POST /api/level {mock-pulse,a,30,durationSec:20}   // 模拟模型/别处输出
滑杆读数              → "30%"（滑块也停在 30）
把 .level-input 设为 0 → { value:"0", readout:"0%" }
900ms 后             → { serverPercent:30, readout:"30%", levelCalls:[] }   // 没有 0 请求
清理：POST /api/stop  → serverPercent:0
```

正常路径（本页先发 40、再拖 0）是好的，实测会发 `percent:0` 并停：`review-zero-normal.png` 对应那次验证。
所以问题只在「实际输出存在、但 local `sentPercent` 还是 0」的场景——而这恰好是会话进行中切到设备视图最常见的场景。

**怎么修**

最直接：在 `change` 事件里，`next === 0` 时不等 `flushLevel` 的早退，直接停 keepalive 并发一次 0（0 是幂等的）：

```js
input.addEventListener('change', () => {
  finish()
  const next = paintLocal(Number(input.value))
  if (next === 0) {
    stopKeepalive(state)
    state.pending = 0
    state.sentPercent = 0
    void sendLevel(state, 0, false)
    return
  }
  scheduleLevel(state, next, true)
})
```

或者在 `flushLevel` 里只把「实际也是 0」当作可以跳过：

```js
if (percent === 0 && state.sentPercent === 0) {
  const actual = finite(channelOf(state.deviceId, state.channelId)?.percent)
  if (actual === undefined || actual === 0) { stopKeepalive(state); return }
}
```

后者依赖 `snapshot` 新鲜度；前者更可靠。并补一个「实际 30 → 滑杆 0 → 快照 0」的回归用例
（当前测试套件没有浏览器/DOM harness，见 S5；至少应在验收脚本里加一条 CDP 冒烟）。

---

## 应该修

### S1 `/play`（以及 `/device`）刷新会丢掉「上次视图」，与验收清单冲突

**文件：行**

- `apps/desktop/src/ui/shell.js:21-37`：`storedView()` **深链优先于 sessionStorage**
  （`/device` → device、`/play` → play，然后才读 `sessionStorage`）。
- `apps/desktop/src/ui/shell.js:70-76`：`show()` 只写 sessionStorage，不更新地址栏。
- `apps/desktop/src/main/dashboard.ts:413-418`：`/play`、`/device` 是页面别名。
- 验收口径：`前端界面设计.md:246`「刷新后仍在刚才的视图；`/play`、`/device` 深链一致」；
  契约 §3.1（`ui/shell.js ← 记住上次视图（sessionStorage）`）。

**实测**

| 入口 | 操作 | 结果 |
| --- | --- | --- |
| `/` | 设备 → 刷新 | **device**（正确，sessionStorage 生效） |
| `/device`（新标签） | 直接打开 | device（正确，深链生效） |
| `/device` | 游玩 → 刷新 | **device**（错误；`stored` 已是 `play`，路径又把视图拨回设备） |
| `/play`（新标签） | 设备 → 刷新 | **play**（错误；`stored` 仍是 `device`，`aria-pressed` 回到 play） |

`review-play-refresh.png` 是 `/play` 刷新后的截图（回到大厅），而 `sessionStorage.embodied.view` 仍是 `device`。
dev-server 启动日志把 `/play` 作为游玩入口打印出来，因此这不是只影响手工改 URL 的边角情况。

**根因**：路径永远赢，但地址栏从不随视图切换而改变。`/play` 下切到设备后，刷新时路径又把视图拨回 play；
`/device` 下切到游玩再刷新则反过来。二者不可能同时满足「深链固定」与「记住上次视图」，除非写 URL。

**怎么修（任选一种，建议 1）**

1. 在 `show(view)` 里用 `history.replaceState` 把路径同步成 `/device` / `/play`（保留 `location.search` 的 token）。
   这样路径始终等于当前视图，深链和刷新记忆同时成立；缺点是从 `/` 切一次后地址会变成 `/device`，可接受。
2. 深链只在「本标签第一次加载」时生效（写一个 `sessionStorage` 标记），之后以存储为准；
   代价是同一标签再次打开 `/device` 深链不会切到设备。
3. 若决定保留「路径永远赢」，就必须改 `前端界面设计.md:246` 的验收口径，明确 `/play`、`/device` 是固定入口、
   不承诺刷新保持——但这就直接放弃了用户要求的「记住上次视图」。

同时把 `前端界面设计.md:208` 的「shell.js 76 行」更新为当前 85 行（见 S4）。

### S2 设备视图的强度/频率上下限滑杆，`aria-label` 没有通道上下文

**文件：行**

- `apps/desktop/src/ui/app.js:462` / `:471`：
  ```js
  lo.setAttribute('aria-label', `${intensity ? '强度' : '频率'}下限`)
  hi.setAttribute('aria-label', `${intensity ? '强度' : '频率'}上限`)
  ```
- 对照：同文件 :393 的直控滑块带通道名（`A 通道 直控强度`），`play.js:755/764` 的软上限滑杆也带
  `deviceId/channelId`。

**实测**：设备视图 3 个通道 × 4 个滑杆，读屏可访问名分别是
`["强度下限","强度上限","频率下限","频率上限", …]`，三组完全同名；用 Tab 走到第 7 个滑杆时无法知道
它属于 A/B/主马达 的哪个设备哪个通道。键盘/读屏用户只能靠上下文猜。这直接对应审查清单第 6 条「滑杆 aria-label」。

**怎么修**：与直控/波形/时长一致，把通道（最好连设备名）写进去：

```js
const channelName = channel.label ?? channel.id ?? '通道'
const deviceName = channel.__deviceName ?? ''   // 或把 device 传进 capRange
lo.setAttribute('aria-label', `${deviceName} ${channelName} 强度下限`)
```

`capRange(deviceId, channel, ...)` 目前只拿 id；把它改成接收 `device` 对象即可。
Play 视图软上限用的是原始 id（`mock-pulse a 强度下限`），也建议换成人读的设备名/通道名（打磨级）。

### S3 频率读数没有单位 / Hz 参考

**文件：行**

- `apps/desktop/src/ui/app.js:483`、`apps/desktop/src/ui/play.js:778`：
  `readout.textContent = `${lo.value}${suffix}–${hi.value}${suffix}``，频率时 `suffix = ''`，
  于是界面上只显示 `40–120`，没有单位。
- 只有 `title` 里写了「编码单位」（`app.js:461/470`、`play.js:754/763`），触屏/键盘用户看不到。
- 契约：`设备范围与单窗口界面-设计说明.md:105`「显示为 `编码单位`（附 Hz 参考）」；
  `前端界面设计.md:222` 的示意同样只写 `40–120`（文档本身也不一致）。

**怎么修**：可见读数加单位（例如 `40–120 编码`，或按后端映射补一个 `≈ x–y Hz` 参考），
并同步 §8.2 的示意；如果后端暂时没有可靠的 Hz 映射，至少在可见处写「编码单位」，不要只藏在 `title` 里。

### S4 `前端界面设计.md` 的 v2 硬约束没有同步，和 §8 / 新测试直接矛盾

**文件：行**

- `前端界面设计.md:3,8,67`：仍把页面写成 `index.html`（控制台）+ `play.html`（游玩页），`play.html` 已删除。
- `:131-139`（§5.1「测试断言」）：仍要求 `/play` 含 `会话上限`、静态白名单含 `play.html`；
  `apps/desktop/tests/dashboard.spec.ts` 已改成 v3 断言（无 `id="ceiling"`）。
  - 注意旧断言「含 `会话上限`」现在会**因为一句解释文案**（`index.html:74/76`）而通过，并不能防止 X 回归；
    「`/` 必须含 `Embodied 控制台`」也会因为 `<title>` 里的字符串而通过，而不是可见品牌。
- `:154-160`（§5.3「兼容」）：仍要求保留 `play.js` 的 `ceiling ceilingVal` id、`app.js` 的
  `conn panic lockBanner ... addDevice ...` 等旧 id；v3 已把设备视图 id 全部 `dev` 前缀、删掉 `ceiling`。
- `:208`：仍写「`shell.js`（新增，76 行）」，当前 85 行（深链逻辑加入后）。
- 契约 §4（`设备范围与单窗口界面-设计说明.md:124`）明确要求「文档同步：本文件、`前端界面设计.md`、README…」。

**为什么算应该修**：这份文档自称「改 UI 不能碰的东西」的硬约束；维护者按 §5.1/§5.3 改，会把已经删掉的
`ceiling`/`play.html` 又加回来，或写出与新测试相反的断言。§8 已经写了 v3，但 §3/§5 没有标注被取代。

**怎么修**：把 §5.1 的断言换成当前 `dashboard.spec.ts` 的 v3 断言（含 `id="view-play"`/`id="view-device"`/
`/shell.js`/无 `id="ceiling"`/软上限）；§5.3 的 id 列表换成 v3 的 `dev*` 列表并删掉 `ceiling`；
§3.1/§3.2 标成「v2 历史」或改写；`76 行` 改为 85 行。

### S5 静态测试对新结构的覆盖有缺口

**文件：行**：`apps/desktop/tests/dashboard.spec.ts:1111-1176`

已覆盖（值得保留）：`id="view-play"`、`id="view-device"`、`data-view-target`、`/shell.js`、
`/app.js`、`/style.css`、`connect-src 'self'`、`id="panic"`、`id="lockBanner"`、`id="choices"`、
`id="debugPanel" style="display:none"`、`id="ceiling"` 不存在、`软上限`、无 probe 字段、
`play.js` 无 `localStorage`/`console.`、`/api/level`/`/api/cap`、`/play.json` 与 `/src/ui/index.html` 404。

缺口：

1. **默认视图**：注释写着 `the play view is the default landing view`（:1120），但没有断言
   `data-view="play"` 或 `#view-play` 未 hidden / `#view-device` hidden。把 `body` 默认改成 device 测试仍过。
2. **`/device` 别名**：`STATIC_ALIASES` 和 `shell.js` 都依赖它，测试没有任何 `/device` 请求。
3. **`/play.html` 404**：只测了 `/play.json` 和 `/src/ui/index.html`；被删除的 `play.html` 没有断言。
4. **`shell.js` 行为**：只断言 200 + content-type；深链优先/sessionStorage/`viewchange`/`aria-pressed`
   完全没有测试。S1 就是在这个盲区里发生的。
5. **`ceilingPercent`**：`expect(js).not.toContain('/api/session/ceiling')` 不够直接，建议加
   `expect(js).not.toContain('ceilingPercent')`（start body 的字段）。
6. **直控 0 / keepalive / 切视图归零**：没有浏览器级测试；B1 因此没有被任何自动化挡住。

**怎么修**：至少补 1-3 的静态断言（1-2 行一条，成本极低）和 `shell.js` 的内容断言
（含 `embodied.view`、`'/device'`、`sessionStorage`）；直控 0/keepalive 若没有 DOM harness，
就在验收脚本里加一条 CDP 冒烟（本报告用的 `.ui-shots/cdp.mjs` 即可复用），或把 `flushLevel` 的
纯逻辑抽出来做单测。

### S6 Electron 的 Ctrl+Alt+P 仍会开第二个 `/play` 窗口（违反用户第 1 条）

**文件：行**

- `apps/desktop/src/main/index.ts:178-198`：`openPlayWindow()` 新建一个 `BrowserWindow` 并 `loadURL('/play')`。
- `apps/desktop/src/main/index.ts:318-320`：`globalShortcut.register(PLAY_ACCELERATOR, () => openPlayWindow())`；
  `:333` 的日志还写着 `opens it in its own window`。
- 主窗口本身已改成加载单窗口页：`apps/desktop/src/main/index.ts:148-168` 的 `createWindow()` 加载 `/`。

**为什么算应该修（高）**

浏览器路径已经是一个窗口两个视图（第 1 条通过），但桌面壳里按 Ctrl+Alt+P 仍会弹出一个独立的游玩窗口，
正是用户要求去掉的旧行为；而主窗口已经是同一个应用页，再开第二个窗口还会导致两处都在轮询同一局、
sessionStorage/视图状态各记各的。core 审查在建议 2 里独立发现同一处，并给出「改为聚焦主窗口并切到 play
视图，或移除快捷键」的方案。

**怎么修**：让快捷键聚焦主窗口并切到 play 视图（例如导航到 `/play` 或通过 IPC 触发视图切换），
不再 `new BrowserWindow`；删掉 `openPlayWindow`/`playWindow`/`:333` 的文案。若保留窗口，
至少要用户明确接受「第二窗口」的设计。

---

## 可以再打磨

1. **窄屏设备视图顺序**：390×844 下三张左栏卡（设备管理/感知/运行状态）先渲染，第一条直控滑杆在 y≈768，
   页面总高 2890；手机上要先滚过三张卡才碰得到控制。建议窄屏把设备卡列放到 rail 之前（只调 grid order）。
   截图：`review-device-390.png`。
2. **大厅软上限卡的底部安全区**：1600×1000 时卡片底 971px、bottombar 从 939px 开始，最后一行输入在 915–937px
   （仍可点，但卡片底部 padding 被压住）；1024×900 时整页只能滚 74px 才能看全，且截图工具隐藏了滚动条。
   建议给 `.lobby` 增加底部 padding / 改成内部滚动。
   数据来自 CDP：`lastRow bottom:940 / bottombar top:939`、`docScrollH 974 vs clientH 900`。
3. **顶栏连接/会话药丸在设备视图会变旧**：`#conn` / `#sessionState` 只由 `play.js` 轮询更新
   （`play.js:1041-1071`），设备视图暂停 play 轮询后，只有左栏 `#devConnState` 更新。若在设备视图里连接掉线，
   顶栏仍可能显示「已连接」。建议 app.js 顺手同步顶栏，或在顶栏标注「游玩」作用域。
4. **disconnected 设备的通道滑杆仍可拖**：`channelRow(deviceId, channel, locked)` 只传 `locked`，
   不看 `device.lifecycle`；Mock Vibrator 处于 `disconnected` 时滑杆仍可用，拖动才会报错 toast
   （`review-device-1600.png`）。建议非 ready 时禁用直控/范围滑杆并给提示。
5. **直控与停止的请求竞态**：`/api/stop` 或切视图发出的 0 与在途的非零 `/api/level` 没有序列化；
   网络慢时非零请求可能在 0 之后到达，输出继续到 `durationSec` 到期（≤15s）。建议 release 时
   AbortController 取消在途 level，或在 0 之前等待在途请求 settle。当前有 15s 上限兜底，故未列为应修。
6. **标题/首帧**：`document.title` 固定为「Embodied 控制台 · 游玩 / 设备」，切到设备不变；
   `/device` 与「记住的 device 视图」由 body 末尾的 `shell.js` 应用，慢设备理论上有 1 帧先画 play 的风险
   （默认 `/` 首屏就是 play，未见控制台先闪）。低风险。
7. **`play.js` 的 `capEditing` 是死代码**：:615 声明、:780-791 增删，但 `renderSoftCaps` 只检查
   `document.activeElement`，从不读这个 Set。删掉或真正用它判断「正在编辑」。
8. **修改范围后不重新夹本地直控值**：输出中把 maxPercent 调低，`state.percent` 仍是旧值，
   下一次 keepalive 会发旧百分比（服务端会夹）；UI 读数靠下一次 snapshot 才对齐。低风险。
9. **隐藏 `sessionCeiling` 与软上限的交互**（跨 core 审查 S-1）：旧 ceiling 仍会把 `maxPercent` 收窄到
   `min(base.max, ceiling)`。UI 侧遇到 `min >= max` 会走 `capsOf` 的 unavailable 分支（显示 `—`、禁用），
   不会发越界值，但用户看到的是滑杆静默回弹、没有解释。若设计保留隐藏 ceiling，建议在软上限卡加只读提示
   （“被全局上限 X 限制”）和释放入口；根因修复见 `analysis/ui-v3-review-core.md` S-1。
10. **`maxDurationSec < 5` 时 5s keepalive 会断档**（跨 core 审查 S-6）：UI 允许把时长设到 1–4s，
    但 keepalive 固定 5s，输出会在到期后短暂归零再续；建议把 keepalive 间隔与 `durationSec` 绑定，
    或在时长输入上给出下限提示。

---

## 已验证通过（截图 / 命令 / 实测数据）

### 1. 单窗口与路由

- `/`、`/play`、`/device` 都 200，字节数同为 16258，sha256 都是 `8ccdf36ba640dd3ede676ae4add34e1e4d477d75692f919103499e078c2802df`，
  与本地 `apps/desktop/src/ui/index.html` 完全一致。
- 首屏 `body[data-view="play"]`；`#view-play` `display:flex`、`#view-device` `display:none`；
  `#navPlay aria-pressed=true`、`#navDevice=false`；点「设备」后 `none/flex`、`aria-pressed` 反转、
  `sessionStorage.embodied.view=device`；`/` 刷新仍 device；`/device` 新标签直接 device；`/play` 新标签 play。
- `play.html` 已删除；`/play.html` → 404、`/src/ui/play.html` → 404、`/play.json` → 404、`/src/ui/index.html` → 404。
- `STATIC_FILES` 只有 `index.html app.js play.js shell.js style.css phone.html` 六个（`dashboard.ts:404`）；
  `/phone` 200。
- 截图：`review-lobby-1600.png`、`review-device-1600.png`、`review-deeplink-device2.png`、
  `review-refresh2.png`（刷新后仍是设备视图）、`review-play-alias3.png`（`/play` 强制 play）。
- 未观察到控制台先闪：默认 HTML 就是 play；`/`、`/play`、`/device` 三个入口的切换没有横向溢出，
  1024 下从滚动位置切设备时 `scrollY` 被夹回 0、顶栏回到 0（`review-scroll-switch.png` 的数据）。

### 2. 默认与「主页面是游玩」

- 大厅首屏：`#lobby display:flex`、`#sessionView display:none`、`#start disabled=true`（真机没有内容包）。
- `document.title` = `Embodied 控制台 · 游玩 / 设备`（可读；没有按视图变化，见打磨 6）。
- `#ceiling` 不存在；大厅文案明确「全局会话上限不再由这里设置…（软上限）」。
- 1024/390 截图：`review-lobby-1024.png`、`review-lobby-390.png`；390 下 `scrollW=clientW=390`，无横向溢出。

### 3. 设备视图 / 直控

- 3 个通道 → 3 个 `.level-input`、6 个 `.cap-range`；DOM 里没有任何「试跑」按钮；
  全程拦截 `fetch`，`/api/demo` 调用次数 **0**。
- 吸附：把滑块设成 5（A 通道 min=10）→ `input.value` 变 `10`、读数 `10%`；
  请求体 `{"deviceId":"mock-pulse","channelId":"a","percent":10,"durationSec":15}`。
- 直控真实下发：设 40 → 请求 `percent:40`，随后 `/api/snapshot` 的 `percent` 也是 **40**；
  拦截计数显示 5.006s 后又发了一次同值（keepalive）。
- `durationSec`：真机 `maxDurationSec=60` → 15；用快照劫持把 maxDurationSec 改成 8 → 请求 `durationSec:8`
  （`min(maxDurationSec,15)` 生效）。
- 切视图归零：在设备视图拖到 40 后点「游玩」，最后一条请求是 `percent:0`；随后快照 `percent:0`。
- 停止按钮：点通道「停止」→ `POST /api/stop {deviceId,channelId}`，快照 `percent:0`、读数 `0%`。
- 锁定/急停：点急停 → `locked:true`、`percent:0`、play/device 两个 `lock-banner on`、
  三个直控滑杆 `disabled:true`；5.6s 内没有新的 `/api/level`（keepalive 已停）。解锁后恢复。
  截图：`review-locked.png`。
- 波形：劫持快照给 A 通道 `supportsWaveform:true` 后出现 `<select>`（7 个库波形 + 「无波形」），
  选择后发 `POST /api/waveforms/select {deviceId,channelId,waveformId}`；`outputFloorPercent:5` 显示
  「最小非零≈5%」。截图：`review-waveform.png`。
- 40% 时的视觉：强度条填充 `57.1429%`（=40/70）、下限刻度 `14.2857%`（=10/70），读数 40%，
  同时出现「输出中 · steady · 15s」标签。截图：`review-level-40.png`。
- 错误 toast：把 `/api/cap` 劫持成 400 → `#err` 变成 `toast on`，文本为服务端原因；截图：`review-toast.png`。
- **B1 的反例**见阻塞级；正常路径（先 40 再 0）实测会发 0（`review-zero-normal.png`）。

### 4. 游玩视图 / 软上限

- `#ceiling` 不存在；`/api/session/start` 请求体只有
  `{"packId":"demo","plannedMinutes":30}`，**没有** `ceilingPercent`。
- 大厅与右轨两个挂载点都渲染出 6 行（3 设备 × 2 通道）；每台设备的名称只出现一次
  （`softCapsLobby.innerText` 中 `Mock Pulse Box` / `Mock Vibrator` 各 1 次，通道用 tag 分组）。
- 软上限改动的真实 payload：`{"deviceId":"mock-pulse","channelId":"a","patch":{"maxPercent":60}}`，
  读数 `10%–60%`。设备视图的范围滑杆同理（`maxPercent:60`、`maxDurationSec:45` 都实测到）。
- 大厅/舞台截图：`review-lobby-1600.png`、`review-stage-1600.png`（预览 47863，进行中一局，
  右轨依次为 状态 / 连接与部位 / 软上限 / 感知，6 行软上限可见）。
- Play 视图的软上限滑杆在锁定时 `disabled`（`review-locked.png` 里颜色变灰）。

### 5. 约束

- **CSP 未放宽**：`index.html:18` 与 `git show f38a2f3:apps/desktop/src/ui/index.html` 第 6 行逐字一致：
  `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'`。
  `phone.html` 未改动（`git diff --stat` 为空）。
- **无外链**：`index.html` / `style.css` 中 `https?://`、`@import`、`url(` 外链搜索为空。
- **`play.js` 无 `localStorage`、无 `console.`**（grep 0 命中）；`shell.js` 只用 `sessionStorage`，
  `storedView`/`remember` 都有 try/catch。
- **token 约定**：两个脚本都只在启动时 `new URLSearchParams(location.search).get('token')` 一次，
  之后只进 `x-control-token`；带 token 的页面 HTML 里搜不到 token 字符串（0 命中）。
- **急停/长按/锁定**：急停常驻顶栏；长按空格 1s → `hold-overlay on` → `locked:true`；
  解锁按钮恢复；banner/滑杆联动见上。截图：`review-locked.png`。
- **轮询暂停**（performance resource 计数，2.6s 窗口）：
  - play 视图：`/api/session` +5，`/api/devices` +0；
  - device 视图：`/api/session` +0，`/api/devices` +5。
  切回时的 `viewchange` 立即 `refreshAll`/`activateDevice` 也在代码与实测中成立。

### 6. 可达性 / 健壮性

- **无重复 id**（DOM 全量扫描 0 个重复）；Tab 顺序：play 视图 `navPlay → navDevice → panic → packSelect →
  plannedMinutes → 软上限滑杆`；device 视图 `nav → panic → 日志/审计/调试 → 添加设备 → 直控/范围滑杆 →
  停止/波形`。隐藏视图的控件不在 Tab 序列里（`offsetParent=null`）。
- 滑杆都有 `aria-label`（直控带通道名，波形/时长带通道名；范围滑杆的缺陷见 S2）；
  导航按钮有 `aria-controls` + `aria-pressed`；`#err` 是 `role=status`/`aria-live=polite`；
  `input[type=range]:focus-visible` 有金色 focus ring（`style.css:591-594`）。
- **缺少 v3 字段的降级**：劫持快照删除 `minPercent/maxPercent/minFreq/maxFreq/maxDurationSec` 后，
  3 个直控滑杆 `disabled:true`、读数全 `—`；6 个范围块显示「强度范围 — / 频率范围 —」且没有 input；
  时长输入 `disabled`；play 侧软上限 6 行全是 `—` + 「宿主尚未提供该通道范围」。
  截图：`review-degrade.png`。
- **空态**：设备视图 `还没有设备。用左栏「添加设备」选择协议后手动连接。`；
  play 软上限 `先在设备视图添加并连接设备`（大厅/右轨一致）。截图：`review-empty.png`。
- **宽度**：1024×900 与 390×844 的 lobby/device 都 `scrollWidth == clientWidth`（无横向溢出）；
  390 设备页总高 2890，可纵向滚动；1024 三栏 236/414/300 不挤压。截图：
  `review-lobby-1024.png`、`review-device-1024.png`、`review-lobby-390.png`、`review-device-390.png`。

### 7. 测试

```bash
cd apps/desktop && node ../../packages/core/node_modules/typescript/bin/tsc --noEmit -p tsconfig.json \
  && node node_modules/vitest/vitest.mjs run --pool=threads
```

- 在 `shell.js` 02:51 更新后重跑：`tsc` 0 error；`Test Files 14 passed (14)`、`Tests 163 passed (163)`，exit 0。
- 静态断言覆盖：`id="view-play"` / `id="view-device"` / `data-view-target` / `/shell.js` / `id="ceiling"` 不存在 /
  `软上限` 都有；缺口见 S5。

### 截图索引

| 截图 | 用途 |
| --- | --- |
| [review-lobby-1600.png](../.ui-shots/review-lobby-1600.png) | 默认游玩/大厅 1600×1000 |
| [review-device-1600.png](../.ui-shots/review-device-1600.png) | 设备视图（切换后） |
| [review-level-40.png](../.ui-shots/review-level-40.png) | 直控 40%：填充/下限刻度/读数/效果标签 |
| [review-stage-1600.png](../.ui-shots/review-stage-1600.png) | 进行中舞台 + 右轨软上限（预览 47863） |
| [review-locked.png](../.ui-shots/review-locked.png) | 急停后锁定横幅、滑杆禁用 |
| [review-lobby-1024.png](../.ui-shots/review-lobby-1024.png) / [review-device-1024.png](../.ui-shots/review-device-1024.png) | 1024 宽度 |
| [review-lobby-390.png](../.ui-shots/review-lobby-390.png) / [review-device-390.png](../.ui-shots/review-device-390.png) | 390 宽度 |
| [review-deeplink-device2.png](../.ui-shots/review-deeplink-device2.png) | `/device` 深链 |
| [review-refresh2.png](../.ui-shots/review-refresh2.png) | `/` 刷新仍设备视图 |
| [review-play-refresh.png](../.ui-shots/review-play-refresh.png) | **S1**：`/play` 刷新回到游玩 |
| [review-degrade.png](../.ui-shots/review-degrade.png) | 缺 v3 字段降级 |
| [review-empty.png](../.ui-shots/review-empty.png) | 无设备空态 |
| [review-toast.png](../.ui-shots/review-toast.png) | `/api/cap` 400 toast |
| [review-waveform.png](../.ui-shots/review-waveform.png) | 波形下拉与 floor 文案 |
| [review-duration.png](../.ui-shots/review-duration.png) | 停止按钮与 maxDurationSec 夹取 |
| [review-polling.png](../.ui-shots/review-polling.png) | 轮询暂停验证时的页面 |

---

### 只读声明

本次审查未修改任何源码/测试，未执行 git 写操作；仅新建本文件并生成 `.ui-shots/review-*.png` 截图，
未触碰 `.ui-shots/preview/`。
