# ui-v6：玩家自由命名部位，内容包部位作为推荐（2026-11）

> 触发：v5 让玩家从内容包 `regions[].label` 里选，产品负责人希望玩家**自由命名**当前会话使用的
> 部位（「左胸」「右大腿」「绑带 2」），并让这个名称进入 LLM；同时问「如果内容包部位只作为
> 推荐，内容包架构还需要变吗」。
>
> 结论：**要变，但只降级一处**：`scenario.regions` 从必填词表变成**可选推荐列表**，不新增文件
> 或字段。玩家文本成为会话 region key，与包推荐共同组成模型可用的部位词表。

## 1. 决策

- **玩家自由命名是主词表**：每个通道一个文本输入；输入与包内 `label`/`id` 完全一致（NFC、trim、
  Unicode 大小写折叠）时提交包 id，保留作者推荐/意图/写作语义；否则提交输入原文，作为会话
  自定义部位 key。
- **内容包 `regions` 保留为推荐**：作者仍可给 3–5 个推荐（手/肩背/全身），它们既是玩家的
  datalist 建议，也是意图默认与写作参考；整段可省略或 `[]`。
- **不做模糊匹配**：不把「左胸」猜成「胸口」；需要同义词就让作者声明 `aliases`（后续）。
- **不新增双字段**：不存「物理名称 + 叙事 region」两个值；一个 key 同时用于定点与叙事，
  简单且不会出现两套真值。
- **安全语义不变**：部位只决定命令去哪；cap/LOCKED/PolicyStore 仍是唯一输出边界。

## 2. 内容包架构变化（回答“还需要变吗”）

| 项 | v5 | v6 |
| --- | --- | --- |
| `scenario.regions` | 必填数组（缺失 = error；`[]` warning） | **可选**（缺失 warning，loader 归一为 `[]`） |
| `regions[].id` | `^[a-z0-9][a-z0-9-]{0,31}$` | 不变（推荐项仍是 slug；玩家自定义 key 不走这个校验） |
| `feedbackIntents[].regions` | 必须引用已声明 id | 仍必须引用已声明 id；**省略默认 `whole-body`**（推荐为空时建议省略） |
| 玩家看到的部位 | 只能从 `regions[].label` 下拉选择 | 自由文本 + `regions[].label` datalist 建议；同名/同 id 自动映射 |
| 引擎可用部位 | 包声明 + whole-body | 包声明 + 玩家自定义 key + whole-body |
| 新增文件/字段 | — | **无** |

因此 “内容包不写预设部位” 是可行的：`regions: []` 或省略，意图不写 `regions`；玩家仍可自由命名
并让模型定点。但**推荐保留 3–5 个**：它们决定意图的默认部位语义、给玩家快捷建议，也让写作有
稳定词表可参考。

## 3. 实现

### 3.1 core

- `devices/regions.ts`：`RegionStore` 的 region key 从 slug 放宽为 **NFC 归一后 trim、1–64 个可见字符**
  （拒绝 C0/C1/Cf/Cs 控制/格式/代理字符、U+2028/U+2029、以及会破坏提示词菜单的 `;`/`；`/`=`）；
  `setByHuman`/`restore`/manifest defaults 都存储归一后的值。旧 slug 仍合法；同名文本 = 同一 region。
- `scenario/validate.ts`：`regions` 缺失 → warning（不再 error）；存在但非数组 → error；
  `[]` → warning；意图 `regions` 仍必须引用已声明 id。
- `scenario/loader.ts`：`normalizeScenario` 把缺失/非数组 `regions` 归一为 `[]`，意图缺省
  `regions: ['whole-body']`。
- `scenario/beat-plan.ts` / `intents.ts`：region 丢弃/降级 warning 的措辞从 “not declared by the
  pack” 改为 “not in this session's region vocabulary”（`ctx.regions` 现在是并集）。

### 3.2 宿主

- `play.ts#sessionRegions(scenario, snapshot)`：包 `regions`（推荐）+ 快照里所有非空
  `Channel.region`（玩家自定义，按出现顺序、去重）；label 用包内 label，自定义就是 key 本身。
- `resolveContextOf`：`ResolveContext.regions` 用这个并集 → `parseBeatPlan`/`intents`/执行器都接受
  玩家自定义 key。
- `worldFacts`：`可用部位` 与 `已就位部位` 用并集；`withPlayableEnums` 的 `regions.items.enum`
  也用并集，因此模型可以直接输出「左胸」作为 region key。
- `openingBriefText` 仍按有效意图表过滤 firstIntent（v5 修复）。

### 3.3 UI

