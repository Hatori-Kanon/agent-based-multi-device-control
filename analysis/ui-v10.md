# ui-v10：导演/部位闭环与内容包覆盖导入（2026-11-03）

> 用户反馈（本轮）：
> 1. **导演感觉没起作用，针对部位的输出只偶尔出现一次，跟写作文本完全不符合。**
> 2. **内容包的导入应该是复制/解压到项目自己所需的目录；文件名重复就覆盖，而不是不能导入。**
>
> 同时要求审查 `session-f7041a49-…` 会话（v4–v9）的修改是否到位。
> 独立审计见 [`session-f7041a49-review.md`](session-f7041a49-review.md)：上一轮 44d8e1c 之后
> 真实运行（本机 audit 2026-11-02T23:41–23:43Z = 本地 07:41–07:43）仍复现全部症状，**不是旧构建/没重启**问题。

## 0. 真实运行证据（上一轮 9 回合，HEAD 44d8e1c 构建）

| 证据 | 数值 |
|---|---|
| 有 `plan_resolved` 的回合 | 5 / 9（turn 3/5/7/8 **完全没有 plan**，模型只写正文） |
| 带 `waveformId` 的下发 | 21 次中 **19 次 rejected**（`UNKNOWN_WAVEFORM`），44d8e1c 后 5/5 全拒 |
| 正强度真实下发 | 整局 **只有 1 次**（turn 6：coyote a 4%/4s） |
| 效应小框空的主因 | 无 plan（4 回合）× 波形全拒（5 回合）× effectSummary 过滤掉 fallback 下发 |

结论：v9 的修复把“模型输出合法波形 id”修到了 model→resolver 这一段，但 **resolver→registry 从未打通**；
“只写正文不调 `apply_plan`”的回合被引擎当成成功；world facts 同时给两套互不相交的部位词表，
resolver 精确匹配失败后 fallback 到**所有在线通道**，于是“文本说小穴、实际驱动全部通道/不驱动”。

## 1. 修复

### 1.1 包内波形真正可派发（P0）

- `WaveformLibrary.addSessionWaveform(waveform)`（core）：宿主在开局把 `pack.waveforms` 装进
  **session scratch**（按 canonical id `<packId>:<localId>`），`dispose` 时 `clearSession()`。
  这是 `DeviceRegistry` 的 `runPattern/setWaveform → library.require()` 唯一认识的作用域。
- `resolveWaveform()`（core）返回**解析后的 canonical `waveform.id`**，而不是请求引用：
  `tentacle-crawl` → `tentacle-shadow:tentacle-crawl`，`builtin:tide` → `tide`（内建库已有）。
  这样包内 `suggest.waveform` 的裸 id / `builtin:` 前缀都能走到 registry。
- 效果：`run_pattern`/`set_waveform` 不再因包波形被整 action rejected；右轨 `channel.waveform` 有值，
  `/api/waveforms/preview` 能取到帧数据，滚动柱状图因此有数据可画。

### 1.2 “有正文没 plan”不再静默成功（P0）

- `runTurn()`（core）：只要 `plan === undefined && !applied` 就纠正一次——首轮正文作为 assistant 消息回灌，
  再发一条强制 `apply_plan` 的 user 纠正；纠正轮正文成为本回合 line，首轮正文作为兜底。
- 纠正请求自身传输失败时：返回“无 plan 但有正文”的成功回合（恢复首轮正文 + warning），
  不让修复前的成功形态变成失败；caller abort / turn timeout 语义不变；已经开始 dispatch 的纠正轮不吞错。
- 效果：审计里那 4 个无 `plan_resolved` 的回合，现在至少会再请求一次；成功则产生真实下发与效果框。

### 1.3 可达部位词表 + 包 id→玩家词别名（P0）

- `targetableRegions()`（host）：world facts 的「可用部位」与 `apply_plan.regions` 枚举只列
  **ready level 通道上真实存在的部位**（玩家自由词或玩家选用的包 id）。没有任何已标注的 ready 通道时**只给
  `whole-body`**（不再回退完整包词表；未标注硬件用 whole-body 驱动全部在线通道，但不会诱导模型写具体包 region id）。
- `regionAliasesOf()`（host）+ `ResolveContext.regionAliases`（core）：内容包 region label 里包含玩家部位词时
  （如 `核心敏感区（阴部/阴茎/阴蒂/大腿内侧）` ∋「阴蒂」），beat 里沿用包 id 也能落到玩家通道，
  而不是 fallback 驱动全部通道。
- `TURN_PROTOCOL` 强化：regions 只能取「已就位部位」名字（whole-body 例外）；有就位部位时 beats 至少一个带
  regions 的动作；narration 必须写本回合实际作用的玩家部位。

### 1.4 效果框 = 真实下发（P1）

- `effectSummary()` 删除 v9 的 `beat.regions.includes(channel.region)` 过滤（它把 fallback 成功下发全部藏掉）；
  现在保留所有非 `rejected` action，部位用 dispatch 后通道的玩家 label，按
  `(device, channel, region, percent, waveformId)` 去重。
