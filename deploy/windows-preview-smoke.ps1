function Assert-PrivateAcl {
    param([string]$Path)
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $acl = Get-Acl -LiteralPath $Path
    if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid) { throw 'Wrong private owner' }
    $rules = $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])
    if (!$rules.Count) { throw 'Empty private DACL' }
    foreach ($rule in $rules) {
        if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -ne $sid) { throw 'Non-user ACE on private data' }
    }
}

function Invoke-PreviewLauncher {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
    # Expand the path once; literal percent/exclamation characters in its value
    # must survive cmd's parsing. All arguments here are fixed smoke commands.
    $env:BUTLER_E2E_LAUNCHER = $launcher
    & $env:ComSpec /d /v:off /s /c ('""%BUTLER_E2E_LAUNCHER%" ' + ($Arguments -join ' ') + '"')
}

# Public installer/CLI/browser smoke. Never emit connection codes or credentials.
$ErrorActionPreference = 'Stop'
$root = Join-Path $env:RUNNER_TEMP ('installed-preview-' + [guid]::NewGuid())
$originalProfile = $env:USERPROFILE
$env:CARGO_HOME = "$originalProfile/.cargo"
$env:RUSTUP_HOME = "$originalProfile/.rustup"
$env:HOME = "$root/home/미리 보기 %USERPROFILE% !"
$env:USERPROFILE = $env:HOME
$env:LOCALAPPDATA = "$root/local/미리 보기 %USERPROFILE% !"
$env:APPDATA = "$root/roaming"
$env:BUTLER_INSTALL_MODIFY_PATH = '0'
$env:npm_config_cache = Join-Path $env:RUNNER_TEMP ('npm-preview-' + [guid]::NewGuid().ToString('N').Substring(0,8))
$env:BUTLER_DATA = "$root/data/미리 보기 %USERPROFILE% !"
$env:BUTLER_APP_SERVER_HOST = '127.0.0.1'
$env:BUTLER_APP_SERVER_PORT = '0'
$env:BUTLER_SECRET_STORE = 'file'
$env:BUTLER_PROVIDER_QUOTA_POLLING = '0'
# Do not turn the service-manager capability off: the real Windows path must work.
New-Item -ItemType Directory -Force $env:HOME,$env:LOCALAPPDATA,$env:APPDATA,$env:BUTLER_DATA | Out-Null
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0)
$listener.Start(); $port = $listener.LocalEndpoint.Port; $listener.Stop()
$files = Join-Path $root 'downloads'
New-Item -ItemType Directory $files | Out-Null
Copy-Item 'dist/release/agent/*' $files
Copy-Item "$PSScriptRoot/install.ps1" "$files/install.ps1"
$server = Start-Process python -ArgumentList @('-m','http.server',"$port",'--bind','127.0.0.1','--directory',"`"$files`"") -PassThru -WindowStyle Hidden
$launcher = "$env:LOCALAPPDATA/Butler/bin/butler.cmd"
try {
    $env:BUTLER_VERSION = (Get-Content "$files/agent-release-manifest.json" -Raw | ConvertFrom-Json).version
    $env:BUTLER_INSTALL_BASE_URL = "http://127.0.0.1:$port"
    $ready = $false
    for ($i=0; $i -lt 50; $i++) {
        try { Invoke-WebRequest $env:BUTLER_INSTALL_BASE_URL -UseBasicParsing | Out-Null; $ready=$true; break } catch { Start-Sleep -Milliseconds 100 }
    }
    if (!$ready) { throw 'Archive server did not start' }
    Invoke-RestMethod "$env:BUTLER_INSTALL_BASE_URL/install.ps1" | Invoke-Expression
    if ($LASTEXITCODE -ne 0) { throw 'Installer failed' }
    # Exercise the packed npm entry point as well as the PowerShell one-liner path.
    Push-Location packages/butler-npm
    try {
        npm pack --pack-destination $root | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'npm pack failed' }
    } finally { Pop-Location }
    $package = (Get-ChildItem "$root/hexpygames-butler-*.tgz").FullName
    tar -xzf $package -C $root
    if ($LASTEXITCODE -ne 0) { throw 'npm package extraction failed' }
    node "$root/package/bin/butler-install.js" install --no-start
    if ($LASTEXITCODE -ne 0) { throw 'npm Windows install failed' }
    node "$root/package/bin/butler-install.js" --version
    if ($LASTEXITCODE -ne 0) { throw 'npm installed-command forwarding failed' }
    Invoke-PreviewLauncher --version
    if ($LASTEXITCODE -ne 0) { throw '--version failed' }
    $status = (Invoke-PreviewLauncher status --json | ConvertFrom-Json)
    if (!$status.ok -or $status.data.services.summary.online -ne 1) { throw 'Status did not report one online service' }
    $record = Get-Content "$env:BUTLER_DATA/state/butler-agent-native-service.json" -Raw | ConvertFrom-Json
    $pidBefore = $record.pid
    Invoke-PreviewLauncher start --json | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Idempotent start failed' }
    $record = Get-Content "$env:BUTLER_DATA/state/butler-agent-native-service.json" -Raw | ConvertFrom-Json
    if ($record.pid -ne $pidBefore) { throw 'Start created a second instance' }
    $open = (Invoke-PreviewLauncher open --no-browser --json | ConvertFrom-Json)
    if (!$open.ok -or $open.data.browserOpened) { throw 'Open failed' }
    try { Invoke-WebRequest "$($record.app_endpoint)/sessions" -UseBasicParsing | Out-Null; throw 'Unauthenticated API allowed' }
    catch { if (!$_.Exception.Response -or [int]$_.Exception.Response.StatusCode -ne 401) { throw } }
    $ui = Invoke-WebRequest $open.data.url -Headers @{'Sec-Fetch-Site'='none'} -SessionVariable browser -UseBasicParsing
    if ($ui.StatusCode -ne 200 -or $ui.Content -notmatch '<div id="root">') { throw 'Renderer not served' }
    $pageHeaders = @{'Sec-Fetch-Site'='same-origin'}
    $sessions = Invoke-RestMethod "$($record.app_endpoint)/sessions" -Headers $pageHeaders -WebSession $browser
    if ($sessions.protocol_version -ne 'butler.app.v1') { throw 'Browser authentication failed' }
    try {
        Invoke-WebRequest "$($record.app_endpoint)/sessions" -Headers @{'Sec-Fetch-Site'='same-site'} -WebSession $browser -UseBasicParsing | Out-Null
        throw 'Foreign-site cookie access allowed'
    } catch { if (!$_.Exception.Response -or [int]$_.Exception.Response.StatusCode -ne 403) { throw } }
    $assets = [regex]::Matches($ui.Content,'(?:src|href)="((?:\./|/)?assets/[^\"]+)"')
    if (!$assets.Count) { throw 'Renderer has no bundled asset references' }
    foreach ($match in $assets) {
        $uri = [Uri]::new([Uri]"$($record.app_endpoint)/", $match.Groups[1].Value)
        $asset = Invoke-WebRequest $uri -Headers $pageHeaders -WebSession $browser -UseBasicParsing
        if ($asset.StatusCode -ne 200) { throw 'Renderer asset missing' }
    }
    Assert-PrivateAcl $env:BUTLER_DATA
    Assert-PrivateAcl "$env:BUTLER_DATA/app/runtime/auth/local-agent-auth.json"
    Assert-PrivateAcl "$env:BUTLER_DATA/app/runtime/auth/local-admin.json"
    Assert-PrivateAcl "$env:BUTLER_DATA/state/app-gateway/project-folder-token-secret"
    $startup = (Invoke-PreviewLauncher startup enable --json | ConvertFrom-Json)
    if ($startup.ok -or ($startup | ConvertTo-Json -Depth 10) -notmatch 'not supported on Windows yet') { throw 'Startup did not report the preview limitation' }
    Invoke-PreviewLauncher restart --json | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Restart failed' }
    $after = Get-Content "$env:BUTLER_DATA/state/butler-agent-native-service.json" -Raw | ConvertFrom-Json
    if ($after.pid -eq $pidBefore) { throw 'Restart did not replace instance' }
    Invoke-PreviewLauncher stop --json | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Stop failed' }
    $status = (Invoke-PreviewLauncher status --json | ConvertFrom-Json)
    if (!$status.ok -or $status.data.services.summary.online -ne 0) { throw 'Service remained online' }
    $current = (Get-Content "$env:LOCALAPPDATA/Butler/agent/current" -Raw).Trim()
    "BUTLER_E2E_INSTALLED_ROOT=$env:LOCALAPPDATA/Butler/agent/$current" >> $env:GITHUB_ENV
    'PASS installed ZIP: version, start, single instance, status, browser UI/assets, cookie auth, private DATA/tokens, restart, stop'
} finally {
    if (Test-Path $launcher) { Invoke-PreviewLauncher stop --json | Out-Null }
    Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
    if (Test-Path $env:npm_config_cache) { Remove-Item $env:npm_config_cache -Recurse -Force }
}
