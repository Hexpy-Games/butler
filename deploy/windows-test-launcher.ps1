param([switch]$NoBrowser, [switch]$Smoke, [switch]$StubChat, [string]$PackageRoot = $PSScriptRoot)
$ErrorActionPreference = 'Stop'
$root = Join-Path $env:TEMP ('butler-win-protected-path-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $root | Out-Null
$keys = @('HOME','BUTLER_DATA','LOCALAPPDATA','APPDATA','TEMP','TMP','TMPDIR','CODEX_HOME',
    'BUTLER_SECRET_STORE','BUTLER_PLATFORM_SYSTEM_SECRETS','BUTLER_SERVICE_MANAGER',
    'BUTLER_APP_DISABLE_SHELL_REGISTRATION','BUTLER_APP_SERVER_HOST','BUTLER_APP_SERVER_PORT',
    'OPENAI_API_KEY','OPENAI_BASE_URL','BUTLER_E2E_TIER','BUTLER_PROVIDER_QUOTA_POLLING')
$saved = @{}
foreach ($key in $keys) { $saved[$key] = [Environment]::GetEnvironmentVariable($key) }
& ([scriptblock]::Create([IO.File]::ReadAllText("$PackageRoot/protocol-snapshot.ps1"))) -Output "$root/before.json"
$before = Get-Content "$root/before.json" -Raw
$agent = $null
$stub = $null
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
    if ($StubChat) {
        $stub = Start-Process python -ArgumentList @(('"' + $PackageRoot + '/stub.py"'), '--root', ('"' + $root + '"')) `
            -NoNewWindow -PassThru -RedirectStandardOutput "$root/stub.log" -RedirectStandardError "$root/stub-error.log"
        for ($attempt = 0; $attempt -lt 120 -and !(Test-Path "$root/stub-port.txt"); $attempt++) {
            $stub.Refresh(); if ($stub.HasExited) { throw 'Stub provider failed to start' }
            Start-Sleep -Milliseconds 100
        }
        $stubPort = [int](Get-Content "$root/stub-port.txt" -Raw)
        $env:OPENAI_BASE_URL = "http://127.0.0.1:$stubPort/v1"
        $env:OPENAI_API_KEY = 'e2e-not-real'; $env:BUTLER_E2E_TIER = 'stub'
        $env:BUTLER_PROVIDER_QUOTA_POLLING = '0'
    }
    $agent = Start-Process "$PackageRoot/butler-agent.exe" -ArgumentList @(
        '--installation-root', ('"' + $PackageRoot + '"'),
        '--resource-root', ('"' + $PackageRoot + '\resources"'), 'service','run',
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
    $raw = & "$PackageRoot/butler.cmd" open --data $env:BUTLER_DATA --no-browser --json
    $code = $LASTEXITCODE
    $link = $raw | ConvertFrom-Json
    if ($code -ne 0 -or !$link.ok) { throw "Test agent connection failed: $($link.error.code)" }
    $url = [uri]$link.data.url
    if (!$link.ok -or $url.Host -ne '127.0.0.1' -or $url.Port -ne $port -or $url.AbsolutePath -ne '/connect') {
        throw 'Connection link does not belong to the test agent'
    }
    if ($Smoke -or $StubChat) {
        $origin = $url.GetLeftPart([System.UriPartial]::Authority)
        $headers = @{ Origin=$origin; Referer="$origin/"; Accept='text/html' }
        $response = Invoke-WebRequest -Uri $url -Headers $headers -UseBasicParsing -SessionVariable browser
        if ($response.StatusCode -ne 200) { throw 'Browser connection failed' }
        $sessions = Invoke-WebRequest -Uri ("$origin/sessions") -Headers $headers -WebSession $browser -UseBasicParsing
        if ($sessions.StatusCode -ne 200) { throw 'Connected browser is not authenticated' }
        Write-Output "Launcher proof: correct port $port; browser cookie authenticated"
        if ($StubChat) { & ([scriptblock]::Create([IO.File]::ReadAllText("$PackageRoot/stub-chat.ps1"))) -Origin $origin -Browser $browser }
    } else {
        if (!$NoBrowser) { Start-Process $url.AbsoluteUri }
        Write-Host "Test agent PID: $($agent.Id). Port: $port"
        Read-Host 'Finish testing, then press Enter to stop and delete this test profile' | Out-Null
    }
} finally {
    if ($agent) {
        & "$PackageRoot/butler.cmd" stop --data "$root/data" --quiet | Out-Null
        $agent.Refresh()
        if (!$agent.HasExited -and !$agent.WaitForExit(10000)) { Stop-Process -Id $agent.Id -Force; $agent.WaitForExit() }
    }
    if ($stub) {
        $stub.Refresh()
        if (!$stub.HasExited) { Stop-Process -Id $stub.Id -Force; $stub.WaitForExit() }
    }
    & ([scriptblock]::Create([IO.File]::ReadAllText("$PackageRoot/protocol-snapshot.ps1"))) -Output "$root/after.json"
    $after = Get-Content "$root/after.json" -Raw
    $logs = Join-Path (Split-Path $PackageRoot -Parent) ('logs/' + (Get-Date -Format 'yyyyMMddTHHmmssfff'))
    New-Item -ItemType Directory -Force $logs | Out-Null
    Get-ChildItem -LiteralPath $root -File | Copy-Item -Destination $logs
    foreach ($path in @('data/metrics','data/logs','data/app/runtime/logs','data/agent-runtime/logs')) {
        $source = Join-Path $root $path
        if (Test-Path $source) { Copy-Item -LiteralPath $source -Destination (Join-Path $logs ($path -replace '/', '-')) -Recurse }
    }
    # Stop first, then preserve SQLite files and their WAL/SHM companions using
    # relative paths. Usage JSONL and diagnostics survive even without a DB.
    foreach ($database in Get-ChildItem "$root/data" -File -Recurse | Where-Object {
        $_.Name -match '\.(sqlite|sqlite3|db)(-wal|-shm)?$'
    }) {
        $relative = $database.FullName.Substring(("$root/data").Length).TrimStart('\','/')
        $destination = Join-Path "$logs/data" $relative
        New-Item -ItemType Directory -Force (Split-Path $destination -Parent) | Out-Null
        Copy-Item -LiteralPath $database.FullName -Destination $destination
    }
    Write-Output "Test logs saved: $logs"
    foreach ($key in $keys) { [Environment]::SetEnvironmentVariable($key,$saved[$key]) }
    python -c "import shutil,sys,os,stat;shutil.rmtree(chr(92)*2+'?'+chr(92)+sys.argv[1],onexc=lambda f,p,e:(os.chmod(p,stat.S_IWRITE),f(p)))" $root
    if ($LASTEXITCODE -ne 0) { throw 'Test profile cleanup failed' }
    if ($before -cne $after) { throw 'Owner protocol registration changed' }
    Write-Output 'Test agent stopped; isolated profile removed; protocol registration unchanged'
}
