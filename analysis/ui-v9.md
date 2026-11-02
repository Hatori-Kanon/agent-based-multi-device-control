# ui-v9：自动运行选项、回合效果小框、通道实时预览（2026-11）

> 反馈：
> 1. 自动运行下还是没有选项；
> 2. 每条新消息下要一个小框，写这次针对的部位和强度-波形；
> 3. 右侧设备栏每个通道要实时预览：部位名与软上限滑条之间一条小强度条 + 数字百分比；
>    波形用柱状图从右往左滚，频率越低柱子越疏、越高越密，强度越高柱子越高。

## 1. 自动运行下的选项

- 去掉上一版“自动模式不生成/丢弃 choices”的限制；`AUTOPILOT_PROTOCOL` 现在要求
  **自动运行回合给 1–3 条 choices**（只有急停/收束等确实不适合选择的回合才可省略）。
- 宿主不再从 `TurnResult` 里丢弃 choices；引擎仍按原语义在 `awaitingChoice()` 时暂停 P3
  自动拍，等玩家点选项后 resume。**自动运行遇到选项会停住是玩家决策点，不是静默/故障。**
- 自动运行下选项有 60s（`EngineConfig.choices.timeoutSec`）被动超时：玩家不选时菜单过期、
  **默认行为 = passive（不补动作）**，然后 autopilot 立刻开下一回合；审计
  `choice_timeout`，不会伪造玩家选择。手动模式不启用该超时（和引擎既有语义一致）。
- 测试：自动开局带 `choices`；自动运行 60s 后菜单消失并联 runner 进入下一回合；
  prompt 不再包含“不要生成 choices”。

## 2. 每条消息的效果小框

- 后端 `PlayTranscriptEntry` 新增 `effects: PlayTurnEffect[]`：
  - 来源是执行器的 `DispatchResult.actions`（真实下发），不是模型 JSON；
  - 每条含 `deviceId/channelId`、部位 id + 玩家词表 label、实际 `percent`、当前通道
    `waveform {id,name}`、intentId、dispatch status（rejected/degraded 等）；
  - 用 dispatch 之后的 registry snapshot，所以本回合选中的波形能反映出来。
- `recentEntries` 仍只保留 8 条给提示词；新增 **`transcriptEntries` 保存整局**，
  `GET /api/session/transcript` 返回全量（UI DOM 自己限 300 条）。否则长会话只有最近 8 条。
- UI 在每条 assistant 旁白下渲染 `.line-effects` 小框（无标签、11.5px）：
  `部位 · 强度% · 波形名`；`rejected` 标「未下发」、`degraded` 标「降级」；
  同一组合去重。玩家消息/系统消息不带效果框。

## 3. 右轨通道实时预览

- 每个通道在 `部位输入` 与 `强度上下限滑条` 之间新增 `.channel-live`：
  - `.live-level`：小强度条 + 数字百分比，数据来自 `snapshot.devices[].channels[].percent`，
    每 500ms 快照轮询更新；
  - 波形通道（`supportsWaveform`）再加 `<canvas.live-wave>` 柱状图。
- 波形数据：新增 `GET /api/waveforms/preview?id=…`（`WebserverDeps.waveformPreview`），
  返回按 25ms slot 展开的 `freq[]`/`intensity[]`（不暴露完整 frame；只给预览）。
  UI 按 waveform id 缓存，只取一次；旧宿主没有该路由时安静跳过，不刷错误。
- Canvas 动画：`requestAnimationFrame`，只在游玩视图且有 session 时绘制：
  - 从右往左滚动（相位随时间增加）；
  - 平均频率低 → 柱距大（疏），高 → 柱距小（密）；
  - 柱高 = 波形 intensity 纹理 × 当前通道 percent；
  - 当前强度为 0 时保留 1px 基线。
- 只有右轨 `#devices` 挂载点渲染实时预览；大厅的软上限卡不重复显示。

## 4. 验证

- 真实浏览器（dev-server + 真实模型 + mock 设备连上并设置部位）：
  - 自动运行开启时开局给出 3 个 choices；
  - 消息下方出现效果小框：`腰腹 · 8%…胸部/乳房 · 8%…`（mock 波形不支持时显示「降级」）；
  - 右轨每个通道出现小强度条与 `0%` 百分比；mock 通道没有波形能力，所以无 canvas；
  - 无原生弹窗、无 console error。截图 `.ui-shots/v9/v9-effect-live.png`。
- 后端单测：transcript 带 effects；`GET /api/waveforms/preview` 200 + freq/intensity 数组；
  自动运行保留 choices、系统续行 user。
- 全量：core 52 files / **682 tests**、desktop 17 files / **216 tests**。

## 5. 限制

- 波形 canvas 只对 `supportsWaveform` 的通道出现；未选择波形时只有基线。
- 预览按波形定义绘制纹理，叠加当前通道强度；不是设备实际输出电压的采样。
- 效果框只展示执行器真实下发的 action；全部 narrative-only（设备未连接/锁定）时为空。
- 自动运行出现 choices 时引擎会停住等待玩家选择；这是引擎既有语义，不自动替玩家选。
- 完整 transcript 在内存中保存整局（通常几十条），刷新后不跨进程恢复（现有会话持久化范围）。