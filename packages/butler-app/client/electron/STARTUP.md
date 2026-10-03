# Desktop startup

Tracking: [#480](https://github.com/Hexpy-Games/butler/issues/480),
[#481](https://github.com/Hexpy-Games/butler/issues/481).

## First window contract

The splash is a **separate 340×280 frameless BrowserWindow**. `bootstrap.mjs`
constructs it as the first action after recording Electron `ready`, before
importing `main.mjs`, starting the agent, migrating storage, or creating the main
window. Single-instance ownership and protocol registration precede readiness.
Squirrel maintenance and menu-bar helper invocations bypass the splash.

The window loads **local `startup.html`**, plain CSS and a tiny script. It loads
no React, DS runtime, app bundle, font file, HTTP URL or shader. A local Butler
mark pulses in CSS; OS or saved reduced motion stops the animation. The selected
wallpaper and mark decode before two animation frames and the native reveal, so
there is no visible empty window or white flash. `roundedCorners` uses Electron's
platform default handling; native corner/shadow behavior still needs OS review.

The main window stays hidden through agent health, migrations and fresh bootstrap
data. Its existing data-paint signal reveals it before destroying the splash.
There is no minimum splash duration. Error, retry and diagnostic export remain
on the same small window. The static renderer cannot navigate or open windows.

## Current wallpaper without starting the agent

Settings → 모양 is persisted in the **canonical `app_settings` table**, key
`settings`, not a standalone wallpaper JSON file. Electron reads that row using
Node's bundled SQLite, read-only with a zero busy timeout. It resolves the same
`BUTLER_APP_SERVER_DB` / `gateways/app.json.config.dbPath` / default
`app-server/butler-client.sqlite` path as the gateway. No migrations, full-table
scan, database copy or renderer cache is involved. Gateway JSON is bounded to
64 KiB. The DB projection selects only wallpaper and the legacy wallpaper kind;
credentials and unrelated settings are never logged or sent to the splash.

Built-ins use the existing checked-in 320×200 DS poster frames, copied by the
Vite asset plugin into **both** app dist and `dist-ds-site`. Animated backgrounds
never compile a shader. Dusk, Shoreline and photo scenes use the same artwork in
light and dark. A dark DS solid surface covers the mark and status in both
schemes. Uploaded images use their existing bounded raster thumbnail. None,
unknown/custom modules without a poster, unreadable settings, and unavailable
assets fall back to the DS Bloom brand poster. Parameter-customized built-ins
currently use that module's standard poster; they do not reproduce custom shader
parameters at startup. This is a still approximation, not the full live scene.

The owner preview at `/?page=patterns/startup` embeds the **actual shipped static
document**, with all ten standalone built-in wallpapers plus None, stages,
failure actions and motion/theme controls. Image/Grain are image filters rather
than standalone wallpapers. Build with:

```sh
bun run --cwd packages/butler-app/client/ui build:ds-site
```

The existing `packages/butler-app/client/ui/dist-ds-site` is rebuilt in this worktree.

## Why even a dedicated Electron window cannot appear immediately

1. **Electron/Chromium process startup before `ready`.** BrowserWindow cannot be
   constructed before Electron initialization. A separate static window removes
   our prerequisites, not that native initialization cost. See
   [Electron BrowserWindow](https://www.electronjs.org/docs/latest/api/browser-window).
2. **First launch after install/update.** Gatekeeper verification of downloaded,
   un-notarized preview builds can delay launch or require user approval before
   our code executes. This first-launch/install/update cost is distinct from a
   warm launch. XProtect may also rescan when signatures change, so “only once”
   is not an absolute security-system guarantee. See
   [Apple Gatekeeper](https://support.apple.com/guide/security/sec5599b66df/web) and
   [malware protection](https://support.apple.com/guide/security/sec469d47bd8/web).
3. **Our previous main-process work.** Before this branch, static runtime imports,
   synchronous setup, DevTools, native shell settings and agent health all
   preceded the first BrowserWindow. The branch split bootstrap from those
   prerequisites; this follow-up also removes the React/DS entry and avoids
   importing the runtime until the complete splash frame can be shown.

## Timing records and external Mac measurement

The existing `{"startup": ...}` console log now carries epoch `timestamp_ms` and
monotonic `elapsed_ms` from Electron's OS-reported process creation, to three
fractional digits (not a claim of microsecond OS accuracy). Events include
`process_start`, `entry`, `will_finish_launching`, `app_ready`,
`appearance_read_start/end`, `splash_ready_to_show`, `splash_painted`,
`splash_shown`, `runtime_import_start/imported`, `renderer_data_painted`,
`main_window_ready`, and `window_ready`. If process creation time is unavailable,
elapsed time is null. The existing `app/runtime/foreground/startup-progress.json`
record includes the ordered timing list once the runtime begins recording
progress, including early bootstrap events. Exported startup diagnostics include
that same list. `splash_painted` is decoded content plus two rAFs;
`splash_shown` is the native show call, **not an OS compositor presentation probe**.

Run the built executable **outside the sandbox**, never the owner's installed app:

```sh
node packages/butler-app/client/electron/scripts/measure-startup.mjs \
  "$PWD/packages/butler-app/client/electron/dist/Butler-darwin-arm64/Butler.app/Contents/MacOS/Butler"
```

The script creates temp HOME/BUTLER_DATA/profile directories in TMPDIR, selects a
non-production port, launches once with a fresh profile and again with the same
profile, prints all timestamps relative to process creation and launch request,
then terminates only its own child through the normal quit path and cleans up.
It overrides the DB path as well. It prints a failure if main readiness is absent.
“Cold-profile” does **not** mean OS disk caches were purged. Direct executable
launch does not measure Finder/LaunchServices Gatekeeper verification. For a new
quarantined install/update, separately time the normal Finder launch; do not
remove quarantine or disable verification to improve the reported number.

If Electron pre-ready plus observed install verification alone exceeds ~1 s on
this Mac, propose a **tiny native launcher/pre-splash in `butler-platform`**:
show a native image/surface first, launch Electron, and close it on an authenticated
ready signal. This has not been implemented. It adds platform-specific window,
accessibility, focus, single-instance, failure/quit handoff and signing/updater
ownership. It cannot bypass Gatekeeper: its executable must also be verified.
A separately notarized launcher may improve steady launch feedback, at the cost
of another distributed binary and lifecycle. Measure before accepting that cost.

## Verification on this follow-up

- The isolated configuration/packaging smoke reads actual SQLite settings for
  every built-in, None and an unknown module; proves indexed access, correct
  selected IDs, scene tone parity, fallback and the dependency-free package.
  Final 12 reads: median **0.264 ms**, max **0.606 ms** (small isolated DB;
  not an owner-scale DB or complete first-frame measurement).
- `tests/smoke/startup-frame-cost.ts` compares each complete bundled poster with
  a one-pixel control in fresh browser contexts, five rounds. It verifies the
  requested image, mark, status, overflow and local-only dependencies on every
  timed sample. Output is `.tmp/startup-evidence/background-cost.json`.
- In this sandbox, Chromium and Electron abort with SIGABRT even with the supplied
  `--single-process` argument. **Background first-frame delta, native cold/warm
  timings, the <300 ms native smoke budget, and visual OS acceptance remain
  unavailable.** The assertions and budget are unchanged. Run the checked-in
  browser and native smokes outside the sandbox before claiming those outcomes.

Installer GIF and installer configuration remain as on the parent branch.
