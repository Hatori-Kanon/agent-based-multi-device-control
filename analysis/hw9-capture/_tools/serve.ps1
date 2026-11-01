<#
.SYNOPSIS
  在仓库根（或 _tools 目录）启动 python -m http.server，用于打开 harness.html。

.DESCRIPTION
  Web Bluetooth 需要安全上下文，localhost 算安全上下文；双击 file:// 打开不行。
  默认从仓库根提供服务（任务规定）：
      http://localhost:8080/analysis/hw9-capture/_tools/harness.html
  加 -FromToolsDir 则从 _tools 目录提供服务（对应计划附录 B 的 /harness.html 写法）。

  停止：Ctrl+C（只影响本机 localhost，不监听外网）。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File analysis\hw9-capture\_tools\serve.ps1

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File analysis\hw9-capture\_tools\serve.ps1 -Port 8081 -Open

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File analysis\hw9-capture\_tools\serve.ps1 -FromToolsDir
#>
[CmdletBinding()]
param(
  [int]$Port = 8080,
  [ValidateSet('RepoRoot', 'ToolsDir')]
  [string]$Root = 'RepoRoot',
  [string]$Python = 'python',
  [switch]$FromToolsDir,
  [switch]$Open
)
$ErrorActionPreference = 'Stop'

function Find-RepoRoot([string]$start) {
  $dir = (Resolve-Path -LiteralPath $start).Path
  for ($i = 0; $i -lt 8; $i++) {
    if (Test-Path -LiteralPath (Join-Path $dir '.git')) { return $dir }
    if ((Test-Path -LiteralPath (Join-Path $dir '.gitignore')) -and
        (Test-Path -LiteralPath (Join-Path $dir 'package.json'))) { return $dir }
    $parent = Split-Path -Parent $dir
    if (-not $parent -or $parent -eq $dir) { break }
    $dir = $parent
  }
  throw "找不到仓库根：从 $start 向上 8 级没有 .git（或 .gitignore+package.json）。请用 -Root/-FromToolsDir 或从仓库内运行。"
}

function Resolve-Python([string]$name) {
  $cmd = Get-Command $name -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  foreach ($alt in @('python3', 'py')) {
    $c = Get-Command $alt -ErrorAction SilentlyContinue
    if ($c) { return $c.Source }
  }
  throw "找不到 Python（试过 '$name'、'python3'、'py'）。请安装 Python 3.10+ 或用 -Python <路径> 指定。"
}

$toolsDir = $PSScriptRoot
$repoRoot = Find-RepoRoot $toolsDir
$harnessRel = 'analysis/hw9-capture/_tools/harness.html'
$harnessPath = Join-Path $repoRoot $harnessRel
if (-not (Test-Path -LiteralPath $harnessPath)) {
  throw "找不到 harness.html：$harnessPath（仓库根=$repoRoot）"
}

if ($FromToolsDir) { $Root = 'ToolsDir' }
if ($Root -eq 'ToolsDir') {
  $serveDir = $toolsDir
  $url = "http://localhost:$Port/harness.html"
} else {
  $serveDir = $repoRoot
  $url = "http://localhost:$Port/" + $harnessRel
}

$pyExe = Resolve-Python $Python
# 注意：本环境里把原生命令输出赋值给变量会拿到空串，所以版本从文件元数据取，避免横幅出现 ()。
$pyVersion = ''
try { $pyVersion = (Get-Item -LiteralPath $pyExe).VersionInfo.ProductVersion } catch { }

# 端口占用预检：被占用时直接给出可操作的提示，而不是让 http.server 抛一串栈
$probe = $null
try {
  $probe = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $Port)
  $probe.Start()
} catch {
  throw "端口 $Port 已被占用。换端口：-Port 8081（记得同步改浏览器地址）。"
} finally {
  if ($probe) { try { $probe.Stop() } catch { } }
}

Write-Host ''
Write-Host '=== HW9 harness 本地服务器 ===' -ForegroundColor Cyan
Write-Host "仓库根 : $repoRoot"
Write-Host "提供目录: $serveDir"
Write-Host "Python : $pyExe ($pyVersion)"
Write-Host "端口   : $Port（只绑定 127.0.0.1，不暴露到局域网）"
Write-Host ''
Write-Host '浏览器打开（Chrome / Edge）：' -ForegroundColor Yellow
Write-Host "  $url" -ForegroundColor Green
Write-Host ''
Write-Host '停止：Ctrl+C' -ForegroundColor DarkGray
Write-Host ''

if ($Open) {
  Start-Sleep -Milliseconds 600
  try { Start-Process $url | Out-Null } catch { Write-Host "自动打开浏览器失败，请手动打开上面的 URL：$($_.Exception.Message)" -ForegroundColor Yellow }
}

Push-Location $serveDir
try {
  & $pyExe -m http.server $Port --bind 127.0.0.1 --directory $serveDir
} finally {
  Pop-Location
}
exit $LASTEXITCODE
