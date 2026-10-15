# Invoked as a file, independent of Butler's PowerShell prelude.
$ErrorActionPreference='Stop'
$matrix = @{fileMode=$ExecutionContext.SessionState.LanguageMode.ToString();version=$PSVersionTable.PSVersion.ToString()}
$matrix.environment = @{TEMP=$env:TEMP;TMP=$env:TMP;USERPROFILE=$env:USERPROFILE;LOCALAPPDATA=$env:LOCALAPPDATA;entryTemp=$env:BUTLER_CONTAINER_TEMP;entryTmp=$env:BUTLER_CONTAINER_TMP}
try { $matrix.getTempPath=[IO.Path]::GetTempPath() }
catch { $matrix.tempError=@{type=$_.Exception.GetType().FullName;hresult=$_.Exception.HResult} }
$mode='$ExecutionContext.SessionState.LanguageMode'
$encoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($mode))
$ps=Join-Path $PSHOME 'powershell.exe'
$matrix.command=@{output=((& $ps -NoProfile -NonInteractive -Command $mode 2>&1 | Out-String).Trim());exitCode=$LASTEXITCODE}
$matrix.encodedCommand=@{output=((& $ps -NoProfile -NonInteractive -EncodedCommand $encoded 2>&1 | Out-String).Trim());exitCode=$LASTEXITCODE}
$matrix.file=@{output=((& $ps -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'language-mode.ps1') 2>&1 | Out-String).Trim());exitCode=$LASTEXITCODE}
$probe=@{}
& (Join-Path $PSScriptRoot 'policy-probe.exe') | ForEach-Object {
    $parts=$_ -split '=',2
    if ($parts.Count -eq 2 -and $parts[0]) { $probe[$parts[0]]=$parts[1] }
}
$matrix.policy=$probe
$pwsh=Get-Command pwsh.exe -ErrorAction SilentlyContinue
$matrix.pwsh=@{exists=($null -ne $pwsh)}
if ($pwsh) {
    $matrix.pwsh.path=$pwsh.Source
    $matrix.pwsh.output=((& $pwsh.Source -NoProfile -NonInteractive -Command $mode 2>&1 | Out-String).Trim())
    $matrix.pwsh.exitCode=$LASTEXITCODE
}
$matrix | ConvertTo-Json -Depth 8 -Compress
exit 0
