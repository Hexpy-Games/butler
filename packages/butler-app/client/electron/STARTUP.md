# Desktop lifecycle windows

Tracking: #480 and #481. The binding design is
`origin/design/lifecycle-windows:plans/lifecycle/lifecycle-windows-spec.md`.

Startup and Quit share a local, prerendered DS page in `dist/lifecycle/`.
Each native window is 360×264, with a 296px opaque raised card, a 48px mark,
and desktop typography and controls. Startup paints before runtime imports;
main-window data paint reveals the main window before destroying startup.
Quit creates its window on demand. Force quit remains disabled.

Canonical appearance comes from one indexed, read-only settings-row query,
with zero busy timeout. Matching user stills take precedence over bundled
720×528 WebP stills. No wallpaper uses the DS base surface. Still caches are
change-driven and keyed by source, tone and, where relevant, day phase.

Build inputs are checked by `lifecycle-window-build.ts --check` and
`generate-lifecycle-stills.ts --check`. Both window and still budgets remain enforced. Each 720×528 WebP is at most
320 KiB and must decode through renderer `createImageBitmap` in at most 15 ms,
with dimensions and file integrity checked. The generator uses quality 0.8
for Stipple and 0.9 for the other modules. The byte cap replaces the former
80 KiB cap; the splash paint budget remains 300 ms.

`measure-startup.mjs --runs 5 --json <file> <executable>` measures five cold
and five warm profiles. It reports median/p95, including painted minus ready.
It redirects HOME, BUTLER_DATA, USERPROFILE, APPDATA, LOCALAPPDATA and temp
paths; disables shell registration and system secrets; quits through the CLI;
and removes profiles after each mode. Cold profile does not mean cold OS cache.
Use only a task-built executable, never the owner's installed application.

Lifecycle diagnostics retain at most five privacy-safe JSON files, mode 0600,
and reveal the saved file. They exclude raw exceptions, settings and paths.
Retry stops the partially started agent, then relaunches and exits.

The installer GIF uses the DS mark engine at 20 Hz: 10 hold, 50 working and
65 settling frames. Two generated outputs matched byte-for-byte:
556,525 bytes, SHA-256
`ea6c5e0702ae60ca90259019a7fbf9a8e08b73fb35e28281f1262ac8a6ab9f3d`.

## Native continuation evidence (2026-10-06)

The frozen preload bridge previously received its readiness hooks after
`Object.freeze`; both hooks are now defined before freezing. Native smoke
inspection confirmed their availability. Hidden startup and main renderers
keep frame scheduling enabled until fresh data paints. Packaged Mac UI lookup
now includes the same native payload layout used on Windows.

The Playwright Electron inspector handshake stalled under Bun; native smoke
entry points now hand execution to Node. Separately, `measure-startup.mjs`
incorrectly selected external-server mode through `BUTLER_APP_SERVER_URL`,
so no App-owned Agent started. It now selects only a loopback port and reads
structured timing events from both output pipes. Ten real Mac launches
completed after that correction (no live model calls).

| Mac direct launch | Runs | app_ready median / p95 (ms) | splash_painted - app_ready median / p95 (ms) |
| --- | ---: | ---: | ---: |
| Cold isolated profile | 5 | 385.430 / 820.438 | 328.257 / 577.005 |
| Warm same profile | 5 | 379.392 / 417.896 | 338.237 / 366.846 |

Raw structured events and summaries are in
`plans/lifecycle/evidence/startup-mac.json`. The 300 ms paint budget **fails**.
Cold means a fresh profile, not an evicted OS disk cache. The ad-hoc signed
Mac verification package used the existing classic icon; the modern Icon
Composer build was unavailable because local actool requested Xcode first-run
setup. No system configuration was changed.

Still output: 19 images, maximum 218,462 bytes. Light/dark Stipple quality
comparisons are stored alongside this evidence. The final renderer decode
check measured Stipple light at 15.2 ms; `bun run check` **fails**, retaining
the 15 ms assertion. Earlier native startup fixture timings were 2369.119 ms
on Mac and 385.798 ms on Windows; both failed the 300 ms assertion despite
functional main-window handoff.

Mac normal Quit showed feedback and exited, but failed the 200 ms show budget
(332.884 ms in the later run). The blocked storage smoke exited before its
15.5 s observation, so its timeout caption and full-queue recovery remain
unqualified. The native error smoke produced the error surface and Open log
diagnostics, but failed to observe a new foreground instance after Retry.
These are acceptance failures, not successful completion.

The installer asset is 192×192, 125 frames / 20 Hz. Preview evidence was posted
to #481 (comment 6007838879); actual hosted installer/DPI captures remain
pending. No installer ran on the owner Windows PC. Protocol-registry exports
were equal before and after each native-host job.

Publication was rejected by GitHub GH013: ref creation is restricted. The
original `codex/lifecycle-windows-impl` branch had already been deleted, so no
existing-ref fallback was available. No PR, tag, merge or hosted Windows CI
was created. Native verification used a Git bundle in the task-owned Windows
worktree while publication was unavailable.
