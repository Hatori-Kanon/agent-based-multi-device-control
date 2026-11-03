# ui-v14 对抗复核：DSML 正文清洗 / 请求值显示 / 右轨 requested 强度条

> 复核员：reviewer（task-23），只读。基线 **HEAD = 16e4a1a（v13）**；对象 = 工作区未提交第五轮 diff
> （11 files **+430/−43**：core loop + tests、host play/dashboard/bootstrap + tests、UI play.js、文档）。唯一写入本文件；
> 未改代码/未 commit。证据：独立门禁 + `.ui-shots/t19-request-display/report.json` + 截图 + 代码/测试阅读 +
> `stripToolMarkup`/`runTurn` 行为探针。真实模型/真实硬件仍未验证。

---

## 0. 门禁（独立复跑）

| 检查 | 结果 |
| --- | --- |
| core `vitest run` | **52 files / 748 tests passed** |
| desktop `vitest run` | **18 files / 255 tests passed** |
| 两包 `tsc --noEmit` | 均 exit 0 |
| esbuild `main/index.ts` / `dev-server.ts`（输出 NUL） | 均 exit 0（main 639.1 kb） |
| `node --check src/ui/play.js` | ok |
| CDP `.ui-shots/t19-request-display/` | report + 5 张截图；`anywhereSaysActual=false`，A 40/40（requested），B 8/8（无 requested 回退 actual），1600/390 无溢出 |

源码 mtime ≤22:55；ui-v14.md 22:57；门禁与构建均在源码稳定后复跑。

---

## 1. 结论速览

- **P0：0 项。**
- **P1：1 项（本轮新引入）**：`stripToolMarkup` 之后如果 **streamed content 全是 markup**、而 `apply_plan.narration` 有合法正文，`consume` 只在 `lineParts` 为空时才采用 narration；清洗发生在 narration 选择之后，最终 `line` 变成空串，host 用模板句占位，**合法正文被丢失**。这是本轮要修的真实泄漏场景（markup-only content + tool-call narration）。
- **P2：约 9 项**：多 DSML 块之间正文被贪婪正则误删、全角尖括号不识别、JSON 行启发式误删带引号的方括号台词、inline 残留双空格、streaming/历史 lastLine 未清洗、requested >100/为负的展示不一致、requested 延续/暂停测试缺口、UI 仍静态+CDP、文档“普通 <> 不误删”过度承诺。
- **判定：需修 P1-1（小改即可）后再交付；其余清洗边界/展示为 P2。修 P1-1 后整体可交付（真机回归除外）。**
  如果 Lead 认为“markup-only content + narration”极低概率，可接受模板句兜底，则该 P1 可降为 P2；但从真实泄漏样本看它正好命中这个组合。

> **更新（2026-11-03 23:02 后）**：P1-1 与 sanitizer P2（完整 block/全角尖括号/JSON 台词/inline 空格）已修；
> delta 复核见 **§6**：P1-1 闭环、无新 P0/P1；最终判定 **可交付（真机回归除外）**。本节保留修复前状态。

---

## 2. 逐项复核

### a) sanitizer（`packages/core/src/agent/loop.ts:457-502`）

**实现**：`stripToolMarkup` 先全角 `｜`→`|` 仅用于检测，无 markup 信号原样返回；依次删除完整 DSML 块（贪婪）、残余 DSML tag、`<parameter>…</parameter>`（跨行）、parameter 头+同行、残余 invoke/calls、单行 `<|…>` token、纯 JSON payload 行；`consume` 的 `cleanLine`（`:346-366`）清洗 lineParts，`narrationOf`（`:504-510`）清洗 narration。测试 `agent-loop.spec.ts:863/877/896/921/949` 覆盖：尾部全角 DSML、正文中间整块、narration、markup-only 无 plan retry、普通 `<>`/括号/`[低笑]` 不误删。**这些用例均通过。**

**发现：**

