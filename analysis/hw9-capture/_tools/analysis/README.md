# HW9 离线分析器（`analyze.py`）

> 位置：`analysis/hw9-capture/_tools/analysis/`
> 用途：把一个抓包目录（计划 §5 格式）变成 **结构化指标 + Gate A/B/B-/C/D 逐条判定 + Q1–Q10 回答表 + summary 骨架**。
> 约束：纯 Python 标准库、无第三方依赖、无网络、不连硬件；只写 `<capture-dir>`（或 `--out-dir`）。

---

## 1. 快速开始

```bash
# 在仓库根目录（或任意目录用相对/绝对路径）
python analysis/hw9-capture/_tools/analysis/analyze.py analysis/hw9-capture/<时间戳目录>

# 只打印结构化 JSON（stdout 纯 JSON，便于二次处理）
python analysis/hw9-capture/_tools/analysis/analyze.py analysis/hw9-capture/<时间戳目录> --json

# 输出到别处（默认写回 capture-dir，符合计划 §7 的交付物位置）
python analysis/hw9-capture/_tools/analysis/analyze.py <capture-dir> --out-dir /tmp/hw9-out
```

输出（默认写到 `<capture-dir>/`）：

| 文件 | 内容 |
|---|---|
| `analysis.json` | 全部指标的结构化数据（`schema_version=hw9-analysis/1`） |
| `analysis.md` | 中文人读报告：§0 结论摘要 … §13 summary 骨架 |
| 控制台 | 一行式 Gate 摘要（含每条判据的数值→判定） |

**解释器说明**：本机 `python` = 3.10.11 可用；`py -3.12` 也可用（已实测）。PATH 里的 `python3` 是 Windows Store 存根（直接返回 exit 49），不要用它。代码兼容 3.10/3.12，无第三方依赖。

---

## 2. 输入契约

必需：`<capture-dir>/notifications.jsonl`（计划 §5：一行一条 JSON，`hex` 是原始报文）。
可选：`gatt.json`、`meta.json`（缺失时相关指标标 `未验证`，不猜）。

处理规则：

1. **原始 `hex` 是唯一真值**：所有字段按计划附录 A 从 `hex` 重新解码；`decoded` 只用于「解码对照差异」统计（`quality.decoded_mismatch`），不参与任何指标计算。
2. `t`（ISO 8601，支持 `Z`/`+08:00`）优先；其次 `monoMs`（相对时间）；都没有时按行序（时长/间隔/窗口类指标记 `未验证`）。同一通道内不混用两种时间源。
3. 没有 `hex` 字段的行（如 harness 的 device info）按「非通知行」跳过并计数。
4. `service`/`char` 不是 `180D`/`2A37`（含 `heart_rate_measurement` 等别名）的通知归为「非 HRS 通知流」，单独做私有通道候选分析。
5. 容错：坏 JSON 行、空/奇数长度/非法 hex、HR 或 RR 被截断、`bit4=1` 但没 RR 数据、flags bit5–7 置位，都会记录并继续，不中断分析。

---

## 3. 输出结构（`analysis.json`）

```
schema_version / generated_at / capture_dir / options
inputs      { files, meta(脱敏), gatt }
quality     行数、HRS 尝试/成功/解码失败、非通知行、非 HRS 流、坏 JSON 行、
            decoded 对照不一致、时间戳告警
overall     条数/时长/条每分钟/到达间隔/空档/时间源
flags       flags 直方图、bit0–bit4 命中率、RFU 位、包长分布、按 flags 的包长与 RR 数
hr          min/max/中位数/均值/P5/P95、HR=0/缺失/超范围、逐包 ΔHR 分布
rr          per_packet(每包 RR 数)、pool(池统计)、artifact(粗伪影)、
            windows(60s 窗口 + RMSSD)、dropout(arrival + rr_accumulation)、consistency
contact     bit2/bit1 统计、状态分段、切换点、摘下/戴上事件（T5）
motion      10s 分箱、运动段（T6）
private_channels  gatt 非标准 notify 特征、非 HRS 流周期/数值候选（Gate C）
rest_window Gate B 静息窗口内的 4 个判据数值
gates       A / B / B_minus / C / D 的 criteria（每条含 value/阈值/verdict/note）+ decision
qa          Q1–Q10 回答和证据指针
assumptions A1–A21（口径假设，必须人工复核）
warnings    数据质量告警/未验证提示
evidence    文档章节 ↔ JSON 路径映射
```

`analysis.md` 章节：§0 结论摘要、§1 数据质量、§2 通知总体、§3 flags、§4 HR、§5 RR、§6 接触、§7 运动、§8 私有通道、§9 Gate 明细、§10 Q1–Q10、§11 假设、§12 未验证清单、§13 summary 骨架。

