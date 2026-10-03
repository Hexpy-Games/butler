# Reuse immutable packages only when every compiled/product source is identical.
param([Parameter(Mandatory)][long]$RunId)
$ErrorActionPreference = 'Stop'
if ($env:RUNNER_ENVIRONMENT -ne 'github-hosted') { throw 'Hosted verification only' }
$headers = @{ Authorization = "Bearer $env:GH_TOKEN"; Accept = 'application/vnd.github+json' }
$api = "https://api.github.com/repos/$env:GITHUB_REPOSITORY/actions/runs"
$source = Invoke-RestMethod "$api/$RunId" -Headers $headers
$current = Invoke-RestMethod "$api/$env:GITHUB_RUN_ID" -Headers $headers
if ($source.workflow_id -ne $current.workflow_id -or $source.head_branch -ne $current.head_branch) {
    throw 'Reuse requires the same workflow and branch'
}
if ($source.status -ne 'completed' -or $source.head_sha -notmatch '^[a-f0-9]{40}$') {
    throw 'Expected completed source run with an exact revision'
}
$jobs = Invoke-RestMethod "$api/$RunId/jobs?per_page=100" -Headers $headers
$build = @($jobs.jobs | Where-Object name -eq 'Build Windows Squirrel artifacts')
if ($build.Count -ne 1 -or $build[0].conclusion -ne 'success') { throw 'Source BUILD did not pass' }
git fetch origin $source.head_sha
if ($LASTEXITCODE) { throw 'Source revision fetch failed' }
$changed = @(git diff --name-only $source.head_sha HEAD)
if ($LASTEXITCODE) { throw 'Source comparison failed' }
$allowed = @(
    '.github/workflows/windows-installer.yml', '.github/workflows/release.yml',
    'deploy/windows-installer-reuse.ps1', 'deploy/app/publish-release-artifacts.sh',
    'deploy/windows-startup-smoke.ps1', 'deploy/windows-task-xml-probe.ps1',
    'plans/windows-wave2.md',
    'packages/butler-app/scripts/windows/installer-smoke.ts',
    'packages/butler-app/scripts/windows/installer-smoke-support.ts',
    'packages/butler-app/scripts/windows/smoke-provider.ts',
    'packages/butler-app/scripts/windows/released-downloads-smoke.ts'
)
foreach ($path in $changed) {
    if ($path -notin $allowed) { throw "Rebuild required: $path" }
}
Write-Host "Verified identical package and compiled E2E sources at $($source.head_sha)"
