# Windows PowerShell initializes .NET's path-switch caches before our script.
# Enable the documented long-path switches and invalidate only those caches.
# See microsoft/referencesource mscorlib/system/AppContext/AppContextSwitches.cs.
& {
    try {
        if ($PSVersionTable.PSEdition -eq 'Desktop') {
            $context = [System.AppContext].Assembly.GetType('System.AppContextSwitches', $true)
            foreach ($name in @('UseLegacyPathHandling', 'BlockLongPaths')) {
                $cacheName = '_' + $name.Substring(0, 1).ToLowerInvariant() + $name.Substring(1)
                $cache = $context.GetField($cacheName, [System.Reflection.BindingFlags]'Static,NonPublic')
                if (!$cache) { throw "Windows PowerShell path compatibility is unavailable: $name" }
                [System.AppContext]::SetSwitch("Switch.System.IO.$name", $false)
                $cache.SetValue($null, 0)
            }
        }
        if ($env:BUTLER_COMMAND_CWD) {
            $directory = $env:BUTLER_COMMAND_CWD.Replace('/', '\')
            Set-Location -LiteralPath $directory -ErrorAction Stop
            Remove-Item Env:BUTLER_COMMAND_CWD -ErrorAction Stop
        }
    } catch {
        [Console]::Error.WriteLine($_.Exception.Message)
        exit 1
    }
}
