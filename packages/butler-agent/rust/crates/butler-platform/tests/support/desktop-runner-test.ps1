# Driven by the stub E2E; all payloads and results stay inside its fixture.
param([Parameter(Mandatory=$true)][string]$Root)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'bundle-common.ps1')
$revision = 'a' * 40
$bundle = Join-Path $Root ('bundles\' + $revision)
New-Item -ItemType Directory -Force $bundle,(Join-Path $Root 'pins'),(Join-Path $Root 'requests') | Out-Null
foreach ($name in @('butler-agent.exe','butler-sandbox.exe','e2e.exe','windows-policy-probe.cs',
    'windows-registry-snapshot.cs','windows-host-snapshot.ps1','ssh-row16.json',
    'resources/eol.md','cassettes/TOOL-01/meta.json','bundle-common.ps1','windows-sandbox-cases.ps1')) {
    $path = Join-Path $bundle $name
    New-Item -ItemType Directory -Force (Split-Path $path -Parent) | Out-Null
    [IO.File]::WriteAllText($path, 'fixture')
}
$payload = @'
param([string]$Manifest,[string]$Bundle)
$pins = Get-Content -Raw $Manifest | ConvertFrom-Json
$root = Join-Path $env:LOCALAPPDATA 'Butler\e2e-results'
New-Item -ItemType Directory -Force $root | Out-Null
@{revision=$pins.revision;status='PASS';startedUtc=[DateTime]::UtcNow.ToString('o')} |
    ConvertTo-Json | Set-Content (Join-Path $root ($pins.revision + '.json'))
Add-Content (Join-Path $env:HOME 'dispatch-count') 'dispatched'
'@
$script = Join-Path $bundle 'windows-sandbox-desktop.ps1'
$payload | Set-Content $script
function Write-Pins {
    $files = @(Get-ChildItem -LiteralPath $bundle -File -Recurse | ForEach-Object {
        @{name=$_.FullName.Substring($bundle.Length + 1).Replace('\','/');sha256=(Get-FileHash $_.FullName).Hash.ToLowerInvariant()}
    })
    @{revision=$revision;binaries=$files} | ConvertTo-Json -Depth 5 |
        Set-Content (Join-Path $Root ('pins\' + $revision + '.json'))
}
Write-Pins
$req = Join-Path $Root ('requests\' + $revision + '.req')
[IO.File]::WriteAllText($req, 'throw "request contents must never execute"')
[IO.File]::WriteAllText((Join-Path $Root 'requests\not-a-revision.req'), 'ignored')
$runner = Join-Path $PSScriptRoot 'desktop-runner.ps1'
function Poll {
    & "$PSHOME\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File $runner -Root $Root -Once
    if ($LASTEXITCODE) { throw 'poll_failed' }
}
# Alter a pinned script: the consumer must not dispatch or acknowledge it.
Add-Content $script '# tampered'
Poll
if (!(Test-Path $req) -or (Test-Path (Join-Path $env:HOME 'dispatch-count'))) { throw 'tamper_was_executed' }
$payload | Set-Content $script
Poll
if (Test-Path $req) { throw 'request_not_acknowledged' }
if (!(Test-Path (Join-Path $Root ('requests\done\' + $revision + '.req')))) { throw 'done_missing' }
Poll
if (@(Get-Content (Join-Path $env:HOME 'dispatch-count')).Count -ne 1) { throw 'duplicate_dispatch' }
if (!(Test-Path (Join-Path $Root 'requests\not-a-revision.req'))) { throw 'invalid_request_consumed' }
# A second console cannot acquire the file lock.
$lock = [IO.File]::Open((Join-Path $Root 'desktop-runner.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
try {
    $child = Start-Process -FilePath "$PSHOME\powershell.exe" -NoNewWindow -PassThru `
        -ArgumentList @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',
            ('"' + $runner + '"'),'-Root',('"' + $Root + '"'),'-Once') `
        -RedirectStandardOutput (Join-Path $Root 'lock.stdout') -RedirectStandardError (Join-Path $Root 'lock.stderr')
    try {
        $null = $child.Handle
        $child.WaitForExit()
        if ($child.ExitCode -eq 0) { throw 'duplicate_runner_accepted' }
    } finally { $child.Dispose() }
} finally { $lock.Dispose() }
function Check-ExitCleanup {
    $childPidFile = Join-Path $env:HOME 'child.pid'
    @'
param([string]$Manifest,[string]$Bundle)
$child = Start-Process "$PSHOME\powershell.exe" -NoNewWindow -PassThru -ArgumentList @('-NoProfile','-Command','Start-Sleep -Seconds 60')
$child.Id | Set-Content (Join-Path $env:HOME 'child.pid')
Start-Sleep -Seconds 60
'@ | Set-Content $script
    Write-Pins
    [IO.File]::WriteAllText($req, '')
    $parent = Start-Process "$PSHOME\powershell.exe" -NoNewWindow -PassThru `
        -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"'+$runner+'"'),'-Root',('"'+$Root+'"'),'-Once') `
        -RedirectStandardOutput (Join-Path $Root 'exit.stdout') -RedirectStandardError (Join-Path $Root 'exit.stderr')
    try {
        $deadline = [DateTime]::UtcNow.AddSeconds(20)
        while (!(Test-Path $childPidFile) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 100 }
        if (!(Test-Path $childPidFile)) { throw 'cleanup_child_not_started' }
        $descendantId = [int](Get-Content $childPidFile)
        Stop-Process -Id $parent.Id -Force
        $parent.WaitForExit()
        $descendant = Get-Process -Id $descendantId -ErrorAction SilentlyContinue
        if ($descendant -and !$descendant.WaitForExit(5000)) {
            Stop-Process -Id $descendantId -Force
            throw 'descendant_outlived_runner'
        }
    } finally {
        if (!$parent.HasExited) { Stop-Process -Id $parent.Id -Force }
        $parent.Dispose()
    }
}
Check-ExitCleanup
Write-Output 'DESKTOP_RUNNER_PROTOCOL=PASS tamper,contents,ack,once,invalid,lock,exit-cleanup'
