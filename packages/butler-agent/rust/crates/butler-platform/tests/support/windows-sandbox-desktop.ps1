# Dev-only desktop acceptance runner. Copied by prepare-windows-sandbox-harness.ps1.
param([Parameter(Mandatory=$true)][string]$Manifest, [string]$Bundle, [ValidateSet('all','normal','timeout','agent-kill')][string]$WfpCase='all')
$ErrorActionPreference = 'Stop'
$Manifest = (Resolve-Path -LiteralPath $Manifest).Path
if (!$Bundle) { $Bundle = Split-Path -Parent $Manifest }
$bundle = (Resolve-Path -LiteralPath $Bundle).Path
. (Join-Path $PSScriptRoot 'bundle-common.ps1')
$pins = Get-Content -Raw $Manifest | ConvertFrom-Json
$resultRoot = Join-Path $env:LOCALAPPDATA 'Butler\e2e-results'
$suffix = if ($WfpCase -eq 'all') { '' } else { '.wfp-' + $WfpCase }
$resultFile = Join-Path $resultRoot ($pins.revision + $suffix + '.json')
$diagnostic = Join-Path $resultRoot ($pins.revision + '.diagnostic.json')
$result = @{ startedUtc=[DateTime]::UtcNow.ToString('o'); diagnostic=$diagnostic; revision=$pins.revision; status='FAIL'; probe=$null; desktop=$null; testExit=$null }
$profile = Join-Path ([IO.Path]::GetTempPath()) ('b-' + [guid]::NewGuid().ToString('N').Substring(0,8))
$installedApp = Join-Path $env:LOCALAPPDATA 'butler-app\Butler.exe'
$script:installedProtocolHash = $null
$before = $null
$result.rows = @(0..17 | ForEach-Object {
    if ($_ -eq 13) { @{row=$_;status='MANUAL_REQUIRED';reason='admin_wfp_diff'} }
    else { @{row=$_;status='FAIL';reason='not_run'} }
})

