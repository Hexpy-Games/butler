$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'windows-host-snapshot.ps1')
function State([string]$hash, [bool]$installed, [string]$time) {
    return @{hash=$hash;matchesInstalledRegistration=$installed;lastWriteUtc=$time;subkeyLastWriteUtc=@{''=$time}}
}
$key='HKCU\Software\Classes\butler'
$before=@{registry=@{$key=(State 'old' $false '1')};tasks=@{'\existing'='one';'\removed'='old'}}
$after=@{registry=@{$key=(State 'new' $true '2')};tasks=@{'\existing'='two';'\added'='new'}}
$changes=HostChanges $before $after
if (!$changes.unattributed -or $changes.tasks.Count -ne 3) { throw 'task_change_not_preserved' }
foreach ($change in $changes.tasks) {
    if ($change.beforeHash -ne $before.tasks[$change.name] -or $change.afterHash -ne $after.tasks[$change.name]) { throw 'task_hash_missing' }
}
$after.tasks=$before.tasks
$changes=HostChanges $before $after
if ($changes.unattributed -or !$changes.registry[0].external -or $changes.registry[0].writerObserved) { throw 'installed_attribution_wrong' }
if ($changes.registry[0].beforeLastWriteUtc -ne '1' -or $changes.registry[0].afterLastWriteUtc -ne '2') { throw 'timestamps_missing' }
$after.registry[$key].matchesInstalledRegistration=$false
if (!(HostChanges $before $after).unattributed) { throw 'unknown_registration_ignored' }
$after.registry[$key]=$before.registry[$key]
if ((HostChanges $before $after).unattributed) { throw 'unchanged_snapshot_failed' }
$after.registry['HKCU\Software\ButlerSandboxDenied']=State 'unexpected' $true '3'
if (!(HostChanges $before $after).unattributed) { throw 'unrelated_key_ignored' }
$after.registry.Remove('HKCU\Software\ButlerSandboxDenied')
$after.registry[$key]=State 'old' $false '2'
if (!(HostChanges $before $after).unattributed) { throw 'rewrite_timestamp_ignored' }
Write-Output 'host_attribution_complete'
