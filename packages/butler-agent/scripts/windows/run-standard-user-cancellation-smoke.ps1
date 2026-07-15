param(
  [Parameter(Mandatory = $true)][string]$Bun,
  [Parameter(Mandatory = $true)][string]$Smoke,
  [Parameter(Mandatory = $true)][string]$Output
)

$ErrorActionPreference = "Stop"
$env:BUTLER_WINDOWS_DACL_SEPARATELY_VERIFIED = "1"
$lines = & $Bun $Smoke 2>&1
$code = $LASTEXITCODE
[IO.File]::WriteAllText($Output, (($lines | Out-String).Trim() + "`r`n"))
exit $code
