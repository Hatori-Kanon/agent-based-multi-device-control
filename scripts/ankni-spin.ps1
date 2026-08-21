# Probe frames for the ANKNI rotation direction encoding.
#
# Usage (fill in your console URL + token, then run each probe and watch the
# toy's direction, then read the output):
#
#   powershell -ExecutionPolicy Bypass -File scripts\ankni-spin.ps1 -Url http://127.0.0.1:6332 -Token 7l-K1loxJzWOsJLnMmO1vOLvVS4xG86Z
#
# Each probe bursts the frame 5 times at 150 ms, then sends the stop frame.
# Probes are single-shot: run once per idea, and do not stack them on top of
# each other. The toy is stream-hold: it keeps spinning only briefly after the
# burst ends.

param(
  [string]$Url = 'http://127.0.0.1:6332',
  [string]$Token = '',
  [string]$Device = 'zkrxb',
  [int]$Probe = 1
)

if ($Token.Length -eq 0) { Write-Output "usage: -Url <console base> -Token <from the console URL> [-Probe 1..5]"; exit 1 }

$headers = @{ 'x-control-token' = $Token; 'Content-Type' = 'application/json' }
$rawUrl = "$Url/api/devices/raw"

# Candidate encodings, most likely first. All carry 40 (0x28) rotation, with a
# candidate direction marker in a different slot. Checksum = sum & 0xFF.
$frames = @(
  'AA080428010000DF', # A1: slot2 = 1 (direction flag low)
  'AA080428020000E0', # A2: slot2 = 2 (direction flag high)
  'AA0804A80000005E', # B:  high bit in the motor byte (0xA8 = 40 + 0x80)
  'AA080428000100DF', # C1: slot3 = 1
  'AA080428000200E0'  # C2: slot3 = 2
)
$stop = 'AA080400000000B6'

function Send-Frame([string]$hex) {
  $body = @{ deviceId = $Device; hex = $hex } | ConvertTo-Json
  Invoke-RestMethod -Method Post -Uri $rawUrl -Headers $headers -Body $body | Out-Null
}

if ($Probe -lt 1 -or $Probe -gt $frames.Count) {
  Write-Output "Probe must be 1..5"
  exit 1
}
$frame = $frames[$Probe - 1]
Write-Output ("probe {0}: {1}  (observe the direction now, then it stops)" -f $Probe, $frame)
1..5 | ForEach-Object { Send-Frame $frame; Start-Sleep -Milliseconds 150 }
Start-Sleep -Milliseconds 400
Send-Frame $stop
Write-Output ("stop frame sent: {0}" -f $stop)
