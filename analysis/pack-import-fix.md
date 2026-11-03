# 内容包导入失败修复：长 `sensation` 与 `easeInOut` 曲线（2026-11-04）

> 用户报告：在工作区导入 `mech-restraint.zip`、`succubus-abyss.zip`（均 v0.5.0）时前端报导入失败。
> 结论：不是这两个包故意写错，是引擎侧两条过窄的校验/解析规则把合法资产拒了；已修复，两个 zip
> 现在都能安装并通过 `loadPack`。

## 1. 复现

用与 `POST /api/packs/import` 完全相同的路径复现（`readZip` → `PackRegistry.install` → `loadPack`，
宿主注入 Node `inflateRaw`）：

```
mech-restraint.zip  → ContentPackError: ... ("segments"): each tag must be 1-24 characters (4 more)
succubus-abyss.zip  → ContentPackError: ... ("segments"): each tag must be 1-24 characters (6 more)
```

## 2. 根因 A：`sensation` 被当成 author tag 过了 24 字符上限

`packages/core/src/scenario/loader.ts` 把波形资产的 `sensation`（作者写给"写作投影"看的感觉描述）
追加进 `Waveform.tags`，再交给 `compileWaveformScript`。而 `packages/core/src/waveform/dsl.ts` 对
**author tag** 有 `MAX_TAG_LENGTH = 24` 的限制：

- 这两个包的 `sensation` 是完整句子（22–43 个汉字），不是 "细密/潮汐" 这类短标签；
- 于是 24 字符以上的 `sensation` 触发 `each tag must be 1-24 characters`，错误被归到 `segments` 路径，
  消息里完全看不出真正原因是 `sensation`；
- 命中范围与字数完全吻合：mech 5/8 个波形、succubus 7/8 个波形（≤24 字的那几个通过）。

**修法**：loader 先只把作者写的 `tags` 交给编译器校验，`sensation` 在编译成功后再追加到 `Waveform.tags`
（去重、逐字保留，不再受 24 字符限制）。`frames` 写法原本就不校验 tag，行为保持一致；author tag
仍然受 24 字符上限约束（有测试守住）。

## 3. 根因 B：段落 DSL 不支持 `easeInOut`

两个包有 5 个波形用了 `"curve": "easeInOut"`（线性/缓入/缓出的对称组合），而 DSL 只接受
`linear | easeIn | easeOut | step`，报 `segment N: unknown curve "easeInOut"`。

**修法**：`dsl.ts` 新增 `easeInOut`（对称二次曲线：`t<0.5 → 2t²`，否则 `1-2(1-t)²`），类型、校验表、
测试同步。`[波形系统设计.md](../波形系统设计.md)` 的曲线列表已更新。

## 4. 附带 UI 加固

长 `sensation` 现在会作为长 tag 出现在设备页波形库的标签 chip 里；`.wf-card .tags .tag` 增加
`max-width: 180px + ellipsis`，并给 chip 加 `title`，避免把卡片撑破，悬停可看全文。

## 5. 修复后验证

对两个真实 zip 重新跑同一导入路径：

```
mech-restraint.zip: OK id=mech-restraint version=0.5.0 replaced=false
succubus-abyss.zip: OK id=succubus-abyss version=0.5.0 replaced=false
```

`registry.load()` 复核：

| 包 | 波形 | warnings | stop 意图 | 阶段 |
|---|---|---|---|---|
| mech-restraint v0.5.0 | 8（全部导入） | 0 | 有 | 5 |
| succubus-abyss v0.5.0 | 8（全部导入） | 1 | 有 | 4 |

唯一 warning 是包内容问题、不阻断：`pack.json: "soothe" is not in the pack's intent table; only the tone is injected`
（`metaReactions` 引用了意图表里不存在的 `soothe`；作者把 `soothe` 加进 `feedbackIntents` 或改掉引用即可）。

新增测试：

- `packages/core/tests/scenario-loader.spec.ts`：长 `sensation`（33 字）通过且逐字保留；author tag 25 字仍被拒。
- `packages/core/tests/scenario-pack-registry.spec.ts`：整 zip 集成导入（长 sensation + `easeInOut`）成功。
- `packages/core/tests/waveform.spec.ts`：`easeInOut` 中点/对称性/慢起快中慢收。

门禁：本次改动涉及的 3 个 core 测试文件 **64/64**；全量门禁（含另一并行会话的在途改动）为
`packages/core` **52 files / 760 tests**、`apps/desktop` **18 files / 262 tests**、两包 `tsc 0`、
Electron/dev-server 构建通过。

## 6. 残余 / 后续

1. **agent 侧 `waveform_author` 工具的曲线 enum 仍是 `linear|easeIn|easeOut|step`**
   （`packages/core/src/agent/tools.ts`）：该文件正被另一个并行会话的未提交修改占用，本轮没有动它，
   避免把别人的改动混进提交；等那边落地后把 `easeInOut` 补进 enum 即可。内容包导入不受影响。
2. `deliverables/content-pack-kit/` 的规范文档（另一个并行会话在改）有两处已与实现不一致：
   `sensation` 不再计入 8-tag/24 字限制；`curve` 列表缺 `easeInOut`。需要在那条线同步。
3. 用户侧：重启 `start.bat`（会重新构建 dist）后再导入两个 zip 即可；进行中的会话不会热加载新代码。
