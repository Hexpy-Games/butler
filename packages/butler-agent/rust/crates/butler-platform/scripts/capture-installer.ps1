param([Parameter(Mandatory=$true)][string]$Setup, [Parameter(Mandatory=$true)][string]$Output)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
  throw 'Installer capture requires a disposable hosted runner'
}
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
New-Item -ItemType Directory -Force $Output | Out-Null
$process = Start-Process -FilePath $Setup -PassThru
$null = $process.Handle # keep the handle so ExitCode/ExitTime stay readable after exit
$receiptPath = Join-Path $Output 'capture-process.json'
$receipt = [ordered]@{ setup_pid = $process.Id; started_at = $process.StartTime.ToUniversalTime().ToString('o') }
function Write-Receipt {
  [IO.File]::WriteAllText($receiptPath, ($receipt | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding($false)))
}
Write-Receipt
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
} finally {
  # Squirrel Setup.exe blocks on its `Update.exe --install` child (hooks and uninstall registration
  # included), so Setup exit is install completion: the same signal the silent install waits on.
  # Never return mid-install; a hung Setup is bounded by the job timeout, not an install budget.
  $process.WaitForExit()
  $receipt.finished_at = $process.ExitTime.ToUniversalTime().ToString('o')
  $receipt.exit_code = $process.ExitCode
  $receipt.duration_ms = [long]($process.ExitTime - $process.StartTime).TotalMilliseconds
  Write-Receipt
  $process.Dispose()
}
if ($receipt.exit_code -ne 0) { throw "Setup exited with $($receipt.exit_code)" }
