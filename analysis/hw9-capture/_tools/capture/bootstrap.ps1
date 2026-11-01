<#
.SYNOPSIS
  创建/复用 analysis/hw9-capture/_tools/.venv，并安装 capture/requirements.txt（bleak 3.x）。

.DESCRIPTION
  当前状态（2026-11-01，Lead 已执行）：.venv = Python 3.10.11 + bleak 3.0.2 + winrt-* 3.2.1。
  本脚本可幂等复跑：
    * 已存在 .venv → 复用，不删除、不重建；
    * `pip install -r` 只补装不满足的依赖；已装的 bleak 3.0.2 满足 `>=3.0,<4`
      → pip 输出 "Requirement already satisfied"，不会重装、更不会降级到 0.2x；
    * 只有显式 -Force 才删除重建 venv（重建后同样从 requirements.txt 装 3.x）。
  依赖只隔离在 _tools/.venv，不碰产品依赖（仓库根 package.json / pnpm）。
  不要用系统 Python 全局 pip install。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File analysis\hw9-capture\_tools\capture\bootstrap.ps1
  （幂等：已装好时只做 import 验证）

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File analysis\hw9-capture\_tools\capture\bootstrap.ps1 -Force
  （删除并重建 .venv，然后装 requirements 里的 bleak 3.x）
#>
[CmdletBinding()]
param(
  [string]$Python = 'python',
  [switch]$Force
)
$ErrorActionPreference = 'Stop'

function Resolve-Python([string]$name) {
  $cmd = Get-Command $name -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  foreach ($alt in @('python3', 'py')) {
    $c = Get-Command $alt -ErrorAction SilentlyContinue
    if ($c) { return $c.Source }
  }
  throw "找不到 Python（试过 '$name'、'python3'、'py'）。需要 Python 3.10+。"
}

$captureDir = $PSScriptRoot
$toolsDir = Split-Path -Parent $captureDir
$hw9CaptureDir = Split-Path -Parent $toolsDir
$analysisDir = Split-Path -Parent $hw9CaptureDir
$repoRoot = Split-Path -Parent $analysisDir
$venvDir = Join-Path $toolsDir '.venv'
$reqFile = Join-Path $captureDir 'requirements.txt'

if (-not (Test-Path -LiteralPath $reqFile)) { throw "找不到 requirements.txt：$reqFile" }

$sysPy = Resolve-Python $Python
$sysVer = ''
try { $sysVer = (Get-Item -LiteralPath $sysPy).VersionInfo.ProductVersion } catch { }
Write-Host "系统 Python：$sysPy ($sysVer)" -ForegroundColor Cyan
Write-Host "目标 venv：$venvDir"

if ((Test-Path -LiteralPath $venvDir) -and $Force) {
  Write-Host '删除已存在的 venv（-Force）…' -ForegroundColor Yellow
  Remove-Item -LiteralPath $venvDir -Recurse -Force
}

$venvPy = Join-Path $venvDir 'Scripts\python.exe'
if (-not (Test-Path -LiteralPath $venvPy)) {
  Write-Host '创建 venv …'
  & $sysPy -m venv $venvDir
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $venvPy)) {
    throw "创建 venv 失败（exit=$LASTEXITCODE）。确认 Python 带 venv 模块。"
  }
} else {
  Write-Host '复用已存在的 venv（不做删除/重建）。'
}

# 某些精简 venv 没有 pip，先 ensurepip 兜底
& $venvPy -c "import pip" 2>$null
if ($LASTEXITCODE -ne 0) {
  Write-Host 'venv 里没有 pip，执行 ensurepip …' -ForegroundColor Yellow
  & $venvPy -m ensurepip --upgrade
}

# 注意：这里刻意不执行 `pip install --upgrade pip`，也不加 --upgrade，
# 避免动到已装环境（bleak 3.0.2 / winrt-* 3.2.1 保持原样）。
Write-Host '安装/校验 requirements.txt（bleak>=3.0,<4；已满足则跳过）…'
& $venvPy -m pip install -r $reqFile
if ($LASTEXITCODE -ne 0) { throw "依赖安装失败（exit=$LASTEXITCODE）。检查 PyPI 网络/代理。" }

Write-Host '验证 bleak …'
& $venvPy -c "import bleak, importlib.metadata as m; print('OK: bleak', m.version('bleak'))"
if ($LASTEXITCODE -ne 0) { throw 'bleak 导入失败，安装未生效。' }

Write-Host ''
Write-Host '完成。用 venv 里的 python 运行抓包 CLI（示例）：' -ForegroundColor Green
Write-Host "  $venvPy $repoRoot\analysis\hw9-capture\_tools\capture\hw9cap.py --help"
Write-Host "  $venvPy $repoRoot\analysis\hw9-capture\_tools\capture\selftest_3x.py"
Write-Host ''
Write-Host '提示：不要把这个 venv 装进产品依赖；它只在 analysis/hw9-capture/_tools 下使用。'
