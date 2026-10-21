param([Parameter(Mandatory=$true)][string[]]$Tests)
# Prove the installed agent-windows-x64 payload; hosted/basics uses debug.
$ErrorActionPreference = 'Stop'
$env:BUTLER_E2E_BIN = Join-Path $env:BUTLER_E2E_INSTALLED_ROOT 'butler-agent.exe'
& "$PSScriptRoot/windows-e2e-artifacts.ps1" -Mode Run -Tests $Tests -WithoutE2eFixtures
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
