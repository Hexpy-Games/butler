# Run over SSH from a clean checkout. Uses only the installed toolchain and ORT.
param([Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference = 'Stop'
$workspace = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..')).Path
$revision = (& git -C $workspace rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or (& git -C $workspace status --porcelain)) { throw 'clean_checkout_required' }
if (!$env:CARGO_TARGET_DIR -or !$env:ORT_LIB_PATH) { throw 'existing_target_and_static_ort_required' }
$oldEnvironment = @{}
foreach ($name in @('HOME','USERPROFILE','BUTLER_DATA','APPDATA','LOCALAPPDATA','TEMP','TMP')) {
    $oldEnvironment[$name] = [Environment]::GetEnvironmentVariable($name)
}
$profile = Join-Path $Destination ('build-' + [guid]::NewGuid().ToString('N').Substring(0,8))
$logs = Join-Path $Destination ('build-logs\' + $revision)
New-Item -ItemType Directory -Force $logs | Out-Null
. (Join-Path $PSScriptRoot 'bundle-common.ps1')
function Build([string]$Name, [string[]]$Arguments) {
    # Each invocation gets its own isolated home/data, while reusing build caches.
    Set-BundleEnvironment $workspace (Join-Path $profile $Name)
    $child = Start-Process -FilePath 'cargo.exe' -WorkingDirectory $workspace -NoNewWindow -PassThru `
        -ArgumentList $Arguments -RedirectStandardOutput (Join-Path $logs "$Name.stdout") `
        -RedirectStandardError (Join-Path $logs "$Name.stderr")
    try {
        $null = $child.Handle
        $child.WaitForExit()
        if ($child.ExitCode -ne 0) { throw ("build_failed: $Name; $logs") }
    } finally {
        if (!$child.HasExited) { & taskkill /pid $child.Id /t /f | Out-Null }
        $child.Dispose()
    }
}
try {
    $env:RUSTUP_AUTO_INSTALL = '0'
    $env:ORT_PREFER_DYNAMIC_LINK = '0'
    $env:ORT_SKIP_DOWNLOAD = '1'
    Build 'agent' @('build','--locked','-p','butler-agent','--no-default-features',
        '--features','static-ort,e2e-fixtures,butler-platform/test-support','--bin','butler-agent')
    Build 'helper' @('build','--locked','-p','butler-platform','--features','test-support','--bin','butler-sandbox')
    Build 'e2e' @('test','--locked','-p','butler-e2e','--test','e2e','--no-run','--message-format=json')
    $test = @(Get-Content (Join-Path $logs 'e2e.stdout') | ForEach-Object {
        $item = $_ | ConvertFrom-Json
        if ($item.reason -eq 'compiler-artifact' -and $item.target.name -eq 'e2e' -and $item.executable) { $item.executable }
    })[-1]
    if (!$test) { throw 'e2e_artifact_missing' }
    Set-BundleEnvironment $workspace (Join-Path $profile 'row16')
    $env:BUTLER_E2E_BIN = Join-Path $env:CARGO_TARGET_DIR 'debug\butler-agent.exe'
    $env:BUTLER_E2E_RESOURCES = Join-Path $workspace '..\resources'
    $env:BUTLER_E2E_CASSETTES = Join-Path $workspace 'crates\butler-e2e\cassettes'
    Remove-Item Env:BUTLER_E2E_WINDOWS_SANDBOX_DESKTOP -ErrorAction SilentlyContinue
    # The same test runner accepts a bundle directory, so stage the test beside the build binaries.
    $bin = Split-Path $env:BUTLER_E2E_BIN -Parent
    Copy-Item -LiteralPath $test -Destination (Join-Path $bin 'e2e.exe')
    Invoke-BundleTest $bin 'windows_sandbox::project_write::row16_non_interactive_asks' (Join-Path $logs 'row16.log')
    $ssh = Join-Path $logs 'ssh-row16.json'
    @{revision=$revision;status='PASS';surface='SSH'} | ConvertTo-Json | Set-Content -Encoding UTF8 $ssh
    & (Join-Path $PSScriptRoot 'prepare-windows-sandbox-harness.ps1') -Agent $env:BUTLER_E2E_BIN `
        -Helper (Join-Path $bin 'butler-sandbox.exe') -Test $test -Resources $env:BUTLER_E2E_RESOURCES `
        -Cassettes $env:BUTLER_E2E_CASSETTES -Revision $revision -SshEvidence $ssh -Destination $Destination
} finally {
    foreach ($name in $oldEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name, $oldEnvironment[$name], 'Process') }
    Remove-Item -LiteralPath $profile -Recurse -Force -ErrorAction SilentlyContinue
}
