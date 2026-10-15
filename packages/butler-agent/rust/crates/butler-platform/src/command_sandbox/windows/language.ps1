$ProgressPreference = 'SilentlyContinue'
# Respect the host application-control policy; never override language mode.
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
