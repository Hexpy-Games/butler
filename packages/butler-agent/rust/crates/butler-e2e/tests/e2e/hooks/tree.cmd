@echo off
powershell.exe -NoProfile -Command "$child = Start-Process powershell.exe -ArgumentList '-NoProfile','-Command','Start-Sleep 60' -PassThru; Set-Content -Encoding ASCII -LiteralPath $env:HOOK_PIDS -Value @($PID, $child.Id); Start-Sleep 60"
