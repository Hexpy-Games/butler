# Publish only complete, independently runnable bundles after their SSH setup check.
param(
    [Parameter(Mandatory=$true)][string]$Agent,
    [Parameter(Mandatory=$true)][string]$Helper,
    [Parameter(Mandatory=$true)][string]$Test,
    [Parameter(Mandatory=$true)][string]$Resources,
    [Parameter(Mandatory=$true)][string]$Cassettes,
    [Parameter(Mandatory=$true)][string]$Revision,
    [Parameter(Mandatory=$true)][string]$SshEvidence,
    [Parameter(Mandatory=$true)][string]$Destination
)
$ErrorActionPreference = 'Stop'
if ($Revision -cnotmatch '^[0-9a-f]{40}$') { throw 'invalid_revision' }
New-Item -ItemType Directory -Force $Destination | Out-Null
$Destination = (Resolve-Path -LiteralPath $Destination).Path
$bundle = Join-Path $Destination ('bundles\' + $Revision)
if (Test-Path -LiteralPath $bundle) { throw 'immutable_bundle_already_exists' }
$stage = Join-Path $Destination ('stage-' + [guid]::NewGuid().ToString('N').Substring(0,8))
New-Item -ItemType Directory -Force $stage | Out-Null
try {
    foreach ($pair in @(@($Agent,'butler-agent.exe'),@($Helper,'butler-sandbox.exe'),
        @($Test,'e2e.exe'),@($SshEvidence,'ssh-row16.json'))) {
        Copy-Item -LiteralPath $pair[0] -Destination (Join-Path $stage $pair[1])
    }
    Copy-Item -LiteralPath $Resources -Destination (Join-Path $stage 'resources') -Recurse
    New-Item -ItemType Directory -Force (Join-Path $stage 'cassettes') | Out-Null
    Copy-Item -LiteralPath (Join-Path $Cassettes 'TOOL-01') -Destination (Join-Path $stage 'cassettes\TOOL-01') -Recurse
    foreach ($name in @('windows-policy-probe.cs','windows-registry-snapshot.cs','windows-host-snapshot.ps1',
        'windows-sandbox-desktop.ps1','windows-sandbox-cases.ps1','bundle-common.ps1','bundle-self-check.ps1')) {
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination (Join-Path $stage $name)
    }
    $binaries = @(Get-ChildItem -LiteralPath $stage -File -Recurse -Force | ForEach-Object {
        @{name=$_.FullName.Substring($stage.Length + 1).Replace('\','/');
          sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}
    })
    $manifest = Join-Path $stage 'pins.json'
    @{revision=$Revision;binaries=$binaries} | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 $manifest
    $evidence = Join-Path $Destination ('checks\' + $Revision)
    & "$PSHOME\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $stage 'bundle-self-check.ps1') `
        -Manifest $manifest -Bundle $stage -Evidence $evidence
    if ($LASTEXITCODE -ne 0) { throw 'bundle_self_check_failed' }
    foreach ($dir in @('bundles','pins','requests')) { New-Item -ItemType Directory -Force (Join-Path $Destination $dir) | Out-Null }
    Move-Item -LiteralPath $stage -Destination $bundle
    # Publish the trusted manifest last; the queue cannot discover a partial build.
    Copy-Item -LiteralPath (Join-Path $bundle 'pins.json') -Destination (Join-Path $Destination ('pins\' + $Revision + '.json'))
    foreach ($name in @('desktop-runner.ps1','desktop-runner-job.cs','bundle-common.ps1','start-desktop-runner.cmd','README.md')) {
        $source = Join-Path $PSScriptRoot $name
        $target = Join-Path $Destination $name
        if ((Test-Path -LiteralPath $target -PathType Leaf) -and
            (Get-FileHash -LiteralPath $source).Hash -eq (Get-FileHash -LiteralPath $target).Hash) { continue }
        Copy-Item -LiteralPath $source -Destination $target -Force
    }
    Write-Host "$Revision bundle ready"
} finally {
    if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
}
