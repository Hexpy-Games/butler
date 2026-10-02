# test-category: format-pin
# Pure format/comparer proof using the exact updater shipped by electron-winstaller.
param([Parameter(Mandatory=$true)][string]$Squirrel)
$ErrorActionPreference = 'Stop'
$assembly = [Reflection.Assembly]::LoadFrom((Resolve-Path $Squirrel))
$type = $assembly.GetType('NuGet.SemanticVersion', $true)
function Version([string]$value) { [Activator]::CreateInstance($type, @($value)) }
$mapped = & node --input-type=module -e "import {windowsPackageVersion as map} from './packages/butler-app/client/electron/scripts/windows-package-version.mjs'; import {createRequire} from 'node:module'; const require=createRequire(new URL('./packages/butler-app/client/electron/package.json', import.meta.url)); const {convertVersion}=require('electron-winstaller'); console.log(JSON.stringify(['0.1.0-preview.9','0.1.0-preview.10','0.1.0'].map(v=>convertVersion(map(v)))));"
if ($LASTEXITCODE) { throw 'Package version mapping failed' }
$versions = $mapped | ConvertFrom-Json
$nine = Version $versions[0]
$ten = Version $versions[1]
$stable = Version $versions[2]
if ($nine.CompareTo($ten) -ge 0 -or $ten.CompareTo($stable) -ge 0) { throw 'Squirrel preview ordering is invalid' }
Write-Output 'PASS Squirrel comparer: preview.9 < preview.10 < stable (padded package suffix, exact display version)'
