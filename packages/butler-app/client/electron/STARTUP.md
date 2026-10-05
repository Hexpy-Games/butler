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
`generate-lifecycle-stills.ts --check`. Both window and still size budgets
remain enforced. The bundled still generator currently rejects Dusk light
(108,594 bytes), Stipple light (283,144) and Stipple dark (175,360), exceeding
80 KiB at the required size and quality. Full app builds and native timing
acceptance are therefore blocked until this design constraint is resolved.

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
