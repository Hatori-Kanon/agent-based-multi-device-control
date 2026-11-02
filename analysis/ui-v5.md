# ui-v5：部位与软上限合并 + 部位→模型的事实投影（2026-11）

> 触发：产品负责人要求「玩家在界面里为每个设备每个通道指定身体部位，把部位设置栏和游玩界面的
> 软上限放在一起，和设备/通道一一对应」，并追问「玩家填写的部位名是否必须完全对应代码要求的
> 名称、我们目前怎样把部位名推给 LLM、玩家部位与内容包不一致会怎样」。
>
> 本文件记录 v5 的决策、实现、验证与仍然存在的限制；`前端界面设计.md` §10 与
> `设备范围与单窗口界面-设计说明.md` §8 是契约摘要，这里是证据与取舍。

## 1. 改造前的事实（代码审计）

- 游玩视图右轨有两张卡： 「连接与部位」（`#devices`，每通道一个**文本框**）与「软上限」
  （`#softCapsRail`）；大厅只有「软上限」（`#softCapsLobby`）。
- 文本框直接 POST 原始字符串到 `/api/region`。`RegionStore` 只接受
  `^[a-z0-9][a-z0-9-]{0,31}$` 的 region id（`packages/core/src/devices/regions.ts` §REGION_ID）：
  - 玩家输入「胸口」「左胸」→ 400 `INVALID_POLICY`；
  - 输入一个合法但内容包没声明的 slug（如 `upper`）→ 能存下，但解析器按 `channel.region ===
    beat.regions[]` 精确比较，永不定点命中，只在 `whole-body` 通配时被驱动（静默降级）。
- 单调用模型（M2 生产路径）的系统提示词只有 boundaries / host / persona / scene（setting +
  当前阶段 note + goal）/ 短 briefs；**没有任何设备、通道、部位、意图表**。
  - `devices_list` 等只读工具虽然暴露给模型，但 `agent/loop.ts` 的 `onToolCall` 只处理
    `apply_plan` 与 `look`；单调用无法把 tool result 发回同一请求，所以模型**从未收到**部位或
    意图清单。
  - 导演/写作拆分管线（`TurnPipeline` / `buildDirectorContext`）在 core 里存在并有单测，但
    desktop 宿主仍走单调用，没有接线。
  - 结果：真实 LLM 回合里 `apply_plan` 的 `intentId`/`regions` 只能靠猜；猜错会被
    `parseBeatPlan` 丢弃（`rule:'intent'/'region'`），多半只剩叙事。这也是 M2 计划 R6 风险
    「plan 合法率低」的未完成缓解项（动态 enum 注入）。
- 部位标签对运行期的唯一影响：`ChannelSnapshot.region` → `resolvePlan` 的 `channelMatchesRegion`；
  `/api/region` 持久化 + `region_change` 审计；导演上下文投影（未接线）。

## 2. 决策

1. **部位不再让玩家自由输入内部 id，而是从当前内容包声明的部位里选。**
   - 内容包 `scenario.regions[]` 就是「叙事部位词表」；`label` 是作者写的中文身体部位名，
     `id` 是稳定匹配键。玩家只看到 label，永远不需要知道 slug。
   - 这样从结构上消灭「玩家名字与内容包 id 不一致」这一类问题；粒度由内容包作者决定
     （需要「左胸」就声明 `left-chest` / 「左胸」）。
   - 没有采用「自由文本 + 自动映射」：需要额外的物理名称存储、归一化/同义词与「映射失败」状态，
     而引擎只能凭包内 id 定点；包没声明的部位本来就不可能被定点，给玩家一个看起来能用的名字
     反而更误导。也没有加「物理名称 + 叙事部位」双字段：v5 目标是把部位并进软上限卡，
     单字段已经能表达「哪个通道在哪个部位」，双字段会多一个控件且当前模型/写作链路用不上。
2. **存档里的旧值不丢，但明确提示。** 不在当前包词表的 region 显示为「已设置的部位」 +
   「内容包未声明」，不暴露原始 id；玩家换一个即可。它仍可被 `whole-body` 通配命中。
