# Write a raw hex frame to a characteristic of a paired BLE device. For
# protocol experiments: candidate frames from the script's own console.
#
#   powershell -ExecutionPolicy Bypass -File scripts\gatt-write.ps1 -Hex AA08040000280000DE
#   powershell -ExecutionPolicy Bypass -File scripts\gatt-write.ps1 -Hex AA080428000000DE -NoResponse
#
# Defaults target the ANKNI-family stream characteristic (ddd1, no response):
#   -ServiceUuid 0000dddd-0000-1000-8000-00805f9b34fb
#   -NoResponse writes ddd1; omit it for a with-response write (use
#   -Characteristic 0000ddd2-0000-1000-8000-00805f9b34fb to hit ddd2).

param(
  [string]$NameFilter = 'ZKRXB',
  [string]$ServiceUuid = '0000dddd-0000-1000-8000-00805f9b34fb',
  [string]$Characteristic = '0000ddd1-0000-1000-8000-00805f9b34fb',
  [string]$Hex = '',
  [switch]$NoResponse
)

$ErrorActionPreference = 'Stop'

if ($Hex.Length -eq 0 -or $Hex.Length % 2 -ne 0 -or $Hex -notmatch '^[0-9a-fA-F]+$') {
  Write-Output "usage: -Hex <even-length hex frame>"
  exit 1
}

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

$dev = Get-PnpDevice -Class Bluetooth -Status OK -ErrorAction SilentlyContinue |
  Where-Object { $_.FriendlyName -match $NameFilter } | Select-Object -First 1
if ($dev -eq $null) { Write-Output "no paired Bluetooth device matching '$NameFilter' found"; exit 1 }
$match = [regex]::Match($dev.InstanceId, 'DEV_([0-9A-Fa-f]{12})')
if (-not $match.Success) { Write-Output ("cannot extract MAC from InstanceId: {0}" -f $dev.InstanceId); exit 1 }
$mac = $match.Groups[1].Value

$null = [Windows.Devices.Bluetooth.BluetoothLEDevice, Windows.Devices.Bluetooth, ContentType = WindowsRuntime]
$null = [Windows.Devices.Bluetooth.GenericAttributeProfile.GattDeviceService, Windows.Devices.Bluetooth, ContentType = WindowsRuntime]
$null = [Windows.Devices.Bluetooth.GenericAttributeProfile.GattCharacteristic, Windows.Devices.Bluetooth, ContentType = WindowsRuntime]
$null = [Windows.Devices.Bluetooth.GenericAttributeProfile.GattCommunicationStatus, Windows.Devices.Bluetooth, ContentType = WindowsRuntime]
$null = [Windows.Devices.Bluetooth.GenericAttributeProfile.GattWriteOption, Windows.Devices.Bluetooth, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.DataWriter, Windows.Storage.Streams, ContentType = WindowsRuntime]

$address = [Convert]::ToUInt64($mac, 16)
$leDevice = Await ([Windows.Devices.Bluetooth.BluetoothLEDevice]::FromBluetoothAddressAsync($address)) ([Windows.Devices.Bluetooth.BluetoothLEDevice])
$servicesResult = Await ($leDevice.GetGattServicesAsync()) ([Windows.Devices.Bluetooth.GenericAttributeProfile.GattDeviceServicesResult])

$svcObj = $null
foreach ($candidate in $servicesResult.Services) {
  if ([string]$candidate.Uuid -ieq $ServiceUuid) { $svcObj = $candidate; break }
}
if ($svcObj -eq $null) { Write-Output "service $ServiceUuid not found"; exit 1 }

$charsResult = Await ($svcObj.GetCharacteristicsAsync()) ([Windows.Devices.Bluetooth.GenericAttributeProfile.GattCharacteristicsResult])
$charObj = $null
foreach ($candidate in $charsResult.Characteristics) {
  if ([string]$candidate.Uuid -ieq $Characteristic) { $charObj = $candidate; break }
}
if ($charObj -eq $null) { Write-Output "characteristic $Characteristic not found"; exit 1 }

$bytes = for ($i = 0; $i -lt $Hex.Length; $i += 2) { [byte][Convert]::ToByte($Hex.Substring($i, 2), 16) }
$writer = New-Object Windows.Storage.Streams.DataWriter
$writer.WriteBytes($bytes)
$buffer = [Windows.Storage.Streams.IBuffer]$writer.DetachBuffer()
$writer.Dispose()

$option = if ($NoResponse) {
  [Windows.Devices.Bluetooth.GenericAttributeProfile.GattWriteOption]::WriteWithoutResponse
} else {
  [Windows.Devices.Bluetooth.GenericAttributeProfile.GattWriteOption]::WriteWithResponse
}
$optionTyped = [Windows.Devices.Bluetooth.GenericAttributeProfile.GattWriteOption]$option
$status = Await ($charObj.WriteValueAsync($buffer, $optionTyped)) ([Windows.Devices.Bluetooth.GenericAttributeProfile.GattCommunicationStatus])
Write-Output ("write {0} -> {1} ({2}): {3}" -f $Hex, $Characteristic, $optionTyped, $status)
