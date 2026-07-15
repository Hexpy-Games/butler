param(
  [Parameter(Mandatory = $true)][string]$Root,
  [Parameter(Mandatory = $true)][string]$Bun,
  [Parameter(Mandatory = $true)][string]$Output,
  [string]$Smoke = "packages/butler-app/scripts/windows/bundled-agent-payload-smoke.ts",
  [ValidateRange(1, 30)][int]$TimeoutMinutes = 10,
  [switch]$InteractiveDesktop
)

$ErrorActionPreference = "Stop"
$workspace = Join-Path $env:TEMP "butler-signed-payload-inputs"
$signedBun = Join-Path $workspace "bun.exe"
$unsignedHost = Join-Path $workspace "butler-process-host-unsigned.exe"
$signedHost = Join-Path $workspace "butler-process-host.exe"
$certificateFile = Join-Path $workspace "butler-test-signing.cer"
$childScript = Join-Path $Root "packages\butler-app\scripts\windows\run-bundled-payload-smoke-child.ps1"
$interactiveController = Join-Path $Root "packages\butler-app\scripts\windows\interactive-smoke-controller.ts"
$taskName = "ButlerWindowsPayloadSmoke-$PID"
$certificate = $null
$taskRegistered = $false

try {
  $integrityGroups = (& whoami /groups /fo csv /nh | Out-String)
  if ($integrityGroups -notmatch "S-1-16-12288") {
    throw "Test certificate setup must run from an elevated session"
  }

  Remove-Item -LiteralPath $workspace -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $Output -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Path $workspace -Force | Out-Null
  $smokePath = Join-Path $Root $Smoke
  if (-not (Test-Path -LiteralPath $smokePath -PathType Leaf)) {
    throw "Windows standard-user smoke script is missing"
  }
  Copy-Item -LiteralPath $Bun -Destination $signedBun -Force

  Push-Location $Root
  try {
    & $Bun "run" "packages/butler-agent/scripts/windows/build-process-host.ts" $unsignedHost | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Windows process host build failed" }
  } finally {
    Pop-Location
  }
  Copy-Item -LiteralPath $unsignedHost -Destination $signedHost -Force

  $certificate = New-SelfSignedCertificate `
    -Type CodeSigningCert `
    -Subject "CN=Butler Windows Payload Test Only" `
    -CertStoreLocation "Cert:\CurrentUser\My" `
    -KeyAlgorithm RSA `
    -KeyLength 2048 `
    -HashAlgorithm SHA256 `
    -NotAfter (Get-Date).AddDays(1)
  Export-Certificate -Cert $certificate -FilePath $certificateFile -Force | Out-Null
  foreach ($storeName in @("Root", "TrustedPublisher")) {
    & certutil.exe -f -addstore $storeName $certificateFile | Out-Null
    if ($LASTEXITCODE -ne 0) {
      throw "Test certificate trust setup failed for $storeName"
    }
  }

  foreach ($path in @($signedBun, $signedHost)) {
    $signature = Set-AuthenticodeSignature `
      -LiteralPath $path `
      -Certificate $certificate `
      -HashAlgorithm SHA256
    if ([string]$signature.Status -ne "Valid") {
      throw "Test payload signing did not produce a valid Authenticode signature"
    }
  }

  $actionArgumentParts = @(
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy Bypass",
    "-File `"$childScript`"",
    "-Root `"$Root`"",
    "-Bun `"$Bun`"",
    "-SignedBun `"$signedBun`"",
    "-SignedHost `"$signedHost`"",
    "-SigningThumbprint `"$($certificate.Thumbprint)`"",
    "-Smoke `"$Smoke`"",
    "-Output `"$Output`""
  )
  if ($InteractiveDesktop) { $actionArgumentParts += "-InteractiveDesktop" }
  $actionArguments = $actionArgumentParts -join " "
  $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $actionArguments
  $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddHours(1)
  $principal = New-ScheduledTaskPrincipal `
    -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) `
    -LogonType Interactive `
    -RunLevel Limited
  Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Principal $principal `
    -Force `
    -ErrorAction Stop | Out-Null
  $taskRegistered = $true
  Start-ScheduledTask -TaskName $taskName -ErrorAction Stop

  $deadline = (Get-Date).AddMinutes($TimeoutMinutes)
  do {
    Start-Sleep -Milliseconds 500
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
    $taskInfo = Get-ScheduledTaskInfo -TaskName $taskName -ErrorAction Stop
    if ((Get-Date) -gt $deadline) { throw "Standard-user payload smoke timed out" }
  } while (
    -not (Test-Path -LiteralPath $Output) -or
    $task.State -eq "Running" -or
    $taskInfo.LastRunTime.Year -lt 2000
  )

  if (-not (Test-Path -LiteralPath $Output)) {
    throw "Standard-user payload smoke did not write a result"
  }
  if ($taskInfo.LastTaskResult -ne 0) {
    throw "Standard-user payload smoke failed with code $($taskInfo.LastTaskResult)"
  }
  exit 0
} catch {
  if (-not (Test-Path -LiteralPath $Output)) {
    [IO.File]::WriteAllText($Output, (($_ | Out-String).Trim() + "`r`n"))
  }
  exit 1
} finally {
  if ($taskRegistered) {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  }
  if ($null -ne $certificate) {
    foreach ($storeName in @("Root", "TrustedPublisher")) {
      & certutil.exe -f -delstore $storeName $certificate.Thumbprint | Out-Null
    }
    Remove-Item `
      -LiteralPath ("Cert:\CurrentUser\My\{0}" -f $certificate.Thumbprint) `
      -Force `
      -ErrorAction SilentlyContinue
  }
  Remove-Item -LiteralPath $workspace -Recurse -Force -ErrorAction SilentlyContinue
}
