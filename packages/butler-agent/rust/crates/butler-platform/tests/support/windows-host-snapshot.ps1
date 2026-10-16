# Read-only host evidence. Values are hashed; only known installed-app matching is disclosed.
function SnapshotHash([string]$text) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($text))) }
    finally { $sha.Dispose() }
}
function RegistryTree($key, [string]$relative, $entries, $times) {
    $timeKey = if ($relative -eq '') { '.' } else { $relative }
    $times[$timeKey] = [ButlerRegistrySnapshot]::LastWriteUtc($key)
    $entries.Add([ordered]@{key=$relative})
    foreach ($name in ($key.GetValueNames() | Sort-Object)) {
        $entries.Add([ordered]@{key=$relative;name=$name;kind=$key.GetValueKind($name).ToString();value=$key.GetValue($name,$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)})
    }
    foreach ($name in ($key.GetSubKeyNames() | Sort-Object)) {
        $child = $key.OpenSubKey($name, $false)
        try { RegistryTree $child ($relative + '\' + $name) $entries $times }
        finally { $child.Dispose() }
    }
}
function InstalledProtocolHash([string]$executable) {
    # Pin the entire Electron registration, including key/value names and types.
    # A matching command alone must never hide an added or modified value.
    $entries = @(
        [ordered]@{key=''},
        [ordered]@{key='';name='';kind='String';value='URL:butler'},
        [ordered]@{key='';name='URL Protocol';kind='String';value=''},
        [ordered]@{key='\shell'},
        [ordered]@{key='\shell\open'},
        [ordered]@{key='\shell\open\command'},
        [ordered]@{key='\shell\open\command';name='';kind='String';value=('"' + $executable + '" "%1"')}
    )
    return SnapshotHash (ConvertTo-Json -InputObject $entries -Depth 8 -Compress)
}
function RegistrySnapshot {
    $registry = @{}
    foreach ($path in @('Software\ButlerSandboxDenied','Software\Classes\butler','Software\Microsoft\Windows\CurrentVersion\Run')) {
        $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($path, $false)
        $entries = [Collections.Generic.List[object]]::new()
        $times = @{}
        try { if ($null -ne $key) { RegistryTree $key '' $entries $times } }
        finally { if ($null -ne $key) { $key.Dispose() } }
        $hash = SnapshotHash (ConvertTo-Json -InputObject @($entries.ToArray()) -Depth 8 -Compress)
        $registry['HKCU\' + $path] = @{
            hash=$hash; lastWriteUtc=$times['.']; subkeyLastWriteUtc=$times
            matchesInstalledRegistration=($path -eq 'Software\Classes\butler' -and $null -ne $script:installedProtocolHash -and $hash -eq $script:installedProtocolHash)
        }
    }
    return $registry
}
function HostSnapshot {
    $tasks = @{}
    foreach ($task in (Get-ScheduledTask -ErrorAction Stop)) {
        $name = $task.TaskPath + $task.TaskName
        $xml = Export-ScheduledTask -TaskName $task.TaskName -TaskPath $task.TaskPath -ErrorAction Stop
        $tasks[$name] = SnapshotHash $xml
    }
    return @{registry=(RegistrySnapshot);tasks=$tasks}
}
function MapChanges($a,$b) {
    if ($null -eq $a) { $a=@{} }; if ($null -eq $b) { $b=@{} }
    return @(@($a.Keys) + @($b.Keys) | Sort-Object -Unique | Where-Object { $a[$_] -ne $b[$_] } | ForEach-Object {
        @{name=$_;beforeHash=$a[$_];afterHash=$b[$_]}
    })
}
function RegistryChanges($a,$b) {
    return @(@($a.Keys) + @($b.Keys) | Sort-Object -Unique | ForEach-Object {
        $key=$_; $old=$a[$key]; $new=$b[$key]
        $timeChanged=@(MapChanges $old.subkeyLastWriteUtc $new.subkeyLastWriteUtc).Count -gt 0
        if ($old.hash -ne $new.hash -or $timeChanged) {
            $external=$key -eq 'HKCU\Software\Classes\butler' -and $new.matchesInstalledRegistration
            @{name=$key;beforeHash=$old.hash;afterHash=$new.hash;beforeLastWriteUtc=$old.lastWriteUtc;afterLastWriteUtc=$new.lastWriteUtc
              timestampChanged=$timeChanged;external=$external
              attribution=$(if ($external) {'installed_app_registration_match'} else {'unattributed'})
              writerObserved=$false}
        }
    })
}
function HostChanges($before,$after) {
    $registry=@(RegistryChanges $before.registry $after.registry)
    $tasks=@(MapChanges $before.tasks $after.tasks)
    return @{registry=$registry;tasks=$tasks;unattributed=(@($registry|Where-Object {!$_.external}).Count -gt 0 -or $tasks.Count -gt 0)}
}
