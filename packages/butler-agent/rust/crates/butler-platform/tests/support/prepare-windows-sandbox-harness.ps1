# Copy only supplied, already-built dev binaries; pin all of them and the runner.
param(
    [Parameter(Mandatory=$true)][string]$Agent,
    [Parameter(Mandatory=$true)][string]$Helper,
    [Parameter(Mandatory=$true)][string]$Test,
    [Parameter(Mandatory=$true)][string]$Revision,
    [Parameter(Mandatory=$true)][string]$SshEvidence,
    [Parameter(Mandatory=$true)][string]$Destination
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force $Destination | Out-Null
$binaries = @()
foreach ($pair in @(@($Agent,'butler-agent.exe'),@($Helper,'butler-sandbox.exe'),@($Test,'e2e.exe'))) {
    $target = Join-Path $Destination $pair[1]
    Copy-Item -LiteralPath $pair[0] -Destination $target
    $binaries += @{name=$pair[1];sha256=(Get-FileHash -Algorithm SHA256 $target).Hash.ToLowerInvariant()}
}
$evidence = Join-Path $Destination 'ssh-row16.json'
Copy-Item -LiteralPath $SshEvidence -Destination $evidence
$binaries += @{name='ssh-row16.json';sha256=(Get-FileHash -Algorithm SHA256 $evidence).Hash.ToLowerInvariant()}
$policySource = Join-Path $Destination 'windows-policy-probe.cs'
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'windows-policy-probe.cs') -Destination $policySource
$binaries += @{name='windows-policy-probe.cs';sha256=(Get-FileHash -Algorithm SHA256 $policySource).Hash.ToLowerInvariant()}
$manifest = @{revision=$Revision;binaries=$binaries}
$manifest | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 (Join-Path $Destination 'pins.json')
$runner = Join-Path $Destination 'windows-sandbox-desktop.ps1'
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'windows-sandbox-desktop.ps1') -Destination $runner
$hash = (Get-FileHash -Algorithm SHA256 $runner).Hash.ToLowerInvariant()
$cmd = @"
@echo off
cd /d "%~dp0"
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "if ((Get-FileHash -Algorithm SHA256 '.\windows-sandbox-desktop.ps1').Hash.ToLowerInvariant() -ne '$hash') { exit 125 }; & '.\windows-sandbox-desktop.ps1' -Manifest '.\pins.json'"
pause
"@
$cmd | Set-Content -Encoding ASCII (Join-Path $Destination 'run-windows-sandbox-e2e.cmd')
Write-Output (Join-Path $Destination 'run-windows-sandbox-e2e.cmd')
