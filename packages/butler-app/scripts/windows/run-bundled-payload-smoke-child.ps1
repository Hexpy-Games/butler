param(
  [Parameter(Mandatory = $true)][string]$Root,
  [Parameter(Mandatory = $true)][string]$Bun,
  [Parameter(Mandatory = $true)][string]$SignedBun,
  [Parameter(Mandatory = $true)][string]$SignedHost,
  [Parameter(Mandatory = $true)][string]$SigningThumbprint,
  [string]$Smoke = "packages/butler-app/scripts/windows/bundled-agent-payload-smoke.ts",
  [Parameter(Mandatory = $true)][string]$Output,
  [switch]$InteractiveDesktop
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
  $env:BUTLER_WINDOWS_PROCESS_HOST = $SignedHost
  $env:BUTLER_WINDOWS_SIGN_CERTIFICATE_SHA1 = $SigningThumbprint
  $env:BUTLER_WINDOWS_STANDARD_USER = "1"
  Push-Location $Root
  try {
    if ($InteractiveDesktop) {
      $controller = Join-Path $Root "packages\butler-app\scripts\windows\interactive-smoke-controller.ts"
      $shortcutPath = Join-Path $env:TEMP "ButlerInteractiveSmoke-$PID.lnk"
      $shell = New-Object -ComObject WScript.Shell
      $shortcut = $shell.CreateShortcut($shortcutPath)
      $shortcut.TargetPath = $SignedBun
      $shortcut.Arguments = @(
        "run",
        "`"$controller`"",
        "--signed-bun",
        "`"$SignedBun`"",
        "--signed-host",
        "`"$SignedHost`"",
        "--signing-thumbprint",
        "`"$SigningThumbprint`"",
        "--smoke",
        "`"$Smoke`"",
        "--output",
        "`"$Output`""
      ) -join " "
      $shortcut.WorkingDirectory = $Root
      $shortcut.WindowStyle = 7
      $shortcut.Save()
      try {
        & explorer.exe $shortcutPath
        $deadline = (Get-Date).AddMinutes(9)
        while (-not (Test-Path -LiteralPath $Output)) {
          if ((Get-Date) -gt $deadline) {
            throw "Interactive standard-user smoke controller timed out"
          }
          Start-Sleep -Milliseconds 250
        }
        $lines = [IO.File]::ReadAllText($Output)
        $exitMatch = [regex]::Match($lines, "__EXIT__=(?<code>-?\d+)")
        if (-not $exitMatch.Success) {
          throw "Interactive standard-user smoke result is missing an exit code"
        }
        $code = [int]$exitMatch.Groups["code"].Value
      } finally {
        Remove-Item -LiteralPath $shortcutPath -Force -ErrorAction SilentlyContinue
      }
    } else {
      $ErrorActionPreference = "Continue"
      $lines = & $SignedBun "run" $Smoke 2>&1
      $code = $LASTEXITCODE
      $ErrorActionPreference = "Stop"
    }
  } finally {
    Pop-Location
  }
  if (-not $InteractiveDesktop) {
    [IO.File]::WriteAllText($Output, (($lines | Out-String).Trim() + "`r`n"))
  }
  exit $code
} catch {
  [IO.File]::WriteAllText($Output, (($_ | Out-String).Trim() + "`r`n"))
  exit 1
}