3. **把部位真正推给模型（同批修复）。**
   - 每回合生成 3 行世界事实：`可用意图`、`可用部位`（含 `whole-body` 通配，id=label）、
     `已就位部位`（当前有 ready `level` 通道的已声明部位）。
   - 只给部位，不给 deviceId/channelId/实时输出/上限/百分比；避免模型写死设备，也避免数值泄漏。
   - 同时给 `apply_plan` 注入运行时枚举（intentId、regions.items），让模型不再猜 id；静态
     tool schema 仍然不含任何内容包取值。
4. **不一致时的运行期语义保持不变（安全语义不动）**：见 §4 矩阵。UI 层预防新错配，运行期保留
   原设计 S15 的降级阶梯并写审计。

## 3. 实现

### 3.1 前端

- `apps/desktop/src/ui/index.html`：右轨两张卡合并为一张挂载 `#devices`，大厅卡保留
  `#softCapsLobby`；`#softCapsRail` 删除；标题统一「设备与软上限」。
- `apps/desktop/src/ui/play.js`：
  - 单一渲染器 `renderSetup()`，两个挂载点共用；每设备 `.soft-cap`，每通道 `.soft-cap-channel`：
    `.soft-cap-channel-head`（`.tag` + `select.region-pick` + 可选 `.region-warn`）→ 强度行 →
    频率行（仅 `channel.supportsWaveform`）。
  - `regionVocabulary` / `vocabularyPackId` / `vocabularyLoading`；`currentSetupPackId()` 取
    运行中会话的 `packId`，否则取大厅下拉框；`refreshVocabulary(packId, force)` 只在 boot、
    包列表（含 active 版本）变化、下拉 change、会话换包、视图切回时拉取，不进 500ms 轮询；
    404 静默空词表，其它错误 toast。
  - 部位 change → `POST /api/region`，采纳 `body.regions`、同步本地快照的 `channel.region`、
    更新/移除警告；失败按服务端值回滚并 toast。提交值始终是 id（未指定 = `null`）。
  - 焦点：两个挂载点各自 focusout 防抖，焦点完全离开后清签名 + 补一次快照；渲染跳过条件是该挂载
    点含 `INPUT`/`SELECT`，拖滑杆/开下拉不被 2s 轮询重建。
  - 强度/频率单位、min<max 联动、锁定禁用、原生单位换算全部保持 v3/v4 行为。
- `apps/desktop/src/ui/style.css`：新增 `.soft-cap-state`（生命周期色）、`.soft-cap-channel-head`、
  `.region-pick`、`.region-warn`；窄屏 760 下部位下拉独占一行；`.lobby-grid` 改成 0.8fr/1.2fr；
  删除 `.region-row*` 与旧 play-only `.device-card/.device-head`。

### 3.2 宿主 API

- `GET /api/packs/regions?packId=<id>` → `{packId, regions:[{id,label}]}`：
  - 缺 `packId` → 400；包未安装/无 active 版本 → `sendPackFailure` 的 404；无 `packRegions` 依赖
    （控制台测试替身）→ 404；
  - 实现：`bootstrap.ts` → `packRegistry.load(packId)` → `play.ts#regionVocabularyOf`；
    freeform 包返回 `[{id:'whole-body',label:'全身'}]`（与 `scenarioFor` 合成一致）。
- `POST /api/region`、`GET /api/region`、`/api/cap` 语义未变；token 鉴权一致。

### 3.3 core / 宿主提示词

- 新 `packages/core/src/agent/context/world.ts`：
  - `buildWorldFacts({intents, regions, channels, budgetChars?})` → 0–3 行；
  - 行 1 `可用意图：id=meaning；…`（声明序、去重）；空意图表给出「无（本回合不要调用 apply_plan）」；
  - 行 2 `可用部位：whole-body=全身（作用于全部通道）；id=label；…`；
  - 行 3 `已就位部位：id、id`（仅已声明、非 whole-body、存在 `ready=true && region===id` 的通道）；
  - label/meaning 去 `\p{Nd}` 并折叠空白；id 只 trim（契约标识符，模块 doc 注明例外）；
  - 默认 600 字符预算：超预算先丢 readiness 行，再 code-point 截断 + `…`；`<=0` → `[]`。
