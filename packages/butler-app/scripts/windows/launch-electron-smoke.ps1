param(
  [Parameter(Mandatory = $true)][string]$Electron,
  [Parameter(Mandatory = $true)][string]$AppRoot,
  [Parameter(Mandatory = $true)][string]$Profile,
  [Parameter(Mandatory = $true)][string]$PidFile,
  [Parameter(Mandatory = $true)][string]$ExitFile,
  [switch]$QuitMain
)

$ErrorActionPreference = "Stop"
try {
  $arguments = @("`"--user-data-dir=$Profile`"")
  if ($QuitMain) { $arguments += "--butler-quit-main-ui" }
  $arguments += "`"$AppRoot`""
  $appProcess = Start-Process `
    -FilePath $Electron `
    -ArgumentList $arguments `
    -WorkingDirectory $AppRoot `
    -PassThru
  [IO.File]::WriteAllText($PidFile, ([string]$appProcess.Id + "`r`n"))
  $appProcess.WaitForExit()
  $exitCode = $appProcess.ExitCode
  [IO.File]::WriteAllText($ExitFile, ([string]$exitCode + "`r`n"))
  exit $exitCode
} catch {
  [IO.File]::WriteAllText($ExitFile, "1`r`n")
  exit 1
}
