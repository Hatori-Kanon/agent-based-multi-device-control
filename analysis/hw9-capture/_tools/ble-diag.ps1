# Diagnostic only: is the BLE radio on, and do advertisement events actually
# reach a PowerShell delegate? Writes a hit counter file so we can tell
# "radio off / blocked" apart from "delegate never fired".
param(
  [int]$Seconds = 10,
  [string]$HitFile = 'analysis/hw9-capture/_tools/diag-hits.log'
)

$ErrorActionPreference = 'Continue'
$hitPath = [IO.Path]::Combine((Get-Location).Path, ($HitFile -replace '/', '\'))
$dir = [IO.Path]::GetDirectoryName($hitPath)
if (-not [IO.Directory]::Exists($dir)) { [IO.Directory]::CreateDirectory($dir) | Out-Null }
[IO.File]::WriteAllText($hitPath, '')

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]
function Await($operation, $resultType) {
  $method = $asTaskGeneric.MakeGenericMethod($resultType)
  $task = $method.Invoke($null, @($operation))
  $task.Wait(-1) | Out-Null
  return $task.Result
}

Write-Output "== radio state =="
try {
  $null = [Windows.Devices.Radios.Radio, Windows.Devices.Radios, ContentType = WindowsRuntime]
  $access = Await ([Windows.Devices.Radios.Radio]::RequestAccessAsync()) ([Windows.Devices.Radios.RadioAccessStatus])
  Write-Output ("radio access: {0}" -f $access)
  $radios = Await ([Windows.Devices.Radios.Radio]::GetRadiosAsync()) ([System.Collections.Generic.IReadOnlyList[Windows.Devices.Radios.Radio]])
  foreach ($r in $radios) { Write-Output ("  radio: {0} kind={1} state={2}" -f $r.Name, $r.Kind, $r.State) }
} catch { Write-Output ("radio query FAIL: {0}" -f $_.Exception.Message) }

Write-Output "== watcher =="
$null = [Windows.Devices.Bluetooth.Advertisement.BluetoothLEAdvertisementWatcher, Windows.Devices.Bluetooth.Advertisement, ContentType = WindowsRuntime]
$watcher = New-Object Windows.Devices.Bluetooth.Advertisement.BluetoothLEAdvertisementWatcher
$watcher.ScanningMode = [Windows.Devices.Bluetooth.Advertisement.BluetoothLEScanningMode]::Active
$watcher.add_Stopped({
  param($s, $e)
  [IO.File]::AppendAllText($hitPath, ("STOPPED reason={0}`n" -f $e.Error))
})
$handler = [Windows.Foundation.TypedEventHandler[Windows.Devices.Bluetooth.Advertisement.BluetoothLEAdvertisementWatcher, Windows.Devices.Bluetooth.Advertisement.BluetoothLEAdvertisementReceivedEventArgs]] {
  param($sender, $e)
  $line = ('{0:X12} rssi={1} name={2}' -f $e.BluetoothAddress, $e.RawSignalStrengthInDBm, $e.Advertisement.LocalName)
  [IO.File]::AppendAllText($hitPath, $line + "`n")
}
$watcher.add_Received($handler)
Write-Output ("watcher status before: {0}" -f $watcher.Status)
$null = $watcher.Start()
Write-Output ("watcher status after start: {0}" -f $watcher.Status)
Start-Sleep -Seconds $Seconds
$null = $watcher.Stop()
Start-Sleep -Milliseconds 300
Write-Output ("watcher status after stop: {0}" -f $watcher.Status)
Write-Output "== hits =="
$content = [IO.File]::ReadAllText($hitPath)
$lines = $content -split "`n" | Where-Object { $_.Trim() }
Write-Output ("hit lines: {0}" -f $lines.Count)
$lines | Select-Object -First 20 | ForEach-Object { Write-Output ("  " + $_) }
