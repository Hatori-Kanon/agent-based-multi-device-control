# HW9 测试执行手册（Lead 版）

> 对应 `analysis/coospo-hw9-test-plan.md`。这份手册是**执行时的操作顺序**：
> 每步谁动手、跑什么命令、产出落到哪个文件、Gate 怎么判。
> 工具链现状见 [`FINDINGS.md`](FINDINGS.md)，命令细节见 [`README.md`](README.md)。

## 0. 现状（2026-11-01 18:00）

- ✅ 依赖已装：`_tools/.venv`（python 3.10.11）+ bleak 3.0.2，**实测能扫到真实 BLE 广播**。
- ✅ `hw9cap.py` 的 `scan` / `decode` / 错误路径实测通过；`info` / `gatt` / `notify` 正向路径待真机。
- ⏳ HW9 在手但未开机/未佩戴：最近一次扫描窗口内没有 CooSpo 设备。
- 路线：**bleak 主**（全自动、毫秒时间戳、原始 hex）+ **harness.html 交叉验证**（Web Bluetooth 链，计划路线 C）+ 手机 nRF Connect 作权威截图（T0/T1）。

## 1. 命令别名（每次会话先设，仓库根执行）

```powershell
cd E:\Harness\DSH\Agent-based-multi-device-control
$HW9PY = "analysis\hw9-capture\_tools\.venv\Scripts\python.exe"
$CAP   = "analysis\hw9-capture\_tools\capture\hw9cap.py"
$ANA   = "analysis\hw9-capture\_tools\analysis\analyze.py"
```

## 2. 用户侧准备（60 秒，一个人一分钟能做完）

1. HW9 充满电、**开机**（臂带通常短按/长按电源键，指示灯闪）。
2. 光学面/电极擦干净，**上臂佩戴，避开肘窝**，贴合不勒。
3. 手机 **CooSpo 官方 App 强制停止**（后台挂着会占连接）；手机放远一点，别让它自动回连。
4. Windows：设置 → 蓝牙和设备 → 若列表里有 HW9，**移除配对**（减少"已配对导致看不到"的坑）。
5. 测试期间**不叠加刺激设备**（首次测试尤其，计划 §8）。

## 3. 会话 S1：设备与广播 + GATT 枚举 + 静息基线（约 20 分钟）