1. **P1-1 清洗后丢失合法 narration（本轮新增，已实测）**
   `consume` 顺序（`loop.ts:355-366`）：
   - 若 lineParts 为空且 `result.text` 非空 → push；
   - `onToolCall` 设置 `narration`（已清洗）；
   - **若 lineParts 仍为空且 narration 非空** → push narration；
   - 最后 `cleanLine()`。
   当 provider 把 markup 流进 content（lineParts 非空）而 plan.narration 是合法正文时，narration 不会被 push；`cleanLine` 把 markup-only line 清成空，`result.line` 最终为 `''`。host（`play.ts:1199-1203`）看到空 line 但 plan 存在 → 使用 `WRITER_TEMPLATE_LINE`，玩家丢失真实正文。
   本机 `runTurn` 探针（markup-only stream + `apply_plan.narration='这是合法正文。'`）结果：`line=""`、`plan=true`、无警告。**建议**：`cleanLine` 后若 lineParts 为空且 `narration !== ''`，把 narration push 回去（narration 已清洗）；或在 `consume` 里先清洗再决定是否用 narration；补“markup-only content + 合法 narration”测试。
2. **P2-1 首个/最后一个 DSML 之间的正文被贪婪删除**
   `cleaned.replace(/<\|{2}DSML[\s\S]*<\|{2}DSML[^>\n]*calls>/gi, '')` 是贪婪的：若一段正文夹在两个独立 DSML 块之间，整段正文会被删。本机探针：`甲。\n<||DSML|| calls>\n乙。\n<||DSML|| calls>` → `甲。`（乙丢失）。真实模型一次泄漏多个块+中间正文的概率不高，但这是数据丢失；建议按块非贪婪/逐段处理，或仅删除成对 block 且保留块外文本。
3. **P2-2 全角尖括号不识别**
   只归一了 `｜`（U+FF5C），`＜＞`（U+FF1C/FF1E）仍是原字符；`hasToolMarkup` 只匹配 ASCII `<|`/`<parameter`/`<invoke`。探针 `前。\n＜｜｜DSML｜｜ calls＞\n后。` 原样返回（泄漏未清）。用户真实样本是 ASCII `<>`+全角 `｜`，当前样本可用；若 provider 输出全角尖括号，仍泄漏。建议归一化 `＜＞` 到 `< >` 仅用于检测/清洗。
4. **P2-3 JSON payload 行启发式误删带引号的方括号台词**
   `isToolJsonLine`（`:496-502`）只要求整行 `[...]`/`{...}` 且包含 `"`；当同一 text 里存在任意 markup 信号时，普通台词行如 `[他说"别动"]` 会被当作 JSON payload 删除。探针：`前。\n<||DSML|| calls>\n[他说"别动"]\n后。` → `前。\n\n后。`。建议要求行是合法 JSON.parse（或严格 `[{`/`{]` 结构）再删。
5. **P2-4 inline 删除残留双空格/空行**
   `前文 <｜｜DSML｜｜ calls> 后文` → `前文  后文`（双空格）；折叠空行只处理 `\n\n\n+`。属观感问题（P3），但清洗后文本可能不自然。
6. **P2-5 streaming/历史路径**
   `onTextDelta`（`loop.ts:292-296`）仍转发**原始 delta**；当前 production UI 不消费 `env.onLine`（bootstrap 未接线），只以最终 `TurnResult.line` 为准，因此当前 UI 不显示 streaming 泄漏。但 `PlaySessionEnvironment.onLine` 是公开 hook，未来/嵌入方若接上就会显示原始 markup。历史会话已保存的 `lastLine` 不会回溯清洗（ui-v14 限制已承认），用户打开旧局仍可能看到旧泄漏；新回合才覆盖。
7. **测试缺口**：没有 markup-only content + narration、两个 block 中间正文、全角尖括号、JSON 台词误删、streaming 残余的测试；当前 5 条只覆盖正常样例。

**结论 a）**：单块/单条真实样本清洗有效，普通 `<>`/括号测试通过；但 **P1-1 会丢失合法 narration**，且存在 3 类误删/漏删边界。不能直接判 sanitizer 完全闭环。

### b) requested 显示（host/dashboard/UI）