- `packages/core/src/agent/tools.ts`：`withPlayableEnums(tools, intentIds, regionIds)`：
  只装饰 `apply_plan`，deep-clone `parameters` 后写
  `beats.items.properties.intentId.enum`（空列表则省略，避免非法空 enum）与
  `beats.items.properties.regions.items.enum = ['whole-body', ...去重 regionIds]`；
  不 mutate 输入/静态 `M2_TOOL_SCHEMAS`；其它工具原引用返回。
- `apps/desktop/src/main/play.ts`：
  - `runOneTurn` 冻结本回合 `snapshot` 并只算一次 `resolveContext`；prompt 与 executor 用同一份；
  - `systemPrompt` 把 world facts 作为**强制 `world` 段**传给 `buildSystemPrompt`（不再混进
    briefs）；opening/sensor 仍是 briefs。`world` 段由 prompt 层在可选块之后无条件追加，长人设
    吃满 4000 字预算也保留，且动态内容在末尾不破坏可缓存前缀；
  - `openingBriefText` 用有效意图表过滤 `metaReactions.opening.firstIntent`；
  - `tools: withPlayableEnums(M2_MODEL_TOOLS, intentIds, regions)`；
  - `worldFacts` 只把 `kind==='level'` 通道的 `region`+`device.lifecycle==='ready'` 交给投影。
- `packages/core/src/agent/prompt.ts`：`PromptSectionKey` 增加 `world`，`PROMPT_SECTION_ORDER`
  末位；`boundaries` 与 `world` 永不参与预算牺牲，`buildSystemPrompt` 在预算循环之外追加 world。
- `apps/desktop/src/main/dashboard.ts` / `bootstrap.ts`：新增可选依赖 `packRegions`、路由与
  `regionVocabularyOf`；路由接受可选 `version`（缺省 active 版本）并返回解析后的
  `{packId, version, regions}`；bootstrap 按 `id@version` 缓存词表，安装时清缓存；
  `regionVocabularyOf` 恒把 `whole-body` 放第一项（包没声明也补上）。

## 4. 不一致时的行为矩阵

| 场景 | 模型看到 | 解析/派发 | 玩家看到 |
| --- | --- | --- | --- |
| 玩家从词表选 `hands`，有已连接通道 | `可用部位` 含 `hands=手`，`已就位部位` 含 `hands` | 命中该通道 | 下拉显示「手」 |
| 玩家未指定（`null`） | 该通道不出现在 `已就位部位` | 只有 `whole-body` 意图命中（通配） | 下拉「未指定」 |
| 玩家旧存档 `legacy-spot`（不在当前包） | `可用部位` 不含它，模型不会选 | 包内意图无法定点命中；`whole-body` 仍命中 | 「已设置的部位」+「内容包未声明」 |
| 玩家选了声明部位但没有通道在该部位 | `可用部位` 含它，`已就位部位` 不含 | 执行器匹配 0 通道 → 降级到**所有在线 level 通道**，`degraded:'no-region-match'` + 审计 warning | 无额外 UI（审计可见） |
| 模型输出未声明的 region id | 枚举已限制，正常不会发生 | `parseBeatPlan` 丢弃该 region（`rule:'region'`）；regions 空则回退 `whole-body`；仍写审计 | 台词可能提到部位，但路由是通配 |
| 旧版/API 直接写中文「左胸」 | — | `RegionStore` 400，不落盘 | v5 UI 不再允许输入；API 仍按 shape 拒绝 |

安全边界不受影响：部位只选择「命令去哪」，`/api/cap`/`PolicyStore`/`LOCKED` 仍是唯一的输出边界；
内容包与模型都没有提高上限的路径。

## 5. 验证

