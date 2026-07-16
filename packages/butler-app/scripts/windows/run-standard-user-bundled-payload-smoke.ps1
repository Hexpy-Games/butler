param(
  [Parameter(Mandatory = $true)][string]$Root,
  [Parameter(Mandatory = $true)][string]$Bun,
  [Parameter(Mandatory = $true)][string]$Output,
  [string]$Smoke = "packages/butler-app/scripts/windows/bundled-agent-payload-smoke.ts",
  [ValidateRange(1, 30)][int]$TimeoutMinutes = 10,
  [switch]$InteractiveDesktop,
  [switch]$PrepareRelease
)

$ErrorActionPreference = "Stop"
$ciMode = $env:CI -eq "true"
$workspaceParent = if ($ciMode) {
  Join-Path $env:ProgramData "Butler\ci"
} else {
  $env:TEMP
}
$workspace = Join-Path $workspaceParent "butler-signed-payload-inputs-$PID"
$signedBun = Join-Path $workspace "bun.exe"
$unsignedHost = Join-Path $workspace "butler-process-host-unsigned.exe"
$signedHost = Join-Path $workspace "butler-process-host.exe"
$certificateFile = Join-Path $workspace "butler-test-signing.cer"
$preparedReleaseRoot = Join-Path $workspace "prepared-release"
$childScript = Join-Path $Root "packages\butler-app\scripts\windows\run-bundled-payload-smoke-child.ps1"
$taskName = "ButlerWindowsPayloadSmoke-$PID"
$certificate = $null
$taskRegistered = $false
$temporaryUserName = $null
$temporaryUserSid = $null
$temporaryUserProfile = $null
$batchLogonRightGranted = $false

