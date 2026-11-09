# 内容包制作包（Embodied Roleplay / DSH）

这是一份**可以直接开工**的内容包制作资料：格式说明 + 两个可改的模板 + 校验/打包/安装工具。
目标是让你写完 Markdown 和少量 JSON 之后，能够在正在运行的控制台里导入、开局、试玩。

> 制作包版本：**v16（2026-11-03）**，与仓库 `main`（M2 + 界面 v16；v16 只改波形图渲染，
> 不影响内容包格式）及 `packages/core/src/scenario/{loader,validate,intents}.ts` 校对。
> 依据：当前代码实现 + `导演与写作上下文契约.md` §3 的运行时修订 v0.1.1–v0.1.5。
> 本资料以**当前代码实际接受的格式**为准，并单独列出「设计稿有、当前实现还没接上」的差异
> （见 `内容包格式要求.md` §7 当前实现边界、§10 与冻结设计稿的差异）——避免你按设计稿写完
> 却发现某个字段没有效果。

---

## 1. 三分钟上手

```text
① 复制模板
   templates/freeform/   ← 先做这个（不用写 scenario.json，最快跑通）
   templates/scenario/   ← 需要阶段、意图表、（可选）推荐部位时再用（已带 stop 与两种 loop 波形样例）
② 改文件
   pack.json   ：id / name / version / mode / rating / boundaries
   persona.md  ：角色人设（必须非空）
   setting.md  ：场景（每一回合都会注入，建议短）
   host.md     ：主持节奏（可选）
③ 校验（在仓库根目录执行）
   node --no-warnings --experimental-transform-types deliverables/content-pack-kit/tools/validate-pack.mjs <你的目录>
④ 安装（自动找正在运行的控制台与 token）
   node deliverables/content-pack-kit/tools/install-pack.mjs <你的目录>
⑤ 打开控制台「游玩」→ 内容包下拉选择它 → 开局
```

Windows 上也可以把目录**拖到 `校验内容包.bat` / `安装内容包.bat` 上**，或在命令行里运行它们。
它们会自动带上 Node 需要的 `--experimental-transform-types` 参数。

> 控制台「游玩 → 开局」卡里也有「导入内容包」按钮：直接选 zip 即可校验、安装并激活（等价于第 ④ 步）。

需要 Node ≥ 22.19（与项目要求一致）。安装脚本只用到 Node 内置模块，不需要额外依赖。

---

## 2. 安装脚本怎么找到控制台

`install-pack.mjs` 会按以下顺序找 `<dataDir>/state/dashboard.json`（里面有控制台地址和 token）：

> 本节的命令都在**仓库根目录**执行；在 `deliverables/content-pack-kit/` 里执行时，
> 把 `deliverables/content-pack-kit/tools/` 换成 `tools/`。

1. `--data-dir <路径>`
2. 环境变量 `EMBODIED_DATA_DIR`
3. 仓库下的 `.dev-data/`（`start-dev.bat` 的默认数据目录）
4. Windows 的 `%APPDATA%` / `%LOCALAPPDATA%` 下 Electron 的 app data（`…/embodied/state/dashboard.json`）
5. `~/Library/Application Support`、`~/.config`（macOS / Linux）

如果有多个控制台在跑，脚本会用**最近写入**的那个，并打印其它候选，避免装错地方。
也可以手动指定：

```bash
node deliverables/content-pack-kit/tools/install-pack.mjs my-pack --url http://127.0.0.1:54321 --token <token>
```

导入会**立即激活**新版本（与 `/api/packs/import` 的行为一致）。查看已装内容包：

```bash
node deliverables/content-pack-kit/tools/install-pack.mjs --list
```

只打包成 zip、不上传（不需要控制台在运行）：

```bash
node deliverables/content-pack-kit/tools/install-pack.mjs my-pack --zip my-pack.zip
```

> 控制台 **游玩 → 开局** 卡里有「导入内容包」按钮，直接选 zip 即可安装并激活（等价于上面的脚本）；
> 也可以继续用脚本或 HTTP API。装好之后，游玩页的内容包下拉会立刻出现它。

---

## 3. 这个目录里有什么

