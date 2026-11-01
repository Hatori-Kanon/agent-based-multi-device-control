<#
.SYNOPSIS
  为 HW9 抓包创建一个符合计划 §5 的测试目录骨架。

.DESCRIPTION
  在 analysis/hw9-capture/ 下新建 <YYYYMMDD-HHmmss>[-Suffix]/，包含：
    meta.json           （设备/环境/测试者，序列号与 MAC 预填“脱敏”）
    gatt.json           （空壳：{"services":[],"advertisement":{...}}）
    notifications.jsonl （空文件，由 harness 或 hw9cap.py notify 写入）
    summary.md          （回答 Q1–Q10 + Gate 结论的骨架）
    README.md           （复现步骤 / 本轮异常说明模板）
    exports/            （nRF Connect 导出的 CSV/截图）
  不覆盖已有目录：重名自动追加 -2、-3…

  只创建目录/文件，不连接设备、不修改产品代码。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File analysis\hw9-capture\_tools\scaffold.ps1 -DeviceName "CooSpo HW9"

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File analysis\hw9-capture\_tools\scaffold.ps1 -Suffix TEST-smoke -Quiet
#>
[CmdletBinding()]
param(
  [string]$DeviceName = 'CooSpo HW9',
  [string]$Tester = '',
  [string]$Notes = '',
  [string]$Suffix = '',
  [switch]$Quiet
)
$ErrorActionPreference = 'Stop'

function ConvertTo-JsonString([string]$s) {
  if ($null -eq $s) { return '' }
  $sb = New-Object System.Text.StringBuilder
  foreach ($ch in $s.ToCharArray()) {
    switch ($ch) {
      '"' { [void]$sb.Append('\"') }
      '\' { [void]$sb.Append('\\') }
      "`n" { [void]$sb.Append('\n') }
      "`r" { [void]$sb.Append('\r') }
      "`t" { [void]$sb.Append('\t') }
      default {
        if ([int][char]$ch -lt 32) { [void]$sb.Append(('\u{0:x4}' -f [int][char]$ch)) }
        else { [void]$sb.Append($ch) }
      }
    }
  }
  return $sb.ToString()
}

function Write-Utf8([string]$path, [string]$content) {
  $enc = New-Object System.Text.UTF8Encoding($false)  # 无 BOM，JSON/Markdown 更通用
  [System.IO.File]::WriteAllText($path, $content, $enc)
}

$toolsDir = $PSScriptRoot
$captureRoot = Split-Path -Parent $toolsDir          # analysis/hw9-capture
$analysisDir = Split-Path -Parent $captureRoot       # analysis
$repoRoot = Split-Path -Parent $analysisDir          # repo root
if (-not (Test-Path -LiteralPath (Join-Path $analysisDir 'coospo-hw9-test-plan.md'))) {
  throw "目录结构不符：找不到 $analysisDir\coospo-hw9-test-plan.md（本脚本应位于 analysis\hw9-capture\_tools\）"
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$suffixClean = ''
if ($Suffix) {
  $safe = ($Suffix -replace '[^A-Za-z0-9._-]', '-').Trim('-', '.', '_')
  if ($safe) { $suffixClean = '-' + $safe }
}
$baseName = $stamp + $suffixClean
$dir = Join-Path $captureRoot $baseName
$n = 1
while (Test-Path -LiteralPath $dir) {
  $n++
  $dir = Join-Path $captureRoot ("$baseName-$n")
}
$dirName = Split-Path -Leaf $dir
New-Item -ItemType Directory -Path $dir -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $dir 'exports') -Force | Out-Null

$startedAt = (Get-Date).ToString('yyyy-MM-ddTHH:mm:sszzz')
$osString = [System.Environment]::OSVersion.VersionString
$psVersion = $PSVersionTable.PSVersion.ToString()
$relDir = "analysis/hw9-capture/$dirName"

# ── meta.json ───────────────────────────────────────────────────────────────
$metaJson = @"
{
  "device": {
    "name": "$(ConvertTo-JsonString $DeviceName)",
    "mac": "（脱敏）",
    "model": "",
    "firmware": "",
    "hardware": "",
    "serial": "（脱敏）"
  },
  "env": {
    "os": "$(ConvertTo-JsonString $osString)",
    "chrome": "",
    "adapter": "",
    "tools": []
  },
  "tester": "$(ConvertTo-JsonString $Tester)",
  "startedAt": "$startedAt",
  "notes": "$(ConvertTo-JsonString $Notes)"
}
"@
Write-Utf8 (Join-Path $dir 'meta.json') $metaJson

