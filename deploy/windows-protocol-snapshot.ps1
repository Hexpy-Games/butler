param([Parameter(Mandatory)][string]$Output)
$ErrorActionPreference = 'Stop'
# Absence is expected; the registry provider avoids native stderr in PS 5.1.
$code = if (Test-Path 'HKCU:\Software\Classes\butler') { 0 } else { 1 }
$export = "$Output.reg"
try {
    $digest = $null
    if ($code -eq 0) {
        $ErrorActionPreference = 'Continue'
        & reg export 'HKCU\Software\Classes\butler' $export /y | Out-Null
        $ErrorActionPreference = 'Stop'
        if ($LASTEXITCODE -ne 0) { throw 'Could not export the protocol registration' }
        $digest = (Get-FileHash $export -Algorithm SHA256).Hash
    } elseif (Test-Path 'Registry::HKEY_CURRENT_USER\Software\Classes\butler') {
        throw 'Could not query an existing protocol registration'
    }
    [ordered]@{ code = $code; sha256 = $digest } | ConvertTo-Json -Compress | Set-Content $Output
} finally {
    if (Test-Path $export) { Remove-Item $export -Force }
}
$global:LASTEXITCODE = 0
