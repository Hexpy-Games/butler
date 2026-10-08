# PS 5.1 recursive providers cannot handle MAX_PATH-sized fixture trees.
function Get-JobTreePath([string]$Path) {
    if (!$env:RUNNER_TEMP -or !$Path -or ![IO.Path]::IsPathRooted($Path)) {
        throw 'Missing absolute job-owned path'
    }
    $full = [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
    $runner = [IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\', '/')
    if (!$full.StartsWith($runner + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Path is outside runner job temp root'
    }
    # Job profiles (installer, packaging) live directly under RUNNER_TEMP, beside
    # OWNER_JOB_ROOT; RUNNER_TEMP containment is the safety boundary.
    # Never follow an existing junction out of the isolated tree.
    for ($cursor = $full; $cursor -and $cursor -ne $runner; $cursor = [IO.Path]::GetDirectoryName($cursor)) {
        if ([IO.Directory]::Exists($cursor) -and
            ([IO.File]::GetAttributes($cursor) -band [IO.FileAttributes]::ReparsePoint)) {
            throw 'Job path contains a reparse point'
        }
    }
    return $full
}

function Copy-JobTree([string]$Source, [string]$Destination) {
    $sourcePath = Get-JobTreePath $Source
    $destinationPath = Get-JobTreePath $Destination
    $savedPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        & robocopy.exe $sourcePath $destinationPath /E /XJ /R:0 /W:0 /NFL /NDL /NJH /NJS
        $code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $savedPreference }
    if ($code -ge 8) { throw "Job fixture copy failed: robocopy exit $code" }
    $global:LASTEXITCODE = 0
}

function Remove-JobTree([string]$Path) {
    $full = Get-JobTreePath $Path
    if ($full -match '[%"!\r\n]') { throw 'Unsafe command path' }
    $extended = if ($full.StartsWith('\\')) { '\\?\UNC\' + $full.Substring(2) } else { '\\?\' + $full }
    if (![IO.Directory]::Exists($extended)) { return }
    $savedPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        & cmd.exe /d /c "rd /s /q `"$extended`""
        $code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $savedPreference }
    if ($code -ne 0) { throw "Job cleanup failed: rd exit $code" }
    $global:LASTEXITCODE = 0
}
