# Claude Code "Notification" hook for Windows: flags the tile in Mission Control,
# plays a sound and shows a tray notification. Never fails the hook.
$ErrorActionPreference = "SilentlyContinue"
$payload = [Console]::In.ReadToEnd()
try {
  Invoke-RestMethod -Uri "http://127.0.0.1:4100/api/attention" -Method Post -ContentType "application/json" -Body $payload -TimeoutSec 2 | Out-Null
} catch {}
$msg = "Waiting for your input"
$proj = ""
try {
  $j = $payload | ConvertFrom-Json
  if ($j.message) { $msg = $j.message }
  if ($j.cwd) { $proj = Split-Path $j.cwd -Leaf }
} catch {}
[System.Media.SystemSounds]::Exclamation.Play()
try {
  Add-Type -AssemblyName System.Windows.Forms
  $n = New-Object System.Windows.Forms.NotifyIcon
  $n.Icon = [System.Drawing.SystemIcons]::Information
  $n.Visible = $true
  $n.ShowBalloonTip(5000, "Claude - $proj", $msg, [System.Windows.Forms.ToolTipIcon]::Info)
  Start-Sleep -Seconds 6
  $n.Dispose()
} catch {}
