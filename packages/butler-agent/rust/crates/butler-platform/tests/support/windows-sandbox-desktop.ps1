# Dev-only desktop acceptance runner. Installed by prepare-windows-sandbox-harness.ps1.
param([Parameter(Mandatory=$true)][string]$Manifest)
$ErrorActionPreference = 'Stop'
$bundle = Split-Path -Parent $Manifest
$pins = Get-Content -Raw $Manifest | ConvertFrom-Json
$resultRoot = Join-Path $env:LOCALAPPDATA 'Butler\e2e-results'
$resultFile = Join-Path $resultRoot ($pins.revision + '.json')
$diagnostic = Join-Path $resultRoot ($pins.revision + '.diagnostic.json')
$result = @{ diagnostic=$diagnostic; revision=$pins.revision; status='FAIL'; probe=$null; desktop=$null; testExit=$null }
$profile = Join-Path $bundle ('tmp-' + [guid]::NewGuid().ToString('N').Substring(0,8))
$before = (& reg query HKCU\Software\Classes\butler /s | Out-String)
try {
    foreach ($pin in $pins.binaries) {
        $path = Join-Path $bundle $pin.name
        if ((Get-FileHash -Algorithm SHA256 $path).Hash.ToLowerInvariant() -ne $pin.sha256) {
            throw ('binary_hash_mismatch: ' + $pin.name)
        }
    }
    # whoami supplies the integrity SID; refuse anything other than Medium IL.
    $groups = (& whoami /groups | Out-String)
    if ($groups -notmatch 'S-1-16-8192\b' -or $groups -match 'S-1-16-(12288|16384)\b') {
        $result.status = 'REFUSED'
        throw 'medium_integrity_required'
    }
    Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class ButlerDesktop {
    [DllImport("user32.dll")] static extern IntPtr GetProcessWindowStation();
    [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder value, int length, out int needed);
    public static string Station() {
        var value = new StringBuilder(256); int needed;
        if (!GetUserObjectInformation(GetProcessWindowStation(), 2, value, 512, out needed))
            throw new InvalidOperationException("window_station_unavailable");
        return value.ToString();
    }
}
'@
    $result.desktop = [ButlerDesktop]::Station()
    if ($result.desktop -ne 'WinSta0') { $result.status='REFUSED'; throw 'interactive_window_station_required' }
    New-Item -ItemType Directory -Force $profile | Out-Null
    $env:HOME = Join-Path $profile 'home'
    $env:BUTLER_DATA = Join-Path $profile 'data'
    $env:APPDATA = Join-Path $profile 'roaming'
    $env:LOCALAPPDATA = Join-Path $profile 'local'
    $env:TEMP = Join-Path $profile 'temp'
    $env:TMP = $env:TEMP
    New-Item -ItemType Directory -Force $env:HOME,$env:BUTLER_DATA,$env:APPDATA,$env:LOCALAPPDATA,$env:TEMP | Out-Null
    $env:BUTLER_WINDOWS_PROJECT_SANDBOX = '1'
    $env:BUTLER_E2E_TIER = 'stub'
    $env:BUTLER_E2E_WINDOWS_SANDBOX_DESKTOP = '1'
    $env:BUTLER_E2E_SKIP_BUILD = '1'
    $env:BUTLER_E2E_BIN = Join-Path $bundle 'butler-agent.exe'
    New-Item -ItemType Directory -Force $resultRoot | Out-Null
    $probeOut = Join-Path $profile 'probe.stdout'
    $probeErr = Join-Path $profile 'probe.stderr'
    $child = $null
    try {
        $child = Start-Process -FilePath (Join-Path $bundle 'butler-sandbox.exe') -ArgumentList @('--probe','--diagnostic',('"' + $diagnostic + '"')) -NoNewWindow -PassThru -RedirectStandardOutput $probeOut -RedirectStandardError $probeErr
        # Windows PowerShell must retain the handle to populate ExitCode.
        $null = $child.Handle
        $child.WaitForExit()
        $result.probe = (Get-Content -Raw $probeOut).Trim()
        $result.probeExit = $child.ExitCode
    } finally {
        if ($null -ne $child) {
            if (!$child.HasExited) { Stop-Process -Id $child.Id -Force }
            $child.Dispose()
        }
    }
    if (Test-Path $diagnostic) {
        $details = Get-Content -Raw $diagnostic | ConvertFrom-Json
        $result.probeDetails = $details
    } else {
        $details = @{reason='probe_diagnostic_missing';stderr=(Get-Content -Raw $probeErr)}
        $details | ConvertTo-Json -Depth 8 | Set-Content -Encoding UTF8 $diagnostic
    }
    if ($result.probeExit -ne 0 -or $result.probe -ne 'partial') { throw ('desktop_probe_failed: ' + $details.reason) }
    $case = 'windows_project_sandbox::desktop_project_write_cleans_drive_journal'
    $listed = & (Join-Path $bundle 'e2e.exe') $case --exact --list
    if ($LASTEXITCODE -ne 0 -or ($listed | Out-String) -notmatch '1 test, 0 benchmarks') { throw 'desktop_test_not_found' }
    $ErrorActionPreference = 'Continue'
    & (Join-Path $bundle 'e2e.exe') $case --exact --nocapture --test-threads=1 *> (Join-Path $bundle 'desktop-test.log')
    $testExit = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    $result.testExit = $testExit
    $output = Get-Content -Raw (Join-Path $bundle 'desktop-test.log')
    if ($testExit -ne 0 -or $output -notmatch 'test result: ok\. 1 passed; 0 failed') { throw 'desktop_project_write_failed' }
    $result.projectWrite = $true
    $result.journalEmpty = $true
    $result.substUnchanged = $true
    $result.status = 'PASS'
} catch {
    $result.error = $_.Exception.Message
} finally {
    $after = (& reg query HKCU\Software\Classes\butler /s | Out-String)
    $result.registryUnchanged = $before -eq $after
    if (!$result.registryUnchanged) { $result.status='FAIL'; $result.error='registry_changed' }
    Remove-Item -LiteralPath $profile -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force $resultRoot | Out-Null
    $result | ConvertTo-Json -Depth 15 | Set-Content -Encoding UTF8 $resultFile
    if ($result.probeDetails) {
        $details = $result.probeDetails
        Write-Host ('Probe: ' + $details.reason + '; child exit: ' + $details.childExitCode + '; NTSTATUS: ' + $details.childNtstatus)
        if ($details.mxcError) {
            Write-Host ('MXC: ' + $details.mxcError.code + ' ' + $details.mxcError.nativeCode + ' ' + $details.mxcError.message)
        }
    }
    if ($result.error) { Write-Host ('Reason: ' + $result.error) }
    if (Test-Path $diagnostic) { Write-Host ('Diagnostic: ' + $diagnostic) }
    Write-Host $result.status $resultFile
}
if ($result.status -ne 'PASS') { exit 1 }