| 文件/目录 | 用途 |
|---|---|
| `内容包格式要求.md` | **权威速查**：全部字段、校验规则、运行期实际读什么、当前实现限制、常见错误 |
| `内容包规范.md` | **设计冻结稿快照**（同步自仓库根，含 2026-11-04 D8 修订）；运行时与作者口径以 `内容包格式要求.md` 为准 |
| `templates/README.md` | **规范样例说明**：两份样例各演示什么、复制后改哪里、哪些坑不要踩 |
| `templates/freeform/` | 轻量包模板：`pack.json` + `persona.md` + `host.md` + `setting.md`，无需 `scenario.json` |
| `templates/scenario/` | 完整包模板：阶段图、带 `stop` 的意图表、可选推荐部位、阶段写作提示、两个包内波形（`loop:true` / `loop:false`）、`history` + `metaReactions` |
| `schema/pack.schema.json` | `pack.json` 的 JSON Schema（VS Code 等编辑器可用来自动补全/检查，已按 v15 校对） |
| `schema/scenario.schema.json` | `scenario.json` 的 JSON Schema（已按 v15 校对） |
| `tools/validate-pack.mjs` | 调用**仓库自己的**加载器校验目录，输出与游戏导入完全一致的结论 |
| `tools/install-pack.mjs` | 校验 → 打包 zip → POST `/api/packs/import`；也支持 `--list` / `--zip` / `--activate` |
| `校验内容包.bat` / `安装内容包.bat` | Windows 一键包装 |

### 在编辑器里启用 Schema 校验（可选）

把下面两行加到 VS Code 的 `settings.json`（路径按你放本制作包的位置调整）：

```json
{
  "json.schemas": [
    { "fileMatch": ["**/pack.json"], "url": "./deliverables/content-pack-kit/schema/pack.schema.json" },
    { "fileMatch": ["**/scenario.json"], "url": "./deliverables/content-pack-kit/schema/scenario.schema.json" }
  ]
}
```

Schema 只做早期提示；**最终以 `validate-pack` 的结论为准**。

---

## 4. 模板改哪里

### freeform（推荐先做）

- `pack.json`：把 `id` 改成你自己的（小写字母/数字/连字符），`name` 写展示名，`version` 从 `0.1.0` 开始。
- `persona.md`：角色是谁、怎么说话、什么不做。文件末尾保留 `## 导演摘要` 节（缺失只会警告；
  当前单调用读全文，但这段是后续导演投影的约定）。
- `setting.md`：开场场景。会**每个回合**全文进入提示词，控制在几百字以内（`persona.md` + `host.md` +
  `setting.md` 共享约 4000 字符预算，谁先超就截谁、后面的块直接不进提示词（人设太长会连带丢场景和事实块））。
- `host.md`：节奏与收尾要求（可选；不写就没有「主持风格」这一段，**没有引擎默认 host 文本**）。

freeform 不需要 `scenario.json`；引擎会自动给一个「自由沙盒」单阶段 + 默认意图表
（`probe-touch` / `ambient-field` / `escalate-step` / `soothe` / `stop`）。

### scenario（完整包）

在 freeform 的基础上再加：

- `scenario.json`：`session` / `phases` / `feedbackIntents`，以及**可选**的 `regions`（作者推荐部位）。
  意图表里**请包含 id 为 `stop` 的意图**：scenario 包会整体覆盖默认意图表，没有它就失去了「显式停下」。
- `phases/<阶段id>.md`：每个阶段的写作提示（只有**当前阶段**那篇会注入；模型推进阶段后自动切换到下一篇）。
  缺失只警告，但建议至少给第一个阶段写一篇。
- 阶段推进：提示词每回合会带**会话时间**（已进行/计划/百分比/剩余）、当前阶段、`advanceWhen`、可推进阶段
  与阶段时间窗；模型在 `apply_plan.advanceTo` 里请求推进，引擎按 `next` 校验后执行（非法值忽略并写审计）。
- `waveforms/*.json`：包内波形资产（可选；包内波形用裸 id 或 `<packId>:<id>` 引用，
  引擎内置波形用 `builtin:<id>`）。`loop:true` 表示持续播放到下一 plan/stop；一次性短纹理请显式 `loop:false`。
- `pack.json#mode` 改成 `"scenario"`。

`regions` 的 label 要写成玩家会输入的身体部位词（别名按「玩家词是 label 子串」命中），且不要带数字。
省略 `regions` 本身只会警告；但模板里的意图还引用着 `hands` / `shoulders`，删 `regions` 时要把意图的
`regions` 一起删掉或改成 `whole-body`，否则会以 `intent.region-undeclared` 拒绝加载。

**注意**：阶段推进是**模型请求 + 引擎校验**（2026-11-04 起）。`phaseWindows` 只作为提示词里的时间窗参考，
**不会自动切阶段**；模型需要在 `apply_plan.advanceTo` 里显式请求，且只能走当前阶段 `next` 声明过的边。
完整包现在实际能测到：意图菜单与部位定点、部位降级、包内波形、开场 brief、**阶段推进与阶段提示切换**、
时间预算/强制收束、收尾与跨会话记忆。详见格式要求 §7。
第一次测试建议先用 `templates/freeform/` 跑通链路，再做 scenario 包。

