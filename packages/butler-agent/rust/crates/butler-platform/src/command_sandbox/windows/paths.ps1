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
            if ($PSVersionTable.PSEdition -eq 'Desktop' -and [System.IO.Path]::GetFullPath($directory).Length -ge 248) {
                # Give relative paths an explicit extended provider root at
                # the volume/share boundary, preserving parent traversal.
                $root = [System.IO.Path]::GetPathRoot($directory)
                $extendedRoot = if ($root.StartsWith('\\')) {
                    '\\?\UNC\' + $root.Substring(2)
                } else { '\\?\' + $root }
                $extendedRoot = $extendedRoot.TrimEnd('\') + '\'
                $relative = $directory.Substring($root.Length).TrimStart('\')
                New-PSDrive -Name ButlerFileSystem -PSProvider FileSystem -Root $extendedRoot -Scope Global -ErrorAction Stop | Out-Null
                Set-Location -LiteralPath ('ButlerFileSystem:\' + $relative) -ErrorAction Stop
                [System.Environment]::CurrentDirectory = $extendedRoot + $relative
            } else {
                Set-Location -LiteralPath $directory -ErrorAction Stop
            }
            Remove-Item Env:BUTLER_COMMAND_CWD -ErrorAction Stop
        }
    } catch {
        [Console]::Error.WriteLine($_.Exception.Message)
        exit 1
    }
}
