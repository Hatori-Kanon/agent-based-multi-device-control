# HW9 抓包索引（2026-11-01）

> 需求文档：`analysis/coospo-hw9-test-plan.md`　工具链（本地、未跟踪）：`analysis/hw9-capture/_tools/`
> 健康数据只存本地；MAC/序列号已脱敏；**不要提交到 git**（`.gitignore` 已覆盖本轮目录）。

## 会话目录

| 目录 | 内容 | 状态 |
|---|---|---|
| [`20261101-174732/`](20261101-174732/) | T0 广播/设备信息、T1 GATT 全量枚举、T2 静息 5m17s、T3 分析、T4 私有通道探针、路线 C Web Bluetooth 交叉验证、T8 重连 | ✅ 完成（含偏差） |
| [`20261101-180827-S2/`](20261101-180827-S2/) | T5 接触/佩戴、T6 运动伪影、T7 精度对照（12 分钟连续抓包 + 阶段切分） | ✅ 完成 |

## 20 行摘要（给 Lead）

1. **Gate A pass**：`0x180D`/`0x2A37` 标准 HRS，未配对直连成功（bleak + Chrome Web Bluetooth 各一次）。
2. 广播里带 `0x180D`；设备 COOSPO HW9，固件 V1.0 / 硬件 V1.4.0 / 软件 V1.1.7，无序列号特征。
3. 静息 5m17s / 318 条，60.2 条/分钟，到达间隔 0.90–1.13s，**无 >3s 空档**，0 断连。
4. `0x2A37` bit4（RR）= 静息 **96.7%**；另有 4.4% 是 `flags=0x00` 的 HR-only 包，集成时必须容忍。
5. RR 共 401 个：中位 747ms，P5/P95 679/793ms，**100% ∈[400,1500]**，静息粗伪影 **0%**。
6. **Gate B 按 §6 字面 fail**：唯一不达标的是"每包 ≥2 RR ≥80%"（实测 30.3%）——这是**分包方式**差异（HW9 每拍 1 个 RR、约 1 包/秒），不是数据缺失。
7. 按**心拍覆盖率**口径（401 RR / ≈414 拍 = 96.9%）+ 范围/伪影判据 → **RR 实质可用**，建议把 §6 判据 2 改成"RR 覆盖心拍 ≥95%"。
8. **限制 1（最重要）：运动时设备直接不发 RR**（走动 2 分钟 120 包 = 0 个 RR；抬臂段仅 6.4%）。运动中只有 bpm。
9. **限制 2：接触状态位不可用**（bit1/bit2 恒 0）。摘下检测靠 **HR=0**，延迟 ≤1.1s；摘下后通知不停（继续 1Hz 空包）。
10. 精度：静息手数 86/82 bpm，设备 87/83 bpm，**偏差 ±1**。
11. 60s RMSSD 中位 20.4ms（17.2–24.6，仅 sanity，不作临床值）；RR 与 bpm 同源（比值 0.971）。
12. 私有服务 `0xFD00` 存在（`fd09`/`fd19` notify + `fd0a`/`fd1a` write）；`fd19` 1Hz 固定 12 字节帧，`fd09` 不写命令无数据 → 官方 HRV 走私有 PPI，**未逆向**（计划要求只记录）。
13. 因标准 HRS 已带 RR，**不需要私有协议**即可满足"动作后 Δbpm + 静息短时 HRV"。
14. 路线 C（我们的 Web Bluetooth 链路）实测可用，后台标签期间 51 条**无缺包**；Web Bluetooth 读不到序列号（SIG 黑名单，正常）。
15. 重连 3/3 成功，3.4–7.4s；1/3 次需重新扫描（交互式 picker 可能要用户重选）。
16. 未做：T8 真并发（涉郊狼刺激，安全闸门）、T9 30min 稳定、Q10 配对缓存对照、手机 nRF 截图。
17. 偏差：T2 静息 5m17s（计划 ≥10min），Gate B 按 5min 窗口判定，结论不受影响。
18. 集成建议：新 kind `hr` 走标准 HRS；容忍无 RR 包；运动中自动降级 `quality=no-rr`；静息/恢复窗口上升到 `rr`。
19. 形态结论：**可作为舒适形态的静息 RR + 全时 bpm 源**；要"运动中 RR"就得 ECM 胸带（Polar H10）。
20. 工具链可复用：`hw9cap.py`（scan/info/gatt/notify/reconnect）、`probe-hw9.py`（多特征并发）、`analyze.py`（离线统计+Gate）、`phase-stats.py`（阶段切分）、`harness.html`（Web Bluetooth）。

## 未做 / 待补

| 项 | 原因 | 补测方式 |
|---|---|---|
| T2 ≥10min 静息 | 用户时间 | 同一命令 `--seconds 600` 重跑，`analyze.py` 直接出数 |
| 手机 nRF Connect 截图（T1） | 已用 bleak 全量枚举，nRF 仅交叉校验 | 手机截图丢 `exports/` |
| T8 与郊狼 B0 并发 | **涉真实刺激输出，需用户显式同意** | 先做"不开刺激只验桥接并发"的版本 |
| T9 30min 连续稳定 | 可选项 | `notify --seconds 1800` |
| Q10 Windows 配对缓存 | 需改系统配对状态 | 设置里配对 → 重扫/重连 → 再解绑，对比可见性 |

## 工具链笔记

- 详见 [`_tools/FINDINGS.md`](_tools/FINDINGS.md)（本机实测：PowerShell/WinRT 事件不可用、WMI 被拒、bleak 路线可用）。
- 执行手册：[`_tools/RUNBOOK.md`](_tools/RUNBOOK.md)。命令手册：[`_tools/README.md`](_tools/README.md)。
- 本轮修了一个工具 bug：`harness.html` 的 `optionalServices` 误用裸短 UUID（Chrome 报 `Invalid Service name`）。
- 一个未定论的问题：`hw9cap.py notify` 在 17:56 那次报"没有特征 2a37"（连接已成功）；当时上一个探针进程
  刚被 kill，可能是连接未释放导致的空 GATT 缓存，也可能是 bleak 3.x 适配回归。**设备已关闭未能复测**；
  本轮采集全部用 `probe-hw9.py` 完成，不影响数据。下次接设备先 `notify --seconds 5` 复现一次。
