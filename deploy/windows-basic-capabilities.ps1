param([Parameter(Mandatory=$true)][string]$Agent)
$ErrorActionPreference = 'Stop'
$root = Join-Path $env:TEMP ('butler-basic-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $root | Out-Null
& "$PSScriptRoot/windows-protocol-snapshot.ps1" -Output "$root/before.json"
$before = Get-Content "$root/before.json" -Raw
$saved = @{}
$keys = @('HOME','BUTLER_DATA','LOCALAPPDATA','APPDATA','TEMP','TMP',
    'BUTLER_E2E_TIER','BUTLER_E2E_PERF','BUTLER_E2E_BIN','BUTLER_SECRET_STORE',
    'BUTLER_PLATFORM_SYSTEM_SECRETS','BUTLER_APP_DISABLE_SHELL_REGISTRATION')
foreach ($key in $keys) { $saved[$key] = [Environment]::GetEnvironmentVariable($key) }
try {
    foreach ($name in @('home','data','local','roaming','tmp')) {
        New-Item -ItemType Directory -Force "$root/$name" | Out-Null
    }
    $env:HOME = "$root/home"
    $env:BUTLER_DATA = "$root/data"
    $env:LOCALAPPDATA = "$root/local"
    $env:APPDATA = "$root/roaming"
    $env:TEMP = "$root/tmp"
    $env:TMP = $env:TEMP
    $env:BUTLER_E2E_TIER = 'stub'
    $env:BUTLER_E2E_PERF = '1'
    $env:BUTLER_E2E_BIN = (Resolve-Path $Agent).Path
    $env:BUTLER_SECRET_STORE = 'file'
    $env:BUTLER_PLATFORM_SYSTEM_SECRETS = '0'
    $env:BUTLER_APP_DISABLE_SHELL_REGISTRATION = '1'
    cargo test --locked --target x86_64-pc-windows-msvc -p butler-e2e --test e2e `
        windows_commands:: -- --test-threads=1 --nocapture
    if ($LASTEXITCODE -ne 0) { throw "Windows basic capability suite failed ($LASTEXITCODE)" }
} finally {
    & "$PSScriptRoot/windows-protocol-snapshot.ps1" -Output "$root/after.json"
    $after = Get-Content "$root/after.json" -Raw
    foreach ($key in $keys) { [Environment]::SetEnvironmentVariable($key, $saved[$key]) }
    python -c "import shutil,sys; shutil.rmtree(chr(92)*2+'?'+chr(92)+sys.argv[1])" $root
    if ($LASTEXITCODE -ne 0) { throw 'Could not remove isolated test profiles' }
    if ($before -cne $after) { throw 'Owner protocol registration changed' }
    Write-Output 'Protocol registration unchanged'
}
