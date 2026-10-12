# Windows PowerShell initializes .NET's path-switch caches before our script.
# Enable the documented long-path switches and invalidate only those caches.
# See microsoft/referencesource mscorlib/system/AppContext/AppContextSwitches.cs.
& {
    try {
        $directory = [System.Environment]::CurrentDirectory.Replace('/', '\')
        $longPath = $directory.Length -ge 248
        if ($PSVersionTable.PSEdition -eq 'Desktop') {
            $context = [System.AppContext].Assembly.GetType('System.AppContextSwitches', $false)
            foreach ($name in @('UseLegacyPathHandling', 'BlockLongPaths')) {
                $cacheName = '_' + $name.Substring(0, 1).ToLowerInvariant() + $name.Substring(1)
                $cache = if ($context) { $context.GetField($cacheName, [System.Reflection.BindingFlags]'Static,NonPublic') } else { $null }
                if (!$cache) {
                    if ($longPath) { throw "Windows PowerShell path compatibility is unavailable: $name" }
                    continue
                }
                [System.AppContext]::SetSwitch("Switch.System.IO.$name", $false)
                $cache.SetValue($null, 0)
            }
        }
        if ($env:BUTLER_COMMAND_RESTORE_CWD) {
            if ($PSVersionTable.PSEdition -eq 'Desktop' -and $longPath) {
                # The provider treats \\?\C:\ as an incomplete UNC root and
                # drops its first child. DosDevices retains the logon's drive
                # lookup while giving the provider a complete extended root.
                $root = [System.IO.Path]::GetPathRoot($directory)
                $extendedRoot = '\\?\GLOBALROOT\DosDevices\' + $(if ($root.StartsWith('\\')) {
                    'UNC\' + $root.Substring(2)
                } else { $root })
                $extendedRoot = $extendedRoot.TrimEnd('\') + '\'
                $relative = $directory.Substring($root.Length).TrimStart('\')
                New-PSDrive -Name ButlerFileSystem -PSProvider FileSystem -Root $extendedRoot -Scope Global -ErrorAction Stop | Out-Null
                Set-Location -LiteralPath ('ButlerFileSystem:\' + $relative) -ErrorAction Stop
                [System.Environment]::CurrentDirectory = $extendedRoot + $relative
            } else {
                Set-Location -LiteralPath $directory -ErrorAction Stop
            }
            Remove-Item Env:BUTLER_COMMAND_RESTORE_CWD -ErrorAction Stop
        }
    } catch {
        [Console]::Error.WriteLine($_.Exception.Message)
        exit 1
    }
}
