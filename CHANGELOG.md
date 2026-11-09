# CHANGELOG

> 正式版本号尚未确定。下面的 `vN` 是内部迭代编号（按开发顺序），用于回溯每次可玩构建；定稿后再把首个发布版本记为 `x.y.z`。

## 仓库整理

- 补齐 `LICENSE`（MIT）与 GitHub Actions `check`（Node 22 + pnpm 10.32.1，typecheck + 测试）
- 新增 `.gitattributes` 固定换行策略，消除 Windows 下的 CRLF 伪 diff
- 生成物 `.archify/` 与本地抓包工具链移出仓库（本地保留，已 ignore）；根目录内容包 zip 移到 `deliverables/`（已 ignore）
- 文档中的真实蓝牙地址脱敏为 `<coyote-1>` / `<coyote-2>`

## v18

- 同型号多设备稳定配对：设备名按序列号持久化，chooser 持久化 BLE 地址空间的 device id（不再用 Web Bluetooth 哈希）
- 两台郊狼同时连接的真机验收记录
- 内容包导入接受长篇 sensation 文案与 easeInOut 曲线

## v17

- 波形柱状图柱距改按物理脉冲周期（1–100 Hz）映射，修正疏密方向

## v16

- 柱状图回到绝对频率疏密、1px 细柱、2x 升采样

## v15

- 柱状图柱距按当前波形自身频域归一化

## v14

- 清理正文中泄漏的 DSML / 工具调用标记；界面只显示模型请求的区间百分比

## v13

- 强度语义澄清：模型只看 0–100% 区间百分比；请求值写入审计，效果框显示「区间 → 实际」
- 未提及的通道默认延续上一回合，只有显式 stop 才停

## v12

- `loop: true` 波形持续播放；自动运行改为区间；同一通道一回合最多一个 beat

## v11

- 同回合同通道命令合并（审计记 superseded）；模型思考期 bounded hold 续接
- 未知波形回退包默认波形；柱状图细化

## v10

- 导演 / 部位管线闭环：包波形进入 registry、无 plan 回合纠正重试、可达部位词表与别名
- 内容包导入改为覆盖安装

## v9

- 自动运行选项与被动超时、回合效果小框、右轨实时强度与波形预览

## v8

- 单列可滚动会话流，最新消息贴底

## v7

- 自动运行、应用内确认框、结束后回到大厅

## v6

- 玩家可自由命名身体部位；内容包 `regions` 降级为可选推荐

## v5

- 部位并入每设备每通道软上限，进入模型提示词与运行时枚举

## v4

- 产品化界面：游玩 / 设备 / 设置三视图、原生单位显示、设置页、去说明文字

## M0 / M1

- M0 安全运行时：`DeviceRegistry`（每设备串行队列）、`EffectRunner`（generation token）、`SafetyPolicy`（只有人类能改边界）、`AuditLog`（append-only JSONL，永不阻塞急停）、`MockBackend`（流式 / 有状态两种失效语义）
- M0 宿主：全局急停热键、带 token 的 `POST /panic`、优雅关闭归零、原子写存储
- M1：两通道独立 pattern 与单独取消、agent 波形按通道上限夹紧、断线后状态恢复
