# Signs a copy of the supplied MSIX with a certificate created in the job,
# installs it and checks Store-build behaviour against the unpacked App.
# Trusts a certificate and installs a package: disposable GitHub-hosted runners only.
param([Parameter(Mandatory)][string]$AppDir, [Parameter(Mandatory)][string]$Msix, [Parameter(Mandatory)][string]$Out)
if ($env:RUNNER_ENVIRONMENT -ne 'github-hosted') { throw 'MSIX verification requires a disposable GitHub-hosted runner' }
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$Out = [IO.Path]::GetFullPath($Out)
$Work = Join-Path $env:RUNNER_TEMP ('butler-msix-check-' + [guid]::NewGuid())
New-Item -ItemType Directory -Force $Out, $Work | Out-Null
$script:Failures = 0
$id = Get-Content -Raw "$PSScriptRoot\identity.json" | ConvertFrom-Json
$Identity = $id.name
$Data = "$env:USERPROFILE\.butler"

function Check([string]$Name, [bool]$Ok, [string]$Detail) {
    $label = if ($Ok) { 'PASS' } else { $script:Failures++; 'FAIL' }
    $line = "${label} ${Name}: $Detail"
    Add-Content -LiteralPath "$Out\results.txt" -Value $line
    Write-Host $line
}
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices; using System.Text;
public static class PkgId {
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern int GetPackageFullName(IntPtr h, ref uint len, StringBuilder name);
    public static string OfPid(int pid) {
        IntPtr h = OpenProcess(0x1000, false, pid);
        if (h == IntPtr.Zero) return "";
        try { uint len = 512; var sb = new StringBuilder(512); return GetPackageFullName(h, ref len, sb) == 0 ? sb.ToString() : ""; }
        finally { CloseHandle(h); }
    }
}
"@
function Get-Tree([int[]]$Roots) {
    $all = @(Get-CimInstance Win32_Process)
    $ids = New-Object 'System.Collections.Generic.HashSet[int]'
    foreach ($id in $Roots) { [void]$ids.Add($id) }
    do {
        $added = $false
        foreach ($p in $all) {
            if ($ids.Contains([int]$p.ParentProcessId) -and $ids.Add([int]$p.ProcessId)) { $added = $true }
        }
    } while ($added)
    $all | Where-Object { $ids.Contains([int]$_.ProcessId) }
}
function Wait-Until([scriptblock]$Cond, [int]$Seconds) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    do {
        if (& $Cond) { return $true }
        Start-Sleep -Seconds 1
    } while ((Get-Date) -lt $deadline)
    return $false
}
function Invoke-InPackage([string]$Name, [string]$CommandLine) {
    Set-Content -LiteralPath "$Work\$Name.cmd" -Encoding ASCII -Value @"
@echo off
$CommandLine > "$Out\$Name.out" 2>&1
echo %ERRORLEVEL%> "$Out\$Name.exit"
"@
    Invoke-CommandInDesktopPackage -PackageFamilyName $pfn -AppId Butler -Command "$env:SystemRoot\System32\cmd.exe" -Args "/c `"$Work\$Name.cmd`""
    if (-not (Wait-Until { Test-Path "$Out\$Name.exit" } 120)) { return @{ exit = -1; out = '' } }
    return @{ exit = [int](Get-Content "$Out\$Name.exit" -Raw); out = (Get-Content "$Out\$Name.out" -Raw) }
}
function Read-Token { (Get-Content "$Data\app\runtime\auth\local-agent-auth.json" -Raw | ConvertFrom-Json).token }
function Get-Gateway($Tree) {
    $ids = @($Tree | Where-Object { $_.Name -eq 'butler-agent.exe' } | ForEach-Object { [int]$_.ProcessId })
    Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
        Where-Object { $ids -contains [int]$_.OwningProcess } | Select-Object -ExpandProperty LocalPort -Unique
}
function Find-SdkTool([string]$Name) {
    $hit = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\10.*\x64\$Name" -ErrorAction SilentlyContinue |
        Sort-Object { [version]$_.Directory.Parent.Name } -Descending | Select-Object -First 1
    if (-not $hit) { throw "$Name not found in the Windows SDK" }
    $hit.FullName
}

Copy-Item -LiteralPath $Msix -Destination "$Work\Butler.msix"
$cert = New-SelfSignedCertificate -Type Custom -Subject $id.publisher -KeyUsage DigitalSignature `
    -FriendlyName 'Butler store check' -CertStoreLocation 'Cert:\CurrentUser\My' `
    -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3', '2.5.29.19={text}')
Export-Certificate -Cert $cert -FilePath "$Work\store-check.cer" | Out-Null
Import-Certificate -FilePath "$Work\store-check.cer" -CertStoreLocation 'Cert:\LocalMachine\TrustedPeople' | Out-Null
& (Find-SdkTool 'signtool.exe') sign /fd SHA256 /sha1 $cert.Thumbprint /s My "$Work\Butler.msix"
if ($LASTEXITCODE -ne 0) { throw "MSIX signing exited $LASTEXITCODE" }
Add-AppxPackage -Path "$Work\Butler.msix"
$pkg = Get-AppxPackage -Name $Identity
$pfn = $pkg.PackageFamilyName
$Install = $pkg.InstallLocation
$Agent = "$Install\resources\bundled-agent\bin\butler-agent.exe"
$unpackagedIds = @()
try {
    $unpackaged = Start-Process "$AppDir\Butler.exe" -PassThru -RedirectStandardOutput "$Out\unpackaged-stdout.txt" -RedirectStandardError "$Out\unpackaged-stderr.txt"
    $unpackagedIds = @($unpackaged.Id)
    if (-not (Wait-Until { Get-Gateway (Get-Tree @($unpackaged.Id)) } 180)) { throw 'Unpackaged App gateway did not start' }
    Start-Process "shell:AppsFolder\$pfn!Butler"
    Start-Sleep -Seconds 30
    $packaged = @(Get-CimInstance Win32_Process | Where-Object { [PkgId]::OfPid([int]$_.ProcessId) -eq $pkg.PackageFullName })
    Check 'second_instance_refused' ($packaged.Count -eq 0 -and $null -ne (Get-Process -Id $unpackaged.Id -ErrorAction SilentlyContinue)) 'package identity absent; unpackaged App still running'
    $unpackagedIds = @(Get-Tree @($unpackaged.Id) | ForEach-Object { [int]$_.ProcessId })
    $unpackagedIds | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }
    if (-not (Wait-Until { @(Get-Process -Id $unpackagedIds -ErrorAction SilentlyContinue).Count -eq 0 } 30)) { throw 'Unpackaged tree did not stop' }

    Set-Content -LiteralPath "$Work\applaunch.cmd" -Encoding ASCII -Value "@echo off`r`n`"$Install\Butler.exe`" > `"$Out\app-stdout.txt`" 2>&1"
    Invoke-CommandInDesktopPackage -PackageFamilyName $pfn -AppId Butler -Command "$env:SystemRoot\System32\cmd.exe" -Args "/c `"$Work\applaunch.cmd`""
    $listening = Wait-Until {
        $tree = @(Get-CimInstance Win32_Process | Where-Object { [PkgId]::OfPid([int]$_.ProcessId) -eq $pkg.PackageFullName })
        Get-Gateway $tree
    } 180
    # The Agent listens on more than one port; the gateway is the one whose authenticated /health answers.
    $headers = @{}
    try { $headers = @{ Authorization = 'Bearer ' + (Read-Token) } } catch { Write-Host "check error: $($_.Exception.Message)" }
    $script:port = $null
    $healthy = Wait-Until {
        foreach ($candidate in @(Get-Gateway @(Get-CimInstance Win32_Process | Where-Object { [PkgId]::OfPid([int]$_.ProcessId) -eq $pkg.PackageFullName }))) {
            try {
                $health = Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 -Uri "http://127.0.0.1:$candidate/health" -Headers $headers
                if ($health.StatusCode -eq 200) { $script:port = $candidate; return $true }
            } catch { }
        }
        $false
    } 120
    $port = $script:port
    Check 'app_agent_gateway_start' ($listening -and $healthy) "gateway port=$port; authenticated health=$healthy"
    $updatesOk = $false
    $statesOk = $false
    $refused = $false
    $component = $null
    $applyCode = $null
    try {
        $base = "http://127.0.0.1:$port"
        $post = Invoke-RestMethod -TimeoutSec 10 -Uri "$base/updates/check" -Method Post -Headers $headers -ContentType 'application/json' -Body '{"component":"app"}'
        $component = $post.data.components[0]
        $statesOk = $component.updater_owner -eq 'store' -and $component.check_state -eq 'unavailable' -and $component.check_error -eq 'update_store_unassociated' -and $component.update_available -eq $false
        try { $null = Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 -Uri "$base/updates/apply" -Method Post -Headers $headers -ContentType 'application/json' -Body '{"component":"app"}' }
        catch {
            # Windows PowerShell keeps the error response body in ErrorDetails.
            $applyCode = ($_.ErrorDetails.Message | ConvertFrom-Json).error.code
            $refused = $applyCode -in @('update_store_unassociated')
        }
        $updatesOk = $statesOk -and $refused
    } catch { Write-Host "check error: $($_.Exception.Message)" }
    Check 'updates_ask_the_store' $updatesOk "owner=$($component.updater_owner); state=$($component.check_state); error=$($component.check_error); available=$($component.update_available); apply=$applyCode"
    Start-Sleep -Seconds 20
    Check 'no_update_check_or_stage' (-not (Test-Path "$Data\updates\staged") -and -not (Test-Path "$Data\updates\artifacts") -and -not (Test-Path "$Data\updates\app-install.log")) 'no staged directory, artifacts or activation helper log'
    $links = @(Get-ChildItem "$Install\resources\bundled-agent\bin" -File | Where-Object { $_.Name -like 'butler-agent (*).exe' })
    $logs = @((Get-Item "$Out\app-stdout.txt" -ErrorAction SilentlyContinue)) + @(Get-ChildItem "$Data\logs" -Recurse -File -ErrorAction SilentlyContinue)
    $roleLines = @($logs | Select-String -Pattern 'process role link')
    Check 'no_role_links' ($links.Count -eq 0 -and $roleLines.Count -eq 0) 'no role executables or process role link log lines'
} finally {
    $ids = @($unpackagedIds) + @(Get-CimInstance Win32_Process | Where-Object { [PkgId]::OfPid([int]$_.ProcessId) -eq $pkg.PackageFullName } | ForEach-Object { [int]$_.ProcessId })
    $ids | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }
    if ($ids.Count -gt 0 -and -not (Wait-Until { @(Get-Process -Id $ids -ErrorAction SilentlyContinue).Count -eq 0 } 30)) { throw 'App processes did not stop' }
}

$prefix = "`"$Agent`" --installation-root `"$Install`" --resource-root `"$Install\resources\bundled-agent\resources`""
$roleOk = $false
$stopOk = $false
try {
    $start = Invoke-InPackage 'start' "$prefix start --data `"$Work\role-data`" --json"
    $restart = Invoke-InPackage 'restart' "$prefix restart --data `"$Work\role-data`" --json"
    $stop = Invoke-InPackage 'stop' "$prefix stop --data `"$Work\role-data`" --json"
    $stopOk = $stop.exit -eq 0
    $startJson = $start.out | ConvertFrom-Json
    $restartJson = $restart.out | ConvertFrom-Json
    $roleOk = $start.exit -eq 0 -and $restart.exit -eq 0 -and $null -ne $startJson -and $null -ne $restartJson -and (Test-Path "$Work\role-data\logs\butler-agent-service.stdout.log")
} catch { Write-Host "check error: $($_.Exception.Message)" }
Check 'restart_role_runs' $roleOk 'start/restart JSON succeeded and restart handoff log exists'
Check 'stop' $stopOk 'package-context stop exited zero'

