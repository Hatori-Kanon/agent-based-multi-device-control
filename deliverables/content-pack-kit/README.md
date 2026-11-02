# 内容包制作包（Embodied Roleplay / DSH）

这是一份**可以直接开工**的内容包制作资料：格式说明 + 两个可改的模板 + 校验/打包/安装工具。
目标是让你写完 Markdown 和少量 JSON 之后，能够在正在运行的控制台里导入、开局、试玩。

> 依据：仓库当前实现（`packages/core/src/scenario/loader.ts` / `validate.ts` / `pack-registry.ts`）
> 与冻结设计稿 [`内容包规范.md`](../../内容包规范.md)。本资料以**当前代码实际接受的格式**为准，
> 并单独列出「设计稿有、当前实现还没接上」的差异（见 `内容包格式要求.md` §7），避免你按设计稿写完
> 却发现某个字段没有效果。

---

## 1. 三分钟上手

```text
① 复制模板
   templates/freeform/   ← 先做这个（不写 JSON 也能玩，最快跑通）
   templates/scenario/   ← 需要阶段、意图表、（可选）推荐部位时再用
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

需要 Node ≥ 22.19（与项目要求一致）。安装脚本只用到 Node 内置模块，不需要额外依赖。

---

## 2. 安装脚本怎么找到控制台

`install-pack.mjs` 会按以下顺序找 `<dataDir>/state/dashboard.json`（里面有控制台地址和 token）：

1. `--data-dir <路径>`
2. 环境变量 `EMBODIED_DATA_DIR`
3. 仓库下的 `.dev-data/`（`start-dev.bat` 的默认数据目录）
4. Windows 的 `%APPDATA%` / `%LOCALAPPDATA%` 下 Electron 的 app data（`…/embodied/state/dashboard.json`）
5. `~/Library/Application Support`、`~/.config`（macOS / Linux）

如果有多个控制台在跑，脚本会用**最近写入**的那个，并打印其它候选，避免装错地方。
也可以手动指定：

```bash
node tools/install-pack.mjs my-pack --url http://127.0.0.1:54321 --token <token>
```

导入会**立即激活**新版本（与 `/api/packs/import` 的行为一致）。查看已装内容包：

```bash
node tools/install-pack.mjs --list
```

只打包成 zip、不上传：

```bash
node tools/install-pack.mjs my-pack --zip my-pack.zip
```

> 当前控制台 UI **没有导入按钮**（这是 v4 产品化时裁掉的运维面），导入走上面的脚本或 HTTP API；
> 装好之后，游玩页的内容包下拉会立刻出现它。

---

## 3. 这个目录里有什么

| 文件/目录 | 用途 |
|---|---|
| `内容包格式要求.md` | **权威速查**：全部字段、校验规则、运行期实际读什么、当前实现限制、常见错误 |
| `templates/freeform/` | 轻量包模板：`pack.json` + `persona.md` + `host.md` + `setting.md`，无需 `scenario.json` |
| `templates/scenario/` | 完整包模板：阶段图、意图表、可选推荐部位、阶段写作提示、一个包内波形资产 |
| `schema/pack.schema.json` | `pack.json` 的 JSON Schema（VS Code 等编辑器可用来自动补全/检查） |
| `schema/scenario.schema.json` | `scenario.json` 的 JSON Schema |
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
- `persona.md`：角色是谁、怎么说话、什么不做。文件末尾保留 `## 导演摘要` 节（当前单调用会读全文，
  但这段是后续导演投影的约定，写了没有坏处）。
- `setting.md`：开场场景。会**每个回合**进入提示词，控制在几百字以内。
- `host.md`：节奏与收尾要求（可选；不写就用引擎默认 host）。

freeform 不需要 `scenario.json`；引擎会自动给一个「自由沙盒」单阶段 + 默认意图表
（`probe-touch` / `ambient-field` / `escalate-step` / `soothe` / `stop`）。

### scenario（完整包）

在 freeform 的基础上再加：

- `scenario.json`：`session` / `regions` / `phases` / `feedbackIntents`。
- `phases/<阶段id>.md`：每个阶段的写作提示（只有当前阶段那篇会注入；缺失只用 goal+警告）。
- `waveforms/*.json`：包内波形资产（可选；`suggest.waveform` 用裸 id 或 `builtin:<id>` 引用）。
- `pack.json#mode` 改成 `"scenario"`。

**注意（重要）**：当前 M2 实现里，阶段图能通过校验，但**不会自动推进**；`phaseWindows`、
`advanceWhen` 目前不参与运行。因此完整包现在实际能测到的是：意图菜单与部位定点（两者都进入
提示词并作为 `apply_plan` 的运行时枚举）、部位降级、包内波形、开场/收尾时长、跨会话记忆
（`history` + `metaReactions`）。详见格式要求 §7。
第一次测试建议先用 `templates/freeform/` 跑通链路，再做 scenario 包。

---

## 5. 校验 / 安装输出怎么看

- `✅ 校验通过` 后面会打印摘要；`⚠️ 警告` 不阻止加载，但建议修（比如缺 `phases/x.md`、`boundaries` 为空）。
- `❌ 校验未通过` 会给出 `文件 (JSON 路径) [规则 id] 原因`，按文件去改即可。
- 安装成功会打印 `已安装并激活 <id>@<version>` 和当前已装列表。

常见错误与修法见 `内容包格式要求.md` §9。

---

## 6. 其他说明

- **内容包是数据不是代码**：不执行脚本、不联网、不能提高设备上限；引擎只按人类设定的区间执行。
- 版本：同一个 `id` 可以并存多个 `version`，但只有一个 active；导入新版本会自动激活。
  测试阶段建议每次改内容就升 `version`（比如 `0.1.1`），避免「已安装」冲突。
- 测试时如果需要重新安装同一版本：先改版本号，或在控制台 API 里卸载（当前 UI 没有卸载入口）。
- 如果控制台没有运行，安装脚本会提示找不到 `dashboard.json`；先 `start.bat` / `start-dev.bat`。
- 本制作包里的 `tools/` 依赖仓库源码（`packages/core/src/scenario/loader.ts`）才能做完整校验。
  在本仓库内使用无需配置；如果解压到仓库外，请设置 `EMBODIED_REPO=<仓库根目录>`（Windows：
  `set EMBODIED_REPO=E:\Harness\DSH\Agent-based-multi-device-control`）再运行校验/安装。
  找不到仓库时只做基础检查（`pack.json`/`persona.md` 存在且 JSON 合法），安装脚本会提示跳过完整校验。
