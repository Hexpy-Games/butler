param([string]$Path, [string]$PackageRoot = $PSScriptRoot, [string]$CsvPath)
if (!$CsvPath) { $CsvPath = Join-Path $PackageRoot 'diag.csv' }
$ErrorActionPreference = 'Stop'
function Find-Diagnostics([string]$Root) {
    if (!$Root) { return }
    $direct = @(foreach ($relative in @('request-prefix-diagnostics.jsonl', 'metrics/request-prefix-diagnostics.jsonl',
        'data-metrics/request-prefix-diagnostics.jsonl')) {
        Get-Item -LiteralPath (Join-Path $Root $relative) -ErrorAction SilentlyContinue
    })
    if ($direct.Count) { return $direct }
    Get-ChildItem -LiteralPath $Root -Filter request-prefix-diagnostics.jsonl -File -Recurse -ErrorAction SilentlyContinue
}
if (!$Path) {
    # Prefer the newest active launcher profile, before environment or saved runs.
    $profiles = Get-ChildItem -LiteralPath $env:TEMP -Filter 'butler-win-protected-path-*' `
        -Directory -ErrorAction SilentlyContinue | Sort-Object CreationTimeUtc -Descending
    foreach ($profile in $profiles) {
        $candidate = Join-Path $profile.FullName 'data'
        if (@(Find-Diagnostics $candidate).Count) { $Path = $candidate; break }
    }
    if (!$Path -and $env:BUTLER_DATA -and @(Find-Diagnostics $env:BUTLER_DATA).Count) {
        $Path = $env:BUTLER_DATA
    }
    if (!$Path) {
        $saved = Join-Path (Split-Path $PackageRoot -Parent) 'logs'
        $folders = Get-ChildItem -LiteralPath $saved -Directory -ErrorAction SilentlyContinue |
            Sort-Object CreationTimeUtc -Descending
        foreach ($folder in $folders) {
            if (@(Find-Diagnostics $folder.FullName).Count) { $Path = $folder.FullName; break }
        }
    }
}
if (!$Path) { throw 'No request diagnostics. Supply -Path with a test data or saved logs folder.' }
$files = @(Find-Diagnostics $Path)
if (!$files.Count) { throw 'No request diagnostic journal in the selected folder.' }
# Streaming reads work while the Agent owns the log. Latest event per request
# replaces its start, so retries and interrupted requests each remain one row.
$requests = @{}
foreach ($file in $files) {
    try { $stream = [IO.File]::Open($file.FullName, 'Open', 'Read', 'ReadWrite') }
    catch [IO.IOException] { continue }
    catch [UnauthorizedAccessException] { continue }
    $reader = [IO.StreamReader]::new($stream)
    try {
        while ($null -ne ($line = $reader.ReadLine())) {
            if (!$line.Trim()) { continue }
            try { $event = $line | ConvertFrom-Json } catch {
                if ($reader.EndOfStream) { Write-Warning 'Ignoring an unfinished final log line'; break }
                throw
            }
            $requests[$event.requestId] = $event
        }
    } finally { $reader.Dispose() }
}
$rows = @($requests.Values | Sort-Object ts,requestId | ForEach-Object {
    $inputTokens = $_.providerReportedInputTokens
    $cached = $_.providerReportedCachedTokens
    $difference = $_.firstDifference.component
    if ($null -ne $_.firstDifference.index) { $difference += "[$($_.firstDifference.index)]" }
    [pscustomobject][ordered]@{
        Session = $_.sessionSha256.Substring(0,12); Kind = $_.sessionKind
        Round = $_.round; Phase = $_.phase; Input = $inputTokens; Cached = $cached
        'Cache%' = if ($null -ne $inputTokens -and $null -ne $cached -and $inputTokens -gt 0) {
            [math]::Round(100.0 * $cached / $inputTokens,2) } else { $null }
        'LCP%' = if ($null -ne $_.lcpTokenPercent) { [math]::Round($_.lcpTokenPercent,2) } else { $null }
        Difference = $difference; Output = $_.providerReportedOutputTokens
        State = if ($_.requestStarted) { 'pending' } else { $_.status }
        Request = $_.requestId; SessionHash = $_.sessionSha256
    }
})
$rows | Format-Table Session,Kind,Round,Phase,Input,Cached,'Cache%','LCP%',Difference -AutoSize | Out-Host
$totals = @($rows | Group-Object SessionHash | ForEach-Object {
    $known = @($_.Group | Where-Object { $null -ne $_.Input })
    $inputTotal = ($known | Measure-Object Input -Sum).Sum
    $cacheKnown = @($_.Group | Where-Object { $null -ne $_.Cached })
    $unpaired = @($_.Group | Where-Object { ($null -ne $_.Input) -xor ($null -ne $_.Cached) })
    $outputKnown = @($_.Group | Where-Object { $null -ne $_.Output })
    $cachedTotal = if ($cacheKnown.Count) { ($cacheKnown | Measure-Object Cached -Sum).Sum } else { $null }
    [pscustomobject][ordered]@{
        Session = $_.Group[0].Session; Requests = $_.Count; Reported = $known.Count
        Input = $inputTotal; Cached = $cachedTotal
        'Cache%' = if ($inputTotal -gt 0 -and $unpaired.Count -eq 0) { [math]::Round(100.0 * $cachedTotal / $inputTotal,2) } else { $null }
        Output = if ($outputKnown.Count) { ($outputKnown | Measure-Object Output -Sum).Sum } else { $null }
        SessionHash = $_.Name
    }
})
$totals | Format-Table Session,Requests,Reported,Input,Cached,'Cache%',Output -AutoSize | Out-Host
$rows | Export-Csv -LiteralPath $CsvPath -NoTypeInformation -Encoding UTF8
$totalsPath = Join-Path (Split-Path $CsvPath -Parent) (([IO.Path]::GetFileNameWithoutExtension($CsvPath)) + '-sessions.csv')
$totals | Export-Csv -LiteralPath $totalsPath -NoTypeInformation -Encoding UTF8
Write-Output "Diagnostics: $($rows.Count) requests; $($totals.Count) sessions; CSV: $CsvPath"
