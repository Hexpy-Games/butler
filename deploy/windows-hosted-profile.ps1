# Job-owned hosted profiles keep fixture I/O off the default user temp volume.
$ErrorActionPreference = 'Stop'
$defender = Get-MpComputerStatus
$root = Join-Path $env:RUNNER_TEMP 'windows-verify'
# Keep TEMP valid for post-job actions after verification-profile cleanup.
$temporary = Join-Path $env:RUNNER_TEMP ("windows-fixtures-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force "$root/logs",$temporary | Out-Null
"Storage control: Defender realtime=$($defender.RealTimeProtectionEnabled) engine=$($defender.AMEngineVersion) temp=$temporary previous_temp=$env:TEMP"
"BUTLER_CI_IO_BASELINE=$env:TEMP" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
foreach ($name in @('TEMP','TMP','TMPDIR')) {
  "$name=$temporary" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
}
"PREVIEW_ROOT=$root" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
"BUTLER_E2E_WORKSPACE_ROOT=$env:GITHUB_WORKSPACE/packages/butler-agent/rust" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
