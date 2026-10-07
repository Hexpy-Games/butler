param([Parameter(Mandatory)][string]$Output)
$ErrorActionPreference = 'Stop'
# Query as required, then hash a registry export: this compares all value types
# and subkeys without depending on console encoding or Out-String formatting.
$ErrorActionPreference = 'Continue'
& cmd.exe /d /c 'reg query HKCU\Software\Classes\butler /s 2>NUL' | Out-Null
$ErrorActionPreference = 'Stop'
$code = $LASTEXITCODE
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