- 有 plan 或非 rejected 下发但正文为空时，用契约模板句 `WRITER_TEMPLATE_LINE`（`（短暂停顿）`）占位并写
  transcript，保证“动作执行了但写作失败”的回合仍有效果框；模板句不写审计。

### 1.5 内容包导入 = 覆盖安装（P0，用户需求 2）

`PackRegistry.install()`（core）：

1. 校验（zip → loadPack/validatePack → id/version）仍然全部在**任何写盘之前**；
2. 同一 `id@version` 已安装时不再抛 `already-installed`，而是在同一前缀
   `content/packs/<id>/<version>/` 重写 zip 文件（同名覆盖）；
3. 删除旧安装里新 zip 不再包含的陈旧文件；
4. 重写 `content/registry.json`（`installedAt` 刷新、name/mode/rating 取新包、`activate:true` 仍决定 active）。

`InstallResult.replaced` 区分首次/覆盖；HTTP 导入不再 400；UI 状态行显示「已导入（覆盖） id @ ver」。
校验失败不动已安装版本；写盘阶段的失败只能回滚“本次新建”的 key（被覆盖旧字节无法恢复，注释写明重导修复）。
文档/工具同步：`deliverables/content-pack-kit/`（格式要求、install-pack.mjs、README）与 `前端界面设计.md`。

### 1.6 对抗复核后的加固（P1/P2，2026-11-03）

首轮修复经独立对抗复核（§[`session-f7041a49-review.md`](session-f7041a49-review.md) §7）后补了 5 处：

- **未标注硬件的词表回退（P1）**：`targetableRegions` 在“没有任何已标注 ready 通道”时返回**空**（不再回退完整包词表），
  world facts 只给 `whole-body`、region enum 也只有 `whole-body`。未标注设备仍能用 whole-body 驱动全部在线通道，
  但不会再把内容包 region id 塞给模型、诱发“文不对部位”的全通道 fallback。
- **离线同部位设备抢走 primary（P1）**：region 展开的 matches 稳定排序 **ready 优先**；`primary` 不会再选中排在前面的
  离线通道导致整拍静默；`round-robin` 只在 ready 池中轮转。全部匹配都离线时仍维持 narrative-only + warning。
- **包波形数量不再受 agent scratch 上限约束（P1）**：`addSessionWaveform` 是 trusted host 路径，去掉 64 上限
  （agent 的 `author`/`importFrames` 仍受限），内容包合法超过 64 个波形不会再让开局失败。
- **开局不再清空人类导入的 session 波形（P1 回归）**：`PlaySession.start` 不再 `clearSession`（设备页在开局前
  `importFrames` 的波形必须保留）；`dispose` 仍按设计丢弃 session scratch。
- **Windows 大小写不敏感覆盖（P2）**：覆盖安装的 created/stale 判断用大小写折叠集合，`remove` 仍用 `store.list`
  返回的原 key；`phases/Resist.md → phases/resist.md` 这类仅大小写改名不会误删刚写入的新文件。
- **session scratch 生命周期（P1-4R / P2-N1 / P2-N5）**：`PlaySession` 记录本局注册的包波形 id，
  `dispose` 只 `removeSessionWaveform(id)` 这些 id（不再全量 `clearSession`）——开局前/跨局人类在设备页导入的
  波形不会被会话边界清掉；PlayHost 的失败开局 catch 会 `dispose`，只回滚本局包波形。host 注册的包波形不再占用
  agent/human 的 64 个 scratch 名额（`addToSession` 只统计非 host 条目）。
- **round-robin 真正轮转（P2-N2/P2-R1）**：宿主每回合把 `roundRobinCursor` 传进 `ResolveContext`，且只有“本回合 plan 中至少一个
  round-robin beat 真实下发（非 rejected）”才 +1（每回合最多一次）；无 plan 回合不占轮转槽，pool=2 时严格 a→b 交替。
  此前宿主从不提供 cursor，生产环境恒选第一个就绪通道。限制：同一 plan 内多个 round-robin beat 共享同一 cursor
  （resolver 是纯函数），即同回合内选同一通道，跨回合才轮转。

## 2. 行为与接口变更

| 变更 | 影响 |
|---|---|
| `WaveformLibrary.addSessionWaveform()` / `removeSessionWaveform()` | 宿主专用（非 agent 路径）；session scratch，按 id 覆盖/移除；不写入 durable；包波形不占用 agent 的 64 槽 |
| `ResolveContext.regionAliases?` / `roundRobinCursor?` | 可选；resolver 仍是纯函数，alias/cursor 不改变安全边界 |
| 无 plan 回合纠正一次 | 每回合最多额外一次模型调用（token 增加）；纠正失败保留首轮正文 |
| `InstallResult.replaced` | 新增字段；`already-installed` 错误码删除（仓库内无引用） |
| 会话 scratch 生命周期 | start 注册包波形并记账；`dispose` 只移除本局包波形；host shutdown 仍 `clearSession`（人类 scratch 终点） |

