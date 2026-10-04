# Only job-owned profile directories are removed; persistent caches survive.
$ErrorActionPreference = 'Stop'
if (!$env:OWNER_JOB_ROOT) { throw 'Missing owner job isolation root' }
try {
    & sccache --stop-server
    # No server is also normal if compilation never started.
    & "$PSScriptRoot/windows-protocol-snapshot.ps1" -Output "$env:OWNER_JOB_ROOT/protocol-after.json"
    $before = Get-Content "$env:OWNER_JOB_ROOT/protocol-before.json" -Raw
    $after = Get-Content "$env:OWNER_JOB_ROOT/protocol-after.json" -Raw
    if ($after -cne $before) {
        throw "Owner protocol registration changed: before=$before after=$after"
    }
    if ($env:OWNER_DELETE_TASK_CACHES -eq '1') {
        # Final captain-only dispatch: preserve shared release/ORT caches.
        foreach ($name in @('captain-p9', 'captain-p10', 'captain-p9-finish')) {
            $path = Join-Path 'C:\Users\yeonw\work\target' $name
            if (Test-Path $path) { Remove-Item $path -Recurse -Force }
        }
    }
} finally {
    Remove-Item $env:OWNER_JOB_ROOT -Recurse -Force
}
exit 0