**隐私**：报告只含聚合统计；不输出逐拍原始 RR 序列、MAC、序列号；`meta.notes` 内容不写入报告（避免泄露敏感信息）。

---

## 4. 指标定义与判读方法

### 4.1 通知总体
- **条/分钟** = HRS 通知条数 ÷ 捕获时长（分钟）。
- **到达间隔** = 相邻两条 HRS 通知的时间差（文件顺序）；负间隔单独计数并剔除（时间戳非单调）。
- **空档** = 间隔 > `--gap-sec`（默认 3s），列表含起止相对/绝对时间；T2/T6 的「断流」证据。
- 时间源未验证（无 t/monoMs）时这些指标输出 `未验证`，不要用行序当秒数。

### 4.2 flags
- `flags` 直方图（取值、二进制、置位 bit、包数、占比）。
- `bit0` HR 格式（0=uint8/1=uint16）、`bit1` 接触状态、`bit2` 接触能力、`bit3` Energy Expended、`bit4` RR 存在。
- 每个 flags 取值对应的包长分布与 RR 个数分布（判断「每包 RR 数是否受 MTU 限制」）。

### 4.3 HR
- 有效 HR 范围取 **1–250** 用于统计；`HR=0` 单列、`>250` 单列、解码失败/无值单列（都计入 `missing_count`）。
- **逐包 ΔHR**：只在相邻两个有效 HR 包之间计算；给出 min/max/中位数、|ΔHR| 均值/P95 与分桶（0、1-2、3-5、6-10、11-20、>20）。用于「动作后 Δbpm」的噪声评估（不做临床宣称）。

### 4.4 RR
- **每包 RR 数分布**：0/1/2/3/4/…/9 各多少包；`≥2 RR 比例` = 含 ≥2 RR 的包 / 能读出 flags 的 HRS 通知包数（分母含解码失败的包；`hex` 为空/读不出 flags 的不计入）。
- **RR 池统计**：min/max/中位数/均值/标准差/P5/P95、∈[400,1500]ms 比例、<400 / >1500 计数。
- **粗伪影率**：按到达顺序展开所有 RR（包内先、跨包相邻），`|rr[i+1]-rr[i]| / rr[i] > 20%`（`--artifact-threshold` 可调）记为伪影；主比率分母是全部相邻对，另报包内/跨包拆分。**这是粗筛，不是 ECG 伪影判别**。
- **60s 窗口 RMSSD**：窗口从首条通知对齐、固定宽度、不重叠；窗口内 ≥3 个 RR 才计算 `sqrt(mean(Δ²))`。**只作 sanity check，不宣称临床值**；窗口内 RR 均归到该包到达时刻（边界有 ±1 包误差）。
- **丢拍估计（两种，都是估计）**：
  1. **到达间隔法**：gap > 1.5×中位间隔时，估丢 `round(gap/中位间隔)-1` 条通知。
  2. **RR 累计法**：只统计「相邻两条都带 RR 的通知包」之间的空档，`expected=Δt/中位RR`、`delivered=后一包实际 RR 数`，缺口 `max(0, round(expected-delivered))`。**不把「设备本来就不发 RR 的包」算成丢拍**。
  3. **RR/bpm 一致性 sanity**：RR 中位数 vs `60000/HR 中位数`，比值偏离 >±20% 提示 RR 缓冲/重复/单位问题或 bpm 与 RR 不同源。
- **丢拍集中时间段**：直接列 >3s 的到达空档（含估丢条数），不做「按 RR 数量分箱」的二次推断。

### 4.5 接触状态（T5）
- 只有 **bit2=1**（设备声明支持接触检测）的包进入状态时间轴：`bit2=1&bit1=1 → contact`，`bit2=1&bit1=0 → no-contact`。
- `bit2=0` 的包跳过并单列：`bit1=1` 记 **inconsistent 矛盾包**，`bit1=0` 记 `unsupported`。这样不会让「本来不报接触能力的包」把时间轴切碎。
- 状态分段给起止、时长、包数、HR 中位数、HR=0 包数、条/分；切换点用于 T5 摘下/戴上。
- **恢复时间（启发式，`未验证` 需人工复核）**：摘下前 30s HR 中位数为基线，取重新接触后首个落入基线 ±20% 的 HR 的时间差；找不到记 `null`。

