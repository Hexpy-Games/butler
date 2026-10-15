@echo off
powershell.exe -NoProfile -Command "[Console]::In.ReadToEnd() | Out-Null; New-Item -ItemType File -Force -Path $env:HOOK_HELD | Out-Null; while (!(Test-Path -LiteralPath $env:HOOK_RELEASE)) { Start-Sleep -Milliseconds 20 }"
