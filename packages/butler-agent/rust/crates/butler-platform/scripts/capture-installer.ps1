param([Parameter(Mandatory=$true)][string]$Setup, [Parameter(Mandatory=$true)][string]$Output)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
  throw 'Installer capture requires a disposable hosted runner'
}
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
New-Item -ItemType Directory -Force $Output | Out-Null
$process = Start-Process -FilePath $Setup -PassThru
$receipt = @{ setup_pid = $process.Id; started_at = $process.StartTime.ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress
[IO.File]::WriteAllText((Join-Path $Output 'capture-process.json'), $receipt,
  (New-Object System.Text.UTF8Encoding($false)))
try {
  $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  for ($index = 0; $index -lt 40; $index++) {
    $bitmap = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
      $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
      $bitmap.Save((Join-Path $Output ('installer-{0:D2}.png' -f $index)))
    } finally { $graphics.Dispose(); $bitmap.Dispose() }
    Start-Sleep -Milliseconds 150
  }
  if (-not $process.WaitForExit(30000)) { throw 'Setup process did not finish' }
  if ($process.ExitCode -ne 0) { throw "Setup exited with $($process.ExitCode)" }
} finally { $process.Dispose() }
