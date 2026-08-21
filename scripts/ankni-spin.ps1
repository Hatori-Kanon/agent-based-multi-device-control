# Probe round 2 for the ANKNI rotation direction encoding.
#
#   powershell -ExecutionPolicy Bypass -File scripts\ankni-spin.ps1 -Url http://127.0.0.1:6332 -Token <token> -Probe 2
#
# Probes 1-4: slot candidates in the stream frame (ddd1).
# Probes 5-8: 03 12 command-family packets on the ACKED channel (ddd2).
# Each probe bursts 5 times at 150ms and resets afterwards (zero stream frame
# plus 03 12 00 stop on the acked channel).

param(
  [string]$Url = 'http://127.0.0.1:6332',
  [string]$Token = '',
  [string]$Device = 'zkrxb',
  [int]$Probe = 1
)

if ($Token.Length -eq 0) { Write-Output "usage: -Url <console base> -Token <from the console URL> [-Probe 1..8]"; exit 1 }

$headers = @{ 'x-control-token' = $Token; 'Content-Type' = 'application/json' }
$rawUrl = "$Url/api/devices/raw"

function Send-Frame([string]$hex, [string]$channel = 'live') {
  $body = @{ deviceId = $Device; hex = $hex; channel = $channel } | ConvertTo-Json
  Invoke-RestMethod -Method Post -Uri $rawUrl -Headers $headers -Body $body | Out-Null
}

function Build-CommandPacket([string]$commandHex, [string]$paramHex) {
  # 03 12 <command> <param> + 16 zero bytes = the family's 20-byte frame.
  return ('03' + '12' + $commandHex + $paramHex + ('00' * 16))
}

# Round 2 candidates. Names say what to look for.
$stream = @(
  @{ name = 'slot4=1';        hex = 'AA080428000001DF' },
  @{ name = 'slot4=2';        hex = 'AA080428000002E0' },
  @{ name = 'slot2=0xFF';     hex = 'AA08042800FF00DD' },
  @{ name = 'slot2=0x28 same as motor'; hex = 'AA08042828000006' }
)
$acked = @(
  @{ name = '03 12 0E 01 (dir?)';  hex = (Build-CommandPacket '0E' '01') },
  @{ name = '03 12 0E 02 (dir?)';  hex = (Build-CommandPacket '0E' '02') },
  @{ name = '03 12 0F 01 (mode?)'; hex = (Build-CommandPacket '0F' '01') },
  @{ name = '03 12 10 01 (mode?)'; hex = (Build-CommandPacket '10' '01') }
)

$stopStream = 'AA080400000000B6'
$stopAcked = Build-CommandPacket '00' '00'

if ($Probe -ge 1 -and $Probe -le 4) {
  $probe = $stream[$Probe - 1]
  Write-Output ("probe {0} [stream]: {1} - {2}   (watch direction, then it resets)" -f $Probe, $probe.name, $probe.hex)
  1..5 | ForEach-Object { Send-Frame $probe.hex 'live'; Start-Sleep -Milliseconds 150 }
  Start-Sleep -Milliseconds 400
  Send-Frame $stopStream 'live'
  Send-Frame $stopAcked 'setup'
  Write-Output "reset sent"
} elseif ($Probe -ge 5 -and $Probe -le 8) {
  $probe = $acked[$Probe - 5]
  Write-Output ("probe {0} [acked]: {1} - {2}   (watch the toy, then it resets)" -f $Probe, $probe.name, $probe.hex)
  Send-Frame $probe.hex 'setup'
  Start-Sleep -Milliseconds 400
  Send-Frame $stopStream 'live'
  Send-Frame $stopAcked 'setup'
  Write-Output "reset sent"
} else {
  Write-Output "Probe must be 1..8"
  exit 1
}
