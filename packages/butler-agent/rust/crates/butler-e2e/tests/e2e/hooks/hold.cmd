@echo off
powershell.exe -NoProfile -Command "[Console]::In.ReadToEnd() | Out-Null; New-Item -ItemType File -Force -Path $env:HOOK_HELD | Out-Null; $deadline = (Get-Date).AddSeconds(60); while (!(Test-Path -LiteralPath $env:HOOK_RELEASE)) { if ((Get-Date) -ge $deadline) { exit 1 }; Start-Sleep -Milliseconds 20 }; [Console]::Write($env:HOOK_TEXT)"
