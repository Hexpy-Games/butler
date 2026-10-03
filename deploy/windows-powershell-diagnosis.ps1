# Read-only process probes for #470; no installer or shell registrations.
$ErrorActionPreference = 'Stop'
$root = Join-Path $env:TEMP ('powershell-diagnosis-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory $root | Out-Null
$common = @('PATH','HOME','TMPDIR','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA',
    'PROGRAMDATA','SYSTEMROOT','WINDIR','COMSPEC','PATHEXT','USERNAME','HOMEDRIVE','HOMEPATH',
    'LANG','LC_ALL','LC_CTYPE','LC_MESSAGES','SHELL','BUTLER_BUN','BUTLER_WINDOWS_PROCESS_HOST',
    'SystemDrive','ProgramFiles','ProgramFiles(x86)','ProgramW6432','CommonProgramFiles',
    'CommonProgramFiles(x86)','CommonProgramW6432','NUMBER_OF_PROCESSORS','PROCESSOR_ARCHITECTURE','OS','PSModulePath')
$prefix = '[Console]::InputEncoding=[Text.UTF8Encoding]::new(); [Console]::OutputEncoding=[Text.UTF8Encoding]::new(); $OutputEncoding=[Console]::OutputEncoding; '
$mark = '[Console]::Error.WriteLine("script-start"); '
$imports = 'Import-Module -Name "$PSHOME\Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1"; '
$cases = [ordered]@{
    'cold-baseline' = $mark + "Write-Output '안녕하세요'"
    'direct-core-import' = $mark + $imports + "Write-Output '안녕하세요'"
    'console-only' = $mark + "[Console]::WriteLine('안녕하세요')"
    'qualified-core-command' = $mark + "Microsoft.PowerShell.Utility\Write-Output '안녕하세요'"
    'trace-discovery' = $mark + 'Trace-Command -Name Modules,CommandDiscovery -PSHost -Expression { Write-Output ''안녕하세요'' }'
}
try {
    foreach ($entry in $cases.GetEnumerator()) {
        $profile = Join-Path $root $entry.Key
        New-Item -ItemType Directory -Force "$profile/home","$profile/local","$profile/roaming","$profile/tmp","$profile/data" | Out-Null
        $info = [Diagnostics.ProcessStartInfo]::new()
        $info.FileName = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
        $info.UseShellExecute = $false
        $info.RedirectStandardOutput = $true
        $info.RedirectStandardError = $true
        $info.StandardOutputEncoding = [Text.UTF8Encoding]::new()
        $info.StandardErrorEncoding = [Text.UTF8Encoding]::new()
        $info.WorkingDirectory = "$profile/data"
        $info.Environment.Clear()
        foreach ($key in $common) {
            $value = [Environment]::GetEnvironmentVariable($key)
            if ($null -ne $value) { $info.Environment[$key] = $value }
        }
        $info.Environment['HOME'] = "$profile/home"
        $info.Environment['USERPROFILE'] = "$profile/home"
        $info.Environment['LOCALAPPDATA'] = "$profile/local"
        $info.Environment['APPDATA'] = "$profile/roaming"
        $info.Environment['TEMP'] = "$profile/tmp"
        $info.Environment['TMP'] = "$profile/tmp"
        $info.Environment['BUTLER_DATA'] = "$profile/data"
        $info.Environment['PYTHONIOENCODING'] = 'utf-8'
        $info.Environment['PYTHONUTF8'] = '1'
        $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($prefix + $entry.Value))
        foreach ($argument in @('-NoLogo','-NoProfile','-NonInteractive','-OutputFormat','Text','-ExecutionPolicy','Bypass','-EncodedCommand',$encoded)) {
            $info.ArgumentList.Add($argument)
        }
        $process = [Diagnostics.Process]::new()
        $process.StartInfo = $info
        $clock = [Diagnostics.Stopwatch]::StartNew()
        $started = $false
        try {
            $started = $process.Start()
            $stdout = $process.StandardOutput.ReadToEndAsync()
            $stderr = $process.StandardError.ReadToEndAsync()
            $finished = $process.WaitForExit(30000)
            if (!$finished) { $process.Kill($true); $process.WaitForExit() }
            $output = $stdout.GetAwaiter().GetResult()
            $errorOutput = $stderr.GetAwaiter().GetResult()
            [ordered]@{ case=$entry.Key; elapsed_ms=$clock.ElapsedMilliseconds; timed_out=!$finished;
                exit_code=$process.ExitCode; stdout=$output; stderr=$errorOutput } | ConvertTo-Json -Compress -Depth 4
            $cache = Join-Path $profile 'local/Microsoft/Windows/PowerShell'
            if (Test-Path $cache) {
                Get-ChildItem $cache -File | ForEach-Object { "cache case=$($entry.Key) name=$($_.Name) bytes=$($_.Length)" }
            }
        } finally {
            if ($started -and !$process.HasExited) { $process.Kill($true); $process.WaitForExit() }
            $process.Dispose()
        }
    }
} finally { Remove-Item $root -Recurse -Force }
