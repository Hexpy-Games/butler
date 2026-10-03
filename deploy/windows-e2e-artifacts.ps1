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
    Copy-Item "$env:CARGO_TARGET_DIR/x86_64-pc-windows-msvc/debug/butler-agent.exe" $artifacts
} else {
    foreach ($test in $Tests) {
        $env:HOME = Join-Path $env:PREVIEW_ROOT ([guid]::NewGuid())
        $env:BUTLER_DATA = Join-Path $env:PREVIEW_ROOT ([guid]::NewGuid())
        New-Item -ItemType Directory $env:HOME,$env:BUTLER_DATA | Out-Null
        $listed = & "$artifacts/e2e.exe" "$test`::" --list
        if ($LASTEXITCODE -ne 0 -or !($listed -match ': test$')) { throw "Empty E2E selection: $test" }
        & "$artifacts/e2e.exe" "$test`::" --test-threads=8 --nocapture
        if ($LASTEXITCODE -ne 0) { throw "E2E failed: $test ($LASTEXITCODE)" }
        Add-Content "$env:PREVIEW_ROOT/logs/completed-harnesses.txt" $test
    }
}
