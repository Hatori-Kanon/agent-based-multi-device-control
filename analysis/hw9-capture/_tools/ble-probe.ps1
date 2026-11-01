# Capability probe: can this sandboxed PowerShell session reach the Windows
# BLE stack at all? Read-only: enumerates the BLE device cache, never connects.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File analysis\hw9-capture\_tools\ble-probe.ps1
#
# Prints one line per device: address, name, paired/connected, and the
# advertised-or-cached service UUIDs when available.

$ErrorActionPreference = 'Continue'

Write-Output "== step 1: WinRT type projection =="
try {
  $null = [Windows.Devices.Bluetooth.BluetoothLEDevice, Windows.Devices.Bluetooth, ContentType = WindowsRuntime]
  Write-Output "BluetoothLEDevice: OK"
} catch { Write-Output ("BluetoothLEDevice: FAIL {0}" -f $_.Exception.Message) }

try {
  $null = [Windows.Devices.Bluetooth.Advertisement.BluetoothLEAdvertisementWatcher, Windows.Devices.Bluetooth.Advertisement, ContentType = WindowsRuntime]
  Write-Output "AdvertisementWatcher: OK"
} catch { Write-Output ("AdvertisementWatcher: FAIL {0}" -f $_.Exception.Message) }

try {
  $null = [Windows.Devices.Enumeration.DeviceInformation, Windows.Devices.Enumeration, ContentType = WindowsRuntime]
  Write-Output "DeviceInformation: OK"
} catch { Write-Output ("DeviceInformation: FAIL {0}" -f $_.Exception.Message) }

Write-Output ""
Write-Output "== step 2: async helper =="
try {
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
  Write-Output "Await: OK"
} catch { Write-Output ("Await: FAIL {0}" -f $_.Exception.Message); exit 1 }

Write-Output ""
Write-Output "== step 3: paired BLE devices =="
try {
  $selPaired = [Windows.Devices.Bluetooth.BluetoothLEDevice]::GetDeviceSelectorFromPairingState($true)
  $paired = Await ([Windows.Devices.Enumeration.DeviceInformation]::FindAllAsync($selPaired)) ([Windows.Devices.Enumeration.DeviceInformationCollection])
  Write-Output ("paired count: {0}" -f $paired.Count)
  foreach ($d in $paired) { Write-Output ("  PAIRED  {0} | {1}" -f $d.Id, $d.Name) }
} catch { Write-Output ("paired enum: FAIL {0}" -f $_.Exception.Message) }

Write-Output ""
Write-Output "== step 4: unpaired (cached-visible) BLE devices =="
try {
  $selAll = [Windows.Devices.Bluetooth.BluetoothLEDevice]::GetDeviceSelectorFromPairingState($false)
  $all = Await ([Windows.Devices.Enumeration.DeviceInformation]::FindAllAsync($selAll)) ([Windows.Devices.Enumeration.DeviceInformationCollection])
  Write-Output ("unpaired count: {0}" -f $all.Count)
  foreach ($d in $all) {
    $addr = '?'
    try { $addr = ('{0:X12}' -f [Windows.Devices.Bluetooth.BluetoothLEDevice]::FromIdAsync) } catch {}
    Write-Output ("  UNPAIRED {0} | {1}" -f $d.Id, $d.Name)
  }
} catch { Write-Output ("unpaired enum: FAIL {0}" -f $_.Exception.Message) }

Write-Output ""
Write-Output "== step 5: paired classic/BT devices via WinRT only (no WMI) =="
try {
  $selAep = [Windows.Devices.Enumeration.DeviceInformation]::GetAqsFilterFromDeviceClass('Bluetooth')
  $bt = Await ([Windows.Devices.Enumeration.DeviceInformation]::FindAllAsync($selAep)) ([Windows.Devices.Enumeration.DeviceInformationCollection])
  Write-Output ("device-class Bluetooth count: {0}" -f $bt.Count)
  foreach ($d in $bt) { Write-Output ("  CLS  {0} | {1}" -f $d.Id, $d.Name) }
} catch { Write-Output ("device-class enum: FAIL {0}" -f $_.Exception.Message) }
