# Unsigned, per-user Windows x64 Agent preview. No elevation or startup task.
# $env:BUTLER_VERSION='0.1.0-preview.N'; irm https://github.com/Hexpy-Games/butler/releases/download/v0.1.0-preview.N/install.ps1 | iex
# All work starts at the final call, so a truncated download does nothing.
function Install-Butler {
    param([string[]]$Options)
    $ErrorActionPreference = 'Stop'
    $version = $env:BUTLER_VERSION -replace '^v', ''
    $start = $true
    for ($i = 0; $i -lt $Options.Count; $i++) {
        switch -Regex ($Options[$i]) {
            '^--version$' { if (++$i -ge $Options.Count) { throw '--version needs a value' }; $version = $Options[$i] -replace '^v', '' }
            '^--version=(.+)$' { $version = $Matches[1] -replace '^v', '' }
            '^--no-start$' { $start = $false }
            '^--modify-path$' { } # PATH is always added on Windows.
            '^(-h|--help)$' { Write-Host 'install.ps1 [--version X] [--no-start]'; return }
            default { throw "Unknown option: $($Options[$i])" }
        }
    }
    if (![Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { throw 'Windows x64 is required' }
    if (!$version) {
        if ($env:BUTLER_INSTALL_BASE_URL) { throw 'Set BUTLER_VERSION with BUTLER_INSTALL_BASE_URL' }
        $release = Invoke-RestMethod 'https://api.github.com/repos/Hexpy-Games/butler/releases/latest'
        $version = $release.tag_name -replace '^v', ''
    }
    if ($version -notmatch '^[A-Za-z0-9][A-Za-z0-9._+\-]{0,63}$' -or $version.Contains('..')) { throw 'Invalid version' }
    $baseVersion = $version.Split('-')[0]
    $base = if ($env:BUTLER_INSTALL_BASE_URL) { $env:BUTLER_INSTALL_BASE_URL.TrimEnd('/') } else { "https://github.com/Hexpy-Games/butler/releases/download/v$version" }
    $agentHome = if ($env:BUTLER_AGENT_HOME) { $env:BUTLER_AGENT_HOME } else { Join-Path $env:LOCALAPPDATA 'Butler/agent' }
    $bin = if ($env:BUTLER_BIN_DIR) { $env:BUTLER_BIN_DIR } else { Join-Path $env:LOCALAPPDATA 'Butler/bin' }
    $data = if ($env:BUTLER_DATA) { $env:BUTLER_DATA } else { Join-Path $env:USERPROFILE '.butler' }
    foreach ($path in @($agentHome,$bin,$data)) {
        if (![IO.Path]::IsPathRooted($path) -or $path -match '[%"\r\n]') { throw 'Invalid installation path' }
    }
    $agentHome = [IO.Path]::GetFullPath($agentHome).TrimEnd('\')
    $data = [IO.Path]::GetFullPath($data).TrimEnd('\')
    if ($agentHome.StartsWith("$data\",[StringComparison]::OrdinalIgnoreCase) -or
        $data.StartsWith("$agentHome\",[StringComparison]::OrdinalIgnoreCase) -or $data -eq $agentHome) { throw 'Installation and DATA must be separate' }
    $launcher = Join-Path $bin 'butler.cmd'
    $marker = 'REM butler-native-launcher v1'
    if ((Test-Path $launcher) -and !(Get-Content $launcher -Raw).Contains($marker)) { throw 'Refusing to replace an unmanaged butler.cmd' }
    $temp = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid())
    New-Item -ItemType Directory $temp | Out-Null
    $stage = $null
    try {
        $archive = "butler-agent-$baseVersion-windows-x64.zip"
        $sums = (Invoke-WebRequest "$base/butler-$version-SHA256SUMS" -UseBasicParsing).Content
        if ($sums -is [byte[]]) { $sums = [Text.Encoding]::UTF8.GetString($sums) }
        $matching = @($sums -split '\r?\n' | Where-Object { $_ -match ('^[a-fA-F0-9]{64}\s+\*?' + [regex]::Escape($archive) + '$') })
        if ($matching.Count -ne 1) { throw 'Archive checksum is missing or ambiguous' }
        $expected = ($matching[0] -split '\s+')[0]
        $zip = Join-Path $temp $archive
        Invoke-WebRequest "$base/$archive" -OutFile $zip -UseBasicParsing
        if ((Get-FileHash $zip -Algorithm SHA256).Hash -ne $expected) { throw 'Checksum mismatch; nothing installed' }
        New-Item -ItemType Directory -Force $agentHome,$bin | Out-Null
        $stage = Join-Path $agentHome ('.staging-' + [guid]::NewGuid())
        New-Item -ItemType Directory $stage | Out-Null
        Expand-ButlerZip $zip $stage
        $manifest = Get-Content (Join-Path $stage 'native-agent-manifest.json') -Raw | ConvertFrom-Json
        if ($manifest.schema -ne 'butler.native-agent-install.v1' -or $manifest.version -ne $baseVersion -or
            $manifest.platform -ne 'windows' -or $manifest.architecture -ne 'x64' -or
            $manifest.binary -ne 'butler-agent.exe' -or $manifest.resources -ne 'resources' -or
            $manifest.binarySha256 -notmatch '^[a-f0-9]{64}$') { throw 'Invalid Agent manifest' }
        $program = Join-Path $stage 'butler-agent.exe'
        if ((Get-FileHash $program -Algorithm SHA256).Hash -ne $manifest.binarySha256) { throw 'Binary checksum mismatch' }
        & $program --installation-root $stage --resource-root "$stage/resources" doctor --check installation
        if ($LASTEXITCODE -ne 0) { throw 'Agent installation check failed' }
        $name = "$baseVersion-$($manifest.binarySha256.Substring(0,8))"
        $target = Join-Path $agentHome $name
        if (Test-Path $target) {
            & "$target/butler-agent.exe" --installation-root $target --resource-root "$target/resources" doctor --check installation
            if ($LASTEXITCODE -ne 0) { throw 'Existing version is damaged; remove it before reinstalling' }
        } else { Move-Item $stage $target; $stage = $null }
        $current = Join-Path $agentHome 'current'
        if (Test-Path $current) {
            $old = (Get-Content $current -Raw).Trim()
            if ($old -ne $name) { [IO.File]::WriteAllText((Join-Path $agentHome 'previous'), $old) }
        }
        [IO.File]::WriteAllText($current, $name)
        $text = "@echo off`r`n$marker`r`n`"$target\butler-agent.exe`" --installation-root `"$target`" --resource-root `"$target\resources`" %*`r`n"
        [IO.File]::WriteAllText($launcher, $text)
        $userPath = [string][Environment]::GetEnvironmentVariable('Path','User')
        if (@($userPath -split ';') -notcontains $bin) {
            [Environment]::SetEnvironmentVariable('Path', ($userPath.TrimEnd(';') + ';' + $bin).TrimStart(';'), 'User')
        }
        if (@($env:PATH -split ';') -notcontains $bin) { $env:PATH += ";$bin" }
        if ($start) {
            & $launcher start
            if ($LASTEXITCODE -ne 0) { throw 'Installed; start failed. Run: butler start' }
        }
        Write-Host 'Butler installed. Run: butler open'
    } finally {
        if ($stage -and (Test-Path $stage)) { Remove-Item $stage -Recurse -Force }
        Remove-Item $temp -Recurse -Force
    }
}

function Expand-ButlerZip {
    param([string]$Zip, [string]$Destination)
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead($Zip)
    try {
        $seen = @{}
        foreach ($entry in $archive.Entries) {
            $name = $entry.FullName
            if ($name.Contains('\') -or $name -match '(^/|:|(^|/)\.\.?(/|$))' -or
                $name -notmatch '^(butler-agent\.exe|butler\.cmd|native-agent-manifest\.json|THIRD_PARTY_NOTICES\.txt|resources(/.*)?)$' -or
                (($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000 -or $seen.ContainsKey($name)) { throw 'Unsafe archive entry' }
            $seen[$name] = $true
            $path = Join-Path $Destination $name
            if ($name.EndsWith('/')) { New-Item -ItemType Directory -Force $path | Out-Null; continue }
            New-Item -ItemType Directory -Force ([IO.Path]::GetDirectoryName($path)) | Out-Null
            [IO.Compression.ZipFileExtensions]::ExtractToFile($entry,$path,$false)
        }
    } finally { $archive.Dispose() }
}

Install-Butler -Options $args
