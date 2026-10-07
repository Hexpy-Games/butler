$ErrorActionPreference = 'Stop'

function Find-Python312($Executable, $Arguments = @()) {
    if (!$Executable -or !(Test-Path -LiteralPath $Executable -PathType Leaf)) { return $null }
    try {
        $ErrorActionPreference = 'Continue'
        $found = & $Executable @Arguments -c 'import sys; print(sys.executable) if sys.version_info[:2] == (3, 12) else sys.exit(1)' 2>$null
        $ErrorActionPreference = 'Stop'
        if ($LASTEXITCODE -eq 0 -and $found -and (Test-Path -LiteralPath "$found" -PathType Leaf)) {
            return "$found"
        }
    } catch { }
    return $null
}

$command = Get-Command python -CommandType Application -ErrorAction SilentlyContinue
$python = if ($command) { Find-Python312 $command.Source } else { $null }
if (!$python) {
    $launcher = Join-Path $env:USERPROFILE 'AppData/Local/Programs/Python/Launcher/py.exe'
    $python = Find-Python312 $launcher @('-3.12')
}
if (!$python -and $env:LOCALAPPDATA) {
    $python = Find-Python312 (Join-Path $env:LOCALAPPDATA 'Programs/Python/Python312/python.exe')
}
if (!$python) {
    $install = Get-Item -LiteralPath 'HKCU:\Software\Python\PythonCore\3.12\InstallPath' -ErrorAction SilentlyContinue
    if ($install) {
        $python = Find-Python312 $install.GetValue('ExecutablePath')
        if (!$python -and $install.GetValue('')) {
            $python = Find-Python312 (Join-Path $install.GetValue('') 'python.exe')
        }
    }
}
if (!$python) {
    throw 'Existing Python 3.12 not found: checked PATH, user launcher, LOCALAPPDATA and HKCU PythonCore. No installation or host changes attempted.'
}
Split-Path -Parent $python | Out-File -FilePath $env:GITHUB_PATH -Encoding utf8 -Append
"PYTHON=$python" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
Write-Output "Using existing Python 3.12: $python"
