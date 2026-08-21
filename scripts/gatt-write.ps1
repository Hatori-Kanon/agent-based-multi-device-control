# Write a raw hex frame to a characteristic of a paired BLE device. For
# protocol experiments: candidate frames from the script's own console.
#
#   powershell -ExecutionPolicy Bypass -File scripts\gatt-write.ps1 -Hex AA08040000280000DE
#   powershell -ExecutionPolicy Bypass -File scripts\gatt-write.ps1 -Hex AA080428000000DE -NoResponse -Service 0000dddd-0000-1000-8000-00805f9b34fb -Characteristic 0000ddd1-0000-1000-8000-00805f9b34fb
#
# Defaults target the ANKNI-family stream characteristic (ddd1, no response).

param(
  [string]$NameFilter = 'ZKRXB',
  [string]$Service = '0000dddd-0000-1000-8000-00805f9b34fb',
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

$device = Get-PnpDevice -Class Bluetooth -Status OK -ErrorAction SilentlyContinue |
  Where-Object { $_.FriendlyName -match $NameFilter } | Select-Object -First 1
if ($device -eq $null) { Write-Output "no paired Bluetooth device matching '$NameFilter' found"; exit 1 }
$match = [regex]::Match($device.InstanceId, 'DEV_([0-9A-Fa-f]{12})')
if (-not $match.Success) { Write-Output ("cannot extract MAC from InstanceId: {0}" -f $device.InstanceId); exit 1 }
$mac = $match.Groups[1].Value

$null = [Windows.Devices.Bluetooth.BluetoothLEDevice, Windows.Devices.Bluetooth, ContentType = WindowsRuntime]
$null = [Windows.Devices.Bluetooth.GenericAttributeProfile.GattDeviceService, Windows.Devices.Bluetooth, ContentType = WindowsRuntime]
$null = [Windows.Devices.Bluetooth.GenericAttributeProfile.GattCharacteristic, Windows.Devices.Bluetooth, ContentType = WindowsRuntime]
$null = [Windows.Devices.Bluetooth.GenericAttributeProfile.GattCharacteristicProperties, Windows.Devices.Bluetooth, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.DataWriter, Windows.Storage.Streams, ContentType = WindowsRuntime]

$address = [Convert]::ToUInt64($mac, 16)
$leDevice = Await ([Windows.Devices.Bluetooth.BluetoothLEDevice]::FromBluetoothAddressAsync($address)) ([Windows.Devices.Bluetooth.BluetoothLEDevice])
$servicesResult = Await ($leDevice.GetGattServicesAsync()) ([Windows.Devices.Bluetooth.GenericAttributeProfile.GattDeviceServicesResult])
$service = $servicesResult.Services | Where-Object { $_.Uuid -ieq $Service } | Select-Object -First 1
if ($service -eq $null) { Write-Output "service $Service not found"; exit 1 }
$charsResult = Await ($service.GetCharacteristicsAsync()) ([Windows.Devices.Bluetooth.GenericAttributeProfile.GattCharacteristicsResult])
$characteristic = $charsResult.Characteristics | Where-Object { $_.Uuid -ieq $Characteristic } | Select-Object -First 1
if ($characteristic -eq $null) { Write-Output "characteristic $Characteristic not found"; exit 1 }

$bytes = for ($i = 0; $i -lt $Hex.Length; $i += 2) { [byte][Convert]::ToByte($Hex.Substring($i, 2), 16) }
$writer = New-Object Windows.Storage.Streams.DataWriter
$writer.WriteBytes($bytes)
$buffer = $writer.DetachBuffer()
$writer.Dispose()

$option = if ($NoResponse) {
  [Windows.Devices.Bluetooth.GenericAttributeProfile.GattWriteOption]::WriteWithoutResponse
} else {
  [Windows.Devices.Bluetooth.GenericAttributeProfile.GattWriteOption]::WriteWithResponse
}
$status = Await ($characteristic.WriteValueAsync($buffer, $option)) ([Windows.Devices.Bluetooth.GenericAttributeProfile.GattCommunicationStatus])
Write-Output ("write {0} -> {1} ({2}): {3}" -f $Hex, $Characteristic, $option, $status)