- 每通道 `.soft-cap-channel-head` 内：
  - `<input class="region-input" type="text" placeholder="部位" maxlength="64" list="region-suggest-N">`；
  - `<datalist>` 的 option 来自当前包推荐 `label`（空 label 回退 id），顺序保留（whole-body 最前）；
  - 空输入 = 未指定；Enter（非输入法组合）只 blur，`change` 时提交，不逐键请求；
  - 锁定时仍可编辑（部位不是安全边界）。
- `resolveRegionInput(text)`：NFC + trim；空 → null；id 精确匹配（Unicode 大小写折叠）→ 包 id；
  label 唯一匹配 → 包 id（重复 label 歧义时回退文本）；否则返回归一后的原文。
- `labelForRegion(value)`：包 id 显示为包 label（编辑后归一展示）；自定义值原样显示。
- 不再有「未指定」「已设置的部位」「内容包未声明」等选项/警告——自定义部位是合法状态。
- 词表版本/缓存/失败重试（`packId@version`、15s 重试、404 空表、force 立即重试）保持 v5 修复。
- 请求仍走 `/api/region`；per-channel 序号防乱序；失败回滚到提交前值。

### 3.4 内容包导入（同批）

- 「开局」卡内容包行下新增 `#packImport`（按钮）+ 隐藏 `#packFile`（`.zip`）+ `#packImportStatus`
  （`aria-live`）。产品 UI 仍只有这一个导入入口；没有卸载/版本切换按钮。
- 客户端校验 `.zip` 与 `<= 64 MB`；用 `fetch('/api/packs/import', { body: file.arrayBuffer(),
  headers: {'x-control-token', 'Content-Type':'application/zip'} })`，与安装脚本同一路由、同一
  加载器/校验（导入即激活）。
- 成功后 `refreshPacks()`、选中 `body.pack.id`、强制刷新推荐词表；失败把后端错误
  （`already-installed`/`PACK_INVALID` 等）显示在状态行；导入期间 `busy` 禁用开局/导入。

## 4. 行为矩阵

| 玩家输入 | 提交 | 模型看到 | 解析 |
| --- | --- | --- | --- |
| 空 | `null` | 该通道不在 `已就位部位` | 只有 `whole-body` 命中 |
| 包内 label「手」 | `hands` | `hands=手` | 定点命中该通道；包意图/写作语义保留 |
| 包内 id「hands」/「HANDS」 | `hands` | 同上 | 同上 |
| 自定义「左胸」 | `左胸` | `左胸=左胸` | 定点命中该 key；模型可输出「左胸」 |
| 两个通道都「左胸」 | 两个通道同 key | 词表只出现一次 | 同一意图可同时命中两个通道 |
| 旧存档 slug `legacy-spot` | 保留 | `legacy-spot=legacy-spot` | 作为自定义 key 仍可定点（包不推荐它而已） |
| 控制字符/空/65+ 字符 | `400 INVALID_POLICY` | — | 不落盘，审计 rejected |

## 5. 验证

- core：52 files / **677 tests** 全过（新增 RegionStore 自由 key/NFC/控制字符/分隔符、scenario 可选
  regions/显式 whole-body/loader 归一、玩家命名标签保留数字）；`tsc --noEmit` 0 error。
- desktop：17 files / **211 tests** 全过（新增 play.spec「玩家命名部位进入 facts/enum」）；
  `tsc --noEmit` 0 error；main/dev-server esbuild 通过；`node --check play.js` 通过。
- 真实浏览器（headless Chrome + dev-server + mock 设备 + kit scenario 包）：
  - 3 个 `input.region-input`（type=text、maxlength=64、placeholder=部位、list 绑定），
    datalist 选项「全身/手/肩背」，datalist id 全局唯一；旧 `.region-pick`/`.region-warn` 0 个；
  - 输入「手」→ `/api/region` 存 `hands`，展示归一为「手」；
  - 输入「HANDS」→ `hands`；输入「 左胸 」→ `左胸`，展示「左胸」；
  - 两个通道同名「左胸」→ 两个 device/channel 均映射到同一 key；
  - 清空 → key 删除、API 返回无该键；
  - 无 console/page error。截图 `.ui-shots/v6/01-lobby-region-input.png`、`02-lobby-custom-parts.png`。
- 真实浏览器 · 内容包导入 UI（空 dataDir 的 dev-server + `tentacle-shadow.zip`）：
  - 空列表时内容包下拉为「（没有已安装的内容包）」；
  - 点「导入内容包」→ 选 zip（CDP `DOM.setFileInputFiles`）→ 下拉自动变为
    `tentacle-shadow · 0.2.0`，状态行「已导入 tentacle-shadow @ 0.2.0」；
  - `GET /api/packs` 返回 active 0.2.0；`GET /api/packs/regions?packId=tentacle-shadow` 返回
    `whole-body/全身、inner-thigh、anal、waist、chest`；三个通道的 datalist 已刷新；
  - 无 console error；截图 `.ui-shots/v6import/01-after-import.png`。

