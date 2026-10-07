$ErrorActionPreference = 'Stop'

# Read the user's existing PATH before the job replaces LOCALAPPDATA/HOME.
$userEnvironment = Get-ItemProperty -LiteralPath 'HKCU:\Environment' -ErrorAction SilentlyContinue
$paths = @()
if ($userEnvironment.Path) {
    $paths += [Environment]::ExpandEnvironmentVariables($userEnvironment.Path) -split ';'
}
$paths += Join-Path $env:USERPROFILE '.cargo/bin'
$paths += Join-Path $env:USERPROFILE '.bun/bin'
# GitHub prepends command-file entries in reverse order. Preserve tool priority.
$paths = @($paths | Select-Object -Unique)
[array]::Reverse($paths)
foreach ($directory in $paths) {
    if ($directory -and (Test-Path -LiteralPath $directory -PathType Container)) {
        $directory | Out-File -FilePath $env:GITHUB_PATH -Encoding utf8 -Append
        $env:PATH = "$directory;$env:PATH"
    }
}

if (!(Get-Command cl -ErrorAction SilentlyContinue) -or !$env:VCToolsInstallDir -or !$env:UCRTVersion -or !$env:UniversalCRTSdkDir) {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
    if (!(Test-Path -LiteralPath $vswhere)) { throw 'Existing MSVC not found: vswhere is missing; no installation attempted' }
    $ErrorActionPreference = 'Continue'
    $installation = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    $ErrorActionPreference = 'Stop'
    if ($LASTEXITCODE -ne 0 -or !$installation) { throw 'Existing x64 MSVC installation not found; no installation attempted' }
    $developer = Join-Path $installation 'Common7/Tools/VsDevCmd.bat'
    if (!(Test-Path -LiteralPath $developer)) { throw 'Existing VsDevCmd.bat not found; no installation attempted' }
    # Capture rather than log the environment, which may contain credentials.
    # Windows PowerShell 5.1 re-quotes native arguments. Avoid a quoted batch path.
    Push-Location -LiteralPath (Split-Path -Parent $developer)
    try {
        $ErrorActionPreference = 'Continue'
        $environment = & $env:ComSpec /d /c 'call VsDevCmd.bat -no_logo -arch=x64 -host_arch=x64 >nul && set'
        $ErrorActionPreference = 'Stop'
        $developerExit = $LASTEXITCODE
    } finally { Pop-Location }
    if ($developerExit -ne 0) { throw 'Existing MSVC developer environment failed; no host changes attempted' }
    $msvcVariables = @('INCLUDE', 'LIB', 'LIBPATH', 'VCToolsInstallDir', 'VCToolsVersion',
        'VCIDEInstallDir', 'VCINSTALLDIR', 'VSINSTALLDIR', 'VisualStudioVersion',
        'WindowsSdkDir', 'WindowsSDKVersion', 'WindowsSDKLibVersion', 'WindowsSdkBinPath',
        'WindowsSdkVerBinPath', 'WindowsLibPath', 'UCRTVersion', 'UniversalCRTSdkDir',
        'DevEnvDir', 'ExtensionSdkDir', 'FrameworkDir', 'FrameworkVersion',
        'Framework40Version', 'FrameworkDir64', 'FrameworkVersion64')
    foreach ($entry in $environment) {
        if ($entry -notmatch '^([^=]+)=(.*)$') { continue }
        $name, $value = $Matches[1], $Matches[2]
        if ($name -eq 'PATH') {
            $developerPaths = @($value -split ';' | Where-Object { $_ })
            [array]::Reverse($developerPaths)
            $developerPaths | Out-File -FilePath $env:GITHUB_PATH -Encoding utf8 -Append
        } elseif ($name -in $msvcVariables) {
            "$name=$value" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
        }
    }
}

# Keep the validated interpreter ahead of any other Python in the imported PATH.
Split-Path -Parent $env:PYTHON | Out-File -FilePath $env:GITHUB_PATH -Encoding utf8 -Append
