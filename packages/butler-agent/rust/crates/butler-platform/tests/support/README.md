# Windows sandbox desktop harness

This is a development harness, not an installed service. Use the existing Windows
Rust/MSVC and static ORT toolchain. Never run setup/install actions or change
registry, startup, Task Scheduler, services, firewall or Credential Manager.
All agent/test processes use temporary profiles. Keep `C:\actions-runner*` out of
this workflow.

## Build and self-check over SSH

From a clean checkout, with `CARGO_TARGET_DIR`, `CARGO_HOME`, `RUSTUP_HOME`,
`ORT_LIB_PATH` and `PROTOC` set to the existing build caches/tools, run:

```powershell
.\rebuild-windows-sandbox-harness.ps1 -Destination C:\Users\yeonw\work\windows-sandbox-e2e
```

The script builds only the agent, sandbox helper and E2E harness. It runs SSH row
16, packages resources and the TOOL-01 stub cassette, hashes every payload file,
and **always** runs `bundle-self-check.ps1` before publishing the pins. The check
uses an absent source workspace to catch dependencies on deleted build paths.
It runs each actual automated row with `BUTLER_E2E_SETUP_ONLY=1`, stopping at
an explicit boundary before the first desktop-dependent operation. This covers
installation/resources, fixture files, Unicode projects, helper policy, tool
staging and ledger paths; agent rows also start the real agent and load their
cassettes. The full desktop entry point always clears the setup-only flag. Tool admission and row 16 run from
the shipped bundle. No MXC process is launched by this setup check. Interactive
behavior and latency remain the desktop matrix's responsibility.

Build logs: `build-logs\<rev>\`; self-check results: `checks\<rev>\self-check.json`.
Failed setup prevents publication. Published `bundles\<rev>\` directories are
immutable; a rebuild of an existing revision fails. Keep build output until
checks finish, then remove the task's target and temporary profiles. Preserve
published bundles, pins, requests and evidence.

## Start once, then request remotely

In the owner's normal, non-admin desktop session, double-click
`C:\Users\yeonw\work\windows-sandbox-e2e\start-desktop-runner.cmd` once. Leave the
visible console open. A process-scoped kill-on-close Job Object stops the matrix
and its descendants when the console closes, including children without consoles.
There is no installation, autostart, registry entry or scheduled task.

The builder and SSH operator are trusted writers of this harness directory.
`pins\<rev>.json` is the build-produced trust manifest outside the immutable
payload. Hashes provide integrity against stale, partial or modified bundles;
they are not signatures against an attacker who can replace both pins and code.
The consumer validates all files (including scripts, resources and cassettes),
rejects traversal/reparse paths and refuses unpinned payload files.

Protocol:

1. `rev` is the exact lowercase, 40-character Git commit SHA. After its pins are
   published, atomically rename an empty `<rev>.tmp` to `requests\<rev>.req` over
   SSH. File contents are ignored and never interpreted.
2. The console polls file metadata every two seconds. An exclusive file handle
   prevents multiple runner consoles; each matrix completes before another starts.
3. The full existing matrix runs in a separate PowerShell process with fresh
   temporary HOME, USERPROFILE, BUTLER_DATA, APPDATA, LOCALAPPDATA and TEMP.
4. Response: `%LOCALAPPDATA%\Butler\e2e-results\<rev>.json` in the desktop user's
   original LOCALAPPDATA, with per-row logs beside it. A response has `revision`,
   `startedUtc`, `status`, `rows` and diagnostics. Only a fresh matching response
   acknowledges the request by moving it to `requests\done\<rev>.req`.
5. Hash mismatch or invalid names are logged once and left pending. After repair,
   replace/touch the request to retry. Interrupted runs without a fresh response
   also remain pending. Recreate a completed request to explicitly rerun it.

For a bounded transport diagnostic, `desktop-runner.ps1 -Root <root> -Once` scans
once and exits. It uses the same verification and dispatch path; SSH cannot
satisfy the matrix's Medium-IL interactive WinSta0 gate.

Row 13 retains `MANUAL_REQUIRED` for the existing elevated WFP comparison; the
runner never elevates or changes firewall state. A PASS for automated rows does
not certify row 13. Failed matrix profiles are reported in `failureDirectory`;
collect evidence before removing only those task-owned directories.
