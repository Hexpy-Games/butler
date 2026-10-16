param([Parameter(Mandatory=$true)][string]$Log)
$ErrorActionPreference = 'Continue'
python "$PSScriptRoot/../.github/scripts/summarize-test-log.py" $Log
$summaryCode = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
if ($summaryCode -ne 0) { Write-Warning "Could not summarize test log: $Log ($summaryCode)" }
