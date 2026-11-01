# BLE advertisement scan via WinRT (no pairing, no connection, read-only).
# Answers T0 of analysis/coospo-hw9-test-plan.md: name, address, RSSI, and the
# service UUIDs / manufacturer data present in the advertising packets.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File analysis\hw9-capture\_tools\ble-scan.ps1 -Seconds 10
#   powershell ... -NameFilter "HW9|CooSpo"            # only print matching devices
#   powershell ... -OutFile analysis\hw9-capture\adv.jsonl
#
# Emits one JSONL row per distinct device (last advertisement wins):
#   { "seenAt","monoMs","addr","name","rssi","services":[...],"mfr":[{"companyId":n,"hex":"..."}],"txPower" }
# Locally-run capture aid only. Redact addr/name before sharing anything.

param(
  [int]$Seconds = 10,
  [string]$NameFilter = '',
  [string]$OutFile = ''
)

$ErrorActionPreference = 'Stop'

$null = [Windows.Devices.Bluetooth.Advertisement.BluetoothLEAdvertisementWatcher, Windows.Devices.Bluetooth.Advertisement, ContentType = WindowsRuntime]
$null = [Windows.Devices.Bluetooth.Advertisement.BluetoothLEAdvertisementReceivedEventArgs, Windows.Devices.Bluetooth.Advertisement, ContentType = WindowsRuntime]
$null = [Windows.Devices.Bluetooth.BluetoothAddressType, Windows.Devices.Bluetooth, ContentType = WindowsRuntime]

$watcher = New-Object Windows.Devices.Bluetooth.Advertisement.BluetoothLEAdvertisementWatcher
$watcher.ScanningMode = [Windows.Devices.Bluetooth.Advertisement.BluetoothLEScanningMode]::Active

$script:seen = @{}   # addr -> hashtable
$script:t0 = [Diagnostics.Stopwatch]::StartNew()

function Format-Addr([uint64]$a) {
  # Bluetooth addresses are 48-bit; render most-significant byte first.
  return ('{0:X2}:{1:X2}:{2:X2}:{3:X2}:{4:X2}:{5:X2}' -f `
    [byte](($a -shr 40) -band 0xFF), [byte](($a -shr 32) -band 0xFF),
    [byte](($a -shr 24) -band 0xFF), [byte](($a -shr 16) -band 0xFF),
    [byte](($a -shr 8) -band 0xFF), [byte]($a -band 0xFF))
}

function Hex-Of([byte[]]$bytes) {
  if ($null -eq $bytes -or $bytes.Length -eq 0) { return '' }
  return (($bytes | ForEach-Object { $_.ToString('x2') }) -join '').ToUpperInvariant()
}

$handler = [Windows.Foundation.TypedEventHandler[Windows.Devices.Bluetooth.Advertisement.BluetoothLEAdvertisementWatcher, Windows.Devices.Bluetooth.Advertisement.BluetoothLEAdvertisementReceivedEventArgs]] {
  param($sender, $e)
  $addr = Format-Addr $e.BluetoothAddress
  $row = $null
  if ($script:seen.ContainsKey($addr)) { $row = $script:seen[$addr] } else {
    $row = [ordered]@{
      seenAt = ''; monoMs = 0; addr = $addr; addrType = [string]$e.BluetoothAddressType
      name = ''; rssi = 0; services = @(); mfr = @(); txPower = $null; count = 0
    }
    $script:seen[$addr] = $row
  }
  $row.count = 1 + $row.count
  $row.seenAt = (Get-Date).ToString('yyyy-MM-ddTHH:mm:ss.fffzzz')
  $row.monoMs = [int]$script:t0.ElapsedMilliseconds
  $row.rssi = $e.RawSignalStrengthInDBm
  if ($e.Advertisement.LocalName) { $row.name = $e.Advertisement.LocalName }
  $svc = @()
  foreach ($u in $e.Advertisement.ServiceUuids) { $svc += [string]$u }
  if ($svc.Count -gt 0) { $row.services = $svc }
  $mfr = @()
  foreach ($m in $e.Advertisement.ManufacturerData) {
    $bytes = [byte[]]::new($m.Data.Length)
    if ($m.Data.Length -gt 0) { [Windows.Storage.Streams.DataReader]::FromBuffer($m.Data).ReadBytes($bytes) | Out-Null }
    $mfr += [ordered]@{ companyId = ('0x{0:X4}' -f $m.CompanyId); hex = (Hex-Of $bytes) }
  }
  if ($mfr.Count -gt 0) { $row.mfr = $mfr }
  if ($e.Advertisement.TxPower.HasValue) { $row.txPower = $e.Advertisement.TxPower.Value }
}

$watcher.add_Received($handler)
$null = $watcher.Start()
Write-Output ("scanning {0}s (active) ..." -f $Seconds)
Start-Sleep -Seconds $Seconds
$null = $watcher.Stop()
Start-Sleep -Milliseconds 200

$rows = $script:seen.Values | Sort-Object { -$_.count }
$filtered = @()
foreach ($r in $rows) {
  if ($NameFilter -and ($r.name -notmatch $NameFilter) -and (($r.services -join ',') -notmatch $NameFilter)) { continue }
  $filtered += $r
}

Write-Output ''
Write-Output ("distinct devices: {0} (shown {1})" -f $rows.Count, $filtered.Count)
foreach ($r in $filtered) {
  $svcText = if ($r.services.Count -gt 0) { ($r.services -join ' ') } else { '-' }
  $nameText = if ($r.name) { $r.name } else { '<no-name>' }
  Write-Output ("{0}  rssi={1,4}  adv={2,3}  {3}  services={4}" -f $r.addr, $r.rssi, $r.count, $nameText, $svcText)
  foreach ($m in $r.mfr) { Write-Output ("        mfr {0} {1}" -f $m.companyId, $m.hex) }
}

if ($OutFile) {
  $dir = Split-Path -Parent $OutFile
  if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  $lines = foreach ($r in $rows) { ($r | ConvertTo-Json -Compress -Depth 5) }
  $lines | Set-Content -Encoding UTF8 -LiteralPath $OutFile
  Write-Output ''
  Write-Output ("wrote {0} rows -> {1}" -f $rows.Count, $OutFile)
}
