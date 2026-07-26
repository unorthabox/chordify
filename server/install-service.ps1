# One-shot durable-service installer for the Chordify analysis server.
# RUN THIS ONCE FROM AN ELEVATED POWERSHELL (Win+X -> "Terminal (Admin)"):
#   powershell -ExecutionPolicy Bypass -File C:\Users\Colto\chordify\server\install-service.ps1
#
# Registers a boot-trigger scheduled task running as the Colto account with an
# S4U logon: starts at boot with no interactive login required and NO password
# stored anywhere. (S4U can't reach authenticated network shares, but the server
# only needs local files + plain outbound HTTP, so that limitation is moot.)
# Replaces both the interim interactive-only task and any manually started server.

$ErrorActionPreference = 'Stop'
$TaskName = 'ChordifyServer'
$Script   = Join-Path $PSScriptRoot 'start.ps1'

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
        ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host 'This script must run in an ELEVATED PowerShell (Run as administrator).' -ForegroundColor Red
    exit 1
}

# retire the interim interactive-only task
try { Unregister-ScheduledTask -TaskName 'ChordifyAnalysisServer' -Confirm:$false -ErrorAction Stop
      Write-Host 'removed interim task ChordifyAnalysisServer' } catch {}
try { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop
      Write-Host "removed existing $TaskName (reinstalling)" } catch {}

# stop any manually-started server holding port 8934
$owners = Get-NetTCPConnection -LocalPort 8934 -State Listen -ErrorAction SilentlyContinue |
          Select-Object -ExpandProperty OwningProcess -Unique
foreach ($op in $owners) {
    try { Stop-Process -Id $op -Force -Confirm:$false; Write-Host "stopped process $op on :8934" } catch {}
}

$action    = New-ScheduledTaskAction -Execute 'powershell.exe' `
             -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Script`""
$trigger   = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType S4U -RunLevel Limited
$settings  = New-ScheduledTaskSettingsSet `
             -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
             -StartWhenAvailable `
             -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1) `
             -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings `
    -Description 'Chordify v2 analysis server (FastAPI on 127.0.0.1:8934; yt-dlp self-updates on start)' | Out-Null
Write-Host "registered $TaskName (boot trigger, S4U as $env:USERNAME)"

Start-ScheduledTask -TaskName $TaskName
Write-Host 'started — waiting for /health…'
$ok = $false
foreach ($i in 1..30) {
    Start-Sleep -Seconds 2
    try {
        $r = Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8934/health -TimeoutSec 3
        if ($r.StatusCode -eq 200) { $ok = $true; break }
    } catch {}
}
if ($ok) {
    Write-Host "OK: $($r.Content)" -ForegroundColor Green
    Write-Host 'Durable service installed. It will start on every boot, logged in or not.'
} else {
    Write-Host 'Server did not answer within 60s — check server\logs\server.log' -ForegroundColor Red
    exit 1
}
