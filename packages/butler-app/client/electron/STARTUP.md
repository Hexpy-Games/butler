# Desktop startup and installer branding

Tracking: [#480](https://github.com/Hexpy-Games/butler/issues/480),
[#481](https://github.com/Hexpy-Games/butler/issues/481).

## Runtime contract

`bootstrap.mjs` registers the renderer scheme and acquires the single-instance
lock before readiness. As required by [Electron ESM ordering](https://www.electronjs.org/docs/latest/tutorial/esm),
the ready handler is registered without top-level-awaiting readiness. Its first action is creating the
small, frameless startup window. The existing runtime module graph is dynamically
imported after the native window is shown. Squirrel lifecycle invocations and
helper processes bypass the splash; `--squirrel-firstrun` does not.

The startup renderer is a separate Vite entry (`startup.html`), composed from DS
Box, Stack, Typo, ButtonContainer, Button and ButlerThinkingMark. It follows the OS
color scheme and reduced motion. The renderer's explicit DS reduced-motion scope
is mirrored to the native profile for the next launch. No new OS-specific window
flags are introduced.

Stages reflect actual waits: preparing, agent, legacy upgrade, renderer. Agent
startup retains the supervisor's 120-second budget; other stages have a 30-second
budget. Errors and expired budgets keep the same window open. Retry relaunches
through the existing graceful quit path. Logs exports the existing setup
bridge's diagnostics plus bounded startup timing records, without settings,
credentials, conversations or raw agent logs.

The main window remains hidden until the healthy agent's fresh settings, model
catalog, navigation and selected conversation (after saved-selection restoration)
are loaded and two animation frames have passed. First-run and legacy-recovery
screens signal their own usable paint. The main window is shown before the splash
is destroyed. Late readiness cannot dismiss a failed splash. There is no minimum
splash duration. Update restarts use the same bootstrap entry.

## Critical path and measurement

Before this change, `main.mjs` loaded its runtime/update/supervisor module graph
and synchronous setup before `app.whenReady()`. The readiness callback awaited
DevTools installation, then `createWindow()` awaited agent health and native
shell settings **before constructing any BrowserWindow**. The resulting blank
period therefore included the entire agent startup budget (up to 120 seconds),
not just renderer loading. This is a source-based explanation; it is not a
measurement of the owner's installation.

The new path removes those prerequisites to the first native window, removes the
DevTools await, and overlaps shell-preference loading with renderer preparation.
It keeps migration, health checks, data loading and update behavior intact.

| Step / event | Source | Timing |
| --- | --- | --- |
| Process creation → JS entry | `startup-window.mjs:8`, `bootstrap.mjs:7` | `entry.elapsed_ms` |
| Electron ready | `bootstrap.mjs:26`, `startup-window.mjs:73` | `app_ready.elapsed_ms` |
| First native window shown | `startup-window.mjs:85` | `splash_shown.elapsed_ms` |
| DS mark first paint | `src/startup.tsx` → `butler:startup-painted` | `splash_painted.elapsed_ms` |
| Runtime module graph | `bootstrap.mjs:28` | `runtime_imported - runtime_import_start` |
| Agent preparation / health | `main.mjs:2079` | `agent_ready - agent_starting`, intermediate preparation events |
| Renderer load and migrations | `main.mjs:2166` | `renderer_loaded`, `migration`, `renderer` |
| Fresh data paint → reveal | `startup-window.mjs:50`, `main.mjs:2186` | `renderer_data_painted`, `ready` |

Times use Electron's OS process-creation timestamp, then a monotonic clock.
Unavailable creation time produces `null`, never a fabricated timing.
`tests/smoke/startup-splash.ts` saves the complete ordered event list and window
screenshots, asserts the native-window handoff and the **<300 ms DS-paint target**.
Its gateway is deliberately gated and stubbed; its total ready time is not a
bundled-agent or owner-scale cold-start result.

## Owner preview and installer asset

Build the static interactive viewer with `bun run --cwd packages/butler-app/client/ui build:ds-site`.
Output: `packages/butler-app/client/ui/dist-ds-site/`.
Serve that directory and open
`/?page=patterns/startup&theme=dark&locale=ko&motion=reduced`.
The toolbar controls theme/locale/motion; stage controls include error, retry and
log-export feedback. Preview actions do not relaunch or export desktop data.

Generate the installer GIF with
`bun run packages/butler-app/client/electron/scripts/render-install-animation.ts`.
It requires Playwright Chromium and ffmpeg, renders the production DS drawing
functions with a seeded simulation at exactly 20 Hz, and returns to the idle mark
before looping. No screenshots sampled from a wall-clock animation are used.

Asset: `assets/butler-install.gif`, 192×192, 80 frames, 20 fps, **255,631 bytes**.
Two local generations were byte-identical (SHA-256
`f9b8942980b0cfc808d856403add3445da43373d312287382e30152ac6a94418`).
`create-windows-installer.mjs` passes it as `loadingGif`; `setupIcon` remains the
existing Butler ICO. Both release and installer workflows call this script.

## Platform evidence still required

Electron exited with SIGABRT in the local macOS sandbox, including with
`--single-process`; no application timing was captured. No native cold-start timings, baseline timings,
owner-scale readiness comparison, or <300 ms qualification are claimed here.

The existing Windows installer workflow has a `hosted-only=true` option so this
feature can be built and installed without touching the owner's Windows PC.
Use that option when dispatching it on this branch. It preserves the existing
install/update/uninstall assertions and captures installation frames through the
platform-layer script, uploaded as `startup-installer-evidence`. The macOS package
workflow uploads `macos-startup-evidence`. Frames must be inspected to establish
that the real installer displayed the Butler motion, including DPI behavior.

This worktree's shared Git metadata rejected both `FETCH_HEAD` and `index.lock`
writes. Changes must be committed/pushed by the runner before either workflow can
verify them. No workflow was dispatched against stale remote code.


## Local validation (2026-10-03)

- Frozen dependency install, `bun run check` (including DS and motion lint),
  packaging checks, Rust formatting, platform clippy with `-D warnings`, and the
  Rust source-check ratchets passed.
- Related DS/protocol tests: 63 passed, 2 existing skips. Supervisor/stop/update/
  Squirrel tests: 70 passed. Native Agent `ci-fast` build passed.
- `startup-viewer.ts`: real built splash stages, actions, both themes, OS and
  persisted motion overrides, overflow and the interactive static viewer passed.
- Full DS navigation was blocked by `TargetClosedError`; layout failed at
  `tests/smoke/app-layout-smoke.ts:1963` (permission popover outside-click dismissal).
  Both failures reproduced against an isolated, freshly built archive of the
  unchanged HEAD `124e4dadf4a1eb69e66bd05f4b1915fc54783614`. Assertions and budgets
  were not changed. Related existing issues: #459 and #389 respectively.
- Native launch timing, retry after an actual native failure, update-restart
  splash, hosted installer frames, and 100–200% DPI acceptance remain unverified.
