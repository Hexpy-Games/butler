. "$PSScriptRoot/windows-job-tree.ps1"
# Only job-owned profile directories are removed; persistent caches survive.
$ErrorActionPreference = 'Stop'
if (!$env:OWNER_JOB_ROOT) { throw 'Missing owner job isolation root' }
$null = Get-JobTreePath $env:OWNER_JOB_ROOT
try {
    & "$PSScriptRoot/windows-protocol-snapshot.ps1" -Output "$env:OWNER_JOB_ROOT/protocol-after.json"
    $before = Get-Content "$env:OWNER_JOB_ROOT/protocol-before.json" -Raw
    $after = Get-Content "$env:OWNER_JOB_ROOT/protocol-after.json" -Raw
    if ($after -cne $before) {
        throw "Owner protocol registration changed: before=$before after=$after"
    }
} finally {
    try {
        $ErrorActionPreference = 'Continue'
        python "$env:GITHUB_WORKSPACE/.github/scripts/runner_cache.py"
        $ErrorActionPreference = 'Stop'
        if ($LASTEXITCODE -ne 0) { throw 'Dependency cache cleanup failed' }
    } finally {
        Remove-JobTree $env:OWNER_JOB_ROOT
    }
}
exit 0
