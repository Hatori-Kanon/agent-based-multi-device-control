# Restore the Electron binary from the local download cache when the
# postinstall download was unavailable (offline / sandboxed environments).
# On a normal machine the postinstall already placed it and this is a no-op.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

$pkg = Get-ChildItem "$root\node_modules\.pnpm" -Directory -Filter 'electron@*' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($null -eq $pkg) {
  Write-Output '[restore-electron] electron package not installed; skipping'
  exit 0
}
$electronDir = Join-Path $pkg.FullName 'node_modules\electron'
$dist = Join-Path $electronDir 'dist'
$pathFile = Join-Path $electronDir 'path.txt'

if ((Test-Path (Join-Path $dist 'electron.exe')) -and (Test-Path $pathFile)) {
  exit 0
}

$zip = Get-ChildItem "$root\.cache\electron" -Filter 'electron-*-win32-x64.zip' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($null -eq $zip) {
  Write-Output '[restore-electron] no cached electron zip; the first online install must download it'
  exit 0
}

Write-Output "[restore-electron] extracting $($zip.Name) ..."
$temp = Join-Path $env:TEMP ("electron-restore-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $temp | Out-Null
try {
  Expand-Archive -Path $zip.FullName -DestinationPath $temp -Force
  New-Item -ItemType Directory -Force -Path $dist | Out-Null
  Copy-Item (Join-Path $temp '*') -Destination $dist -Recurse -Force
  # path.txt must NOT end with a newline: electron joins it onto dist\ to find
  # the executable, and a trailing \n breaks the path.
  [System.IO.File]::WriteAllText($pathFile, 'electron.exe')
  Write-Output '[restore-electron] done'
} finally {
  Remove-Item $temp -Recurse -Force -ErrorAction SilentlyContinue
}