# ── gatt.json 空壳（严格按计划 §5 结构，待填） ──────────────────────────────
$gattJson = @'
{
  "services": [],
  "advertisement": {
    "name": "",
    "services": [],
    "manufacturerData": ""
  }
}
'@
Write-Utf8 (Join-Path $dir 'gatt.json') $gattJson

# ── notifications.jsonl 空文件 ──────────────────────────────────────────────
Write-Utf8 (Join-Path $dir 'notifications.jsonl') ''

# ── summary.md 骨架 ─────────────────────────────────────────────────────────
$summaryMd = @"
# CooSpo HW9 测试记录（$dirName）

- 设备：$(ConvertTo-JsonString $DeviceName)
- 开始时间：$startedAt
- 测试机：$osString（PowerShell $psVersion）
- 数据目录：``$relDir``
- 配套文件：``meta.json`` / ``gatt.json`` / ``notifications.jsonl`` / ``exports/``
- 对照文档：``analysis/coospo-hw9-test-plan.md``（§0 问题、§5 格式、§6 Gate）

> 纪律：原始 hex 必须保留；每条记录带本机到达时间与工具名；只存本地；序列号/MAC 脱敏（§4）。

## Gate 结论（§6）

| Gate | 条件 | 结论 | 证据 |
|---|---|---|---|
| A 可连接 | 能连 ``0x180D`` 并收到 ``0x2A37`` 通知 ≥10s | 未验证 | |
| B RR 可用 | 静息 5min：≥80% 通知 bit4=1；每包 ≥2 RR 比例 ≥80%；≥95% RR∈[400,1500]ms；粗伪影率 <5% | 未验证 | |
| B- 仅 bpm | 有 HRS 但 bit4 恒 0 或 RR 不达标 | 未验证 | |
| C 私有通道 | 无标准 RR，但非标准 notify 特征可疑 | 未验证 | |
| D 不可用 | 无法连接/无通知/Windows 方案不稳定 | 未验证 | |

**最终结论**：未验证

## 逐条回答 §0 的 Q1–Q10

### Q1 是否提供标准 ``0x180D`` / ``0x2A37``，能否不配对直连？
- 结论：未验证
- 证据：

### Q2 ``0x2A37`` flags bit4（RR-Interval）是否为 1？多久出现一次？
- 结论：未验证
- 证据（计数/比例）：

### Q3 每包几个 RR？RR 是否合理（400–1500ms）？伪影比例？
- 结论：未验证
- 证据（RR 中位数/P5/P95/min/max、>20% 跳变比例）：

### Q4 通知频率、接触状态 bit1/bit2 是否可用？摘下/戴上变化？
- 结论：未验证
- 证据：

### Q5 无标准 RR 时，是否有厂商私有 notify 服务/特征？
- 结论：未验证
- 证据（UUID/属性/频率/报文长度）：

### Q6 官方 App 的 HRV 是设备端还是 App 端算的？
- 结论：未验证
- 证据：

### Q7 固件/型号/硬件版本、电量、广播名、广播里是否带 ``0x180D``？
- 结论：未验证
- 证据（firmware/hardware/battery + 广播 serviceUuids）：

### Q8 与郊狼 B0 流并发时 BLE 是否被卡？
- 结论：未验证
- 证据（时间线/最大间隔/丢包）：

### Q9 断线重连行为（3 次退避、是否清缓冲、是否需重新选设备）？
- 结论：未验证
- 证据（``reconnect`` JSONL：connectMs / foundByScan / needsReselect / notifyOk）：

### Q10 Windows 配对/缓存是否导致第二次连接看不到设备？
- 结论：未验证
- 证据：

## 统计（从 notifications.jsonl 生成，建议用 _tools 里的统计脚本复核）

- 通知总条数：
- 每分钟条数：
- flags 取值分布：
- HR 范围：
- 每包 RR 个数分布：
- 包长分布：
- RR 中位数 / P5 / P95 / min / max：
- 相邻 RR 变化 >20% 比例（粗伪影率）：

## 并发 / 重连（T8）

- 并发：
- 重连：

## 异常与备注

