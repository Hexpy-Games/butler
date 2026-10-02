param([Parameter(Mandatory=$true)][string]$Launcher)
# E2E: uses the installed artifact; never builds Rust or runs on the owner PC.
if ($env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') {
    throw 'Task Scheduler smoke requires a disposable GitHub Windows runner'
}
$ErrorActionPreference = 'Stop'
$protocolBefore = (& reg query HKCU\Software\Classes\butler /s 2>$null) -join "`n"
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$name = "ButlerAgent-$sid"
function Invoke-Startup([string]$Action) {
    $result = & $Launcher startup $Action --json | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or !$result.ok) { throw "startup $Action failed" }
    return $result.data
}
try {
    if ((Invoke-Startup status).state -ne 'disabled') { throw 'Initial startup state' }
    Invoke-Startup enable | Out-Null
    if ((Invoke-Startup status).state -ne 'enabled') { throw 'Startup not enabled' }
    [xml]$xml = (& schtasks /Query /TN $name /XML) -join "`n"
    if ($LASTEXITCODE -ne 0) { throw 'Task XML query failed' }
    if ($xml.Task.Principals.Principal.RunLevel -ne 'LeastPrivilege' -or
        $xml.Task.Triggers.LogonTrigger.UserId -ne $sid -or
        $xml.Task.Settings.Hidden -ne 'true' -or
        !$xml.Task.Settings.RestartOnFailure -or
        [IO.Path]::GetFullPath($xml.Task.Actions.Exec.WorkingDirectory) -ne [IO.Path]::GetFullPath($env:BUTLER_E2E_INSTALLED_ROOT)) {
        throw 'Task definition contract failed'
    }
    # enable runs the job immediately; verify the real service, not just task existence.
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
        $status = & $Launcher status --json | ConvertFrom-Json
        if ($status.data.services.summary.online -eq 1) { break }
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $deadline)
    if ($status.data.services.summary.online -ne 1) { throw 'Scheduled service did not start' }
    Invoke-Startup disable | Out-Null
    if ((Invoke-Startup status).state -ne 'disabled') { throw 'Task not deleted' }
    & $Launcher stop --json | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Scheduled service did not stop' }
    # A same-name foreign task must survive enable and disable.
    $xml.Task.Actions.Exec.Command = "$env:SystemRoot\System32\cmd.exe"
    $foreign = Join-Path $env:HOME 'foreign-task.xml'
    $xml.Save($foreign)
    & schtasks /Create /TN $name /XML $foreign | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Foreign fixture creation failed' }
    $before = (& schtasks /Query /TN $name /XML) -join "`n"
    if ((Invoke-Startup status).state -ne 'foreign') { throw 'Foreign not reported' }
    foreach ($action in @('enable','disable')) {
        & $Launcher startup $action --json | Out-Null
        if ($LASTEXITCODE -eq 0) { throw "Foreign task accepted by $action" }
    }
    $after = (& schtasks /Query /TN $name /XML) -join "`n"
    if ($before -cne $after) { throw 'Foreign task changed' }
    & schtasks /Delete /TN $name /F | Out-Null
    Invoke-Startup enable | Out-Null
    & $Launcher uninstall --keep-data --yes --json | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Uninstall failed' }
    & schtasks /Query /TN $name /XML 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { throw 'Uninstall retained task' }
    'PASS Task Scheduler: XML, enable/run, disable/delete, foreign preservation, uninstall'
} finally {
    & schtasks /End /TN $name 2>$null | Out-Null
    & schtasks /Delete /TN $name /F 2>$null | Out-Null
    if (Test-Path $Launcher) { & $Launcher stop --json | Out-Null }
    $protocolAfter = (& reg query HKCU\Software\Classes\butler /s 2>$null) -join "`n"
    if ($protocolBefore -cne $protocolAfter) { throw 'Protocol registry changed' }
}
$global:LASTEXITCODE = 0