| 步 | 谁 | 动作 | 产出 |
|---|---|---|---|
| S1.0 | Lead | `scaffold.ps1` 建目录 `<TS>-S1` | `meta.json`/`gatt.json`/`notifications.jsonl`/`summary.md`/`README.md`/`exports/` |
| S1.1 | Lead | `& $HW9PY $CAP scan --seconds 20 --out <dir>\exports\scan.jsonl` | T0：广播 name/services/mfr；**Q7**、`0x180D` 是否在广播 |
| S1.2 | Lead | `& $HW9PY $CAP info --address <MAC> --out <dir>\meta-fragment.json` | T0：0x180A 厂商/型号/固件/硬件/序列号、0x180F 电量；**Q7** |
| S1.3 | Lead | `& $HW9PY $CAP gatt --address <MAC> --out <dir>\gatt.json` | T1：全量服务/特征/属性/CCCD；**Q1/Q5** |
| S1.4 | 手机 | nRF Connect 展开全部服务截图 + 导出，丢进 `<dir>\exports\` | T1 权威截图（交叉校验） |
| S1.5 | **用户** | **静坐/静躺 10 分钟，不碰臂带** | — |
| S1.6 | Lead | `& $HW9PY $CAP notify --address <MAC> --service heart_rate --char heart_rate_measurement --seconds 600 --out <dir>\notifications.jsonl` | T2：原始通知流（后台跑，Lead 盯着） |
| S1.7 | Lead | `python $ANA <dir> --rest-start 0 --rest-sec 300` | T3：RR 质量 + **Gate A/B** |

注意：
- S1.6 必须**先开始抓、再让用户静坐**，否则头 10 秒是摆设。Lead 用后台任务跑，不阻塞对话。
- 若 `scan` 扫到名字不是 CooSpo HW9：先按 RSSI 和 services 里有没有 `fdaa`/`180d`/私有 UUID 看，让用户确认哪台是它（别猜）。
- 若 `gatt` 连不上：先查是不是手机 App 又回连了（BLE 外设通常只接受一个中心）。

## 4. 会话 S2：接触/佩戴 + 运动伪影 + 精度对照（约 20 分钟）

| 步 | 谁 | 动作 | 产出 |
|---|---|---|---|
| S2.1 | Lead | `scaffold.ps1` 建 `<TS>-S2`，`notify --seconds 900` 持续记录 | 一整段带标注的通知流 |
| S2.2 | 用户 | 正常佩戴 2 分钟（静） | T5 基线：bit1/bit2 取值 |
| S2.3 | 用户 | **摘下 60s** → 重新戴上 | T5：bit1/bit2 变化、HR 是否归零、通知是否停、恢复时间 |
| S2.4 | 用户 | 原地抬臂 30 次 / 走动 2 分钟 | T6：RR 跳变、丢拍、bpm 跳变 |
| S2.5 | 用户 | 手动数脉搏 30s ×2，报两次计数 | T7：与设备 bpm 的差值 |
| S2.6 | Lead | 按阶段切分统计（`analyze.py` + 人工标注时间段） | **Q4/Q3**（接触位、运动可用性） |

标注方式：Lead 在用户每次"开始/结束"某个动作时记一条时间点（`<dir>\exports\phases.json`），
分析时用该时间窗切分。**数据本身（bit1 翻转、RR 跳变）是主要证据，人工标注只作辅助。**

## 5. 会话 S3：重连 + Windows 配对缓存（约 20 分钟）

| 步 | 谁 | 动作 | 产出 |
|---|---|---|---|
| S3.1 | Lead | `& $HW9PY $CAP reconnect --address <MAC> --times 3 --delay 2` | T8/Q9：重连耗时、是否需要重新选设备 |
| S3.2 | 用户 | 关机 30s → 开机；再走远 5m 回来 | Q9 行为差异 |
| S3.3 | 用户 | Windows 里给 HW9 配对（设置里手动添加） | Q10 配对前/后对比 |
| S3.4 | Lead | 配对后再 `scan` + `gatt` + 一次 `notify` | **Q10**：配对缓存是否让第二次连接看不到设备/连不上 |

## 6. 会话 S4（可选）：T9 长时间稳定 30 分钟

用户戴着静息 30 分钟（可以看剧），Lead 后台 `notify --seconds 1800`，统计丢包率/断连次数/电量变化。

## 7. T8 并发测试：**安全闸门，需要用户明确同意**

计划里 T8 是"与郊狼 B0 流并发"。这涉及真实刺激设备输出，**默认不做**：

- 首次测试保持无刺激（计划 §1 明确要求）。
- 若要做：用户必须明确说"可以"，且先连郊狼、确认无输出、再连 HW9；刺激只允许极低强度或直接不叠加（用 mock/空转验证桥接并发）。
- Q8（"隐藏 worker 单 pending requestDevice"）是我们的 Web Bluetooth 桥问题，正确做法是用 `harness.html` + 我们的 app 各开一次选设备，看是否串行——**不需要真的通电刺激**。

## 8. T4 厂商私有通道（条件触发）

仅当 S1.7 判定 **bit4 恒 0（标准 HRS 无 RR）** 时才做：

1. 从 `gatt.json` 里挑出所有 notify/indicate 的非标准特征。
2. 逐个 `notify --service <厂商> --char <厂商> --seconds 120 --note t4-vendor --out <dir>\exports\vendor-<uuid>.jsonl`。
3. 只记录不猜协议；用 `analyze.py` 的私有通道候选表（中位周期/u16 范围）列候选。
4. 官方 App 的 HRV 页面：打开看有没有数值 → **关掉 App 再抓包**（避免占连接）。

## 9. Gate 判定口径（回答 teammate 的 12 个"定义不清"，Lead 裁决）

| 争议点 | 裁决 |
|---|---|
| B「静息 5min」取哪段 | 默认 T2 抓包**前 300s**；若用户前 5 分钟在动，用 `--rest-start` 指到稳定段，并在 summary 写明 |
| B 判据 2 分母 | **全部通知**（含 bit4=0 的包）——比"只算带 RR 的包"严格，采用严格口径 |
| 伪影率是否含跨包对 | **含**；超范围 RR 也计入（不剔除，剔除会美化数据） |
| Gate C「可疑」量化 | 见 §6 表：非标准 notify 特征存在 + 周期 0.5–2s 或 u16 落在 300–1500 之一 → 候选 |
| Gate A「≥10s」 | 总覆盖 ≥10s（不需连续） |
| 0x0A（bit1=1 且 bit2=0）矛盾包 | 标 `inconsistent`、跳过接触时间轴；仍计入 flags 分布与 Gate B 判据分母 |
| decoded 与 hex 冲突 | **以 hex 为准**；冲突计数单列 |
| 时间源优先级 | `t` > `monoMs` > 行序 |
| B-「bit4 恒 0」 | 不要求严格 100%；`Gate B fail 且 Gate A pass` 即 B- |
| Gate D「Windows 不稳定」 | 需 T8 证据，否则该子项记"未验证" |
| nRF CSV → JSONL | 先人工核对格式，需要时再加转换器；不阻塞主流程 |
| Q6/Q8/Q9/Q10 | 必须人工/多源证据，分析器只给"未验证 + 原因" |

## 10. 数据与隐私

- 所有产物在 `analysis/hw9-capture/`，**不提交 git**（`.gitignore` 已覆盖 `_tools/.local/`、`.venv/`；真实目录交付前 Lead 再确认）。
- 交付物里 MAC/序列号脱敏（`--redact-mac` 默认开）；原始值只允许留在 `_tools/.local/`。
- 心率是敏感健康数据：报告只给聚合统计，不给逐拍 RR 时间序列。
- 失败也要交付：哪一步卡住、错误原文、截图。