## 6. 已知限制

- **不做模糊匹配/同义词**：自定义「左胸」不会自动映射到包推荐「胸口」；要同义请让作者声明
  `aliases`（未来扩展）。
- **split 写作链路未接线**：若将来启用 `TurnPipeline`，writer 的 `regionLabels` 需要把玩家自定义
  key 映射进去，否则写作可能用「身体」兜底；单调用宿主不受影响。
- 包推荐仍会被校验引用一致（intent 引用的 id 必须声明）；完全不写 `regions` 的包要记得让意图
  省略 `regions`。
- 玩家自定义 key 会进审计与提示词；含数字的自定义 key 属于“玩家命名”而非度量泄漏（与 v5 的 id
  例外一致），仍建议不要写数值。
- **词表未加载时的映射**：如果玩家在推荐词表到达前就输入了包内 label（如「手」），它会被当作
  自定义 key 保存；词表到达后不会自动迁移（避免后台改写玩家数据）。重输一次即可映射；推荐词表
  通常在页面 boot 阶段很快到达。
- `;`/`；`/`=` 不能出现在玩家自定义 key 中（会破坏 `id=label；…` 菜单行）；包内 label 出现这些
  字符时，facts 会用空格替代（id 不变）。
- 内容包**导入**已有 UI（开局卡「导入内容包」）；**卸载/版本切换**仍无 UI（脚本/API），
  设备页仍保留独立软上限滑杆（与游玩卡同一 policy）。

## 7. 复核

### 7.1 独立 adversarial review 与修复

复核结论：**无 BLOCKER**；安全面（region 只影响路由、无新写路径、cap/LOCKED 不变）通过。
已修复：

| # | 级别 | 问题 | 修复 |
| --- | --- | --- | --- |
| 1 | MAJOR | `regions: []` + 意图 `regions:["whole-body"]` 被 `intent.region-undeclared` 拒绝 | validator 把 `whole-body` 视为永远合法；补 validate/loader 测试 |
| 2 | MINOR | Cf/Cs/零宽/bidi/代理字符可进 key；无 NFC | key 改为 NFC + 拒绝 `\p{Cc}\p{Cf}\p{Cs}\u2028\u2029`；补拒绝/NFC 测试 |
| 3 | MINOR | 自定义含数字标签被 facts 去数字（`绑带 2` → `绑带`） | `label === id`（玩家命名）跳过 digitFree；补测试 |
| 4 | MINOR | 自定义名可注入 `；`/`=` 破坏菜单 | RegionStore 拒绝这些字符；包 label 在 facts 里降级为空格 |
| 5 | MINOR | 词表未加载时输入包 label 被存成自定义、之后不迁移 | 已知限制（§6）：不后台改写玩家数据，重输一次即映射 |
| 6 | MINOR | 无 Unicode NFC，组合字符形成两个 key | RegionStore/UI 均 NFC 归一；测试覆盖 |
| 7 | MINOR | 文档漂移（kit README/error table、device doc、ASCII 表述） | 已更新 kit README/格式文档、前端设计 §11、设备说明 §9、本文件 |
| 8 | MINOR | 缺少 whole-body/自定义数字/Cf/Cs/映射竞态测试 | 已补 whole-body、数字标签、Cf/Cs/分隔符/NFC 测试；UI 输入仍由真实浏览器验证 |
| 9 | NIT | UI `maxlength=64` 是 UTF-16 单元、store 是码点 | 记录为已知差异（星面字符 UI 更严，不影响安全） |
| 10 | NIT | 输入只在 change 提交，关窗可能丢未失焦编辑 | 与其它页面一致；未加 pagehide 异步 flush（fetch 可能被中断） |
| 11 | NIT | 断开设备的自定义部位仍出现在 `可用部位` | 低优先级；`已就位部位` 已正确排除 |

### 7.2 其余复核

- **Lead 自审**：RegionStore NFC/trim 在 set/restore/defaults/snapshot/audit 一致；旧 slug 与旧
  persisted 值兼容；`scenario.regions` 缺失时 validator/loader 一致归一为 `[]`，意图显式
  whole-body 合法；`sessionRegions` 与 `resolveContextOf`/`worldFacts`/`withPlayableEnums` 用同一
  并集且只收 `level` 通道；UI id 优先、label 唯一匹配、歧义回退文本、空/清空/失败回滚/乱序响应；
  部位输入不进入任何安全边界。
- **真实浏览器**：见 §5；推荐 `全身/手/肩背`、自由文本「左胸」、label/id 映射、同名合并、清空
  均验证，旧 `.region-pick/.region-warn` 为 0，无 console error。
- 仍未覆盖：真实 LLM key 下的 plan 合法率、真实郊狼硬件、Electron 真机（既有的人工验收项）。
