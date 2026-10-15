# Visible, non-installed request consumer. Request contents are never read.
param([string]$Root=$PSScriptRoot, [switch]$Once)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'bundle-common.ps1')
$Root = (Resolve-Path -LiteralPath $Root).Path
$requests = Join-Path $Root 'requests'
$done = Join-Path $requests 'done'
New-Item -ItemType Directory -Force $requests,$done | Out-Null
$lock = $null
try {
    # FileShare.None also prevents two independent consoles from running together.
    $lock = [IO.File]::Open((Join-Path $Root 'desktop-runner.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
    Write-Host 'Desktop runner ready; close this window to stop.'
    $rejected = @{}
    do {
        foreach ($request in @(Get-ChildItem -LiteralPath $requests -Filter '*.req' -File | Sort-Object Name)) {
            $revision = $request.BaseName
            $stamp = $request.LastWriteTimeUtc.Ticks
            if ($rejected[$request.Name] -eq $stamp) { continue }
            try {
                if ($request.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'request_reparse_point' }
                if ($revision -cnotmatch '^[0-9a-f]{40}$') { throw 'invalid_revision' }
                $bundle = Join-Path $Root ('bundles\' + $revision)
                $manifest = Join-Path $Root ('pins\' + $revision + '.json')
                $null = Read-BundlePins $manifest $bundle $revision
            } catch {
                $rejected[$request.Name] = $stamp
                Write-Host "$revision ignored: $($_.Exception.Message)"
                continue
            }
            Write-Host "$revision running"
            $started = [DateTime]::UtcNow
            $child = $null
            try {
                $script = Join-Path $bundle 'windows-sandbox-desktop.ps1'
                $child = Start-Process -FilePath "$PSHOME\powershell.exe" -NoNewWindow -PassThru `
                    -ArgumentList @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',
                        ('"' + $script + '"'),'-Manifest',('"' + $manifest + '"'),
                        '-Bundle',('"' + $bundle + '"'))
                $null = $child.Handle
                $child.WaitForExit()
                $result = Join-Path $env:LOCALAPPDATA ('Butler\e2e-results\' + $revision + '.json')
                if (!(Test-Path -LiteralPath $result)) { throw 'result_missing' }
                $response = Get-Content -LiteralPath $result -Raw | ConvertFrom-Json
                if ($response.revision -cne $revision -or [DateTime]$response.startedUtc -lt $started) { throw 'stale_result' }
                Move-Item -LiteralPath $request.FullName -Destination (Join-Path $done $request.Name) -Force
                Write-Host "$revision $($response.status) exit=$($child.ExitCode)"
            } catch {
                # Leave unacknowledged failures for an explicit operator retry.
                $rejected[$request.Name] = $stamp
                Write-Host "$revision failed: $($_.Exception.Message)"
            } finally {
                if ($null -ne $child) {
                    if (!$child.HasExited) { & taskkill /pid $child.Id /t /f | Out-Null }
                    $child.Dispose()
                }
            }
        }
        if (!$Once) { Start-Sleep -Seconds 2 }
    } while (!$Once)
} finally {
    if ($null -ne $lock) { $lock.Dispose() }
}