function Set-BatchLogonRight {
  param(
    [Parameter(Mandatory = $true)][string]$Sid,
    [Parameter(Mandatory = $true)][bool]$Enabled
  )
  if (-not ("Butler.Windows.LsaAccountRights" -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;

namespace Butler.Windows {
  public static class LsaAccountRights {
    [StructLayout(LayoutKind.Sequential)]
    private struct LsaObjectAttributes {
      public int Length;
      public IntPtr RootDirectory;
      public IntPtr ObjectName;
      public uint Attributes;
      public IntPtr SecurityDescriptor;
      public IntPtr SecurityQualityOfService;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct LsaUnicodeString {
      public ushort Length;
      public ushort MaximumLength;
      [MarshalAs(UnmanagedType.LPWStr)] public string Buffer;

      public LsaUnicodeString(string value) {
        Buffer = value;
        Length = checked((ushort)(value.Length * 2));
        MaximumLength = checked((ushort)(Length + 2));
      }
    }

    [DllImport("advapi32.dll")]
    private static extern uint LsaOpenPolicy(
      IntPtr systemName,
      ref LsaObjectAttributes attributes,
      uint desiredAccess,
      out IntPtr policyHandle
    );

    [DllImport("advapi32.dll")]
    private static extern uint LsaAddAccountRights(
      IntPtr policyHandle,
      IntPtr accountSid,
      LsaUnicodeString[] userRights,
      uint countOfRights
    );

    [DllImport("advapi32.dll")]
    private static extern uint LsaRemoveAccountRights(
      IntPtr policyHandle,
      IntPtr accountSid,
      [MarshalAs(UnmanagedType.Bool)] bool allRights,
      LsaUnicodeString[] userRights,
      uint countOfRights
    );

    [DllImport("advapi32.dll")]
    private static extern uint LsaClose(IntPtr policyHandle);

    [DllImport("advapi32.dll")]
    private static extern uint LsaNtStatusToWinError(uint status);

    public static void SetBatchLogonRight(string sidValue, bool enabled) {
      const uint PolicyCreateAccount = 0x00000010;
      const uint PolicyLookupNames = 0x00000800;
      var attributes = new LsaObjectAttributes {
        Length = Marshal.SizeOf(typeof(LsaObjectAttributes))
      };
      IntPtr policyHandle;
      uint status = LsaOpenPolicy(
        IntPtr.Zero,
        ref attributes,
        PolicyCreateAccount | PolicyLookupNames,
        out policyHandle
      );
      ThrowIfFailed(status);
      var sid = new SecurityIdentifier(sidValue);
      var sidBytes = new byte[sid.BinaryLength];
      sid.GetBinaryForm(sidBytes, 0);
      var pinnedSid = GCHandle.Alloc(sidBytes, GCHandleType.Pinned);
      try {
        var rights = new[] { new LsaUnicodeString("SeBatchLogonRight") };
        status = enabled
          ? LsaAddAccountRights(policyHandle, pinnedSid.AddrOfPinnedObject(), rights, 1)
          : LsaRemoveAccountRights(
              policyHandle,
              pinnedSid.AddrOfPinnedObject(),
              false,
              rights,
              1
            );
        ThrowIfFailed(status);
      } finally {
        pinnedSid.Free();
        LsaClose(policyHandle);
      }
    }

    private static void ThrowIfFailed(uint status) {
      if (status != 0) {
        throw new Win32Exception((int)LsaNtStatusToWinError(status));
      }
    }
  }
}
"@
  }
  [Butler.Windows.LsaAccountRights]::SetBatchLogonRight($Sid, $Enabled)
}

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
  if ($env:GITHUB_ACTIONS -eq "true") {
    & icacls.exe $Root /grant "*S-1-5-32-545:(OI)(CI)M" | Out-Null
    if ($LASTEXITCODE -ne 0) {
      throw "GitHub Windows workspace standard-user access setup failed"
    }
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

  if ($PrepareRelease) {
    $env:BUTLER_BUN = $signedBun
    $env:BUTLER_APP_MANAGED_BUN_WIN32_X64 = $signedBun
    $env:BUTLER_APP_WINDOWS_PROCESS_HOST = $signedHost
    $env:BUTLER_WINDOWS_PROCESS_HOST = $signedHost
    $env:BUTLER_WINDOWS_SIGN_CERTIFICATE_SHA1 = $certificate.Thumbprint
    $env:BUTLER_WINDOWS_STANDARD_USER = "0"
    $env:BUTLER_WINDOWS_CI_ELEVATED_TOKEN = "1"
    $env:BUTLER_WINDOWS_RELEASE_PREPARATION_TOKEN = "1"
    $env:BUTLER_APP_REQUIRE_PRODUCTION_SIGNING = "1"
    $env:BUTLER_WINDOWS_LIFECYCLE_RELEASE_ROOT = $preparedReleaseRoot
    Push-Location $Root
    try {
      & $Bun "run" $Smoke "--prepare-only"
      if ($LASTEXITCODE -ne 0) {
        throw "Windows lifecycle release preparation failed"
      }
    } finally {
      Pop-Location
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
    "-Output `"$Output`"",
    "-TimeoutMinutes $TimeoutMinutes"
  )
  if ($PrepareRelease) {
    $actionArgumentParts += "-PreparedReleaseRoot `"$preparedReleaseRoot`""
  }
  if ($InteractiveDesktop) { $actionArgumentParts += "-InteractiveDesktop" }
  if ($ciMode -and $InteractiveDesktop) {
    $actionArgumentParts += "-DirectInteractive"
  }
  $actionArguments = $actionArgumentParts -join " "
  $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $actionArguments
  $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddHours(1)
  $settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries

  if ($ciMode) {
    $temporaryUserName = "ButlerCi$PID"
    $temporaryPassword = "Btlr!1aA$([Guid]::NewGuid().ToString('N'))"
    $securePassword = ConvertTo-SecureString $temporaryPassword -AsPlainText -Force
    $temporaryUser = New-LocalUser `
      -Name $temporaryUserName `
      -Password $securePassword `
      -AccountNeverExpires `
      -PasswordNeverExpires `
      -UserMayNotChangePassword
    $temporaryUserSid = [string]$temporaryUser.SID
    Add-LocalGroupMember `
      -Group (Get-LocalGroup -SID "S-1-5-32-545") `
      -Member $temporaryUser
    Set-BatchLogonRight -Sid $temporaryUserSid -Enabled $true
    $batchLogonRightGranted = $true
    New-Item -ItemType File -Path $Output -Force | Out-Null
    foreach ($access in @(
      @{ Path = $workspace; Rule = "*${temporaryUserSid}:(OI)(CI)M" },
      @{ Path = $Output; Rule = "*${temporaryUserSid}:(M)" }
    )) {
      & icacls.exe $access.Path /grant $access.Rule | Out-Null
      if ($LASTEXITCODE -ne 0) {
        throw "Temporary standard-user validation access setup failed"
      }
    }
    $temporaryPrincipal = "$env:COMPUTERNAME\$temporaryUserName"
    $temporaryUserProfile = Join-Path $env:SystemDrive "Users\$temporaryUserName"
    Register-ScheduledTask `
      -TaskName $taskName `
      -Action $action `
      -Trigger $trigger `
      -Settings $settings `
      -User $temporaryPrincipal `
      -Password $temporaryPassword `
      -RunLevel Limited `
      -Force `
      -ErrorAction Stop | Out-Null
    $temporaryPassword = $null
  } else {
    $principal = New-ScheduledTaskPrincipal `
      -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) `
      -LogonType Interactive `
      -RunLevel Limited
    Register-ScheduledTask `
      -TaskName $taskName `
      -Action $action `
      -Trigger $trigger `
      -Principal $principal `
      -Settings $settings `
      -Force `
      -ErrorAction Stop | Out-Null
  }
  $taskRegistered = $true
  Start-ScheduledTask -TaskName $taskName -ErrorAction Stop

  $deadline = (Get-Date).AddMinutes($TimeoutMinutes)
  do {
    Start-Sleep -Milliseconds 500
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
    $taskInfo = Get-ScheduledTaskInfo -TaskName $taskName -ErrorAction Stop
    if ((Get-Date) -gt $deadline) { throw "Standard-user payload smoke timed out" }
  } while (
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
  if (
    -not (Test-Path -LiteralPath $Output) -or
    (Get-Item -LiteralPath $Output).Length -eq 0
  ) {
    [IO.File]::WriteAllText($Output, (($_ | Out-String).Trim() + "`r`n"))
  }
  exit 1
} finally {
  if ($taskRegistered) {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  }
  if ($batchLogonRightGranted) {
    Set-BatchLogonRight -Sid $temporaryUserSid -Enabled $false
  }
  if ($null -ne $temporaryUserName) {
    Remove-LocalUser -Name $temporaryUserName -ErrorAction SilentlyContinue
  }
  if ($null -ne $temporaryUserProfile) {
    Remove-Item `
      -LiteralPath $temporaryUserProfile `
      -Recurse `
      -Force `
      -ErrorAction SilentlyContinue
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