## 3. 验证

**静态/单测（本机，pnpm 不在 PATH，用 `node_modules/.bin`）**

- `packages/core`：`vitest run` → **52 files / 706 tests passed**；`tsc --noEmit` 通过。
- `apps/desktop`：`vitest run` → **17 files / 228 tests passed**；`tsc --noEmit` 通过。
- `corepack pnpm --filter @embodied/desktop build` → esbuild 5 个产物构建通过（启动脚本会重新构建）。

**真实模型端到端冒烟**（`node --experimental-transform-types`，真实 `state/llm.json` 的 DeepSeek 配置；
一台 waveform-capable mock 双通道/四通道设备，无 BLE 硬件；数据目录临时，跑完删除）

| 场景 | 结果 |
|---|---|
| A：`tentacle-shadow@0.2.0`，通道标注 阴蒂/后穴 | 导入两次：第一次 `replaced=false`、第二次 `replaced=true`；4/4 回合有 plan，**0 个 rejected**；每回合效果框 2 行（阴蒂/后穴 + 实际 percent + 包波形名）；`run_pattern` 6 次全部 ok；旁白出现实际部位名 |
| B：`tentacle-shadow@0.3.0`（用户 active 版本），4 通道标注 小穴/后穴/阴蒂/乳房 | 4/4 回合有 plan、全部 action `dispatched`；**失败的波形操作 0 次**（含包裸 id、`builtin:tide`、namespaced id）；效果框覆盖 4 个玩家部位；旁白分别出现 阴蒂/乳房/后穴/小穴 |

对照上一轮审计：同一模型、同一包、同一玩家词表下，波形拒绝从 19/21 → 0，无 plan 回合从 4/9 → 0，
效果框从“偶尔一次” → 每回合都有。

## 4. 限制 / 未覆盖

1. **真实郊狼波形端到端未在本机验证**：本环境没有 BLE 硬件，冒烟用 `supportsWaveform` 的 mock 后端
   覆盖了“resolver→registry→waveform 选中→snapshot/preview”的完整数据链，但真机的 `BF` 重写与波形
   时序仍需在用户设备上过一遍。
2. 覆盖安装不可逆：被覆盖旧字节无法恢复，写/registry 失败时可能“部分新字节 + registry 旧描述”，重导修复；
   并发 `session.start` 与重导同一前缀时仍可能读到新旧混合（逐文件原子写、无目录级交换）。
3. 空目录残留（stale 清理只删文件）；不影响加载。
4. 区域别名是“玩家词是包 label 子串”的确定性匹配；玩家用与包 label 无关的自造词时，若模型仍使用
   未在「已就位部位」里的包 id，会走 fallback（degraded，效果框可见但不精准）——prompt 已强制只取就位词。
5. 纠偏重试的 timeout/abort 仍按原语义抛错（不拿首轮正文兜底），两次纠正后仍无 plan 的回合只记 warning、
   无设备动作；真实 provider 上“assistant 首轮正文回灌 + 纠正 user 消息”的形状只由单测覆盖（真实模型冒烟
   未触发纠偏路径，因为模型 4/4 回合都调用了 apply_plan）。这些是残余风险，不影响主路径。
6. round-robin 只在**跨回合**轮转：同一 plan 内多个 round-robin beat 共享同一 cursor（同回合内选同一通道）；
   回合 runner 硬失败/超时（`runOneTurn` 抛错）时 cursor 不推进，下个 RR 回合可能重复上一通道。
   另：失败开局的包波形回滚只在 PlayHost 产品路径成立（其 catch 会 `dispose`）；直接调用
   `PlaySession.start` 的嵌入式宿主需自行 `dispose`。
7. `resolveContext.regions` 仍保留完整词表（解析告警/别名需要）；若模型完全无视 enum 硬写未就位的包 id，
   仍会走 fallback 全 ready 通道——效果框会如实显示、协议已禁止，但这是 prompt 软约束。

## 5. 相关文件

- core：[`packages/core/src/agent/loop.ts`](../packages/core/src/agent/loop.ts)、
  [`.../scenario/intents.ts`](../packages/core/src/scenario/intents.ts)、
  [`.../scenario/pack-registry.ts`](../packages/core/src/scenario/pack-registry.ts)、
  [`.../waveform/library.ts`](../packages/core/src/waveform/library.ts)
- host：[`apps/desktop/src/main/play.ts`](../apps/desktop/src/main/play.ts)、
  [`bootstrap.ts`](../apps/desktop/src/main/bootstrap.ts)、[`dashboard.ts`](../apps/desktop/src/main/dashboard.ts)
- UI：[`apps/desktop/src/ui/play.js`](../apps/desktop/src/ui/play.js)（导入状态文案）
- 审计报告：[`analysis/session-f7041a49-review.md`](session-f7041a49-review.md)