- 单测/类型：
  - core：52 files / **674 tests** 全过；`tsc --noEmit` 0 error；新增 `agent-world-facts` 8 条、
    `agent-tools` 扩到 12 条（枚举注入、去重、静态 schema 不变、输入不 mutate）、
    `agent-prompt` 增加「长人设下强制 world 段仍保留」。
  - desktop：17 files / **210 tests** 全过；`tsc --noEmit` 0 error；新增
    `/api/packs/regions` 正常/400/404/token/显式版本/未知版本路径、无 `packRegions` 依赖 404、
    包无 active 版本 404；`play.spec` 新增「单调用提示词含意图菜单 + 已就位部位 + 工具枚举 +
    world 段位置」与 `openingBriefText` 的无效 firstIntent 过滤。
  - esbuild：`main.ts`、`dev-server.ts`（含 UI 文本 loader）构建通过；`node --check play.js` 通过。
- 真实浏览器（headless Chrome + 真实 dev-server + mock 设备 + 已安装 kit 的 `lighthouse-night`
  scenario 包，`EMBODIED_UI_FROM_DISK=1`）：
  - 大厅/右轨标题恰为「设备与软上限」（状态卡之外无重复卡）；`#softCapsRail` 不在 DOM；
  - 每个挂载点 2 设备 / 3 通道 / 3 个部位下拉；选项为「未指定 / 手 / 肩背 / 全身」；
  - 依次给 A 选「手」、B 选「肩背」→ `/api/region` 返回 `mock-pulse:a=hands, mock-pulse:b=shoulders`，
    快照 `channel.region` 同步，两个下拉各自保持；
  - 直接写一个旧值 `legacy-spot` 后刷新：下拉显示「已设置的部位」+「内容包未声明」，
    页面文本不包含原始 id；
  - 无 console/page error；截图见 `.ui-shots/v5/01-lobby-region-picker.png`、
    `02-lobby-first-channel-hands.png`、`03-lobby-stale-region-warning.png`（`.ui-shots/` 为
    gitignore 的临时验证目录）。
- 真实浏览器（未安装包 → 页面打开后装包）：初始 `#packSelect` 为空、三个拾取器只有「未指定」；
  通过安装脚本装入 `lighthouse-night` 后，30s 包轮询内（实测下一次包刷新即触发）`#packSelect`
  变成 `lighthouse-night`，三个拾取器出现「未指定 / 手 / 肩背 / 全身」，无 page error。这覆盖了
  「产品 UI 没有导入按钮、装包后如何让正在打开的页面拿到词表」的路径。
- 真实浏览器（未安装包）：拾取器只有「未指定」，装包后 30s 内自动出现词表（由包列表签名变化触发）。

## 6. 已知限制 / 后续

- **阶段图仍不推进**（既有 M2 限制）；`phaseWindows`/`advanceWhen`/`next`、`corpus.md`、
  `pack.aftercare.text`、`scenario.opening|npcs|secrets`、`## 导演摘要` 的接线状态未变。
- 部位词表取自「当前设置用的包」：会话中途不能换包；大厅换包/换 active 版本会重拉；运行中的
  会话用 `session.packVersion` 固定词表，后台激活别的版本不会改 picker。内容包导入/卸载/版本
  切换仍无 UI（API/脚本）。
- 设备页仍保留直控和软上限（硬件调试/直控用途），与游玩卡的软上限写同一 policy；如果产品上
  要求「软上限只在一处」，下一步可把设备页的范围滑杆移除、只留直控与波形。
- 玩家若想使用内容包未声明的部位名（例如「左胸」），当前设计是让**内容包声明更细的部位**
  （`left-chest` / 「左胸」）；若将来需要「物理名称任意、叙事部位单独映射」，需要新增
  `physicalLabel` 字段与存储/API/提示词，不在 v5。
- 真实 LLM key 下尚未跑回合（本环境没有 key）；单调用提示词/枚举由 scripted runner 单测覆盖，
  仍需真 key smoke test 观察 plan 合法率。
- `## 导演摘要`/split 模式未接线：如果将来启用 `TurnPipeline`，世界事实应改由
  `buildDirectorContext` 提供，而不是继续放在单调用 `world` 段；`pipeline.ts` 里已加注释，
  提醒接线时对 director 的 `apply_plan` 也调用 `withPlayableEnums`。

## 7. 复核记录

### 7.1 独立 adversarial review（HEAD 73f4a07）与修复

复核结论：**无 BLOCKER**；安全面（只读词表路由、facts 无上限/输出、LOCKED 与 cap 夹紧不变）
通过。以下问题已全部修复：

