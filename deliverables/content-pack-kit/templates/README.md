# 规范样例（templates/）

这里是**可以直接复制来开工**的内容包样例。两份样例都通过 `tools/validate-pack.mjs` 校验
（与游戏导入用同一套加载器规则），复制后只需要改内容，不要改结构。

> 依据：`deliverables/content-pack-kit/内容包格式要求.md`（以当前代码为准）。
> 建议先读该文件的 §0、§7、§7.5，再动手。

## 1. 两份样例

| 样例 | 模式 | 演示什么 |
|---|---|---|
| `templates/freeform/` | `freeform` | 最小可玩包：`pack.json` + `persona.md` + `setting.md` + `host.md`，不需要 `scenario.json`。引擎自动给「自由沙盒」单阶段和默认意图表。 |
| `templates/scenario/` | `scenario` | 完整包：`session`（时间预算/收尾）、可选 `regions`（推荐部位）、`phases`（阶段图与阶段写作提示）、`feedbackIntents`（意图表，**含 `stop`**）、两个包内波形（`loop: true` 持续纹理 / `loop: false` 一次性纹理）、`history` + `metaReactions`（跨会话记忆）。 |

## 2. 复制与校验

```bash
# 在仓库根目录执行（把 <你的目录> 换成复制出来的目录）
cp -r deliverables/content-pack-kit/templates/scenario <你的目录>
node --no-warnings --experimental-transform-types deliverables/content-pack-kit/tools/validate-pack.mjs <你的目录>
```

Windows 上也可以把目录拖到 `deliverables/content-pack-kit/校验内容包.bat` 上。

最少要改的地方：

1. `pack.json`：`id`（小写字母/数字/连字符，全局唯一）、`name`、`version`（从 `0.1.0` 开始，严格 `x.y.z`）。
2. `persona.md`：角色是谁、怎么说话、什么不做；保留 `## 导演摘要` 节（缺失会警告）。
3. `setting.md`：开场场景（每回合全文进提示词，控制在几百字内）。
4. `host.md`：主持节奏（可选；不写就没有"主持风格"这一段）。
5. 想改玩法再动 `scenario.json`；每改一次内容建议升 `version`。

## 3. scenario 样例里值得照抄的细节

- **`stop` 意图不能省**：`scenario` 包会整体覆盖引擎默认意图表；没有 id 为 `stop` 的意图，
  模型就没有"显式停下某个部位"的菜单项（运行期未提及的通道默认延续，见格式要求 §7.5）。
- **`regions` 只是推荐**：可整段省略或写成 `[]`，但**删它之前要同时删掉意图里的 region 引用**
  （本模板引用 `hands` / `shoulders`），或把意图的 `regions` 改成 `whole-body`，否则会以
  `intent.region-undeclared` 拒绝加载。玩家在控制台「游玩 → 设备与软上限」里给每个通道自由命名部位；
  label 请写玩家会输入的身体部位词（别名按「玩家词是 label 子串」命中），且不要带数字
  （world 段会去掉 label 里的数字）。
- **两种波形写法**：`soft-waves.json` 用段落 DSL、`loop: true`（持续到下一 plan/stop）；
  `single-touch.json` 用 `loop: false`（一次性短纹理，保持声明的时长）。
  引用：包内波形写裸 id 或 `<packId>:<id>`；引擎内置波形写 `builtin:<id>`（如 `builtin:tide`）。
  裸写内置名（如 `tide`）运行期能解析，但导入期会 warning，建议内置波形统一带 `builtin:`。
- **阶段推进已接线**：提示词会带会话时间、当前阶段、`advanceWhen`、可推进阶段与阶段时间窗；模型在
  `apply_plan.advanceTo` 里请求推进，引擎只接受当前阶段 `next` 声明过的边，非法值忽略并写审计。
  `phaseWindows` 只作时间窗参考、不自动切阶段；推进后下一回合会注入新阶段的 `phases/*.md`。
  阶段文本请按阶段拆分写，`advanceWhen` 写成模型能理解的自然语言条件。
- **收尾**：`session.aftercareMin` 是唯一生效的时长（测试包建议 `0`）；`pack.aftercare.text`
  当前只校验、不消费，收尾台词请写在 `persona.md` / `host.md` / 阶段提示里。

## 4. 不要做的事

- 不要把 `boundaries` / `aftercare` 写进 `scenario.json`（会警告并忽略，只认 `pack.json`）。
- 不要用 `>`、`<=`、`*`、`||`、预发布版本写 `engine` / `version`（见格式要求 §2）。
- 不要依赖 `corpus.md`、`scenario.opening` / `npcs` / `secrets`、`assets/`、`waveforms/index.json`
  ——这些当前不会进入提示词（见格式要求 §7.2）。
- 不要在同一个意图里写超范围波形（freq 10–240、intensity 0–100、总长 100ms 整数倍、1–600 帧）；
  `durationSec` 只需正数，超过 600 秒只警告，执行时会被通道上限夹紧。
