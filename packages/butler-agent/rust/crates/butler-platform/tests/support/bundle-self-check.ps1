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
    foreach ($case in @('bundle::every_row_setup_from_bundle',
        'bundle::desktop_request_protocol', 'preparation::admission_preserves_tool_search_paths', 'project_write::row16_non_interactive_asks')) {
        Invoke-BundleTest $Bundle ('windows_sandbox::' + $case) (Join-Path $Evidence ($case.Replace('::','-') + '.log'))
    }
    @{revision=$pins.revision;status='PASS';rows=@(0..12)+@(14,15,16);
        qualification='Setup and SSH only; interactive matrix pending';sourceWorkspaceAbsent=$true} |
        ConvertTo-Json -Depth 4 | Set-Content -Encoding UTF8 (Join-Path $Evidence 'self-check.json')
    Write-Host "$($pins.revision) bundle self-check PASS"
} finally {
    Remove-Item -LiteralPath $profile -Recurse -Force -ErrorAction SilentlyContinue
}