### 4.6 运动伪影（T6）
- 10s 分箱（`--bin-sec`）：箱内相邻 RR 对 ≥ `--min-pairs-per-bin`（默认 3）且伪影率 ≥ `--motion-artifact-ratio`（默认 20%）→ 运动 bin；相邻运动 bin 合并成段。
- 段内给 RR 对/伪影对/伪影率/最大跳变/|ΔHR| max，用于回答「运动中 RR 是否可用/只能 bpm」。
- 样本不足时明确写「未检测到」，不代表运动中一定无伪影。

### 4.7 私有通道（Gate C / T4）
- 从 `gatt.json` 找**非标准服务**下带 `notify`/`indicate` 的特征。
- 从 `notifications.jsonl` 找 `service/char` 不是 HRS 的通知流，统计条数、周期中位数、包长分布、uint16 小端中位数/P5/P95。
- **候选判定**（只列候选，不猜协议）：中位周期 ∈[0.5,2.0]s **或** uint16 小端中位数 ∈[300,1500] 之一满足即列为候选。

### 4.8 Gate 判定
判定词：**`pass` = 该 Gate 的条件成立；`fail` = 条件不成立；`未验证` = 证据/数据不足（不猜）**。

| Gate | 判定规则（每条都会打印测量值 + 阈值） |
|---|---|
| **A 可连接** | 收到 HRS 通知 ≥1 条 且 通知覆盖时长 ≥10s。gatt.json 的 180D/2A37/notify 只作交叉核对（缺失 → `未验证`，不否决 A；因为收到通知本身就证明连接+订阅成功）。 |
| **B RR 可用** | 静息窗口内 4 条同时满足：bit4=1 比例 ≥80%；每包 ≥2 RR 比例 ≥80%；RR ∈[400,1500]ms 比例 ≥95%；粗伪影率 <5%。任一 `fail` → B=`fail`；无 fail 但有 `未验证` → B=`未验证`；全 pass → B=`pass`。窗口默认 **首条通知起 300s**（`--rest-start`/`--rest-sec` 可改）；捕获不足 300s 或窗口内可读 flags 的通知 <10 条 → 全部判据 `未验证`，窗口内数值仅参考。 |
| **B- 仅 bpm** | A=`pass` 且 B=`fail` → `pass`（降级为 `quality=no-rr` 成立）；B=`pass` → `fail`（无需降级）；任一项 `未验证` → `未验证`。 |
| **C 私有通道** | **前提：Gate B 不通过（标准 HRS 无可用 RR）**。满足前提且存在 gatt 非标准 notify 特征 或 实收非 HRS 通知流 → `pass`（仅候选，需 T4 逆向，不承诺可用）；有候选但 Gate B 已 pass → `fail`；无候选且 gatt 缺失 → `未验证`；无候选且 gatt 存在 → `fail`。 |
| **D 不可用** | 通知总数为 0 → `pass`（不可用成立）；否则 `fail`（连接失败/Windows 稳定性子项仍为 `未验证`，需 T8 证据）。 |

**决策树**（计划 §6）：A 未过 → D；A 过 + B 过 → 首选（RR 源）；A 过 + B 不过 + C 有候选 → 仅 bpm + 评估私有协议成本（默认不投入）；A 过 + B/C 都不行 → 仅 bpm 趋势；A/B 证据不足 → 未验证。

### 4.9 Q1–Q10
自动填能由通知流回答的：Q1（180D/2A37 存在与通知计数；"不配对直连" 未验证）、Q2（bit4 比例）、Q3（每包 RR 数/范围/伪影）、Q4（通知频率 + 接触 bit1/bit2 + 切换次数）、Q5（非标准 notify 特征/流）、Q7（meta/gatt 的型号固件硬件与广播服务；MAC/序列号脱敏）。
**必然未验证**：Q6（App 侧 HRV）、Q8（与 B0 并发）、Q9（重连行为）、Q10（Windows 配对缓存）——离线通知流无法回答，需人工/日志。

---

## 5. 口径假设（完整列表见 `analysis.md` §11 / `analysis.json#/assumptions`）

最容易影响结论的几条，复核时优先看：

1. **静息窗口**：默认首条通知起 300s；若抓包不是「前 5 分钟静息」，必须用 `--rest-start` 指定，否则 Gate B 可能被运动段污染。
2. **Gate B 分母**：判据 1/2 用「能读出 flags 的通知条数」（含解码失败），判据 3 用全部 RR，判据 4 用全部相邻 RR 对。
3. **RR 时间归属**：一包多个 RR 都归到该包到达时刻（窗口/分箱边界 ±1 包误差）。
4. **伪影定义**是 `|ΔRR|/RR > 20%` 的粗筛，不等于真实伪影率。
5. **RMSSD 只作 sanity**，不宣称临床值。
6. **T5 恢复时间**是启发式（基线 ±20%），找不到就 `null`。
7. **运动段阈值**（10s 分箱 / ≥3 对 / 20%）是工程参数，不是行业标准。
8. **gatt/meta 缺失**时相关项 `未验证`，不用通知流反推服务枚举。

