# Shared by the trusted queue runner, bundle builder and desktop entry point.
function Read-BundlePins([string]$Manifest, [string]$Bundle, [string]$Revision) {
    if ($Revision -cnotmatch '^[0-9a-f]{40}$') { throw 'invalid_revision' }
    $pins = Get-Content -LiteralPath $Manifest -Raw | ConvertFrom-Json
    if ($pins.revision -cne $Revision) { throw 'revision_mismatch' }
    $seen = @{}
    foreach ($pin in $pins.binaries) {
        if ($pin.name -notmatch '^[a-zA-Z0-9_.-]+([/\\][a-zA-Z0-9_.-]+)*$' -or
            @($pin.name -split '[/\\]' | Where-Object { $_ -in @('.', '..') }).Count -or
            $seen.ContainsKey($pin.name) -or $pin.sha256 -cnotmatch '^[0-9a-f]{64}$') {
            throw 'invalid_pin'
        }
        $seen[$pin.name.Replace('\','/')] = $true
        $path = Join-Path $Bundle $pin.name
        $part = Get-Item -LiteralPath $path -Force
        while ($null -ne $part) {
            if ($part.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'bundle_reparse_point' }
            $parent = Split-Path -Parent $part.FullName
            $part = if ($parent) { Get-Item -LiteralPath $parent -Force } else { $null }
        }
        if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $pin.sha256) {
            throw ('hash_mismatch: ' + $pin.name)
        }
    }
    foreach ($required in @('butler-agent.exe','butler-sandbox.exe','e2e.exe',
        'windows-sandbox-desktop.ps1','bundle-common.ps1','windows-policy-probe.cs',
        'windows-registry-snapshot.cs','windows-host-snapshot.ps1','ssh-row16.json',
        'resources/eol.md','cassettes/TOOL-01/meta.json')) {
        if (!$seen.ContainsKey($required)) { throw ('missing_pin: ' + $required) }
    }
    foreach ($file in Get-ChildItem -LiteralPath $Bundle -File -Recurse -Force) {
        $relative = $file.FullName.Substring($Bundle.Length + 1).Replace('\','/')
        if ($relative -ne 'pins.json' -and !$seen.ContainsKey($relative)) { throw ('unpinned_file: ' + $relative) }
    }
    return $pins
}
function Set-BundleEnvironment([string]$Bundle, [string]$Profile) {
    foreach ($tool in @(@('CARGO_HOME','.cargo'), @('RUSTUP_HOME','.rustup'))) {
        if (![Environment]::GetEnvironmentVariable($tool[0])) {
            $path = Join-Path $env:USERPROFILE $tool[1]
            if (Test-Path -LiteralPath $path -PathType Container) {
                [Environment]::SetEnvironmentVariable($tool[0], $path, 'Process')
            }
        }
    }
    foreach ($pair in @(@('HOME','home'),@('USERPROFILE','home'),@('BUTLER_DATA','data'),
        @('APPDATA','roaming'),@('LOCALAPPDATA','local'),@('TEMP','temp'),@('TMP','temp'))) {
        $path = Join-Path $Profile $pair[1]
        New-Item -ItemType Directory -Force $path | Out-Null
        [Environment]::SetEnvironmentVariable($pair[0], $path, 'Process')
    }
    $env:BUTLER_E2E_RESOURCES = Join-Path $Bundle 'resources'
    $env:BUTLER_E2E_CASSETTES = Join-Path $Bundle 'cassettes'
    $env:BUTLER_E2E_BIN = Join-Path $Bundle 'butler-agent.exe'
    $env:BUTLER_E2E_SKIP_BUILD = '1'
    $env:BUTLER_E2E_TIER = 'stub'
    $env:BUTLER_E2E_RECORD = '0'
    $env:BUTLER_APP_DISABLE_SHELL_REGISTRATION = '1'
    Remove-Item Env:BUTLER_WINDOWS_PROJECT_SANDBOX -ErrorAction SilentlyContinue
}
function Invoke-BundleTest([string]$Bundle, [string]$Case, [string]$Log) {
    $child = Start-Process -FilePath (Join-Path $Bundle 'e2e.exe') -NoNewWindow -PassThru `
        -ArgumentList @($Case,'--exact','--nocapture','--test-threads=1') `
        -RedirectStandardOutput "$Log.stdout" -RedirectStandardError "$Log.stderr"
    try {
        $null = $child.Handle
        if (!$child.WaitForExit(600000)) { throw ('setup_timeout: ' + $Case) }
        $child.WaitForExit()
        $output = (Get-Content -Raw "$Log.stdout") + (Get-Content -Raw "$Log.stderr")
        $output | Set-Content -Encoding UTF8 $Log
        if ($child.ExitCode -ne 0 -or $output -notmatch 'test result: ok\. 1 passed; 0 failed' -or
            $output -match 'SKIP|skipping') { throw ('setup_failed: ' + $Case + '; ' + $Log) }
    } finally {
        if (!$child.HasExited) { & taskkill /pid $child.Id /t /f | Out-Null }
        $child.Dispose()
    }
}
