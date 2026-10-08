param([Parameter(Mandatory=$true)][string]$Launcher)
# E2E: uses the installed artifact; never builds Rust or runs on the owner PC.
if ($env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') {
    throw 'Task Scheduler smoke requires a disposable GitHub Windows runner'
}
$ErrorActionPreference = 'Stop'
& "$PSScriptRoot/windows-protocol-snapshot.ps1" -Output "$env:HOME/protocol-before.json"
$protocolBefore = Get-Content "$env:HOME/protocol-before.json" -Raw
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$name = "ButlerAgent-$sid"
$testOwnsName = $false
function Invoke-Startup([string]$Action) {
    $ErrorActionPreference = 'Continue'
    $result = & $Launcher startup $Action --json
    $ErrorActionPreference = 'Stop'
    if ($LASTEXITCODE -ne 0) { throw "startup $Action failed" }
    $result = $result | ConvertFrom-Json
    if (!$result.ok) { throw "startup $Action failed" }
    return $result.data
}
try {
    if ((Invoke-Startup status).state -ne 'disabled') { throw 'Initial startup state' }
    $testOwnsName = $true
    $enabled = Invoke-Startup enable
    $bytes = [IO.File]::ReadAllBytes($enabled.definition)
    if ($bytes.Length -lt 6 -or $bytes[0] -ne 255 -or $bytes[1] -ne 254 -or
        ![Text.Encoding]::Unicode.GetString($bytes, 2, $bytes.Length - 2).StartsWith('<?xml version="1.0" encoding="UTF-16"?>')) {
        throw 'Task XML must use UTF-16LE with a matching declaration and BOM'
    }
    if ((Invoke-Startup status).state -ne 'enabled') { throw 'Startup not enabled' }
    $ErrorActionPreference = 'Continue'
    $taskXml = (& schtasks /Query /TN $name /XML) -join "`n"
    $ErrorActionPreference = 'Stop'
    if ($LASTEXITCODE -ne 0) { throw 'Task XML query failed' }
    [xml]$xml = $taskXml
    $scheduler = New-Object -ComObject Schedule.Service
    $scheduler.Connect()
    $definition = $scheduler.GetFolder('\').GetTask($name).Definition
    $triggerUser = $definition.Triggers.Item(1).UserId
    if (!$triggerUser.StartsWith('S-1-')) {
        $triggerUser = ([Security.Principal.NTAccount]$triggerUser).Translate([Security.Principal.SecurityIdentifier]).Value
    }
    if ($definition.Principal.RunLevel -ne 0 -or $triggerUser -ne $sid -or
        !$definition.Settings.Hidden -or !$definition.Settings.Enabled -or
        $definition.Settings.RestartInterval -ne 'PT1M' -or $definition.Settings.RestartCount -ne 3 -or
        [IO.Path]::GetFullPath($xml.Task.Actions.Exec.WorkingDirectory) -ne (Split-Path $xml.Task.Actions.Exec.Command)) {
        throw 'Task definition contract failed'
    }
    $encoded = ($xml.Task.Actions.Exec.Arguments -split '-EncodedCommand ')[1]
    $script = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($encoded))
    $tokens = $null; $parseErrors = $null
    $tree = [Management.Automation.Language.Parser]::ParseInput($script, [ref]$tokens, [ref]$parseErrors)
    $locations = @($tree.FindAll({ param($node)
        $node -is [Management.Automation.Language.CommandAst] -and $node.GetCommandName() -eq 'Set-Location'
    }, $true))
    if ($parseErrors.Count -or $locations.Count -ne 1 -or $locations[0].CommandElements.Count -ne 3 -or
        $locations[0].CommandElements[1].ParameterName -ne 'LiteralPath' -or
        $locations[0].CommandElements[2] -isnot [Management.Automation.Language.StringConstantExpressionAst]) {
        throw 'Task must set exactly one literal Agent directory'
    }
    $observedRoot = $locations[0].CommandElements[2].Value
    $literalRoot = [IO.Path]::GetFullPath($env:BUTLER_E2E_INSTALLED_ROOT)
    [ordered]@{ literalAgentDirectory = $observedRoot; installedDirectory = $literalRoot } | ConvertTo-Json -Compress
    if ([IO.Path]::GetFullPath($observedRoot) -ne $literalRoot) { throw 'Task lost its literal Agent directory' }
    foreach ($key in @('HOME','LOCALAPPDATA','APPDATA','BUTLER_AGENT_HOME')) {
        if (!$script.Contains("SetEnvironmentVariable('$key',")) { throw "Missing task profile binding: $key" }
    }
    # enable runs the job immediately; verify the real service, not just task existence.
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
        $ErrorActionPreference = 'Continue'
        $status = & $Launcher status --json
        $ErrorActionPreference = 'Stop'
        if ($LASTEXITCODE -ne 0) { throw 'Native command failed' }
        $status = $status | ConvertFrom-Json
        if ($status.data.services.summary.online -eq 1) { break }
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $deadline)
    if ($status.data.services.summary.online -ne 1) { throw 'Scheduled service did not start' }
    Invoke-Startup disable | Out-Null
    if ((Invoke-Startup status).state -ne 'disabled') { throw 'Task not deleted' }
    $ErrorActionPreference = 'Continue'
    & $Launcher stop --json | Out-Null
    $ErrorActionPreference = 'Stop'
    if ($LASTEXITCODE -ne 0) { throw 'Scheduled service did not stop' }
    # A same-name foreign task must survive enable and disable.
    $xml.Task.Actions.Exec.Command = "$env:SystemRoot\System32\cmd.exe"
    $foreign = Join-Path $env:HOME 'foreign-task.xml'
    $xml.Save($foreign)
    $ErrorActionPreference = 'Continue'
    & schtasks /Create /TN $name /XML $foreign | Out-Null
    $ErrorActionPreference = 'Stop'
    if ($LASTEXITCODE -ne 0) { throw 'Foreign fixture creation failed' }
    $ErrorActionPreference = 'Continue'
    $before = (& schtasks /Query /TN $name /XML) -join "`n"
    $ErrorActionPreference = 'Stop'
    if ($LASTEXITCODE -ne 0) { throw 'Foreign task query failed' }
    if ((Invoke-Startup status).state -ne 'foreign') { throw 'Foreign not reported' }
    foreach ($action in @('enable','disable')) {
        $ErrorActionPreference = 'Continue'
        & $Launcher startup $action --json | Out-Null
        $ErrorActionPreference = 'Stop'
        if ($LASTEXITCODE -eq 0) { throw "Foreign task accepted by $action" }
    }
    $ErrorActionPreference = 'Continue'
    $after = (& schtasks /Query /TN $name /XML) -join "`n"
    $ErrorActionPreference = 'Stop'
    if ($LASTEXITCODE -ne 0) { throw 'Foreign task query failed' }
    if ($before -cne $after) { throw 'Foreign task changed' }
    $ErrorActionPreference = 'Continue'
    & schtasks /Delete /TN $name /F | Out-Null
    $ErrorActionPreference = 'Stop'
    if ($LASTEXITCODE -ne 0) { throw 'Native command failed' }
    Invoke-Startup enable | Out-Null
    $ErrorActionPreference = 'Continue'
    & $Launcher uninstall --keep-data --yes --json | Out-Null
    $ErrorActionPreference = 'Stop'
    if ($LASTEXITCODE -ne 0) { throw 'Uninstall failed' }
    $ErrorActionPreference = 'Continue'
    & schtasks /Query /TN $name /XML 2>$null | Out-Null
    $ErrorActionPreference = 'Stop'
    if ($LASTEXITCODE -eq 0) { throw 'Uninstall retained task' }
    'PASS Task Scheduler: XML, enable/run, disable/delete, foreign preservation, uninstall'
} finally {
    # An assertion can fail while the just-started task is still publishing
    # its service receipt. Own only PIDs of this test's unique Agent binary.
    $expectedExecutable = [IO.Path]::GetFullPath((Join-Path $env:BUTLER_E2E_INSTALLED_ROOT 'butler-agent.exe'))
    $owned = @(Get-CimInstance Win32_Process | Where-Object {
        $_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath) -eq $expectedExecutable
    } | ForEach-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue })
    $cleanupCodes = @()
    if (Test-Path $Launcher) {
        $ErrorActionPreference = 'Continue'
        & $Launcher stop --json | Out-Null
        $ErrorActionPreference = 'Stop'
        $cleanupCodes += $LASTEXITCODE
    }
    if ($testOwnsName) {
        $ErrorActionPreference = 'Continue'
        & schtasks /End /TN $name 2>$null | Out-Null
        $ErrorActionPreference = 'Stop'
        $cleanupCodes += $(if ($LASTEXITCODE -in @(0,1)) { 0 } else { $LASTEXITCODE })
        $ErrorActionPreference = 'Continue'
        & schtasks /Delete /TN $name /F 2>$null | Out-Null
        $ErrorActionPreference = 'Stop'
        $cleanupCodes += $(if ($LASTEXITCODE -in @(0,1)) { 0 } else { $LASTEXITCODE })
    }
    foreach ($process in $owned) {
        if (!$process.HasExited) { $process.Kill() }
        $process.WaitForExit()
    }
    & "$PSScriptRoot/windows-protocol-snapshot.ps1" -Output "$env:HOME/protocol-after.json"
    $protocolAfter = Get-Content "$env:HOME/protocol-after.json" -Raw
    if ($protocolBefore -cne $protocolAfter) { throw 'Protocol registry changed' }
    if (@($cleanupCodes | Where-Object { $_ -ne 0 }).Count) { throw 'Task cleanup failed' }
}
$global:LASTEXITCODE = 0