try {
    $null = Read-BundlePins $Manifest $bundle $pins.revision
    . (Join-Path $bundle 'windows-host-snapshot.ps1')
    # whoami supplies the integrity SID; refuse anything other than Medium IL.
    $groups = (& whoami /groups | Out-String)
    if ($groups -notmatch 'S-1-16-8192\b' -or $groups -match 'S-1-16-(12288|16384)\b') {
        $result.status = 'REFUSED'
        throw 'medium_integrity_required'
    }
    Set-BundleEnvironment $bundle $profile
    Remove-Item Env:BUTLER_E2E_SETUP_ONLY -ErrorAction SilentlyContinue
    Add-Type -TypeDefinition (Get-Content -Raw (Join-Path $bundle 'windows-registry-snapshot.cs'))
    if (Test-Path -LiteralPath $installedApp -PathType Leaf) {
        $script:installedProtocolHash = InstalledProtocolHash $installedApp
    }
    Remove-Item Env:BUTLER_WINDOWS_PROJECT_SANDBOX -ErrorAction SilentlyContinue
    $env:BUTLER_APP_DISABLE_SHELL_REGISTRATION = '1'
    $env:BUTLER_E2E_WINDOWS_POLICY_PROBE = Join-Path $profile 'windows-policy-probe.exe'
    Add-Type -TypeDefinition (Get-Content -Raw (Join-Path $bundle 'windows-policy-probe.cs')) -OutputAssembly $env:BUTLER_E2E_WINDOWS_POLICY_PROBE -OutputType ConsoleApplication
    $env:BUTLER_E2E_TIER = 'stub'
    $env:BUTLER_E2E_RECORD = '0'
    $env:BUTLER_E2E_WINDOWS_SANDBOX_DESKTOP = '1'
    $env:BUTLER_E2E_SKIP_BUILD = '1'
    $env:BUTLER_E2E_BIN = Join-Path $bundle 'butler-agent.exe'
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
            if (!$child.HasExited) { & taskkill /pid $child.Id /t /f | Out-Null }
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
    $before = HostSnapshot
    . (Join-Path $bundle 'windows-sandbox-cases.ps1')
    $cases = @(Get-MatrixCases)
    if ($WfpCase -eq 'normal') { $cases = @($cases | Where-Object { $_[0] -eq 1 }) }
    if ($WfpCase -eq 'timeout') { $cases = ,@(12,'project_write::row12_timeout_cleanup') }
    if ($WfpCase -eq 'agent-kill') { $cases = ,@(12,'project_write::row12_agent_kill_cleanup') }
    foreach ($entry in $cases) {
        $row = [int]$entry[0]
        $case = if ($row -eq 15) { $entry[1] } else { 'windows_sandbox::' + $entry[1] }
        $env:BUTLER_E2E_PERF = if ($row -eq 14) { '1' } else { '0' }
        $env:BUTLER_DEBUG_SANDBOX_TIMINGS = if ($row -eq 14) { '1' } else { '0' }
        $log = Join-Path $resultRoot ($pins.revision + $suffix + '.row-' + $row + '.log')
        $rowBefore = HostSnapshot
        $item = @{row=$row;status='FAIL';test=$case;log=$log;startedUtc=[DateTime]::UtcNow.ToString('o')}
        try {
            $listed = & (Join-Path $bundle 'e2e.exe') $case --exact --list
            if ($LASTEXITCODE -ne 0 -or ($listed | Out-String) -notmatch '1 test, 0 benchmarks') { throw 'test_not_found' }
            $child = $null
            try {
                $out = Join-Path $profile ('row-' + $row + '.stdout')
                $err = Join-Path $profile ('row-' + $row + '.stderr')
                $child = Start-Process -FilePath (Join-Path $bundle 'e2e.exe') -ArgumentList @($case,'--exact','--nocapture','--test-threads=1') -NoNewWindow -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
                $null = $child.Handle
                if (!$child.WaitForExit(600000)) { throw 'row_runner_timeout' }
                $child.WaitForExit()
                $item.exitCode = $child.ExitCode
                $output = (Get-Content -Raw $out) + "`n" + (Get-Content -Raw $err)
                $output | Set-Content -Encoding UTF8 $log
                if ($row -eq 0) {
                    $matrixLine=@($output -split "`r?`n" | Where-Object { $_.StartsWith('WINDOWS_LANGUAGE_MATRIX=') })
                    if ($matrixLine.Count -ne 1) { throw 'language_matrix_missing' }
                    $item.languageMatrix=$matrixLine[0].Substring('WINDOWS_LANGUAGE_MATRIX='.Length) | ConvertFrom-Json
                }
                if ($item.exitCode -ne 0 -or $output -notmatch 'test result: ok\. 1 passed; 0 failed' -or $output -match 'SKIP|skipping|BUNDLE_SETUP_COMPLETE') { throw 'row_failed' }
                if ($row -eq 14 -and $output -notmatch 'Windows MXC added p50 latency.*enforced=true') { throw 'latency_budget_not_enforced' }
                if ($row -eq 15 -and $output -notmatch 'contained=true authority_count=0') { throw 'permission_card_appeared' }
                $item.status = 'PASS'
            } finally {
                if ($null -ne $child) {
                    if (!$child.HasExited) { & taskkill /pid $child.Id /t /f | Out-Null }
                    $child.Dispose()
                }
            }
        } catch { $item.error = $_.Exception.Message }
        $rowAfter = HostSnapshot
        $item.finishedUtc = [DateTime]::UtcNow.ToString('o')
        $item.registryBefore = $rowBefore.registry
        $item.registryAfter = $rowAfter.registry
        $changes = HostChanges $rowBefore $rowAfter
        $item.registryChanges = $changes.registry
        $item.registryChangedKeys = @($changes.registry | ForEach-Object { $_.name })
        $item.scheduledTaskChanges = $changes.tasks
        if ($changes.unattributed) {
            $item.testStatus = $item.status
            $item.status='FAIL'; $item.error='unattributed_host_state_changed_during_row'
        }
        $result.rows = @($result.rows | Where-Object { $_.row -ne $row }) + @($item)
        Write-Host ('Row ' + $row + ': ' + $item.status)
    }
    $result.rows = @($result.rows | Where-Object { $_.row -ne 16 })
    $ssh = Join-Path $bundle 'ssh-row16.json'
    if (Test-Path $ssh) {
        $row16 = Get-Content -Raw $ssh | ConvertFrom-Json
        if ($row16.revision -eq $pins.revision -and $row16.status -eq 'PASS') {
            $result.rows += @{row=16;status='PASS';surface='SSH';evidence=$ssh}
        } else { $result.rows += @{row=16;status='FAIL';reason='ssh_evidence_mismatch'} }
    } else { $result.rows += @{row=16;status='FAIL';reason='ssh_evidence_missing'} }
    if (@($result.rows | Where-Object { $_.status -eq 'FAIL' -and ($WfpCase -eq 'all' -or $_.reason -ne 'not_run') }).Count -eq 0) { $result.status='PASS' }
    $result.qualification = 'Row 13 requires owner admin WFP comparison'

} catch {
    $result.error = $_.Exception.Message
} finally {
    if ($null -ne $before) {
        try {
            $after = HostSnapshot
            $result.registryBefore = $before.registry
            $result.registryAfter = $after.registry
            $changes = HostChanges $before $after
            $result.registryChanges = $changes.registry
            $result.registryChangedKeys = @($changes.registry | ForEach-Object { $_.name })
            $result.registryUnchanged = $changes.registry.Count -eq 0
            $result.scheduledTaskChanges = $changes.tasks
            $result.scheduledTasksUnchanged = $changes.tasks.Count -eq 0
            if ($changes.unattributed) {
                $result.status='FAIL'; $result.error='unattributed_host_state_changed'
            }
        } catch { $result.status='FAIL'; $result.error='host_snapshot_failed: ' + $_.Exception.Message }
    }
    New-Item -ItemType Directory -Force $resultRoot | Out-Null
    $log = Join-Path $bundle 'desktop-test.log'
    if ($result.testExit -ne $null -and (Test-Path $log)) {
        $result.testLog = Join-Path $resultRoot ($pins.revision + '.desktop-test.log')
        Copy-Item -LiteralPath $log -Destination $result.testLog -Force
    }
    if ($result.status -eq 'PASS') {
        Remove-Item -LiteralPath $profile -Recurse -Force -ErrorAction SilentlyContinue
    } elseif (Test-Path $profile) {
        $result.failureDirectory = $profile
        Write-Host ('Failure directory: ' + $profile)
    }
    $result.rows = @($result.rows | Sort-Object row)
    $json = $result | ConvertTo-Json -Depth 20
    $null = $json | ConvertFrom-Json
    $json | Set-Content -Encoding UTF8 $resultFile
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