---

## 6. 怎么加新指标

1. **解码层**：若新字段来自 0x2A37，改 `decode_hrs_hex()`（保持「部分解析成功也返回前缀字段」的约定）。
2. **计算层**：在 `analyze.py` 对应区块加纯函数，返回 JSON 可序列化 dict（不要 NaN/inf；用 `rnd()` 控精度）。
3. **挂载**：把结果放进 `doc["xxx"]`（`analyze_capture`）；若 Gate/QA 需要，放进 `ctx` 再改 `evaluate_gates`/`build_qa`。
4. **渲染**：`render_markdown()` 加章节/表格（表格用 `md_table`），`render_console()` 加关键一行；`analysis.md` 章节号顺延。
5. **假设**：只要引入新口径，追加到 `build_assumptions()`（编号顺延），并在 README §5 增补。
6. **自测**：在 `selftest/make_samples.py` 改/加合成样本，在 `selftest/check.py` 加**区间断言**（不要写死精确浮点），跑 `python selftest/check.py` 必须 0 fail。
7. 守住三条红线：只从 `hex` 解码、只写 `<capture-dir>`/`--out-dir`、数据不足输出 `未验证`。

---

## 7. 自测（`selftest/`）

```bash
cd analysis/hw9-capture/_tools/analysis
python selftest/check.py        # 生成样本 + CLI 跑分析器 + 断言（推荐）
bash selftest/run.sh            # 等价包装
```

3 组合成样本（**SELFTEST-SYNTHETIC，不是真实健康数据**）：

| 样本 | 内容 | 预期 |
|---|---|---|
| `rr-good/` | 360 条，bit4 恒 1、每包 2 RR、RR 700–900ms、无空档（时长 359s） | Gate A pass、**B pass**、B- fail、C fail、D fail，决策「首选」 |
| `bpm-only/` | 360 条，bit4 恒 0、无 RR | A pass、**B fail**、**B- pass**、C fail、D fail，决策「仅 bpm」 |
| `messy/` | 0x16/0x06/0x0A/0x04 混包、3 段 >3s 空档、多处 >20% 跳变、摘下段（HR=0）、1 条截断包、1 行坏 JSON、18 行故意写错的 `decoded`、厂商 fff0/fff1 流 | A pass、**B fail**、B- pass、**C pass**、D fail；空档=3、运动段≥3、RR 累计估丢拍>0、矛盾接触包被过滤 |

`check.py` 当前 **60 条断言**，输出逐条 `PASS/FAIL` 和汇总；退出码 0=全过，1=有失败。

> 自测会在样本目录生成 `analysis.json`/`analysis.md`（预期产物）和 `selftest/_run/*`（CLI 日志）。
> 注意：本机 DSH 沙箱下 `subprocess` 的 **pipe 会被拒绝**（WinError 5），所以 `check.py` 用文件重定向而不是 `capture_output`。

---

## 8. 已知限制（不要用本工具越界回答）

1. **不做医疗/临床判断**：不评估真实心率精度，只回答协议与数据质量。
2. **Q6/Q8/Q9/Q10 必然未验证**：离线通知流回答不了 App 行为、并发、重连、Windows 缓存。
3. **gatt.json/meta.json 缺失**时 Q1/Q5/Q7 与 Gate C 相关项降级为未验证。
4. **静息窗口是人工前提**：工具不会自动识别「哪 5 分钟是静息」，必要时用 `--rest-start`。
5. **丢拍是估计**：到达间隔法与 RR 累计法都会受设备缓冲/补发影响，不能当精确计数。
6. **私有通道只列候选**，不逆向协议；Gate C 通过 ≠ 可用。
7. **时间源**：无 `t`/`monoMs` 时无法给出时长/频率，相关项一律未验证。
8. 不处理多设备混合文件；同一文件里若混入其它设备/其它特征，非 HRS 部分会被当作「非 HRS 通知流」单列。

---

## 9. 文件清单

```
analysis/hw9-capture/_tools/analysis/
├── analyze.py               # 分析器（纯 stdlib）
├── README.md                # 本文件
└── selftest/
    ├── make_samples.py      # 生成 3 组合成样本（确定性）
    ├── check.py             # 自测：生成样本 → CLI 跑分析器 → 60 条断言
    ├── run.sh               # bash 包装
    ├── rr-good/ bpm-only/ messy/   # 合成样本 + 生成的 analysis.json/md
    └── _run/                # 自测 CLI 日志（每次覆盖）
```
