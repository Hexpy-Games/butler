# Dev-only desktop acceptance runner. Installed by prepare-windows-sandbox-harness.ps1.
param([Parameter(Mandatory=$true)][string]$Manifest, [ValidateSet('all','normal','timeout','agent-kill')][string]$WfpCase='all')
$ErrorActionPreference = 'Stop'
$Manifest = (Resolve-Path -LiteralPath $Manifest).Path
$bundle = Split-Path -Parent $Manifest
$pins = Get-Content -Raw $Manifest | ConvertFrom-Json
$resultRoot = Join-Path $env:LOCALAPPDATA 'Butler\e2e-results'
$suffix = if ($WfpCase -eq 'all') { '' } else { '.wfp-' + $WfpCase }
$resultFile = Join-Path $resultRoot ($pins.revision + $suffix + '.json')
$diagnostic = Join-Path $resultRoot ($pins.revision + '.diagnostic.json')
$result = @{ diagnostic=$diagnostic; revision=$pins.revision; status='FAIL'; probe=$null; desktop=$null; testExit=$null }
$profile = Join-Path $bundle ('tmp-' + [guid]::NewGuid().ToString('N').Substring(0,8))
function RegistrySnapshot {
    # These are the only registry paths reached by the contained write attempt
    # or by Butler registration. Store hashes, never registry values in evidence.
    $registry = @{}
    foreach ($key in @('HKCU\Software\ButlerSandboxDenied','HKCU\Software\Classes\butler','HKCU\Software\Microsoft\Windows\CurrentVersion\Run')) {
        $previous=$ErrorActionPreference
        $ErrorActionPreference='Continue'
        $text = (& reg query $key /s 2>$null | Out-String)
        $ErrorActionPreference=$previous
        $sha = [Security.Cryptography.SHA256]::Create()
        try { $registry[$key] = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($text))) } finally { $sha.Dispose() }
    }
    return $registry
}
function HostSnapshot {
    $registry = RegistrySnapshot
    # XML pins actions, triggers and settings; LastRunTime is intentionally not
    # part of a task definition and can change independently during this run.
    $tasks = @{}
    foreach ($task in (Get-ScheduledTask -ErrorAction Stop)) {
        $name = $task.TaskPath + $task.TaskName
        $xml = Export-ScheduledTask -TaskName $task.TaskName -TaskPath $task.TaskPath -ErrorAction Stop
        $sha = [Security.Cryptography.SHA256]::Create()
        try { $tasks[$name] = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($xml))) } finally { $sha.Dispose() }
    }
    return @{registry=$registry;tasks=$tasks}
}
function SameMap($a,$b) {
    if ($a.Count -ne $b.Count) { return $false }
    foreach ($key in $a.Keys) { if ($a[$key] -ne $b[$key]) { return $false } }
    return $true
}
function RegistryDiff($a,$b) {
    return @(@($a.Keys) + @($b.Keys) | Sort-Object -Unique | Where-Object { $a[$_] -ne $b[$_] })
}
$before = $null
$result.rows = @(0..16 | ForEach-Object {
    if ($_ -eq 13) { @{row=$_;status='MANUAL_REQUIRED';reason='admin_wfp_diff'} }
    else { @{row=$_;status='FAIL';reason='not_run'} }
})

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
    New-Item -ItemType Directory -Force $profile | Out-Null
    $env:HOME = Join-Path $profile 'home'
    $env:BUTLER_DATA = Join-Path $profile 'data'
    $env:APPDATA = Join-Path $profile 'roaming'
    $env:LOCALAPPDATA = Join-Path $profile 'local'
    $env:TEMP = Join-Path $profile 'temp'
    $env:TMP = $env:TEMP
    New-Item -ItemType Directory -Force $env:HOME,$env:BUTLER_DATA,$env:APPDATA,$env:LOCALAPPDATA,$env:TEMP | Out-Null
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
    $cases = @(
        @(0,'language::language_policy_probe'),
        @(1,'project_boundaries::row01_project_and_scratch'),
        @(2,'project_boundaries::row02_outside_writes'),
        @(3,'project_boundaries::row03_secret_contents_ads_and_parent_delete'),
        @(4,'tools::row04_git'), @(5,'boundaries::row05_credentials'),
        @(6,'boundaries::row06_registry_tasks_wmi'), @(7,'boundaries::row07_alias_escapes'),
        @(8,'project_boundaries::row08_ancestor_sibling_listings'),
        @(9,'boundaries::row09_network'), @(10,'tools::row10_toolchains_unicode_long_path'),
        @(11,'project_write::row11_new_secrets_are_swept'),
        @(12,'project_write::row12_timeout_and_agent_kill'), @(14,'latency::row14_latency'),
        @(15,'access_tiers::auto::auto_works_in_the_project_and_asks_for_risky_steps')
    )
    if ($WfpCase -eq 'normal') { $cases = @($cases | Where-Object { $_[0] -eq 1 }) }
    if ($WfpCase -eq 'timeout') { $cases = ,@(12,'project_write::row12_timeout_cleanup') }
    if ($WfpCase -eq 'agent-kill') { $cases = ,@(12,'project_write::row12_agent_kill_cleanup') }
    foreach ($entry in $cases) {
        $row = [int]$entry[0]
        $case = if ($row -eq 15) { $entry[1] } else { 'windows_sandbox::' + $entry[1] }
        $env:BUTLER_E2E_PERF = if ($row -eq 14) { '1' } else { '0' }
        $log = Join-Path $resultRoot ($pins.revision + $suffix + '.row-' + $row + '.log')
        $rowBefore = RegistrySnapshot
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
                if ($item.exitCode -ne 0 -or $output -notmatch 'test result: ok\. 1 passed; 0 failed' -or $output -match 'SKIP|skipping') { throw 'row_failed' }
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
        $rowAfter = RegistrySnapshot
        $item.finishedUtc = [DateTime]::UtcNow.ToString('o')
        $item.registryBefore = $rowBefore
        $item.registryAfter = $rowAfter
        $item.registryChangedKeys = @(RegistryDiff $rowBefore $rowAfter)
        if ($item.registryChangedKeys.Count -gt 0) {
            $item.testStatus = $item.status
            $item.status='FAIL'; $item.error='host_state_changed_during_row'
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
    Write-Host 'Owner only: open Administrator PowerShell for snapshots; run each test command in a separate NORMAL desktop PowerShell.'
    Write-Host ('$wfp = "' + $resultRoot + '\' + $pins.revision + '.wfp"; New-Item -ItemType Directory -Force $wfp')
    foreach ($phase in @('normal','timeout','agent-kill')) {
        Write-Host ('ADMIN: netsh wfp show filters file="$wfp\before-' + $phase + '.xml"')
        Write-Host ('NORMAL: powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "' + $PSCommandPath + '" -Manifest "' + $Manifest + '" -WfpCase ' + $phase)
        Write-Host ('ADMIN: netsh wfp show filters file="$wfp\after-' + $phase + '.xml"')
    }
    Write-Host 'ADMIN: foreach ($phase in @("normal","timeout","agent-kill")) { $a=[xml](Get-Content -Raw "$wfp\before-$phase.xml"); $b=[xml](Get-Content -Raw "$wfp\after-$phase.xml"); $x=@($a.SelectNodes("//filters/item")); $y=@($b.SelectNodes("//filters/item")); "$phase before=$($x.Count) after=$($y.Count)"; if ($x.Count -eq 0 -or $x.Count -ne $y.Count) { throw "WFP count mismatch or invalid XML" } }'

} catch {
    $result.error = $_.Exception.Message
} finally {
    if ($null -ne $before) {
        try {
            $after = HostSnapshot
            $result.registryBefore = $before.registry
            $result.registryAfter = $after.registry
            $result.registryChangedKeys = @(RegistryDiff $before.registry $after.registry)
            $result.registryUnchanged = SameMap $before.registry $after.registry
            $result.scheduledTasksUnchanged = SameMap $before.tasks $after.tasks
            if (!$result.registryUnchanged -or !$result.scheduledTasksUnchanged) {
                $result.status='FAIL'; $result.error='host_state_changed'
                # Preserve row results: a global interval does not identify its writer.
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
