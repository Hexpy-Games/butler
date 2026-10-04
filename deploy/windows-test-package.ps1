param([Parameter(Mandatory)][string]$Archive, [Parameter(Mandatory)][string]$Output,
    [Parameter(Mandatory)][string]$Commit, [string]$RepoRoot = (Split-Path $PSScriptRoot -Parent))
$ErrorActionPreference = 'Stop'
if (Test-Path $Output) { throw 'Test package destination already exists' }
New-Item -ItemType Directory -Force $Output | Out-Null
Expand-Archive -LiteralPath $Archive -DestinationPath $Output
$scripts = @{
    'windows-test-launcher.ps1'='launch.ps1'; 'windows-protocol-snapshot.ps1'='protocol-snapshot.ps1'
    'windows-test-diag.ps1'='diag.ps1'; 'windows-test-chat.ps1'='stub-chat.ps1'; 'windows-test-stub.py'='stub.py'
}
foreach ($source in $scripts.Keys) { Copy-Item "$RepoRoot/deploy/$source" (Join-Path $Output $scripts[$source]) }
$launcher = @'
@echo off
setlocal
set "BUTLER_TEST_PACKAGE=%~dp0"
powershell -NoProfile -Command "& ([scriptblock]::Create([IO.File]::ReadAllText($env:BUTLER_TEST_PACKAGE + 'launch.ps1'))) -PackageRoot $env:BUTLER_TEST_PACKAGE %*"
'@
[IO.File]::WriteAllText((Join-Path $Output 'launch.cmd'), ($launcher -replace "`r?`n","`r`n") + "`r`n")
$diag = @'
@echo off
setlocal
set "BUTLER_TEST_PACKAGE=%~dp0"
powershell -NoProfile -Command "& ([scriptblock]::Create([IO.File]::ReadAllText($env:BUTLER_TEST_PACKAGE + 'diag.ps1'))) -PackageRoot $env:BUTLER_TEST_PACKAGE %*"
'@
[IO.File]::WriteAllText((Join-Path $Output 'diag.cmd'), ($diag -replace "`r?`n","`r`n") + "`r`n")
$hash = (Get-FileHash "$Output/butler-agent.exe" -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllText((Join-Path $Output 'BUILD.txt'), "commit=$Commit`nbinarySha256=$hash`ntraceable=per-request prefix/cache diagnostics + diag.ps1`n")
Write-Output "Traceable test package: $Commit; binary SHA256: $hash"