- **事务**：`lastRequested`（`play.ts:522`）与 `lastBodies` 在 `commitResolvedBodies`（`:1404-1434`）同事务提交：blocked/actions 数不符/身份不匹配整轮不提交；只 `status !== 'rejected'` 提交；stop/percent0 删除；被拒 stop 不删。`noteDispatch`（`:1355-1385`）stop/人类直控清除；dispatchWindowActive 内是模型/hold 自己的事件。测试：stop 清空（`play.spec.ts:2344`）、人类直控只清该通道（`:2357`）、正常记录（`:2338`）、HTTP snapshot 字段（`:880-893`）。**事务与 key 正确。**
- **snapshot**：`DashboardDeps.requestedPercents` 可选（`dashboard.ts:107`）；`decorateSnapshot`（`:474/520/867`）按 `device:channel` 合并 `requestedPercent`，不写回 registry；bootstrap 接线（`bootstrap.ts:1348-1351`）。测试 HTTP 实际取到字段。
- **UI**：
  - 效果小框（`play.js:652-680`）：有 requested 只显示 `区间 X%`，无 requested 回退实际单值；`rejected` 不显示；去重 key 按 request/legacy 区分；CDP `anywhereSaysActual=false`、`阴蒂 · 区间 40% · 腔鞘套弄抽吸`、旧路径 `胸部 · 55% · 涟漪`。
  - 右轨（`play.js:966-978`）：优先 `channel.requestedPercent`，缺字段回退 `channel.percent`；title 仅 requested 显示“模型请求（区间百分比）”；CDP A 40/40、B 8/8，无溢出。
  - **P2-6**：`requestedPercent` 若来自 **deltaPercent 超界**（requested >100/为负），效果小框会原样显示 `区间 120%`/`-5%`，右轨则 clamp 到 0–100，两处不一致；建议展示层 clamp 并保留 clamped 信息，或只展示 0–100。
- **产品语义**：requested-only 符合用户“不要写实际”的要求；manual 直控回退 actual 做反馈符合“滑杆拖动有反馈”；continuation 保留 requested（代码不删）符合未提及通道延续。**P2-7**：pause/panic/end 的 requested 清空没有独立测试（依赖 stop 事件；stop/human 有测试），continuation 保留也没有直接断言。
- **CDP 真实性**：report.json 与截图存在，stub snapshot 明确 A requested=40/actual=8、B 无 requested；UI 行为真实；但不覆盖真实 host/decorateSnapshot 的端到端（HTTP 测试覆盖了字段，二者互补）。**P2-8**：UI 仍只有静态断言+手动 CDP，`effectPercentText`/右轨 fallback 无 vitest。

### c) prompt

- 全局 `TURN_PROTOCOL` 新增（`play.ts:181`）：`正文只输出给玩家看的叙事；不要输出 <|...|>、DSML、工具调用语法、parameter/invoke 或任何特殊 token。`
- 测试 `play.spec.ts:1540+` 断言存在；prompt 中没有 cap 数值/设备 id，符合前几轮约束。**c）通过。**

### d) 门禁 / 测试

- 独立复跑：core 748、desktop 255、两包 tsc 0、esbuild main/dev-server 0、node check play.js ok；diff 11 files +430/−43。
- 已有测试：sanitizer 5 条、requested 事务/snapshot/UI 静态/CDP。
- 缺口见 a-7、b-6/7/8；另有：
  - 没有 sanitize 前后 **narration 回退**测试（P1-1）；
  - 没有 **多 block/贪婪**、全角尖括号、JSON 台词误删测试；
  - 没有 streaming delta/历史 lastLine 测试；
  - 没有 requested **>100/负值**展示测试；
  - 没有 **pause/panic/end requested 清除**、continuation 保留测试；
  - 没有真实模型/真实 BLE 回归。

### e) 其他泄漏路径

- **已覆盖**：`TurnResult.line`、`apply_plan.narration`（`narrationOf`）、streamed content 最终 line、host transcript 新行都清洗；UI 不渲染 streaming delta（当前 production 无 `onLine` 消费）。
- **未覆盖**：
  1. `onTextDelta`/`PlaySessionEnvironment.onLine` 原始 delta（若未来接线）；
  2. 历史会话/archive 中已持久化的旧 `lastLine`（不回溯）；
  3. sanitizer 未处理的 markup 变体（全角尖括号、非 DSML 特殊 token 的其它花样）。
