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

# Round 3 candidates: the header bytes are the remaining unknown. The JH1
# family header is AA 08 04 — 0x04 looks like a motor-type/mode select, and a
# reverse direction may ride a different value there.
$stream = @(
  @{ name = 'byte2=03';      hex = 'AA080328000000DD' },
  @{ name = 'byte2=05';      hex = 'AA080528000000DF' },
  @{ name = 'byte1=09';      hex = 'AA090428000000DF' },
  @{ name = 'byte2=00';      hex = 'AA080028000000DA' }
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
  $entry = $stream[$Probe - 1]
  Write-Output ("probe {0} [stream]: {1} - {2}   (watch direction, then it resets)" -f $Probe, $entry.name, $entry.hex)
  1..5 | ForEach-Object { Send-Frame $entry.hex 'live'; Start-Sleep -Milliseconds 150 }
  Start-Sleep -Milliseconds 400
  Send-Frame $stopStream 'live'
  Send-Frame $stopAcked 'setup'
  Write-Output "reset sent"
} elseif ($Probe -ge 5 -and $Probe -le 8) {
  $entry = $acked[$Probe - 5]
  Write-Output ("probe {0} [acked]: {1} - {2}   (watch the toy, then it resets)" -f $Probe, $entry.name, $entry.hex)
  Send-Frame $entry.hex 'setup'
  Start-Sleep -Milliseconds 400
  Send-Frame $stopStream 'live'
  Send-Frame $stopAcked 'setup'
  Write-Output "reset sent"
} else {
  Write-Output "Probe must be 1..8"
  exit 1
}
