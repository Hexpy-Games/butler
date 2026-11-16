import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

type PowerShell = (script: string, env: NodeJS.ProcessEnv) => string;

type IdleProcess = {
  pid: number; name: string; commandLine: string | null; started: string;
  WorkingSet64: number; PrivateMemorySize64: number; cpuSeconds: number;
};
function idleProcessSamples(newFolder: string, env: NodeJS.ProcessEnv, powershell: PowerShell): { before: IdleProcess[]; after: IdleProcess[] } {
  return JSON.parse(powershell(`$root = [IO.Path]::GetFullPath($env:BUTLER_VERSION_FOLDER).TrimEnd('\\') + '\\'
    function Read-IdleProcesses {
      Get-CimInstance Win32_Process |
      Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) } |
      ForEach-Object {
        $process = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
        if ($process) {
          @{ pid = $_.ProcessId; name = $_.Name; commandLine = $_.CommandLine;
            started = $process.StartTime.ToUniversalTime().ToString('o');
            WorkingSet64 = $process.WorkingSet64; PrivateMemorySize64 = $process.PrivateMemorySize64;
            cpuSeconds = $process.TotalProcessorTime.TotalSeconds }
        }
      }
    }
    $before = @(Read-IdleProcesses)
    Start-Sleep -Seconds 10
    $after = @(Read-IdleProcesses)
    @{ before = $before; after = $after } | ConvertTo-Json -Compress -Depth 4`, { ...env, BUTLER_VERSION_FOLDER: newFolder }));
}

export async function measureIdleProcesses(newFolder: string, env: NodeJS.ProcessEnv, powershell: PowerShell) {
  await Bun.sleep(20_000);
  const samples = idleProcessSamples(newFolder, env, powershell);
  const before = new Map(samples.before.map(row => [row.pid, row]));
  const idleProcesses = samples.after.map(({ commandLine, started, ...row }) => {
    const previous = before.get(row.pid);
    // A new or reused PID has no CPU delta for the full window.
    return { ...row, type: commandLine?.match(/(?:^|\s)--type=(\S+)/u)?.[1] ?? null,
      cpuSeconds: previous?.started === started ? row.cpuSeconds - previous.cpuSeconds : null };
  });
  return { idleProcesses, windowSeconds: 10 };
}

export function rerunUpdatedHook(newFolder: string, toPackage: string, env: NodeJS.ProcessEnv) {
  const started = Date.now();
  const hook = spawnSync(join(newFolder, "Butler.exe"), ["--squirrel-updated", toPackage], {
    env, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 60_000, maxBuffer: Infinity,
  });
  return { hook, updatedHook: { exitCode: hook.status, stdout: hook.stdout ?? "",
    stderr: hook.stderr ?? "", durationMs: Date.now() - started } };
}

export function readPostUpdateRegistration(shortcuts: string[], env: NodeJS.ProcessEnv, powershell: PowerShell) {
  const postUpdateRegistration: { shortcuts: { path: string; TargetPath: string | null; WorkingDirectory: string | null }[];
    protocolCommand: string | null } = JSON.parse(powershell(`$shell = New-Object -ComObject WScript.Shell
    $paths = ConvertFrom-Json $env:BUTLER_SMOKE_SHORTCUTS
    $shortcuts = @(foreach ($path in $paths) {
      $shortcut = $null
      if (Test-Path -LiteralPath $path) { $shortcut = $shell.CreateShortcut($path) }
      @{ path = $path; TargetPath = $shortcut.TargetPath; WorkingDirectory = $shortcut.WorkingDirectory }
    })
    $key = Get-Item -LiteralPath 'HKCU:\\Software\\Classes\\butler\\shell\\open\\command' -ErrorAction SilentlyContinue
    $command = $null
    if ($key) { $command = $key.GetValue('') }
    @{ shortcuts = $shortcuts; protocolCommand = $command } | ConvertTo-Json -Compress -Depth 4`,
  { ...env, BUTLER_SMOKE_SHORTCUTS: JSON.stringify(shortcuts) }));
  return postUpdateRegistration;
}

type Registration = ReturnType<typeof readPostUpdateRegistration>;

/** Removes the shortcuts and points the protocol at a bogus command, so only the updated hook can restore them. */
export function staleRegistrations(shortcuts: string[], env: NodeJS.ProcessEnv, powershell: PowerShell) {
  powershell(`$ErrorActionPreference = 'Stop'
    $paths = ConvertFrom-Json $env:BUTLER_SMOKE_SHORTCUTS
    foreach ($path in $paths) { if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force } }
    $command = 'HKCU:\\Software\\Classes\\butler\\shell\\open\\command'
    if (-not (Test-Path -LiteralPath $command)) { New-Item -Path $command -Force | Out-Null }
    Set-Item -LiteralPath $command -Value '"stale" "%1"'
    if ((Get-Item -LiteralPath $command).GetValue('') -ne '"stale" "%1"') { throw 'Protocol command was not made stale' }
    foreach ($path in $paths) { if (Test-Path -LiteralPath $path) { throw "Shortcut still exists: $path" } }`,
  { ...env, BUTLER_SMOKE_SHORTCUTS: JSON.stringify(shortcuts) });
}

export function assertRegistrations(registration: Registration, stub: string, installed: string, label: string) {
  for (const shortcut of registration.shortcuts) {
    assert.notEqual(shortcut.TargetPath, null, `${label}: shortcut missing: ${shortcut.path}`);
    assert.equal(shortcut.TargetPath?.toLowerCase(), stub.toLowerCase(), `${label}: shortcut TargetPath: ${shortcut.path}`);
    assert.equal(shortcut.WorkingDirectory, installed, `${label}: shortcut WorkingDirectory: ${shortcut.path}`);
  }
  assert.equal(registration.protocolCommand, `"${stub}" "%1"`, `${label}: butler protocol command`);
}

// Hosted runners measure 0.13-0.17 s of CPU per 10 s idle window across all rows.
const IDLE_CPU_SECONDS_BUDGET = 0.5;

export function assertIdle(result: Awaited<ReturnType<typeof measureIdleProcesses>>) {
  const rows = result.idleProcesses;
  const named = (name: string) => rows.filter(row => row.name.toLowerCase() === name);
  for (const name of ["butler.exe", "butler-agent.exe"]) {
    assert.equal(named(name).length, 1, `Expected exactly one ${name}: ${JSON.stringify(named(name))}`);
  }
  const unmeasured = rows.filter(row => row.cpuSeconds === null);
  assert.deepEqual(unmeasured, [], `A process started or restarted during the idle window: ${JSON.stringify(unmeasured)}`);
  const hosts = named("butler_cef_host.exe");
  const untyped = hosts.filter(row => row.type === null);
  assert.deepEqual(untyped, [], `butler_cef_host.exe rows must be --type= subprocesses: ${JSON.stringify(untyped)}`);
  assert.ok(hosts.length <= 3, `At most 3 butler_cef_host.exe processes expected: ${JSON.stringify(hosts)}`);
  const total = rows.reduce((sum, row) => sum + (row.cpuSeconds ?? 0), 0);
  assert.ok(total <= IDLE_CPU_SECONDS_BUDGET, `Idle CPU ${total}s over ${result.windowSeconds}s exceeds ${IDLE_CPU_SECONDS_BUDGET}s: ${JSON.stringify(rows)}`);
}