- **未发现**：plan narration 之外的正文/审计新泄漏；prompt 无 cap/设备 id 泄漏；requested 字段不含 cap。

---

## 3. 问题清单

### P0

无。

### P1

**P1-1｜markup-only content + 合法 `apply_plan.narration` 时最终 line 为空，叙事丢失（本轮新增）**
- 位置：`loop.ts:355-366`（narration 只在 lineParts 为空时用，cleanLine 在之后）、`:346-354`；host `play.ts:1199-1203`（空 line + plan → 模板句）。
- 复现（本机 `runTurn` 探针）：runner 流 `<｜｜DSML｜｜ calls>` 并把 `narration='这是合法正文。'` 放进 apply_plan → `line=""`、`plan=true`。
- 影响：真实泄漏样本正好是“content 全是 markup + narration 在 tool call 里”，玩家看到模板句而非模型正文。
- 建议：cleanLine 后若 lineParts 为空且 `narration` 非空，push 已清洗的 narration；补一条测试。属小改。

### P2

1. **多 DSML 块之间正文被贪婪删除**（`loop.ts:462-465` 正则）：探针两 block 中间“乙。”丢失；建议非贪婪/逐块清洗或保留块外文本。
2. **全角尖括号 `＜＞` 不识别**：只归一 `｜`；探针原样泄漏；建议归一 `<`/`>` 仅检测。
3. **JSON 行启发式误删带引号台词**：`isToolJsonLine` 对任意 `[...]`/`{...}`+`"` 生效；探针 `[他说"别动"]` 在 markup 存在时被删；建议严格 JSON.parse。
4. **inline 残留双空格**（P3 观感）。
5. **streaming/历史 lastLine 未清洗**：`onTextDelta` 原始 delta；旧 archive 不回溯；当前 UI 只用最终 line，但 hook/旧局仍有残余。
6. **requested >100/负值展示不一致**：效果框显示原值，右轨 clamp；建议统一。
7. **requested 生命周期测试缺口**：continuation 保留、pause/panic/end 清除无独立断言。
8. **UI 仍静态/CDP**：`effectPercentText`/右轨 fallback 无 vitest。
9. **文档边界**：README/ui-v14 说“普通 `<>`/括号不误删”，但 P2-1/2/3 显示多 block、全角尖括号、带引号方括号台词可被误删；建议在文档写明这些例外（README 的 v13 段落是历史 changelog，保留旧“区间→实际”描述本身合理）。

---

## 4. 交付结论

- **P0=0；P1-1 是新增的真实用户场景缺陷（清洗后 narration 丢失），建议先修（约 5 行 + 1 测试）再交付。**
- 其余 a/b/c 语义：单块 sanitizer、requested 事务/snapshot/UI/CDP、prompt 均通过；P2 为边界/可观测性/测试/文档，不阻断（修 P1-1 后）。
- **结论：需修 P1-1（小改）后，可交付（真机回归除外）**。若 Lead 判定该组合可接受模板句兜底，则 P1-1 可降为 P2，整体可直接交付并记录已知边界。
- 交付前仍需：真实模型样本回归（确保 markup-only content + narration 正常）、真实郊狼 BLE + 真实进程整局；历史 transcript 旧泄漏在交付说明中注明“新回合覆盖、旧存档不回溯”。

---

## 5. 复核记录

- 只读复核：`git diff`（HEAD 16e4a1a → 工作区，11 files +430/−43）+ `analysis/ui-v14.md` + `.ui-shots/t19-request-display/` + 本机 audit；未改源码，唯一写入本文件，未 commit。
- 独立门禁：core 52/748、desktop 18/255、两包 tsc 0、esbuild main/dev-server 0、`node --check play.js` ok。
- 行为探针：`stripToolMarkup` 多 block/全角尖括号/JSON 台词/inline；`runTurn` markup-only content + narration → line 空。
- delta 后门禁：core 52/753、desktop 18/255、tsc 0、build 0；P1-1 探针 line=合法正文（见 §6）。

---

## 6. P1-1 + sanitizer P2 修复复核（delta，2026-11-03 23:02–23:10）

