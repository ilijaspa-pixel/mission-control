# Removes Mission Control's autostart and shortcut on Windows.
Remove-Item (Join-Path ([Environment]::GetFolderPath("Startup")) "MissionControl.vbs") -ErrorAction SilentlyContinue
Remove-Item (Join-Path ([Environment]::GetFolderPath("Desktop")) "Mission Control.url") -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match "next.*4100|scripts[\\/]dev.mjs" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Write-Host "Removed. To undo the Claude Code settings change, restore ~\.claude\settings.json.before-mission-control"
