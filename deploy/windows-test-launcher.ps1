param([switch]$NoBrowser, [switch]$Smoke)
$ErrorActionPreference = 'Stop'
$root = Join-Path $env:TEMP ('butler-win-protected-path-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $root | Out-Null
$keys = @('HOME','BUTLER_DATA','LOCALAPPDATA','APPDATA','TEMP','TMP','TMPDIR','CODEX_HOME',
    'BUTLER_SECRET_STORE','BUTLER_PLATFORM_SYSTEM_SECRETS','BUTLER_SERVICE_MANAGER',
    'BUTLER_APP_DISABLE_SHELL_REGISTRATION','BUTLER_APP_SERVER_HOST','BUTLER_APP_SERVER_PORT')
$saved = @{}
foreach ($key in $keys) { $saved[$key] = [Environment]::GetEnvironmentVariable($key) }
& "$PSScriptRoot/protocol-snapshot.ps1" -Output "$root/before.json"
$before = Get-Content "$root/before.json" -Raw
$agent = $null
try {
    foreach ($name in @('home','data','local','roaming','tmp','codex')) {
        New-Item -ItemType Directory -Force "$root/$name" | Out-Null
    }
    $env:HOME = "$root/home"; $env:BUTLER_DATA = "$root/data"
    $env:LOCALAPPDATA = "$root/local"; $env:APPDATA = "$root/roaming"
    $env:TEMP = "$root/tmp"; $env:TMP = $env:TEMP; $env:TMPDIR = $env:TEMP
    $env:CODEX_HOME = "$root/codex"
    $env:BUTLER_SECRET_STORE = 'file'; $env:BUTLER_PLATFORM_SYSTEM_SECRETS = '0'
    $env:BUTLER_SERVICE_MANAGER = 'off'; $env:BUTLER_APP_DISABLE_SHELL_REGISTRATION = '1'
    $env:BUTLER_APP_SERVER_HOST = '127.0.0.1'
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0)
    $listener.Start(); $port = $listener.LocalEndpoint.Port; $listener.Stop()
    $env:BUTLER_APP_SERVER_PORT = $port.ToString()
    $agent = Start-Process "$PSScriptRoot/butler-agent.exe" -ArgumentList @(
        '--installation-root', ('"' + $PSScriptRoot + '"'),
        '--resource-root', ('"' + $PSScriptRoot + '\resources"'), 'service','run',
        '--data', ('"' + $env:BUTLER_DATA + '"')) `
        -NoNewWindow -PassThru -RedirectStandardOutput "$root/agent.log" -RedirectStandardError "$root/agent-error.log"
    $ready = $false
    for ($attempt = 0; $attempt -lt 120 -and !$ready; $attempt++) {
        $agent.Refresh(); if ($agent.HasExited) { throw 'Test agent exited during startup' }
        try {
            $client = [Net.Sockets.TcpClient]::new()
            $client.Connect('127.0.0.1',$port); $ready = $true
        } catch {} finally { if ($client) { $client.Dispose() } }
        if (!$ready) { Start-Sleep -Milliseconds 500 }
    }
    if (!$ready) { throw 'Test agent did not start listening' }
    $ready = $false
    for ($attempt = 0; $attempt -lt 120 -and !$ready; $attempt++) {
        $agent.Refresh(); if ($agent.HasExited) { throw 'Test agent exited before publishing its instance' }
        $record = Join-Path $env:BUTLER_DATA 'state/butler-agent-native-service.json'
        if (Test-Path $record) {
            $instance = Get-Content $record -Raw | ConvertFrom-Json
            $ready = $instance.pid -eq $agent.Id -and $instance.state -eq 'ready'
        }
        if (!$ready) { Start-Sleep -Milliseconds 500 }
    }
    if (!$ready) { throw 'Test agent did not publish its ready instance' }
    $raw = & "$PSScriptRoot/butler.cmd" open --data $env:BUTLER_DATA --no-browser --json
    $code = $LASTEXITCODE
    $link = $raw | ConvertFrom-Json
    if ($code -ne 0 -or !$link.ok) { throw "Test agent connection failed: $($link.error.code)" }
    $url = [uri]$link.data.url
    if (!$link.ok -or $url.Host -ne '127.0.0.1' -or $url.Port -ne $port -or $url.AbsolutePath -ne '/connect') {
        throw 'Connection link does not belong to the test agent'
    }
    if ($Smoke) {
        $origin = $url.GetLeftPart([System.UriPartial]::Authority)
        $headers = @{ Origin=$origin; Referer="$origin/"; Accept='text/html' }
        $response = Invoke-WebRequest -Uri $url -Headers $headers -UseBasicParsing -SessionVariable browser
        if ($response.StatusCode -ne 200) { throw 'Browser connection failed' }
        $sessions = Invoke-WebRequest -Uri ("$origin/sessions") -Headers $headers -WebSession $browser -UseBasicParsing
        if ($sessions.StatusCode -ne 200) { throw 'Connected browser is not authenticated' }
        Write-Output "Launcher proof: correct port $port; browser cookie authenticated"
    } else {
        if (!$NoBrowser) { Start-Process $url.AbsoluteUri }
        Write-Host "Test agent PID: $($agent.Id). Port: $port"
        Read-Host 'Finish testing, then press Enter to stop and delete this test profile' | Out-Null
    }
} finally {
    if ($agent) {
        & "$PSScriptRoot/butler.cmd" stop --data "$root/data" --quiet | Out-Null
        $agent.Refresh()
        if (!$agent.HasExited -and !$agent.WaitForExit(10000)) { Stop-Process -Id $agent.Id -Force; $agent.WaitForExit() }
    }
    & "$PSScriptRoot/protocol-snapshot.ps1" -Output "$root/after.json"
    $after = Get-Content "$root/after.json" -Raw
    foreach ($key in $keys) { [Environment]::SetEnvironmentVariable($key,$saved[$key]) }
    python -c "import shutil,sys,os,stat;shutil.rmtree(chr(92)*2+'?'+chr(92)+sys.argv[1],onexc=lambda f,p,e:(os.chmod(p,stat.S_IWRITE),f(p)))" $root
    if ($LASTEXITCODE -ne 0) { throw 'Test profile cleanup failed' }
    if ($before -cne $after) { throw 'Owner protocol registration changed' }
    Write-Output 'Test agent stopped; isolated profile removed; protocol registration unchanged'
}
