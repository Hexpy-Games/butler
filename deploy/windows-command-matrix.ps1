# Manual native-loop proof; regular runs use hosted / basics.
$env:HOME = Join-Path $env:PREVIEW_ROOT ([guid]::NewGuid())
$env:BUTLER_DATA = Join-Path $env:PREVIEW_ROOT ([guid]::NewGuid())
New-Item -ItemType Directory $env:HOME,$env:BUTLER_DATA | Out-Null
$env:BUTLER_E2E_BIN = "$env:CARGO_TARGET_DIR/x86_64-pc-windows-msvc/debug/butler-agent.exe"
$env:BUTLER_E2E_PERF = '1'
$ErrorActionPreference = 'Continue'
cmd /d /c "cargo test --locked --target x86_64-pc-windows-msvc -p butler-e2e --test e2e windows_commands:: -- --test-threads=1 --nocapture > `"$env:PREVIEW_ROOT/logs/command-matrix.log`" 2>&1"
$testCode = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
Remove-Item Env:BUTLER_E2E_PERF
if ($testCode -ne 0) {
  & "$env:GITHUB_WORKSPACE/deploy/windows-test-log.ps1" -Log "$env:PREVIEW_ROOT/logs/command-matrix.log"
  exit $testCode
}
