param(
  [Parameter(Mandatory = $true)][string]$Root,
  [Parameter(Mandatory = $true)][string]$Bun,
  [Parameter(Mandatory = $true)][string]$SignedBun,
  [Parameter(Mandatory = $true)][string]$SignedHost,
  [Parameter(Mandatory = $true)][string]$Output
)

$ErrorActionPreference = "Stop"
try {
  $integrityGroups = (& whoami /groups /fo csv /nh | Out-String)
  if ($integrityGroups -notmatch "S-1-16-8192") {
    throw "Payload smoke child is not running with a standard-user token"
  }
  $env:BUTLER_BUN = $SignedBun
  $env:BUTLER_APP_MANAGED_BUN_WIN32_X64 = $SignedBun
  $env:BUTLER_APP_WINDOWS_PROCESS_HOST = $SignedHost
  $env:BUTLER_WINDOWS_STANDARD_USER = "1"
  Push-Location $Root
  try {
    $ErrorActionPreference = "Continue"
    $lines = & $SignedBun "run" "packages/butler-app/scripts/windows/bundled-agent-payload-smoke.ts" 2>&1
    $code = $LASTEXITCODE
    $ErrorActionPreference = "Stop"
  } finally {
    Pop-Location
  }
  [IO.File]::WriteAllText($Output, (($lines | Out-String).Trim() + "`r`n"))
  exit $code
} catch {
  [IO.File]::WriteAllText($Output, (($_ | Out-String).Trim() + "`r`n"))
  exit 1
}
