# Dump the GATT service/characteristic table of a Bluetooth LE device, found
# by fuzzy name match against the device currently paired on this machine.
#
#   powershell -ExecutionPolicy Bypass -File scripts\gatt-dump.ps1
#
# Edit $nameFilter below to target another device. Output lists every service
# UUID with its characteristics and capabilities. The device must be powered
# on; a phone/vendor app holding the connection may block Windows from
# connecting - disconnect it first.

$ErrorActionPreference = 'Stop'

$nameFilter = 'ZKRXB'

# --- WinRT async helper (console FullLanguage PowerShell) -------------------
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
  Where-Object { $_.FriendlyName -match $nameFilter } | Select-Object -First 1
if ($device -eq $null) {
  Write-Output "no paired Bluetooth device matching '$nameFilter' found"
  exit 1
}
Write-Output ("device: {0}" -f $device.FriendlyName)
Write-Output ("pnp:    {0}" -f $device.InstanceId)

$match = [regex]::Match($device.InstanceId, 'DEV_([0-9A-Fa-f]{12})')
if (-not $match.Success) {
  Write-Output ("cannot extract MAC from InstanceId: {0}" -f $device.InstanceId)
  exit 1
}
$mac = $match.Groups[1].Value
Write-Output ("MAC:    {0}" -f $mac)

$null = [Windows.Devices.Bluetooth.BluetoothLEDevice, Windows.Devices.Bluetooth, ContentType = WindowsRuntime]
$null = [Windows.Devices.Bluetooth.GenericAttributeProfile.GattDeviceService, Windows.Devices.Bluetooth, ContentType = WindowsRuntime]
$null = [Windows.Devices.Bluetooth.GenericAttributeProfile.GattCharacteristic, Windows.Devices.Bluetooth, ContentType = WindowsRuntime]
$null = [Windows.Devices.Bluetooth.GenericAttributeProfile.GattCharacteristicProperties, Windows.Devices.Bluetooth, ContentType = WindowsRuntime]

$address = [System.UInt64]::Parse(('0x' + $mac), [System.Globalization.NumberStyles]::HexNumber)
$leDevice = Await ([Windows.Devices.Bluetooth.BluetoothLEDevice]::FromBluetoothAddressAsync($address)) ([Windows.Devices.Bluetooth.BluetoothLEDevice])
Write-Output ("connection: {0}" -f $leDevice.ConnectionStatus)

$servicesResult = Await ($leDevice.GetGattServicesAsync()) ([Windows.Devices.Bluetooth.GenericAttributeProfile.GattDeviceServicesResult])
if ($servicesResult.Status -ne 'Success') {
  Write-Output ("services status: {0}" -f $servicesResult.Status)
  exit 1
}
foreach ($service in $servicesResult.Services) {
  Write-Output ("SERVICE {0}" -f $service.Uuid)
  $charsResult = Await ($service.GetCharacteristicsAsync()) ([Windows.Devices.Bluetooth.GenericAttributeProfile.GattCharacteristicsResult])
  foreach ($characteristic in $charsResult.Characteristics) {
    Write-Output ("   CHAR   {0}  props={1}" -f $characteristic.Uuid, [int]$characteristic.CharacteristicProperties)
  }
}
