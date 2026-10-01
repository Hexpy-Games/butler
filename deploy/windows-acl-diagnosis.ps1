# Reproduce the original writer; compare its display parser with actual SIDs.
$ErrorActionPreference = 'Stop'
$env:HOME = Join-Path $env:PREVIEW_ROOT ([guid]::NewGuid())
$env:BUTLER_DATA = Join-Path $env:PREVIEW_ROOT ([guid]::NewGuid())
New-Item -ItemType Directory $env:HOME,$env:BUTLER_DATA | Out-Null
$nested = "$env:BUTLER_DATA/a/b"
New-Item -ItemType Directory -Force $nested | Out-Null
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
& "$env:SystemRoot/System32/icacls.exe" "$env:BUTLER_DATA/a" /inheritance:r /grant:r "*${sid}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Original ACL grant failed' }
$acl = Get-Acl -LiteralPath $nested
$owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
$rules = $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])
$unexpected = @($rules | Where-Object { $_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Value -notin @($sid,'S-1-5-18') })
$display = & "$env:SystemRoot/System32/icacls.exe" $nested
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
& "$env:SystemRoot/System32/WindowsPowerShell/v1.0/powershell.exe" -NoLogo -NoProfile -NonInteractive -Command $script 2>&1 |
    Tee-Object "$env:PREVIEW_ROOT/logs/acl-apply-diagnosis.log"
if ($LASTEXITCODE -ne 0) { throw 'Private ACL application failed; see acl-apply-diagnosis.log' }