$ok = $false
try { $r = Invoke-InPackage 'st-read' "`"$Agent`" --package-startup-task"; $ok = $r.exit -eq 0 -and ($r.out | ConvertFrom-Json).state -eq 'disabled' } catch { Write-Host "check error: $($_.Exception.Message)" }
Check 'startup_task_read' $ok 'initial state disabled'
$ok = $false
try { $r = Invoke-InPackage 'st-enable' "`"$Agent`" --package-startup-task enable"; $ok = $r.exit -eq 0 -and ($r.out | ConvertFrom-Json).state -eq 'enabled' } catch { Write-Host "check error: $($_.Exception.Message)" }
Check 'startup_task_enable' $ok 'state enabled'
$ok = $false
try {
    $key = "HKCU:\Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppModel\SystemAppData\$pfn\ButlerStartup"
    $state = Get-ItemPropertyValue -LiteralPath $key -Name State
    Set-Content -LiteralPath "$Out\startup-task-registry.txt" -Value "State=$state"
    Set-ItemProperty -LiteralPath $key -Name State -Value 1
    $r = Invoke-InPackage 'st-read2' "`"$Agent`" --package-startup-task"
    $ok = $r.exit -eq 0 -and ($r.out | ConvertFrom-Json).state -eq 'disabled_by_user'
} catch { Write-Host "check error: $($_.Exception.Message)" }
Check 'startup_task_user_off_visible' $ok 'outside user-off registry change reads disabled_by_user'
$ok = $false
try { $r = Invoke-InPackage 'st-disable' "`"$Agent`" --package-startup-task disable"; $ok = $r.exit -eq 0 -and ($r.out | ConvertFrom-Json).state.StartsWith('disabled') } catch { Write-Host "check error: $($_.Exception.Message)" }
Check 'startup_task_disable' $ok 'state starts with disabled'

$guid = [guid]::NewGuid().ToString()
$folder = "$env:APPDATA\ButlerStoreCheck-$guid"
$ok = $false
try {
    $r = Invoke-InPackage 'shell-write' "cmd /c `"mkdir `"%APPDATA%\ButlerStoreCheck-$guid`" && echo x> `"%APPDATA%\ButlerStoreCheck-$guid\x.txt`" && reg add HKCU\Software\ButlerStoreCheck /v probe /t REG_SZ /d $guid /f`""
    $ok = $r.exit -eq 0 -and (Test-Path "$folder\x.txt") -and (Get-ItemPropertyValue 'HKCU:\Software\ButlerStoreCheck' -Name probe) -eq $guid
} catch { Write-Host "check error: $($_.Exception.Message)" }
Check 'shell_writes_visible_outside' $ok 'AppData file and HKCU probe visible outside package'
Remove-AppxPackage -Package $pkg.PackageFullName
$ok = $false
try { $ok = (Test-Path "$folder\x.txt") -and (Get-ItemPropertyValue 'HKCU:\Software\ButlerStoreCheck' -Name probe) -eq $guid } catch { Write-Host "check error: $($_.Exception.Message)" }
Check 'shell_writes_survive_uninstall' $ok 'AppData file and HKCU probe remain after uninstall'
Get-Content -LiteralPath "$Out\results.txt" | Write-Host
if ($script:Failures -gt 0) { exit 1 }
