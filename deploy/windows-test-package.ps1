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
Copy-Item "$Output/launch.ps1" "$Output/try.ps1"
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
$info = @{ commit=$Commit; binarySha256=$hash; builtAt=[DateTime]::UtcNow.ToString('o'); diagnostics='request-prefix-diagnostics.jsonl' } | ConvertTo-Json
[IO.File]::WriteAllText((Join-Path $Output 'build-info.json'), $info + "`n")
$readme = @'
Start testing: launch.cmd (auto-connects a browser to an isolated test Agent).
Press Enter in the launcher after testing to stop and remove the profile.
The familiar try.ps1 launcher is also included.
After testing: diag.cmd prints request/session tables and writes diag.csv and diag-sessions.csv.
For an active profile or saved run: diag.ps1 -Path <test-data-or-logs-folder>.
Logs and SQLite databases are saved under the parent logs folder before cleanup.
LCP compares o200k tokenized serialized components; missing values remain blank.
'@
[IO.File]::WriteAllText((Join-Path $Output 'README.txt'), $readme + "`n")
Write-Output "Traceable test package: $Commit; binary SHA256: $hash"
