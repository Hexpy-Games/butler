param([Parameter(Mandatory)][string]$ArchiveDirectory, [switch]$StartupContract)
if ($env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') {
    throw 'Task Scheduler contract requires disposable hosted Windows'
}
$ErrorActionPreference = 'Stop'
$root = Join-Path $env:RUNNER_TEMP ([guid]::NewGuid())
$env:HOME = "$root/home/미리 보기 %USERPROFILE% !"
$env:USERPROFILE = $env:HOME
$env:LOCALAPPDATA = "$root/local/미리 보기 %USERPROFILE% !"
$env:APPDATA = "$root/roaming"
$env:BUTLER_DATA = "$root/data"
$env:BUTLER_SECRET_STORE = 'file'
$env:BUTLER_PROVIDER_QUOTA_POLLING = '0'
$env:BUTLER_APP_SERVER_HOST = '127.0.0.1'
$env:BUTLER_APP_SERVER_PORT = '0'
$env:BUTLER_INSTALL_SKIP_USER_PATH = '1'
New-Item -ItemType Directory -Force $env:HOME,$env:LOCALAPPDATA,$env:APPDATA,$env:BUTLER_DATA | Out-Null
$before = (& reg query HKCU\Software\Classes\butler /s 2>$null) -join "`n"
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$name = "ButlerAgent-$sid"
$registered = $false
$server = $null
function Capture-NativeXml([string]$Name) {
    $info = [Diagnostics.ProcessStartInfo]::new('schtasks.exe', "/Query /TN $Name /XML")
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $process = [Diagnostics.Process]::Start($info)
    $buffer = [IO.MemoryStream]::new()
    try {
        $process.StandardOutput.BaseStream.CopyTo($buffer)
        $process.WaitForExit()
        if ($process.ExitCode) { throw 'Captured export failed' }
        $bytes = $buffer.ToArray()
        $encoding = if ($bytes[1] -eq 0 -or ($bytes[0] -eq 255 -and $bytes[1] -eq 254)) {
            [Text.Encoding]::Unicode
        } else { [Text.Encoding]::UTF8 }
        return $encoding.GetString($bytes).TrimStart([char]0xfeff)
    } finally { $buffer.Dispose(); $process.Dispose() }
}
try {
    $zip = @(Get-ChildItem "$ArchiveDirectory/butler-agent-*-windows-x64.zip")
    if ($zip.Count -ne 1) { throw 'Expected one Agent archive' }
    $expected = (Get-Content ($zip[0].FullName + '.sha256')).Split(' ')[0]
    if ((Get-FileHash $zip[0].FullName -Algorithm SHA256).Hash.ToLower() -ne $expected) { throw 'Archive checksum mismatch' }
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0)
    $listener.Start(); $port = $listener.LocalEndpoint.Port; $listener.Stop()
    $server = Start-Process python -ArgumentList @('-m','http.server',"$port",'--bind','127.0.0.1',
        '--directory',"`"$ArchiveDirectory`"") -PassThru -WindowStyle Hidden
    $env:BUTLER_VERSION = (Get-Content "$ArchiveDirectory/agent-release-manifest.json" -Raw | ConvertFrom-Json).version
    $env:BUTLER_INSTALL_BASE_URL = "http://127.0.0.1:$port"
    $ready = $false
    for ($i = 0; $i -lt 50; $i++) {
        try { Invoke-WebRequest $env:BUTLER_INSTALL_BASE_URL -UseBasicParsing | Out-Null; $ready = $true; break }
        catch { Start-Sleep -Milliseconds 100 }
    }
    if (!$ready) { throw 'Archive server did not start' }
    & "$PSScriptRoot/install.ps1" --no-start
    if ($LASTEXITCODE) { throw 'Isolated PowerShell installation failed' }
    $launcher = "$env:LOCALAPPDATA/Butler/bin/butler.exe"
    $active = (Get-Content "$env:LOCALAPPDATA/Butler/agent/current" -Raw).Trim()
    if ($active.Contains('..') -or $active -match '[\\/]') { throw 'Invalid installed projection' }
    $env:BUTLER_E2E_INSTALLED_ROOT = Join-Path "$env:LOCALAPPDATA/Butler/agent" $active
    if ($StartupContract) {
        & "$PSScriptRoot/windows-startup-smoke.ps1" -Launcher $launcher
        if ($LASTEXITCODE) { throw 'Installed Task Scheduler contract failed' }
        return
    }
    $state = & $launcher startup status --json | ConvertFrom-Json
    if (!$state.ok -or $state.data.state -ne 'disabled') { throw 'A preexisting task must not be touched' }
    $local = & $launcher startup enable --files-only --json | ConvertFrom-Json
    if ($LASTEXITCODE -or !$local.ok) { throw 'Task rendering failed' }
    & schtasks /Create /TN $name /XML $local.data.definition
    if ($LASTEXITCODE) { throw 'Task import failed' }
    $registered = $true
    $remote = (& schtasks /Query /TN $name /XML) -join "`n"
    if ($LASTEXITCODE) { throw 'Task export failed' }
    $scheduler = New-Object -ComObject Schedule.Service
    $scheduler.Connect()
    $unicode = $scheduler.GetFolder('\').GetTask($name).Xml
    $captured = Capture-NativeXml $name
    [ordered]@{ consoleExportMatchesUnicode = $remote.Trim() -eq $unicode.Trim();
        capturedExportMatchesUnicode = $captured.Trim() -eq $unicode.Trim();
        currentAccount = [Security.Principal.WindowsIdentity]::GetCurrent().Name } | ConvertTo-Json -Compress
    foreach ($item in @(
        @{ Kind = 'local'; Xml = [IO.File]::ReadAllText($local.data.definition) },
        @{ Kind = 'scheduler'; Xml = $remote },
        @{ Kind = 'unicode-api'; Xml = $unicode },
        @{ Kind = 'captured-native'; Xml = $captured }
    )) {
        [xml]$document = $item.Xml
        $fields = [ordered]@{ kind = $item.Kind; root = $document.DocumentElement.LocalName }
        foreach ($path in @('RegistrationInfo/Source','RegistrationInfo/Documentation',
            'Actions/Exec/Command','Actions/Exec/Arguments','Actions/Exec/WorkingDirectory',
            'Principals/Principal/UserId','Principals/Principal/LogonType','Principals/Principal/RunLevel',
            'Triggers/LogonTrigger/UserId','Triggers/LogonTrigger/Enabled','Settings/Enabled')) {
            $xpath = '/*' + (($path -split '/' | ForEach-Object { "/*[local-name()='$_']" }) -join '')
            $fields[$path] = $document.SelectSingleNode($xpath).InnerText
        }
        $fields | ConvertTo-Json -Compress
    }
    $state = & $launcher startup status --json | ConvertFrom-Json
    if (!$state.ok -or $state.data.state -ne 'enabled') { throw 'Imported task failed ownership validation' }
    'PASS imported Task Scheduler XML retains the exact execution identity'
    & schtasks /Run /TN $name | Out-Null
    if ($LASTEXITCODE) { throw 'Task run request failed' }
    Start-Sleep -Seconds 3
    $task = $scheduler.GetFolder('\').GetTask($name)
    [ordered]@{ phase = 'original-start'; result = $task.LastTaskResult; state = $task.State;
        dataRecord = Test-Path "$env:BUTLER_DATA/state/butler-agent-native-service.json" } | ConvertTo-Json -Compress
    # Same exact encoded action, with only the Scheduler's initial directory
    # moved out of a path containing a literal environment-variable spelling.
    [xml]$safeDirectory = $unicode
    $safeDirectory.Task.Actions.Exec.WorkingDirectory = $env:SystemRoot
    $scheduler.GetFolder('\').RegisterTask($name, $safeDirectory.OuterXml, 6, $sid, $null, 3, $null) | Out-Null
    & schtasks /Run /TN $name | Out-Null
    if ($LASTEXITCODE) { throw 'Task comparison run request failed' }
    Start-Sleep -Seconds 3
    $task = $scheduler.GetFolder('\').GetTask($name)
    [ordered]@{ phase = 'system-directory-start'; result = $task.LastTaskResult; state = $task.State;
        dataRecord = Test-Path "$env:BUTLER_DATA/state/butler-agent-native-service.json" } | ConvertTo-Json -Compress
    $scheduler.GetFolder('\').RegisterTask($name, $unicode, 6, $sid, $null, 3, $null) | Out-Null
} finally {
    if ($registered) {
        & schtasks /End /TN $name 2>$null | Out-Null
        if (Test-Path $launcher) { & $launcher stop --json | Out-Null }
        & schtasks /Delete /TN $name /F | Out-Null
    }
    if ($server -and !$server.HasExited) { Stop-Process -Id $server.Id -Force; $server.WaitForExit() }
    $after = (& reg query HKCU\Software\Classes\butler /s 2>$null) -join "`n"
    Remove-Item $root -Recurse -Force
    if ($before -cne $after) { throw 'Protocol registration changed' }
    $global:LASTEXITCODE = 0
}
$global:LASTEXITCODE = 0
