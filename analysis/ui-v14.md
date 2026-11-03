# ui-v14：清理正文中的工具调用标记、只显示模型请求区间百分比（2026-11-03）

> 用户第五轮反馈（附截图）：
> 1. 对话正文出现命令泄漏：`<｜｜DSML｜｜ calls>`、`<｜｜DSML｜｜ invoke name="apply_plan">`、`<parameter name="beats">[...]` 等。
> 2. 对话下的部位输出提示不要写“实际多少”；右侧软上限区域部位下面的强度条也按**模型请求的区间百分比**显示，实际强度后台运算，玩家不需要知道。

## 1. 正文泄漏工具调用标记

**现象与来源**：真实会话状态里保存的 `lastLine` 末尾就有 `<｜｜DSML｜｜ calls>`（全角竖线 U+FF5C），截图中的 invoke/parameter 块也是同一类 DSML 脚手架。这是模型把工具调用的特殊 token 写进了 `content`，而 core loop 之前把 `content` 原文直接当正文。

**修复**：

- `packages/core/src/agent/loop.ts` 新增导出纯函数 `stripToolMarkup(text)`：
  - 全角 `｜`→`|` 仅用于检测；没有任何 markup 信号时**原样返回**（普通 `<`/`>`/括号/日文引号/`[低笑]` 不会被改写）。
  - 依次删除：完整 DSML 块（首个 `<||DSML...` 到最后一个 `<||DSML...calls>`，含 invoke/parameter/JSON）→ 残余 DSML tag → `<parameter>...</parameter>`（可跨行）→ parameter 头+同行 payload → 残余 invoke/calls 标签 → 单行 `<|...>` token → 残留纯 JSON payload 行；折叠空行并 trim。
- `consume` 末尾统一清洗 `lineParts`，`narrationOf()` 也清洗；只有 markup + 无 plan 时 line 为空，触发现有 empty-turn 纠正重试；清洗后为空但有 plan 时 host 仍按模板句占位。
- `TURN_PROTOCOL` 增加：`正文只输出给玩家看的叙事；不要输出 <|...|>、DSML、工具调用语法、parameter/invoke 或任何特殊 token。`

## 2. 只显示模型请求的区间百分比

- **效果小框**：有 `requestedPercent` 时显示 `部位 · 区间 40% · 波形名`；不再出现 `→ 实际 X%`。旧宿主/无 request 路径才回退旧的 `部位 · 55% · 波形名`；`rejected` 不显示、同组合去重。
- **右轨实时强度条**：`updateChannelLive` 优先用 `channel.requestedPercent`（0–100 区间请求）作为填充宽度与数字，title=“模型请求（区间百分比）”；厂商原生/实际 percent 仍由后端运算与审计保存，UI 不展示。字段缺失（手动直控/旧宿主）回退 `channel.percent`，保证人手拖动滑杆仍有反馈。
- 后端：`PlaySession.lastRequested` 在提交延续 body 的同一事务里记录 `action.request.requestedPercent`；stop/percent0、stop 事件、人类直控、pause/panic/end 清除；未提及通道的 continuation 保留。`PlayHost.requestedPercents()` → `DashboardDeps.requestedPercents` → `decorateSnapshot` 给每个 channel 合并 `requestedPercent`（`GET /api/snapshot`，key `device:channel`，不写回 registry）。
- 波形图高度/疏密、软上限滑杆单位、波形名行均不变。

## 3. 验证

- `packages/core`：**52 files / 753 tests**；`apps/desktop`：**18 files / 255 tests**；两包 `tsc` 0；main/dev-server 构建通过。
- core 清洗测试（runTurn 真行为）：尾部全角/半角 DSML、正文中间整块 invoke/parameter、双 block 之间正文保留、全角尖括号 `＜＞`、narration 含 markup、markup-only 无 plan 触发 retry、content markup + narration 合法时回退 narration、严格 JSON 判定（`[他说"别动"]` 保留）、普通 `<>`/括号/`[低笑]` 不误删、inline 删除后双空格压缩。
- host/UI 测试：cap0–20 + targetPercent50 → effect.requestedPercent=50/percent=10、snapshot channel.requestedPercent=50；stop 清空；人类直控清空；dashboard /api/snapshot 返回字段；prompt 含“不要输出特殊 token”。
- CDP 真页面（stub snapshot a.requestedPercent=40 & percent=8）：
  - 效果框 chips：`阴蒂 · 区间 40% · 腔鞘套弄抽吸`、`胸部 · 55% · 涟漪`（旧路径）、`腰 · 区间 70%`；`anywhereSaysActual=false`（无“实际”字样）。
  - 右轨：A 通道 fill=40%/text=40%/title=模型请求；B 通道（无 requested）fill=8% 回退实际；390 窄屏无溢出、无 JS 错误。

![效果框](.ui-shots/t19-request-display/02-effects-crop-1600.png)
![右轨实时条](.ui-shots/t19-request-display/03-rail-live-crop-1600.png)

## 4. 限制 / 残余

1. `turn.agent` 的流式 `onTextDelta` 仍转发原始 delta（本修复只保证最终 `TurnResult.line` 与 narration 干净）；当前 UI 以回合结束后的最终 line 为准，不渲染流式 delta。
2. 历史会话文件里已经保存的旧 `lastLine` 不会被回溯清洗；新回合会覆盖。
3. requested 值是“最近一次被成功提交的模型请求”：preempt/blocked 回合不更新（与延续 body 事务一致）；stop/人类直控后清空，右轨回退显示实际值（手动直控反馈）。
4. 真实 Coyote BLE 波形、真实进程整局仍待硬件回归。

## 5. 相关文件

- core：[`packages/core/src/agent/loop.ts`](../packages/core/src/agent/loop.ts)
- host：[`apps/desktop/src/main/play.ts`](../apps/desktop/src/main/play.ts)、
  [`apps/desktop/src/main/dashboard.ts`](../apps/desktop/src/main/dashboard.ts)、
  [`apps/desktop/src/main/bootstrap.ts`](../apps/desktop/src/main/bootstrap.ts)
- UI：[`apps/desktop/src/ui/play.js`](../apps/desktop/src/ui/play.js)
- 复核：[`analysis/ui-v14-review.md`](ui-v14-review.md)
