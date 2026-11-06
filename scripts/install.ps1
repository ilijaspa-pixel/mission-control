# Mission Control installer for Windows. Run from the repo folder in PowerShell:
#   powershell -ExecutionPolicy Bypass -File scripts\install.ps1
# Optional voice input:  $env:GROQ_API_KEY="gsk_..." before running.
$ErrorActionPreference = "Stop"
$Repo = Split-Path -Parent $PSScriptRoot
$Port = 4100
function Say($t) { Write-Host "`n$t" -ForegroundColor Cyan }

Say "1/6 Checking requirements"
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Write-Host "Node.js is missing. Install the LTS from https://nodejs.org then run this again."; exit 1 }
$major = [int](node -p "process.versions.node.split('.')[0]")
if ($major -lt 20) { Write-Host "Node $major is too old; need 20 or newer."; exit 1 }
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) { Write-Host "Note: 'claude' (Claude Code) not found on PATH. Mission Control shows Claude Code sessions, so install it too." }

Say "2/6 Installing packages (takes a minute)"
Set-Location $Repo
npm install --no-audit --no-fund
if ($LASTEXITCODE -ne 0) {
  Write-Host "npm install failed. If the error mentions node-pty or node-gyp, install 'Visual Studio Build Tools' with the 'Desktop development with C++' workload, then run this again."
  exit 1
}

Say "3/6 Settings"
if ($env:GROQ_API_KEY) { "GROQ_API_KEY=$($env:GROQ_API_KEY)" | Set-Content -Encoding ascii .env.local; Write-Host "Voice input on." }
else { Write-Host "Voice input off (no GROQ_API_KEY). Fine to skip." }

Say "4/6 Claude Code status line + 'needs you' alert"
$claudeDir = Join-Path $HOME ".claude"
New-Item -ItemType Directory -Force -Path (Join-Path $claudeDir "hooks") | Out-Null
Copy-Item extras\statusline.cjs (Join-Path $claudeDir "statusline.cjs") -Force
Copy-Item extras\notify-waiting.ps1 (Join-Path $claudeDir "hooks\notify-waiting.ps1") -Force
node scripts/merge-settings.cjs
if ($LASTEXITCODE -ne 0) { Write-Host "Could not update Claude Code settings; Mission Control still works without the alert." }

Say "5/6 Start on login (hidden)"
$log = Join-Path $env:LOCALAPPDATA "mission-control.log"
$startup = [Environment]::GetFolderPath("Startup")
$vbs = Join-Path $startup "MissionControl.vbs"
$cmd = "cmd /c cd /d ""$Repo"" && npm run dev:win > ""$log"" 2>&1"
"CreateObject(""WScript.Shell"").Run ""$($cmd.Replace('"','""'))"", 0, False" | Set-Content -Encoding ascii $vbs
Start-Process wscript.exe -ArgumentList "`"$vbs`""

Say "6/6 Desktop shortcut"
$url = Join-Path ([Environment]::GetFolderPath("Desktop")) "Mission Control.url"
"[InternetShortcut]`r`nURL=http://localhost:$Port/" | Set-Content -Encoding ascii $url

Write-Host -NoNewline "Waiting for Mission Control to start"
for ($i = 0; $i -lt 90; $i++) {
  try { Invoke-WebRequest -UseBasicParsing "http://localhost:$Port" -TimeoutSec 2 | Out-Null; break } catch { Write-Host -NoNewline "."; Start-Sleep 2 }
}
Say "Done. Open http://localhost:$Port (or 'Mission Control' on your Desktop)."
Write-Host "Restart any open Claude Code windows so they pick up the status line and alert hook."
Write-Host "Log file: $log"
