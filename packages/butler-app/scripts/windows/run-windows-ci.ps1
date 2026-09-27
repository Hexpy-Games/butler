param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("Setup", "Quality", "Tests", "ProductE2E", "Package", "Lifecycle")]
  [string]$Mode
)

$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..\..\..\..")
Set-Location $root

if ($Mode -notin @("Setup", "Quality")) {
  throw "Windows agent-bundled runtime and release are unsupported after the native Agent transition; Electron UI setup and quality checks remain available."
}

function Invoke-Checked {
  param(
    [Parameter(Mandatory = $true)][string]$Command,
    [Parameter(Mandatory = $true)][string[]]$Arguments
  )
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$Command failed with exit code $LASTEXITCODE"
  }
}

switch ($Mode) {
  "Setup" {
    Invoke-Checked -Command "bun.exe" -Arguments @("install", "--frozen-lockfile")
    foreach ($packageRoot in @(
      "packages/butler-app/client/electron",
      "packages/butler-app/client/ui"
    )) {
      Invoke-Checked -Command "npm.cmd" -Arguments @("--prefix", $packageRoot, "ci")
      Invoke-Checked -Command "npm.cmd" -Arguments @(
        "--prefix", $packageRoot, "audit", "--audit-level=high"
      )
    }
  }
  "Quality" {
    Invoke-Checked -Command "bun.exe" -Arguments @("x", "eslint", ".")
    foreach ($script in @(
      "packages/butler-app/scripts/lint/design-token-lint.ts",
      "packages/butler-app/scripts/lint/app-client-copy-lint.ts",
      "packages/butler-app/scripts/lint/component-line-count-lint.ts",
      "packages/butler-app/scripts/lint/css-module-global-lint.ts",
      "packages/butler-app/scripts/lint/prop-boundary-lint.ts"
    )) {
      Invoke-Checked -Command "bun.exe" -Arguments @("run", "--silent", $script)
    }
    Invoke-Checked -Command "bun.exe" -Arguments @(
      "x", "prettier", "--check", "packages/butler-app/client/ui/src/**/*.css",
      "--log-level", "warn"
    )
    Invoke-Checked -Command "bun.exe" -Arguments @(
      "x", "stylelint", "packages/butler-app/client/ui/src/**/*.css"
    )
    Invoke-Checked -Command "bun.exe" -Arguments @("x", "tsc", "-p", "tsconfig.json", "--noEmit")
    Invoke-Checked -Command "npm.cmd" -Arguments @(
      "--prefix", "packages/butler-app/client/ui", "run", "--silent", "typecheck"
    )
  }
}
