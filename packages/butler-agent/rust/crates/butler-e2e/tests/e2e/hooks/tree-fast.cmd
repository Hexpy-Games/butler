@echo off
rem Two fast-starting children (ping), no PowerShell: its cold start would count against the hook's timeout.
start "" /b cmd /d /c "ping -n 60 -l 1357 127.0.0.1 >nul"
echo up> "%HOOK_PIDS%"
ping -n 60 -l 1357 127.0.0.1 >nul
