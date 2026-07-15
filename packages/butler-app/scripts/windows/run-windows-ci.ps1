param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("Setup", "Quality", "Tests", "ProductE2E", "Package", "Lifecycle")]
  [string]$Mode
)

$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..\..\..\..")
Set-Location $root

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

function Assert-StandardUser {
  $groups = (& whoami.exe /groups /fo csv /nh | Out-String)
  $script:ButlerCiStandardUser = (
    $groups -match "S-1-16-8192" -and
    $groups -notmatch "S-1-16-12288"
  )
  if (-not $script:ButlerCiStandardUser) {
    if ($env:CI -ne "true" -or $groups -notmatch "S-1-16-12288") {
      throw "Windows product validation requires a standard-user token"
    }
  }
}

function Invoke-WithSignedRuntime {
  param([Parameter(Mandatory = $true)][scriptblock]$Action)

  Assert-StandardUser
  if ($script:ButlerCiStandardUser) {
    throw (
      "Signed Windows CI modes require the explicit hosted-CI elevated token; " +
      "use run-standard-user-bundled-payload-smoke.ps1 for physical standard-user proof"
    )
  }
  Invoke-Checked -Command "npm.cmd" -Arguments @(
    "--prefix",
    "packages/butler-app/client/ui",
    "run",
    "build"
  )
  $workspaceParent = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { $env:TEMP }
  $workspace = Join-Path $workspaceParent "butler-windows-ci-signing"
  $signedBun = Join-Path $workspace "bun.exe"
  $unsignedHost = Join-Path $workspace "butler-process-host-unsigned.exe"
  $signedHost = Join-Path $workspace "butler-process-host.exe"
  $certificateFile = Join-Path $workspace "butler-ci-signing.cer"
  $certificate = $null

  $environmentNames = @(
    "BUTLER_BUN",
    "BUTLER_APP_MANAGED_BUN_WIN32_X64",
    "BUTLER_APP_WINDOWS_PROCESS_HOST",
    "BUTLER_WINDOWS_PROCESS_HOST",
    "BUTLER_WINDOWS_SIGN_CERTIFICATE_SHA1",
    "BUTLER_WINDOWS_STANDARD_USER",
    "BUTLER_WINDOWS_CI_ELEVATED_TOKEN",
    "BUTLER_APP_REQUIRE_PRODUCTION_SIGNING"
  )
  $previousEnvironment = @{}
  foreach ($name in $environmentNames) {
    $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
  }

  try {
    Remove-Item -LiteralPath $workspace -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Path $workspace -Force | Out-Null
    $bunPath = (Get-Command bun.exe -ErrorAction Stop).Source
    Copy-Item -LiteralPath $bunPath -Destination $signedBun -Force
    Invoke-Checked -Command $bunPath -Arguments @(
      "run",
      "packages/butler-agent/scripts/windows/build-process-host.ts",
      $unsignedHost
    )
    Copy-Item -LiteralPath $unsignedHost -Destination $signedHost -Force

    $certificate = New-SelfSignedCertificate `
      -Type CodeSigningCert `
      -Subject "CN=Butler Windows CI Test Only" `
      -CertStoreLocation "Cert:\CurrentUser\My" `
      -KeyAlgorithm RSA `
      -KeyLength 2048 `
      -HashAlgorithm SHA256 `
      -NotAfter (Get-Date).AddDays(1)
    Export-Certificate `
      -Cert $certificate `
      -FilePath $certificateFile `
      -Force | Out-Null
    foreach ($storeName in @("Root", "TrustedPublisher")) {
      & certutil.exe -f -addstore $storeName $certificateFile | Out-Null
      if ($LASTEXITCODE -ne 0) {
        throw "Windows CI test certificate trust setup failed for $storeName"
      }
    }
    foreach ($path in @($signedBun, $signedHost)) {
      $signature = Set-AuthenticodeSignature `
        -LiteralPath $path `
        -Certificate $certificate `
        -HashAlgorithm SHA256
      if ([string]$signature.Status -ne "Valid") {
        throw "Windows CI test input signing failed"
      }
    }

    $env:BUTLER_BUN = $signedBun
    $env:BUTLER_APP_MANAGED_BUN_WIN32_X64 = $signedBun
    $env:BUTLER_APP_WINDOWS_PROCESS_HOST = $signedHost
    $env:BUTLER_WINDOWS_PROCESS_HOST = $signedHost
    $env:BUTLER_WINDOWS_SIGN_CERTIFICATE_SHA1 = $certificate.Thumbprint
    $env:BUTLER_WINDOWS_STANDARD_USER = if ($script:ButlerCiStandardUser) { "1" } else { "0" }
    $env:BUTLER_WINDOWS_CI_ELEVATED_TOKEN = if ($script:ButlerCiStandardUser) { "0" } else { "1" }
    $env:BUTLER_APP_REQUIRE_PRODUCTION_SIGNING = "1"
    & $Action
  } finally {
    foreach ($name in $environmentNames) {
      [Environment]::SetEnvironmentVariable(
        $name,
        $previousEnvironment[$name],
        "Process"
      )
    }
    if ($null -ne $certificate) {
      foreach ($storeName in @("Root", "TrustedPublisher")) {
        & certutil.exe -f -delstore $storeName $certificate.Thumbprint | Out-Null
      }
      Remove-Item `
        -LiteralPath "Cert:\CurrentUser\My\$($certificate.Thumbprint)" `
        -Force `
        -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath $workspace -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Invoke-StandardUserSmoke {
  param(
    [Parameter(Mandatory = $true)][string]$Smoke,
    [Parameter(Mandatory = $true)][int]$TimeoutMinutes,
    [switch]$InteractiveDesktop
  )

  Invoke-Checked -Command "npm.cmd" -Arguments @(
    "--prefix",
    "packages/butler-app/client/ui",
    "run",
    "build"
  )
  $groups = (& whoami.exe /groups /fo csv /nh | Out-String)
  if ($groups -notmatch "S-1-16-12288") {
    throw "Windows standard-user smoke dispatch requires an elevated parent token"
  }
  $bun = (Get-Command bun.exe -ErrorAction Stop).Source
  $output = Join-Path $env:TEMP "butler-windows-ci-standard-user-$PID.txt"
  $runner = Join-Path `
    $root `
    "packages\butler-app\scripts\windows\run-standard-user-bundled-payload-smoke.ps1"
  try {
    & $runner `
      -Root $root `
      -Bun $bun `
      -Output $output `
      -Smoke $Smoke `
      -TimeoutMinutes $TimeoutMinutes `
      -InteractiveDesktop:$InteractiveDesktop
    if ($LASTEXITCODE -ne 0) {
      $diagnostic = if (Test-Path -LiteralPath $output) {
        [IO.File]::ReadAllText($output)
      } else {
        "standard-user smoke result is missing"
      }
      throw "Windows standard-user smoke failed: $diagnostic"
    }
    Get-Content -LiteralPath $output -Raw
  } finally {
    Remove-Item -LiteralPath $output -Force -ErrorAction SilentlyContinue
  }
}

switch ($Mode) {
  "Setup" {
    Invoke-Checked -Command "bun.exe" -Arguments @(
      "install",
      "--frozen-lockfile"
    )
    Invoke-Checked -Command "npm.cmd" -Arguments @(
      "--prefix",
      "packages/butler-app/client/electron",
      "ci"
    )
    Invoke-Checked -Command "npm.cmd" -Arguments @(
      "--prefix",
      "packages/butler-app/client/ui",
      "ci"
    )
    foreach ($packageRoot in @(
      "packages/butler-app/client/electron",
      "packages/butler-app/client/ui"
    )) {
      Invoke-Checked -Command "npm.cmd" -Arguments @(
        "--prefix",
        $packageRoot,
        "audit",
        "--audit-level=high"
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
      "x",
      "prettier",
      "--check",
      "packages/butler-app/client/ui/src/**/*.css",
      "--log-level",
      "warn"
    )
    Invoke-Checked -Command "bun.exe" -Arguments @(
      "x",
      "stylelint",
      "packages/butler-app/client/ui/src/**/*.css"
    )
    Invoke-Checked -Command "bun.exe" -Arguments @(
      "x",
      "tsc",
      "-p",
      "tsconfig.json",
      "--noEmit"
    )
    Invoke-Checked -Command "npm.cmd" -Arguments @(
      "--prefix",
      "packages/butler-app/client/ui",
      "run",
      "--silent",
      "typecheck"
    )
  }
  "Tests" {
    $testHostRoot = Join-Path $env:TEMP "butler-windows-ci-tests-$PID"
    $testHost = Join-Path $testHostRoot "butler-process-host.exe"
    $previousProcessHost = $env:BUTLER_WINDOWS_PROCESS_HOST
    try {
      Remove-Item -LiteralPath $testHostRoot -Recurse -Force -ErrorAction SilentlyContinue
      New-Item -ItemType Directory -Path $testHostRoot -Force | Out-Null
      Invoke-Checked -Command "bun.exe" -Arguments @(
        "run",
        "packages/butler-agent/scripts/windows/build-process-host.ts",
        $testHost
      )
      $env:BUTLER_WINDOWS_PROCESS_HOST = $testHost
      Invoke-Checked -Command "bun.exe" -Arguments @(
        "test",
        "--timeout",
        "30000",
        "tests/unit/platform-command-executor.test.ts",
        "tests/unit/background-command-registry.test.ts",
        "tests/unit/butler-cli-command-registry.test.ts",
        "tests/unit/runtime-filesystem.test.ts",
        "tests/unit/app-managed-runtime.test.ts",
        "tests/unit/principal-turn-cancellation.test.ts",
        "tests/unit/principal-turn-cancellation-auth.test.ts",
        "tests/unit/windows-process-host-contract.test.ts",
        "tests/unit/app-foreground-lifecycle.test.ts",
        "tests/unit/app-agent-supervisor-drain.test.ts",
        "tests/unit/app-quit-state-machine.test.ts",
        "tests/unit/app-update-source.test.ts",
        "tests/unit/app-first-run-setup-bridge-runtime.test.ts",
        "tests/unit/app-windows-squirrel-lifecycle.test.ts",
        "tests/unit/windows-ci-workflow.test.ts"
      )
      Invoke-Checked -Command "bun.exe" -Arguments @(
        "test",
        "tests/unit/release-packaging.test.ts",
        "--test-name-pattern",
        "^(Windows app release artifacts are buildable but remain gated|Windows managed runtime validation accepts only x64 PE images)$"
      )
    } finally {
      Remove-Item `
        -Path (Join-Path $env:TEMP "butler-app-update-source-*") `
        -Recurse `
        -Force `
        -ErrorAction SilentlyContinue
      if ($null -eq $previousProcessHost) {
        Remove-Item Env:BUTLER_WINDOWS_PROCESS_HOST -ErrorAction SilentlyContinue
      } else {
        $env:BUTLER_WINDOWS_PROCESS_HOST = $previousProcessHost
      }
      Remove-Item -LiteralPath $testHostRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
  "ProductE2E" {
    Invoke-StandardUserSmoke `
      -Smoke "packages/butler-app/scripts/windows/windows-product-loop-smoke.ts" `
      -TimeoutMinutes 20
  }
  "Package" {
    Invoke-WithSignedRuntime {
      Invoke-Checked -Command $env:BUTLER_BUN -Arguments @(
        "run",
        "packages/butler-app/scripts/windows/windows-release-package-smoke.ts"
      )
    }
  }
  "Lifecycle" {
    Invoke-StandardUserSmoke `
      -Smoke "packages/butler-app/scripts/windows/windows-squirrel-release-cycle-smoke.ts" `
      -TimeoutMinutes 30 `
      -InteractiveDesktop
  }
}
