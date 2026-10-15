# Job-owned hosted profiles keep fixture I/O off the default user temp volume.
$ErrorActionPreference = 'Stop'
$defender = Get-MpComputerStatus
# Preserve long-path command support when fixtures move off the system volume.
# This helper runs only on disposable hosted runners, never owner machines.
$volume = [IO.Path]::GetPathRoot($env:RUNNER_TEMP).TrimEnd('\')
fsutil.exe 8dot3name set $volume 0
if ($LASTEXITCODE -ne 0) { throw "Could not enable short names on hosted work volume $volume" }
fsutil.exe 8dot3name query $volume
if ($LASTEXITCODE -ne 0) { throw "Could not inspect hosted work volume $volume" }
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
