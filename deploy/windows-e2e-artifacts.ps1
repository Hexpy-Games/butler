param([ValidateSet('Export','Run')][string]$Mode, [string[]]$Tests)
$ErrorActionPreference = 'Stop'
$artifacts = Join-Path $env:PREVIEW_ROOT 'artifacts'
if ($Mode -eq 'Export') {
    New-Item -ItemType Directory -Force $artifacts | Out-Null
    $records = Get-Content "$env:PREVIEW_ROOT/logs/harness-compile.log" |
        Where-Object { $_.StartsWith('{') } | ForEach-Object { $_ | ConvertFrom-Json }
    foreach ($record in $records) {
        if ($record.reason -eq 'compiler-artifact' -and $record.executable -and $record.profile.test) {
            Copy-Item $record.executable "$artifacts/$($record.target.name).exe"
        }
    }
    foreach ($binary in @('butler-agent.exe', 'butler-sandbox.exe')) {
        $source = "$env:CARGO_TARGET_DIR/x86_64-pc-windows-msvc/debug/$binary"
        if (!(Test-Path -LiteralPath $source -PathType Leaf)) { throw "Missing Windows E2E binary: $source" }
        Copy-Item -LiteralPath $source -Destination $artifacts
    }
} else {
    if ($env:BUTLER_E2E_TIER -ne 'stub') { throw 'Compiled Windows verification requires BUTLER_E2E_TIER=stub' }
    foreach ($test in $Tests) {
        $env:HOME = Join-Path $env:PREVIEW_ROOT ([guid]::NewGuid())
        $env:BUTLER_DATA = Join-Path $env:PREVIEW_ROOT ([guid]::NewGuid())
        New-Item -ItemType Directory $env:HOME,$env:BUTLER_DATA | Out-Null
        $ErrorActionPreference = 'Continue'
        $listed = & "$artifacts/e2e.exe" "$test`::" --list
        $ErrorActionPreference = 'Stop'
        if ($LASTEXITCODE -ne 0 -or !($listed -match ': test$')) { throw "Empty E2E selection: $test" }
        $savedPerf = $env:BUTLER_E2E_PERF
        # The hosted run records command timings; the owner-PC matrix (windows-command-matrix.ps1) enforces the budgets.
        $env:BUTLER_E2E_PERF = '0'
        $threads = if ($test -eq 'windows_commands') { 1 } else { 8 }
        $log = "$env:PREVIEW_ROOT/logs/$test.log"
        $ErrorActionPreference = 'Continue'
        cmd /d /c "`"$artifacts/e2e.exe`" `"$test`::`" --test-threads=$threads --nocapture > `"$log`" 2>&1"
        $testCode = $LASTEXITCODE
        $ErrorActionPreference = 'Stop'
        if ($null -eq $savedPerf) { Remove-Item Env:BUTLER_E2E_PERF -ErrorAction SilentlyContinue } else { $env:BUTLER_E2E_PERF = $savedPerf }
        if ($testCode -ne 0) {
            & "$PSScriptRoot/windows-test-log.ps1" -Log $log
            throw "E2E failed: $test ($testCode)"
        }
        Add-Content "$env:PREVIEW_ROOT/logs/completed-harnesses.txt" $test
    }
}
