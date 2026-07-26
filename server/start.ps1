# Chordify analysis server launcher — run by Task Scheduler at logon (or NSSM).
# `uv tool upgrade yt-dlp` is the Windows analog of the old systemd ExecStartPre.
$ErrorActionPreference = 'Continue'
Set-Location $PSScriptRoot
New-Item -ItemType Directory -Force logs | Out-Null
& uv tool upgrade yt-dlp *>> logs\server.log
& uv run uvicorn app.main:app --host 127.0.0.1 --port 8934 *>> logs\server.log