| # | 级别 | 问题 | 修复 |
| --- | --- | --- | --- |
| 1 | MAJOR | 词表失败被缓存成 `[]` 且标记已加载，永久空 picker；force 失败清掉好词表 | `vocabularyRetry`/`vocabularyRetryAt`；失败不标记已加载、同 key 保留好词表、15s 最小重试间隔，force 立即重试 |
| 2 | MAJOR | world facts 只在 briefs，长人设吃满预算会被整体丢掉 | prompt 新增强制 `world` 段（`PROMPT_SECTION_ORDER` 末位、预算循环外追加）；新增长人设测试 |
| 3 | MINOR | 包省略 `whole-body` 时 picker 没有「全身」，与 facts/enum 不一致 | `regionVocabularyOf` 恒把 whole-body 放第一项；测试改为包不声明它也返回 |
| 4 | MINOR | 词表只按 packId、只读 active 版本；会话中途激活别的版本会漂移 | 路由接受 `version` 并返回解析版本；UI 用 `${id}@${version}` 缓存，会话用 `session.packVersion` |
| 5 | MINOR | 无效 `metaReactions.firstIntent` 仍被渲染，与 apply_plan 枚举冲突 | `openingBriefText` 按有效意图表过滤（freeform 也覆盖）；单测 |
| 6 | MINOR | 快速改部位时乱序响应可能把标签拨回，失败回滚用 `regions` 映射会清空后端声明值 | 每通道请求序号，只采纳最新响应；失败回滚到提交前值 `before` |
| 7 | MINOR | 缺 DOM/重试/版本/长 prompt 测试 | 补 dashboard 版本/404 测试、prompt 长人设测试、play 的 firstIntent 测试；pick DOM 由真实浏览器验证 |
| 8 | NIT | 数字只出现在 id 中（可接受），测试断言太窄 | 测试改为先把所有已知 id 去掉再断言无数字 |
| 9 | NIT | `capEditing` 死代码 | 删除 Set 与 focus/pointer 监听 |
| 10 | NIT | split 管线会绕过 `withPlayableEnums` | `pipeline.ts` 加接线注释（split 尚未启用） |
| 11 | NIT | 每次词表请求都完整加载/校验包 | bootstrap 按 `id@version` 缓存，安装时清缓存 |
| 12 | NIT | — | 同 8 |

### 7.2 其余复核

- **Lead 自审**（逐文件 diff）：route 鉴权/400/404 映射、freeform 合成词表、`packRegions` 与
  安装/激活共用 `runPackOp` 串行队列、`refreshVocabulary` 的 in-flight/换包竞态、渲染跳过条件
  （INPUT/SELECT）、`applyRegion` 失败回滚、world facts 只含部位/意图且无百分比/上限/输出、
  `withPlayableEnums` 不 mutate 静态 schema、world 段在预算循环外追加。
- **独立交叉验证**（团队成员，不同环境）：
  - ui-shell：真实 dev-server + CDP，1600/1024/760 三档下 `#softCapsRail` 不在 DOM、右轨恰好
    「状态 / 设备与软上限」两张卡、两个挂载点同源渲染、344px 轨道与窄屏横向溢出为 0、
    生命周期/焦点颜色取 token；页面无 console error。
  - play-ui：临时 DOM stub 真实执行 play.js 的 52 条断言（词表只请求一次、两个挂载点各渲染、
    部位 POST 载荷与回写、警告出现/消失、未指定/词表外占位、锁定只禁滑杆、编辑中不重建、
    失焦补渲染）；复核修复后的 23 条断言（版本化 URL、同 key 去重、失败恢复、force 保留好词表、
    乱序响应、回滚语义）。
  - core：全量 52 files / 674 tests 与类型检查通过；desktop：17 files / 210 tests 通过。
  - Lead：真实 dev-server + mock 设备 + 已安装 kit scenario 包的浏览器验证（§5），以及
    「页面先打开、后装包」的 30s 词表自动出现路径。
- 仍未覆盖：真实 LLM key 下的 plan 合法率 smoke test、真实郊狼硬件、Electron 真机
  （均为既有的人工验收项，不属于本次改动引入）。
