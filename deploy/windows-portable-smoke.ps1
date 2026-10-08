param([Parameter(Mandatory = $true)][string]$PackageRoot)
. "$PSScriptRoot/windows-job-tree.ps1"
$ErrorActionPreference = 'Stop'
$saved = @{}
foreach ($name in @('HOME','BUTLER_DATA','LOCALAPPDATA','APPDATA','TEMP','TMP','BUTLER_SMOKE_PROFILE_ROOT')) {
    $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}
$root = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid())
New-Item -ItemType Directory "$root/home","$root/data","$root/tmp","$root/local","$root/roaming" | Out-Null
$env:HOME = "$root/home"
$env:BUTLER_DATA = "$root/data"
$env:LOCALAPPDATA = "$root/local"
$env:APPDATA = "$root/roaming"
$env:TEMP = "$root/tmp"
$env:TMP = "$root/tmp"
$env:BUTLER_SMOKE_PROFILE_ROOT = $root
try {
    & "$PSScriptRoot/windows-protocol-snapshot.ps1" -Output "$root/protocol-before.json"
    bun run packages/butler-app/scripts/windows/packaged-app-smoke.ts $PackageRoot
    if ($LASTEXITCODE) { throw 'Portable smoke failed' }
} finally {
    try {
        & "$PSScriptRoot/windows-protocol-snapshot.ps1" -Output "$root/protocol-after.json"
        if ((Get-Content "$root/protocol-before.json" -Raw) -cne (Get-Content "$root/protocol-after.json" -Raw)) {
            throw 'Portable smoke changed owner protocol registration'
        }
    } finally {
        try { Remove-JobTree $root }
        finally {
            foreach ($name in $saved.Keys) { [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process') }
        }
    }
}
