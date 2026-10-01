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

function Assert-InstalledBinding {
    param([string]$Root)
    $manifestPath = Join-Path $Root 'native-agent-manifest.json'
    $foreign = Get-Content $manifestPath -Raw | ConvertFrom-Json
    $foreign.platform = 'linux'
    $launcher = Join-Path $Root 'butler.cmd'
    foreach ($case in @(
        @{ Path = $launcher; Text = ([IO.File]::ReadAllText($launcher).Replace('butler-agent.exe','foreign-tool.exe')) },
        @{ Path = $manifestPath; Text = ($foreign | ConvertTo-Json -Depth 10) }
    )) {
        $original = [IO.File]::ReadAllBytes($case.Path)
        try {
            [IO.File]::WriteAllText($case.Path,$case.Text)
            & "$Root/butler-agent.exe" --installation-root $Root --resource-root "$Root/resources" doctor --check installation --json | Out-Null
            if ($LASTEXITCODE -eq 0) { throw 'Doctor accepted a tampered installation binding' }
        } finally { [IO.File]::WriteAllBytes($case.Path,$original) }
    }
}

function Assert-CommandBinding {
    param([string]$Command)
    & $Command doctor --check installation --json | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Native command lost its installation binding' }
    $marker = "$Command.target"
    $original = [IO.File]::ReadAllBytes($marker)
    $preference = $ErrorActionPreference
    try {
        [IO.File]::WriteAllText($marker,"$env:SystemRoot\System32\cmd.exe")
        $ErrorActionPreference = 'Continue'
        & $Command doctor --check installation --json 2>$null | Out-Null
        if ($LASTEXITCODE -eq 0) { throw 'Native command accepted a foreign binding' }
    } finally {
        $ErrorActionPreference = $preference
        [IO.File]::WriteAllBytes($marker,$original)
    }
}

