# Only job-owned profile directories are removed; persistent caches survive.
$ErrorActionPreference = 'Stop'
if (!$env:OWNER_JOB_ROOT) { throw 'Missing owner job isolation root' }
try {
    & sccache --stop-server
    # No server is also normal if compilation never started.
    $before = Get-Content "$env:OWNER_JOB_ROOT/protocol.json" -Raw | ConvertFrom-Json
    $after = & reg query 'HKCU\Software\Classes\butler' /s 2>&1 | Out-String
    $code = $LASTEXITCODE
    if ($code -ne $before.code -or $after -cne $before.text) {
        throw 'Owner butler protocol registration changed during the build job'
    }
} finally {
    Remove-Item $env:OWNER_JOB_ROOT -Recurse -Force
}
exit 0