再记三条运行期约束（详见格式要求 §7.5）：**一回合每通道最多一条命令**（要连续动作请拆到下一回合）、
**同通道 loop 只能最后一拍**、**未提及的通道默认延续，要停必须用 `stop` 意图显式停**。

---

## 5. 校验 / 安装输出怎么看

- `✅ 校验通过` 后面会打印摘要；`⚠️ 警告` 不阻止加载，但建议修（比如缺 `phases/x.md`、`boundaries` 为空）。
- `❌ 校验未通过` 会给出 `文件 (JSON 路径) [规则 id] 原因`，按文件去改即可。
- 安装成功会打印 `已安装并激活 <id>@<version>`（同版本重导显示 `已安装并激活（覆盖）`）和当前已装列表。

常见错误与修法见 `内容包格式要求.md` §9。

---

## 6. 其他说明

- **内容包是数据不是代码**：不执行脚本、不联网、不能提高设备上限；引擎只按人类设定的区间执行。
- 版本：同一个 `id` 可以并存多个 `version`，但只有一个 active；导入会自动激活该版本。
  同 `id@version` 重导不是错误：会覆盖安装到同一目录（同名文件覆盖，新包里没有的旧文件
  被清理），状态行/脚本显示「已导入（覆盖）」/「已安装并激活（覆盖）」。
- 测试时仍建议改内容就升 `version`（比如 `0.1.1`）：这样旧版保留、可随时切回做对比。
  想重装同一版本直接重导即可。版本切换用 `install-pack --activate id@version` 或
  `POST /api/packs/activate`；**卸载当前没有任何入口**（UI / HTTP / CLI 都没有，core 的
  `PackRegistry.uninstall` 未接线）。
- 覆盖安装对下一次开局生效；进行中的会话仍用启动时加载到内存的包。
- 如果控制台没有运行，安装脚本会提示找不到 `dashboard.json`；先 `start.bat` / `start-dev.bat`。
- 本制作包里的 `tools/` 依赖仓库源码（`packages/core/src/scenario/loader.ts`）才能做完整校验。
  在本仓库内使用无需配置；如果解压到仓库外，请设置 `EMBODIED_REPO=<仓库根目录>`（Windows：
  `set EMBODIED_REPO=E:\Harness\DSH\Agent-based-multi-device-control`）再运行校验/安装。
  找不到仓库时：`validate-pack` 会直接报错退出（exit 2）；`install-pack` 会退化为只检查
  `pack.json`/`persona.md` 是否存在且 JSON 合法，并提示跳过完整校验。

---

## 7. 本制作包更新记录

| 日期 | 内容 |
|---|---|
| 2026-11-04（阶段推进） | `apply_plan` 新增可选 `advanceTo`（模型请求、引擎只接受当前阶段 `next`，写 `phase_advance` 审计）；提示词每回合注入会话时间/当前阶段/`advanceWhen`/可推进阶段/阶段时间窗；`phaseWindows` 只作参考、不自动切阶段；推进后自动切 `phases/<id>.md`；**所有新会话都从第一个阶段开始**（正常结束、暂停或崩溃未完成都不恢复阶段；未完成快照只保留为快照/账本事实，供内容包后续“特殊阶段”逻辑使用） |
| 2026-11-04（D8 修订） | 强度三档改为 **25/50/80**（旧 40/70/100 废止，仍相对玩家软区间）；提示词改为**优先用 `targetPercent` 连续表达**、不再规定“普通强度”区间；明确波形 `intensity` 是脉宽/纹理而非整体幅度（幅度由 strength/targetPercent 决定，不做乘法）；**80% 以上的“惩罚”属剧本玩法**，写进 persona/host/phases，引擎不做惩罚、不降上限。同时把更新后的 `内容包规范.md`（设计冻结稿）随包同步一份。 |
| 2026-11-03（v15/v16） | 按当前代码复核全部字段与运行期消费：修正 `regions` 可选/可达词表、意图表必须带 `stop`、波形校验细节（segments/frames 差异、大小写 `.JSON` 静默忽略、`license` 忽略）、收尾与 `plannedMinutes` 的真实行为；新增格式要求 §7.5 运行期约束、修正 §10 差异表。样例补 `stop` 意图与 `loop:false` 波形，新增 `templates/README.md`；`schema/*` 同步更新；修复两个 `.bat`（原文件把 `\f`/`\v` 写成了控制字节，命令路径失效）与 `install-pack --zip`（现在不需要控制台）。 |