# Public installer/CLI/browser smoke. Never emit connection codes or credentials.
$ErrorActionPreference = 'Stop'
# Keep the fixture within Windows PowerShell 5.1's normal path limit.
$root = Join-Path $env:RUNNER_TEMP ([guid]::NewGuid().ToString('N'))
$originalProfile = $env:USERPROFILE
$env:CARGO_HOME = "$originalProfile/.cargo"
$env:RUSTUP_HOME = "$originalProfile/.rustup"
$env:BUTLER_INSTALL_SKIP_USER_PATH = '1'
$env:HOME = "$root/home/미리 보기 %USERPROFILE% !"
$env:USERPROFILE = $env:HOME
$env:LOCALAPPDATA = "$root/local/미리 보기 %USERPROFILE% !"
$env:APPDATA = "$root/roaming"
$env:npm_config_cache = Join-Path $env:RUNNER_TEMP 'npm-cache'
$env:BUTLER_DATA = "$root/data/미리 보기 %USERPROFILE% !"
$env:BUTLER_APP_SERVER_HOST = '127.0.0.1'
$env:BUTLER_APP_SERVER_PORT = '0'
$env:BUTLER_SECRET_STORE = 'file'
$env:BUTLER_PROVIDER_QUOTA_POLLING = '0'
# Do not turn the service-manager capability off: the real Windows path must work.
New-Item -ItemType Directory -Force $env:HOME,$env:LOCALAPPDATA,$env:APPDATA,$env:BUTLER_DATA | Out-Null
"WINDOWS_PREVIEW_TEMP_ROOT=$root" >> $env:GITHUB_ENV
$env:WINDOWS_PREVIEW_TEMP_ROOT = $root
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0)
$listener.Start(); $port = $listener.LocalEndpoint.Port; $listener.Stop()
$files = Join-Path $root 'downloads'
New-Item -ItemType Directory $files | Out-Null
Copy-Item 'dist/release/agent/*' $files
Copy-Item "$PSScriptRoot/install.ps1" "$files/install.ps1"
$server = Start-Process python -ArgumentList @('-m','http.server',"$port",'--bind','127.0.0.1','--directory',"`"$files`"") -PassThru -WindowStyle Hidden
$launcher = "$env:LOCALAPPDATA/Butler/bin/butler.exe"
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
    $current = (Get-Content "$env:LOCALAPPDATA/Butler/agent/current" -Raw).Trim()
    Assert-InstalledBinding "$env:LOCALAPPDATA/Butler/agent/$current"
    Assert-CommandBinding $launcher
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
    & $launcher --version
    if ($LASTEXITCODE -ne 0) { throw '--version failed' }
    $status = (& $launcher status --json | ConvertFrom-Json)
    if (!$status.ok -or $status.data.services.summary.online -ne 1) { throw 'Status did not report one online service' }
    $record = Get-Content "$env:BUTLER_DATA/state/butler-agent-native-service.json" -Raw | ConvertFrom-Json
    $pidBefore = $record.pid
    & $launcher start --json | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Idempotent start failed' }
    $record = Get-Content "$env:BUTLER_DATA/state/butler-agent-native-service.json" -Raw | ConvertFrom-Json
    if ($record.pid -ne $pidBefore) { throw 'Start created a second instance' }
    $open = (& $launcher open --no-browser --json | ConvertFrom-Json)
    if (!$open.ok -or $open.data.browserOpened) { throw 'Open failed' }
    try { Invoke-WebRequest "$($record.app_endpoint)/sessions" -UseBasicParsing | Out-Null; throw 'Unauthenticated API allowed' }
    catch { if (!$_.Exception.Response -or [int]$_.Exception.Response.StatusCode -ne 401) { throw } }
    $navigation = @{ 'Sec-Fetch-Site' = 'none'; 'Sec-Fetch-Mode' = 'navigate'; Accept = 'text/html' }
    $page = @{ 'Sec-Fetch-Site' = 'same-origin'; Origin = $record.app_endpoint }
    $ui = Invoke-WebRequest $open.data.url -Headers $navigation -SessionVariable browser -UseBasicParsing
    if ($ui.StatusCode -ne 200 -or $ui.Content -notmatch '<div id="root">') { throw 'Renderer not served' }
    $sessions = Invoke-RestMethod "$($record.app_endpoint)/sessions" -Headers $page -WebSession $browser
    if ($sessions.protocol_version -ne 'butler.app.v1') { throw 'Browser authentication failed' }
    $assets = [regex]::Matches($ui.Content,'(?:src|href)="((?:\./|/)?assets/[^\"]+)"')
    if (!$assets.Count) { throw 'Renderer has no bundled asset references' }
    foreach ($match in $assets) {
        $uri = [Uri]::new([Uri]"$($record.app_endpoint)/", $match.Groups[1].Value)
        $asset = Invoke-WebRequest $uri -Headers $page -WebSession $browser -UseBasicParsing
        if ($asset.StatusCode -ne 200) { throw 'Renderer asset missing' }
    }
    Assert-PrivateAcl $env:BUTLER_DATA
    Assert-PrivateAcl "$env:BUTLER_DATA/app/runtime/auth/local-agent-auth.json"
    Assert-PrivateAcl "$env:BUTLER_DATA/app/runtime/auth/local-admin.json"
    Assert-PrivateAcl "$env:BUTLER_DATA/state/app-gateway/project-folder-token-secret"
    $startup = (& $launcher startup enable --json | ConvertFrom-Json)
    if ($startup.ok -or ($startup | ConvertTo-Json -Depth 10) -notmatch 'not supported on Windows yet') { throw 'Startup did not report the preview limitation' }
    & $launcher restart --json | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Restart failed' }
    $after = Get-Content "$env:BUTLER_DATA/state/butler-agent-native-service.json" -Raw | ConvertFrom-Json
    if ($after.pid -eq $pidBefore) { throw 'Restart did not replace instance' }
    & $launcher stop --json | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Stop failed' }
    $status = (& $launcher status --json | ConvertFrom-Json)
    if (!$status.ok -or $status.data.services.summary.online -ne 0) { throw 'Service remained online' }
    $current = (Get-Content "$env:LOCALAPPDATA/Butler/agent/current" -Raw).Trim()
    "BUTLER_E2E_INSTALLED_ROOT=$env:LOCALAPPDATA/Butler/agent/$current" >> $env:GITHUB_ENV
    'PASS installed ZIP: version, start, single instance, status, browser UI/assets, cookie auth, private DATA/tokens, restart, stop'
} finally {
    if (Test-Path $launcher) { & $launcher stop --json | Out-Null }
    Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
}