> Lead 已修：`cleanLine` 后再回退 narration；DSML 逐块非贪婪删除；全角 ＜＞ 归一；`isToolJsonLine` 改严格 JSON.parse；
> inline 删除后压双空格。只读复核；diff 11 files **+538/−46**（core loop/tests 更新，host/UI 未再改），
> 源码 mtime ≤23:01；独立门禁 **core 52/753、desktop 18/255、两包 tsc 0、esbuild main/dev-server 0、
> `node --check play.js` ok**。**P1-1 闭环，无新 P0/P1。**

### 6.1 P1-1（markup-only content + narration）— ✅ 闭环

- 实现：`consume` 现在先 `cleanLine()`，再在 `lineParts.length===0 && narration!==''` 时用**已清洗**的 narration
  （`packages/core/src/agent/loop.ts:359-371`）；`narrationOf` 仍先清洗。
- 行为复验（本机 `runTurn` 探针）：stream `<｜｜DSML｜｜ calls>` + `apply_plan.narration='这是合法正文。'`
  → `line="这是合法正文。"`、`plan=true`（修复前 `line=""`）；host 不再落模板句。
- 测试：`agent-loop.spec.ts:962`（adopts plan narration when the content was pure markup）真断言。✅

### 6.2 sanitizer P2 — ✅ 闭环（目标用例）

- **完整 DSML 块/双 block 中间正文**：`block` 正则改为 lazy + 循环逐块删除（`loop.ts:465-475`）；
  测试 `:990`（keeps prose between two leaked blocks）真断言 `甲。\n\n乙。\n\n丙。`。✅
  - 残留 P3 边界：若两个 **单独 `<||DSML...calls>` tag** 之间夹正文（没有成对 block 结构），仍按一个 block 删除中间文本；
    这更像“块内内容”而非块外正文，非本轮目标；不阻断。
- **全角 ＜＞**：`stripToolMarkup` 现在同时归一 `＜＞`（`loop.ts:458-461`）并清洗；测试 `:1007` 全角尖括号真断言。✅
- **JSON 行误删**：`isToolJsonLine` 改为 `JSON.parse` 严格解析（`:496-502`）；`[他说"别动"]` 保留；测试 `:1020`。✅
- **inline 双空格**：末尾 `[ 	]{2,}`→单空格（`:500-502`）；测试 `:1033` 断言 `甲 乙`。✅
- **新 P3（不影响交付）**：归一 `＜＞` 会影响**含 markup 的文本里普通全角尖括号**（输出变 ASCII）；`[ 	]{2,}`
  会压掉正文中故意的连续空格。只在 markup 路径触发，建议后续按需精细处理。

### 6.3 未变的残余 P2（均不阻断）

1. **streaming/历史**：`onTextDelta` 仍转发原始 delta；production UI 不消费 `env.onLine`，最终 line 干净；
   历史 lastLine 不回溯（ui-v14 文档已承认）。
2. **requested >100/负值**：效果框原样显示，右轨 clamp 到 0–100；展示不一致未变。
3. **requested 生命周期**：continuation 保留、pause/panic/end 清除无独立测试（stop/human 有测试）。
4. **UI** 仍只有静态断言 + CDP；`effectPercentText`/右轨 fallback 无 vitest。
5. **文档边界**：README/ui-v14 可注明多 block/全角/JSON 台词等边界（本 delta 已修复主要项，仍建议保留说明）。
6. **真实模型/真实 BLE 回归**：仍待用户硬件；CDP 仍是 stub 宿主。

### 6.4 最终结论（更新）

- **P1-1 已闭环**（clean 后回退 narration，测试 + 探针）；sanitizer 的完整 block、全角尖括号、JSON 台词、inline 空格
  均已修并测试；**无新 P0/P1**。requested 显示/事务/prompt/UI CDP 在前一轮已通过，本 delta 未改它们。
- **最终：可交付（真机回归除外）**。剩余仅 streaming/历史路径、requested 超界/生命周期测试、UI 自动化、文档边界与
  真实硬件回归，均不阻断；建议下一批顺手补 requested 超界展示与 lifecycle 测试。
