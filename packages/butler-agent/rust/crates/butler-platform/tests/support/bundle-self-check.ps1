param([Parameter(Mandatory=$true)][string]$Manifest,
    [Parameter(Mandatory=$true)][string]$Bundle,
    [Parameter(Mandatory=$true)][string]$Evidence)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'bundle-common.ps1')
$Bundle = (Resolve-Path -LiteralPath $Bundle).Path
$pins = Get-Content -LiteralPath $Manifest -Raw | ConvertFrom-Json
$null = Read-BundlePins $Manifest $Bundle $pins.revision
New-Item -ItemType Directory -Force $Evidence | Out-Null
$profile = Join-Path (Split-Path $Bundle -Parent) ('b-' + [guid]::NewGuid().ToString('N').Substring(0,8))
try {
    Set-BundleEnvironment $Bundle $profile
    Remove-Item Env:BUTLER_E2E_WINDOWS_SANDBOX_DESKTOP -ErrorAction SilentlyContinue
    # Deliberately poison source lookup: only shipped inputs may satisfy setup.
    $env:BUTLER_E2E_WORKSPACE_ROOT = Join-Path $profile 'absent-build-workspace'
    $env:BUTLER_E2E_WINDOWS_POLICY_PROBE = Join-Path $profile 'windows-policy-probe.exe'
    Add-Type -TypeDefinition (Get-Content -Raw (Join-Path $Bundle 'windows-policy-probe.cs')) `
        -OutputAssembly $env:BUTLER_E2E_WINDOWS_POLICY_PROBE -OutputType ConsoleApplication
    . (Join-Path $Bundle 'windows-sandbox-cases.ps1')
    $env:BUTLER_E2E_SETUP_ONLY = '1'
    foreach ($entry in Get-MatrixCases) {
        $case = if ($entry[0] -eq 15) { $entry[1] } else { 'windows_sandbox::' + $entry[1] }
        $log = Join-Path $Evidence ('row-' + $entry[0] + '-setup.log')
        Invoke-BundleTest $Bundle $case $log
        if ((Get-Content -Raw $log) -notmatch 'BUNDLE_SETUP_COMPLETE') { throw ('setup_boundary_missing: ' + $case) }
        Write-Host ('Row ' + $entry[0] + ': SETUP_PASS')
    }
    Remove-Item Env:BUTLER_E2E_SETUP_ONLY
    foreach ($case in @('bundle::desktop_request_protocol',
        'preparation::admission_preserves_tool_search_paths', 'project_write::row16_non_interactive_asks')) {
        Invoke-BundleTest $Bundle ('windows_sandbox::' + $case) (Join-Path $Evidence ($case.Replace('::','-') + '.log'))
    }
    @{revision=$pins.revision;status='PASS';rows=@(0..12)+@(14,15,16);
        qualification='Setup and SSH only; interactive matrix pending';sourceWorkspaceAbsent=$true} |
        ConvertTo-Json -Depth 4 | Set-Content -Encoding UTF8 (Join-Path $Evidence 'self-check.json')
    Write-Host "$($pins.revision) bundle self-check PASS"
} finally {
    Remove-Item -LiteralPath $profile -Recurse -Force -ErrorAction SilentlyContinue
}
