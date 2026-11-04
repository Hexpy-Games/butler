param([ValidateSet('Build','Verify')][string]$Mode)
. "$PSScriptRoot/windows-job-tree.ps1"
$ErrorActionPreference = 'Stop'
$root = Join-Path $env:RUNNER_TEMP ([guid]::NewGuid())
$repo = (Get-Location).Path
$out = Join-Path $repo 'dist/release/installer-contracts'
$env:CARGO_HOME = "$env:USERPROFILE/.cargo"
$env:RUSTUP_HOME = "$env:USERPROFILE/.rustup"
$env:HOME = Join-Path $root 'home'
$env:BUTLER_DATA = Join-Path $root 'data'
New-Item -ItemType Directory $env:HOME,$env:BUTLER_DATA | Out-Null
try {
    if ($Mode -eq 'Build') {
        New-Item -ItemType Directory -Force $out | Out-Null
        Push-Location packages/butler-agent/rust
        try {
            $ErrorActionPreference = 'Continue'
            cargo clippy --locked --target x86_64-pc-windows-msvc -p butler-platform -- -D warnings
            $ErrorActionPreference = 'Stop'
            if ($LASTEXITCODE) { throw 'Windows platform clippy failed' }
            $ErrorActionPreference = 'Continue'
            cargo test --locked --profile ci-fast --target x86_64-pc-windows-msvc -p butler-e2e --test e2e --no-run --message-format=json > "$root/compile.jsonl"
            $ErrorActionPreference = 'Stop'
            if ($LASTEXITCODE) { throw 'Update harness build failed' }
        } finally { Pop-Location }
        foreach ($line in Get-Content "$root/compile.jsonl") {
            $record = $line | ConvertFrom-Json
            if ($record.reason -eq 'compiler-artifact' -and $record.executable -and $record.profile.test) {
                Copy-Item $record.executable "$out/$($record.target.name).exe"
            }
        }
    } else {
        if ($env:RUNNER_ENVIRONMENT -ne 'github-hosted') { throw 'Hosted verification only' }
        $zip = @(Get-ChildItem dist/release/agent-first/butler-agent-*-windows-x64.zip)
        if ($zip.Count -ne 1) { throw 'Expected exact first Agent archive' }
        Expand-Archive $zip[0].FullName "$root/agent"
        $env:BUTLER_E2E_BIN = "$root/agent/butler-agent.exe"
        $env:BUTLER_E2E_SKIP_BUILD = '1'
        $env:BUTLER_E2E_TIER = 'stub'
        $env:BUTLER_E2E_WORKSPACE_ROOT = Join-Path $repo 'packages/butler-agent/rust'
        foreach ($test in @('updates','update_channels','process_names')) {
            $env:HOME = Join-Path $root ([guid]::NewGuid())
            $env:BUTLER_DATA = Join-Path $root ([guid]::NewGuid())
            New-Item -ItemType Directory $env:HOME,$env:BUTLER_DATA | Out-Null
            $ErrorActionPreference = 'Continue'
            $listed = & "$out/e2e.exe" "$test`::" --list
            $ErrorActionPreference = 'Stop'
            if ($LASTEXITCODE -ne 0 -or !($listed -match ': test$')) { throw "Empty update E2E selection: $test" }
            $ErrorActionPreference = 'Continue'
            & "$out/e2e.exe" "$test`::" --nocapture --test-threads=8
            $ErrorActionPreference = 'Stop'
            if ($LASTEXITCODE) { throw "Update E2E failed: $test" }
        }
    }
} finally { Remove-JobTree $root }
