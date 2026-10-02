# Pure format/comparer proof using the exact updater shipped by electron-winstaller.
param([Parameter(Mandatory=$true)][string]$Squirrel)
$ErrorActionPreference = 'Stop'
$assembly = [Reflection.Assembly]::LoadFrom((Resolve-Path $Squirrel))
$type = $assembly.GetType('NuGet.SemanticVersion', $true)
function Version([string]$value) { [Activator]::CreateInstance($type, @($value)) }
$nine = Version '0.1.0-preview0000000009'
$ten = Version '0.1.0-preview0000000010'
$stable = Version '0.1.0'
if ($nine.CompareTo($ten) -ge 0 -or $ten.CompareTo($stable) -ge 0) { throw 'Squirrel preview ordering is invalid' }
Write-Output 'PASS Squirrel comparer: preview.9 < preview.10 < stable (padded package suffix, exact display version)'
