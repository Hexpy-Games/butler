@echo off
powershell.exe -NoProfile -Command "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); if ($env:HOOK_FILE) { [Console]::Write([IO.File]::ReadAllText($env:HOOK_FILE)) } else { [Console]::Write($env:HOOK_TEXT) }; exit [int]$env:HOOK_EXIT"
