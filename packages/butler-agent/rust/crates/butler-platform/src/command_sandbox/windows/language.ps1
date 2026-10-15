$ProgressPreference = 'SilentlyContinue'
# Respect the host application-control policy; never override language mode.
trap {
    if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage' -and $_.FullyQualifiedErrorId -match 'ConstrainedLanguage|RestrictedLanguage|CannotDefineNewType|CannotCreateType') {
        Write-Error -Message 'PowerShell language policy blocks this operation. Use built-in cmdlets or a native executable inside the same sandbox; do not retry .NET/COM/Add-Type or request weaker containment.' -ErrorAction Continue
        exit 1
    }
    throw $_
}
if ($ExecutionContext.SessionState.LanguageMode -eq 'FullLanguage') {
    [Console]::InputEncoding = [Text.UTF8Encoding]::new()
    [Console]::OutputEncoding = [Text.UTF8Encoding]::new()
    $OutputEncoding = [Console]::OutputEncoding
} else {
    # Reading an encoding property is allowed; constructing it and changing
    # Console properties are blocked by CLM. The launcher sets the code page
    # before PowerShell starts and caches its console output encoding.
    $OutputEncoding = [Text.Encoding]::UTF8
}