-
"@
Write-Utf8 (Join-Path $dir 'summary.md') $summaryMd

# ── 测试目录 README.md（复现步骤模板） ──────────────────────────────────────
$readmeMd = @"
# $dirName 复现步骤

本目录由 ``analysis/hw9-capture/_tools/scaffold.ps1`` 生成，按 ``analysis/coospo-hw9-test-plan.md`` §5 组织。

## 1. 设备与环境
- 设备：$(ConvertTo-JsonString $DeviceName)
- 测试机：$osString（PowerShell $psVersion）
- 浏览器：Chrome/Edge ____ 版本
- 蓝牙适配器：____（设备管理器）

## 2. 抓包（按计划 §2 选路线）

### 路线 A（首选，全量枚举 + 原始抓包）：nRF Connect
1. 扫描 → 连接 HW9 → 展开全部服务。
2. 对每个 characteristic 记录 UUID/属性/是否有 CCCD + 用户描述 → 填 ``gatt.json``。
3. 对 ``0x2A37`` 打开 notify 观察 1–2 分钟，开 Log，导出到 ``exports/``。
4. 其它可 notify 特征各订阅 2 分钟，记录原始 hex（找厂商 HRV 通道）。

### 路线 B（Windows 路径验证）：edge://bluetooth-internals
1. Edge/Chrome 打开 ``edge://bluetooth-internals`` → Start Scan → 选 HW9 → Inspect。
2. 记录设备 ID、广播、服务列表、通知是否成功（截图放 ``exports/``）。

### 路线 C（解析链路验证）：harness.html
1. 仓库根执行：
   ``powershell -NoProfile -ExecutionPolicy Bypass -File analysis\hw9-capture\_tools\serve.ps1``
2. Chrome 打开输出的 URL → 连接心率带 → 选 HW9。
3. 停止/断连后下载 ``notifications.jsonl`` / ``meta.json``，覆盖本目录同名文件或放进 ``exports/``。

### 路线 A'（自动化）：hw9cap.py（bleak，需先 bootstrap，见 _tools/README.md）
``````
analysis\hw9-capture\_tools\.venv\Scripts\python.exe analysis\hw9-capture\_tools\capture\hw9cap.py scan --seconds 10
analysis\hw9-capture\_tools\.venv\Scripts\python.exe analysis\hw9-capture\_tools\capture\hw9cap.py gatt --address <MAC> --out "$relDir/gatt.json"
analysis\hw9-capture\_tools\.venv\Scripts\python.exe analysis\hw9-capture\_tools\capture\hw9cap.py notify --address <MAC> --seconds 600 --out "$relDir/notifications.jsonl"
``````

## 3. 记录纪律（计划 §4）
- 原始 hex 必须保留；解析值只作附加字段。
- 每条记录带本机到达时间 + 工具名。
- 健康数据只存本地，不提交 git；交付前脱敏序列号/MAC。
- 一次只改一个变量。

## 4. 本轮异常 / 偏差说明
-

## 5. 参考
- 测试计划：``analysis/coospo-hw9-test-plan.md``
- 工具说明：``analysis/hw9-capture/_tools/README.md``
- 环境实测结论：``analysis/hw9-capture/_tools/FINDINGS.md``
"@
Write-Utf8 (Join-Path $dir 'README.md') $readmeMd

# ── 输出 ────────────────────────────────────────────────────────────────────
$files = @('meta.json', 'gatt.json', 'notifications.jsonl', 'summary.md', 'README.md', 'exports/')
if (-not $Quiet) {
  Write-Host ''
  Write-Host '已创建 HW9 测试目录：' -ForegroundColor Green
  Write-Host "  $dir"
  Write-Host '包含：'
  foreach ($f in $files) { Write-Host "  - $f" }
  Write-Host ''
  Write-Host '下一步：' -ForegroundColor Yellow
  Write-Host "  1) 采集：按 $relDir\README.md 里的路线 A/B/C 执行。"
  Write-Host "  2) 填 gatt.json / meta.json（hw9cap.py gatt/info 或 nRF Connect）。"
  Write-Host "  3) notifications.jsonl 由 harness 下载或 hw9cap.py notify 直接写入本目录。"
  Write-Host "  4) 逐条回答 summary.md 的 Q1–Q10 并给 Gate 结论。"
  Write-Host ''
} else {
  Write-Output $dir
}
