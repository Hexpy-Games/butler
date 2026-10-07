# Reproduce the original writer; compare its display parser with actual SIDs.
$ErrorActionPreference = 'Stop'
$env:HOME = Join-Path $env:PREVIEW_ROOT ([guid]::NewGuid())
$env:BUTLER_DATA = Join-Path $env:PREVIEW_ROOT ([guid]::NewGuid())
New-Item -ItemType Directory $env:HOME,$env:BUTLER_DATA | Out-Null
$nested = "$env:BUTLER_DATA/a/b"
New-Item -ItemType Directory -Force $nested | Out-Null
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$ErrorActionPreference = 'Continue'
& "$env:SystemRoot/System32/icacls.exe" "$env:BUTLER_DATA/a" /inheritance:r /grant:r "*${sid}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' | Out-Null
$ErrorActionPreference = 'Stop'
if ($LASTEXITCODE -ne 0) { throw 'Original ACL grant failed' }
$acl = Get-Acl -LiteralPath $nested
$owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
$rules = $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])
$unexpected = @($rules | Where-Object { $_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Value -notin @($sid,'S-1-5-18') })
$ErrorActionPreference = 'Continue'
$display = & "$env:SystemRoot/System32/icacls.exe" $nested
$ErrorActionPreference = 'Stop'
if ($LASTEXITCODE -ne 0) { throw 'Original ACL inspection failed' }
$account = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$displayPrivate = $true
foreach ($line in $display) {
    $line = $line.Trim()
    if ($line.StartsWith($nested)) { $line = $line.Substring($nested.Length).Trim() }
    $separator = $line.IndexOf(':(')
    if ($separator -ge 0) {
        $who = $line.Substring(0,$separator).Trim()
        if ($who -notin @($account,$sid,'NT AUTHORITY\SYSTEM','S-1-5-18')) { $displayPrivate = $false }
    }
}
"Original writer: ownerMatches=$($owner -eq $sid), unexpectedAllowACEs=$($unexpected.Count), displayChecker=$displayPrivate, SDDL=$($acl.Sddl)" |
    Tee-Object "$env:PREVIEW_ROOT/logs/acl-diagnosis.log"
$env:BUTLER_ACL_PATH = Join-Path $env:HOME 'protected'
$env:BUTLER_ACL_OPERATION = 'protect'
New-Item -ItemType Directory $env:BUTLER_ACL_PATH | Out-Null
$script = Get-Content "$PSScriptRoot/../packages/butler-agent/rust/crates/butler-platform/src/secure_fs/windows/acl.ps1" -Raw
$ErrorActionPreference = 'Continue'
& "$env:SystemRoot/System32/WindowsPowerShell/v1.0/powershell.exe" -NoLogo -NoProfile -NonInteractive -Command $script 2>&1 |
    Tee-Object "$env:PREVIEW_ROOT/logs/acl-apply-diagnosis.log"
$ErrorActionPreference = 'Stop'
if ($LASTEXITCODE -ne 0) { throw 'Private ACL application failed; see acl-apply-diagnosis.log' }
$child = Join-Path $env:BUTLER_ACL_PATH 'inherited'
New-Item -ItemType File $child | Out-Null
$acl = Get-Acl -LiteralPath $child
$rules = $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])
$unexpected = @($rules | Where-Object { $_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Value -ne $sid })
"Protected child: ownerMatches=$($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -eq $sid), nonUserAllowACEs=$($unexpected.Count), SDDL=$($acl.Sddl)" |
    Tee-Object -Append "$env:PREVIEW_ROOT/logs/acl-diagnosis.log"
if ($unexpected.Count) { throw 'Protected child inherited a non-user Allow ACE' }
# Preserve the old per-call implementation as a measured baseline. Every
# invocation targets only the job's fresh profile; no registry is involved.
$timer = [Diagnostics.Stopwatch]::StartNew()
for ($index = 0; $index -lt 16; $index++) {
    $env:BUTLER_ACL_PATH = Join-Path $env:HOME "legacy-$index.txt"
    $content = "complete record $index"
    [IO.File]::WriteAllText($env:BUTLER_ACL_PATH, $content)
    $env:BUTLER_ACL_OPERATION = 'protect'
    $ErrorActionPreference = 'Continue'
    & "$env:SystemRoot/System32/WindowsPowerShell/v1.0/powershell.exe" -NoLogo -NoProfile -NonInteractive -Command $script
    $ErrorActionPreference = 'Stop'
    if ($LASTEXITCODE -ne 0) { throw 'Legacy protection failed' }
    $env:BUTLER_ACL_OPERATION = 'inspect'
    $ErrorActionPreference = 'Continue'
    $private = & "$env:SystemRoot/System32/WindowsPowerShell/v1.0/powershell.exe" -NoLogo -NoProfile -NonInteractive -Command $script
    $ErrorActionPreference = 'Stop'
    if ($LASTEXITCODE -ne 0 -or $private -ne 'True') { throw 'Legacy inspection did not report private content' }
    if ([IO.File]::ReadAllText($env:BUTLER_ACL_PATH) -ne $content) { throw 'Legacy file content changed' }
}
$timer.Stop()
"Legacy per-call PowerShell ACL baseline: 16 complete files, 16 protects, 16 inspections, $($timer.Elapsed.TotalMilliseconds)ms" |
    Tee-Object -Append "$env:PREVIEW_ROOT/logs/acl-diagnosis.log"
