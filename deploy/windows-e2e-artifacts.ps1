param([ValidateSet('Export','Run')][string]$Mode, [string[]]$Tests, [switch]$RequireUncontained)
$ErrorActionPreference = 'Stop'
$artifacts = Join-Path $env:PREVIEW_ROOT 'artifacts'
$commandRegressions = @(
    'windows_commands::observation::observation_ask_first_approves_exact_command_then_lists_downloads',
    'windows_commands::path_messages::home_command_directory_keeps_exact_approval',
    'windows_commands::capabilities::current_work::sequential_file_capabilities_close_the_current_work',
    'windows_commands::windows_command_tool_native_matrix'
)
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
        if ($RequireUncontained -and $test -eq 'windows_commands') {
            foreach ($case in $commandRegressions) {
                if ($listed -notcontains "${case}: test") { throw "Missing without-MXC regression: $case" }
            }
            # Probe the shipped helper on the actual hosted machine; do not disable MXC.
            $probe = "$env:PREVIEW_ROOT/logs/without-mxc-probe.txt"
            $ErrorActionPreference = 'Continue'
            & "$artifacts/butler-sandbox.exe" --probe > $probe 2>&1
            $probeCode = $LASTEXITCODE
            $ErrorActionPreference = 'Stop'
            $reason = (Get-Content -LiteralPath $probe -Raw).Trim()
            if ($probeCode -ne 0 -or $reason -notin @('mxc_api_missing','base_container_unavailable',
                'native_deny_unsupported','dacl_fallback_required','non_interactive_desktop','privilege_not_held')) {
                throw "Expected an unavailable Windows sandbox, got: $reason"
            }
        }
        $savedPerf = $env:BUTLER_E2E_PERF
        $threads = if ($test -eq 'windows_commands') { $env:BUTLER_E2E_PERF = '1'; 1 } else { 8 }
        $log = "$env:PREVIEW_ROOT/logs/$test.log"
        $ErrorActionPreference = 'Continue'
        cmd /d /c "`"$artifacts/e2e.exe`" `"$test`::`" --test-threads=$threads --nocapture > `"$log`" 2>&1"
        $testCode = $LASTEXITCODE
        $ErrorActionPreference = 'Stop'
        $env:BUTLER_E2E_PERF = $savedPerf
        if ($testCode -ne 0) {
            & "$PSScriptRoot/windows-test-log.ps1" -Log $log
            throw "E2E failed: $test ($testCode)"
        }
        if ($RequireUncontained -and $test -eq 'windows_commands') {
            foreach ($case in $commandRegressions) {
                if (!(Select-String -LiteralPath $log -SimpleMatch "test $case ... ok" -Quiet)) {
                    throw "Without-MXC regression did not pass: $case"
                }
            }
        }
        Add-Content "$env:PREVIEW_ROOT/logs/completed-harnesses.txt" $test
    }
}
