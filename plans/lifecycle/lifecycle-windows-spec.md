# Lifecycle windows: startup and quit (#480, #481)

**Status:** design approved by the owner on 2026-10-05 (variant A, solid card, DS buttons and typography).
**Start from:** latest `origin/main`. Rebase or replace the WIP on `codex/startup-splash` and `codex/quit-feedback`; reuse their timing instrumentation, supervisor changes and smokes, not their HTML/CSS.
**Design source (read it, copy from it):** `packages/butler-app/client/ui/ds-site/proposals/lifecycle-windows/` on branch `design/lifecycle-windows`.
Review page: build the DS site, open `?proposal=lifecycle-windows`. Real window: `node packages/butler-app/client/ui/ds-site/proposals/lifecycle-windows/electron-preview.mjs`.

| Proposal file | What it is for Codex |
| --- | --- |
| `LifecycleWindow.tsx` | The window composition and `lifecycleContent()` (state → title, line, detail, caption, actions). Port it as is. |
| `copy.ts` | `WINDOW_COPY` (ko/en) and `I18N_KEYS`. The source of the i18n keys below. |
| `state.ts` | States, window size, mark rule (`markWorking`). |
| `Stage.tsx` | How one window renders at 100vw × 100vh, the play sequence, contentRect measuring. |
| `Backdrop.tsx` | `still` (recommended) vs `poster` (today's codex behaviour, comparison only). |
| `render-install-gif.ts` | The installer GIF generator to adopt (§9). |
| `electron-main.mjs` | Window flags used for the owner preview (frameless, shadow, rounded corners). |

Two windows, one family. Both are static pages, not the app bundle:

- **Startup window**: shown first on every normal launch; closes when the main window has painted fresh data.
- **Quit window**: shown while a normal Quit runs; closes when the process exits.

Out of scope: Squirrel maintenance launches, the menu-bar helper process, update-install confirmation (unchanged), Linux.

---

## 1. Design (what must ship)

Window: **360×264** content size (macOS points / Windows DIPs), frameless, not resizable, not maximizable, not fullscreenable, native shadow, platform rounded corners, title `Butler`, appears in the Dock/taskbar.

Layout, top to bottom:

1. **Backdrop**: the user's wallpaper still fills the window (§4). With wallpaper `none`, the backdrop is `Box surface="base"` (what the main window shows with no wallpaper).
2. **Card**, centred: outer width 296 px (one `--space-lg` window inset on each side is the remaining 32 px), height hugs content. Surface = the DS solid card (§2.2): opaque `--color-surface-raised-opaque`, hairline `--line` border, `--radius-panel`, `--space-lg` inset, `--shadow-card`.
3. Inside the card, `Stack gap="md" cross="center"`:
   - **Mark**: `ButlerThinkingMark`, 48×48 (needs `size="3xl"`, §2.4), `theme` passed explicitly.
   - **Text** `Stack gap="xs" cross="center"`: title, then one of stage line / detail, then optional caption.
   - **Actions** (only some states): `ButtonContainer size="sm" justify="center" windowDrag="no-drag"` with `Button size="sm"`.

The whole window is a drag region (`windowDrag="drag"`); buttons stay clickable (`.drag-region button`).

Typography (desktop ramp, measured in the approved proposal):

| Element | Component | Tokens (size / line height / weight) |
| --- | --- | --- |
| Title | `Typo.AppTitle tone="primary" align="center"`, never `truncate` | `--typo-app-title-*`: 15px / 1.4 (21px) / 620 |
| Stage line | `RollingStatusLine role="status" aria-live="polite"` › `RollingSwap itemKey={stage}` › `Typo.Body tone="secondary"` | `--typo-body-*`: 14px / 1.45 / 400 |
| Failure detail | `Typo.Body tone="secondary"` (wraps) | same as body |
| Slow caption | `Typo.Caption tone="tertiary"` | `--typo-caption-*`: 12px / 1.45 / 400 |
| Buttons | `Button size="sm"` | height `--control-height-sm` 28px, padding 0 10px, `--font-size-3` 14px; gap `--space-sm` 8px |

Korean wraps between words (`:lang(ko)` keep-all from tokens.css, app-title keep-all); set `<html lang>` from the locale. The longest one-line strings measured 220px (KO stage) and 212px (EN stage) against a 264px text column: nothing truncates. A new string longer than 264px at 14px is a copy bug, not a layout change.

Mark motion: `working` in every state except startup `error` and quit `failed` (still logo). Reduced motion (OS, or the saved Wallpaper motion "paused") uses the mark's own still-logo breathe. The mark is one mounted element; flip `state`, never remount.

### States

Startup (`lifecycle.startup.*`):

| State | Title | Line / detail | Caption | Actions |
| --- | --- | --- | --- | --- |
| `prepare`, `service`, `screen`, `upgrade`, `data` | `startup.title` | stage line `startup.stage.<stage>` | — | — |
| slow (any stage > 8 s) | `startup.title` | current stage line | `slow` | — |
| `error` | `startup.failed` (role=alert) | detail `startup.reason.<failed stage>` | — | `[openLog]` secondary, `[retry]` default |

Quit (`lifecycle.quit.*`):

| State | Title | Line / detail | Caption | Actions |
| --- | --- | --- | --- | --- |
| `saving` … `finishing` | `quit.title` | stage line `quit.stage.<stage>` | — | — |
| `timeout` (> 15 s) | `quit.title` | current stage line, still live | `slow` | `[openLog]` |
| `failed` | `quit.failed` (role=alert) | — | — | `[openLog]` |

**Force quit is behind the flag `lifecycle.forceQuit`, default off, and stays off until the supervisor has `forceStop()` (§6.4).** With the flag on: `timeout` drops the caption and shows `[openLog] [forceQuit]` (destructive, Tooltip + `aria-description` = `quit.forceHint`); `failed` shows detail `quit.forceHint` and `[openLog] [forceQuit]`. This is exactly `lifecycleContent(kind, state, copy, forceQuit)` in the proposal.

Light/dark: the window theme equals what the main window will show first: app theme setting → wallpaper scene tone (`wallpaperSceneTone`) → OS (`nativeTheme`). Scene/photo wallpapers keep one look in both themes; only the card follows the theme.

---

## 2. DS changes (owner-approved; do these first, in the DS, with showcase/guidance/README per the DS skill)

DS primitives are otherwise frozen. Each item: tests first where the DS has them, update showcase + `<Name>.guidance.tsx` + README, regenerate the skill catalog (`bun run ds:skill-catalog`), shrink any baseline it frees.

### 2.1 Desktop viewport scope

Problem: every DS `(width <= 640px)` rule fires in a 360px desktop window as if it were a phone. It grows the type ramp (`tokens.css` phone block, around lines 758-795: body 14→16, app title 15→17, caption 12→14, `--font-size-3` follows body) and gives buttons a 44px floor (`--control-hit-target`, tokens.css ~663-667; `Button.module.css` ~163-166 `min-height: var(--control-hit-target)`).

Add a scope like the existing `[data-motion="reduced"]`:

- `[data-viewport="desktop"]` re-declares, with their desktop `:root` values, every token the `(width <= 640px)` and `(width <= 640px), (pointer: coarse)` `:root` blocks override, plus every token derived from one of them (e.g. `--font-size-3: var(--typo-body-size)`), so they re-resolve inside the scope.
- Every DS component rule under `@media (width <= 640px)` (Button, IconButton, Typo `data-align-with`, Stack `compactGap`, inputs, …) must be inert inside the scope. Preferred mechanism: guard those rules with `:not([data-viewport="desktop"] *)`, or move the floor to a token the scope resets. A coarse pointer must still get the 44px floor (`(pointer: coarse)` is not disabled by the scope).
- Export a tiny helper/attribute contract (e.g. `desktopViewportScope = { "data-viewport": "desktop" }`) and document: "Use only for desktop windows narrower than 640px (lifecycle windows). Never in the main window."
- The proposal emulates this in `LifecycleWindow.tsx` (`DESKTOP_SCOPE`: parses tokens.css, sets `--control-hit-target: 0px`). Delete that emulation when the scope exists.
- Test (format-pin or DS contract test): inside the scope at a 360px viewport, `Button size="sm"` measures 28px tall, `Typo.Body` 14px, `Typo.AppTitle` 15px, `Typo.Caption` 12px.

### 2.2 Public opaque surface

The approved card is the DS's existing "solid card over wallpaper" recipe, today private to `SetupWizardContent surface="solid"` (`SetupWizardShell.module.css` `.content[data-surface="solid"]`): `--color-surface-raised-opaque`, `var(--border-hairline) solid var(--line)`, `--radius-panel`, `--space-lg`, `--shadow-card`.

Make it public on `Box`: `surface="raised-opaque"` plus `elevation?: "none" | "card"` (`card` = `--shadow-card`). Re-implement `SetupWizardContent surface="solid"` on top of it (no visual change; screenshot-compare the first-run step). The lifecycle card is then:

```tsx
<Box surface="raised-opaque" elevation="card" border="hairline" radius="panel" padding="lg">…</Box>
```

(The proposal renders `Box surface="raised"`, 96% opaque, no shadow, as the closest public composition today.)

### 2.3 Wallpaper stacking

`Wallpaper` is `position: fixed; z-index: 0` (`Wallpaper.module.css`), and no public layout primitive lifts content above it; only blocks do it privately (`SetupWizardShell.module.css` `z-index: 1` on content). The proposal uses one labelled raw `<div style={{ position: "relative" }}>`.

Add a public layer contract: `Stack`/`Box` prop `layer="content"` (position relative, `z-index: var(--z-content)` with a new token, e.g. 1) or a tiny block `WallpaperStage` = `{ wallpaper: ReactNode; children }` that owns the backdrop layer and the content layer. Pick one, document "content over a Wallpaper", and migrate `SetupWizardShell` to it if it fits without visual change.

### 2.4 Mark size

`IconSize` stops at `2xl` (32px, `components/Icons/Icons.tsx`). Add `3xl: 48` and `--icon-size-3xl: 48px`; `ButlerThinkingMark size="3xl"` replaces the proposal's 48px `UNSAFE_style` wrapper.

### 2.5 Mark theme (small DS fix, do it)

`markLoop.ts` resolves the nearest `.theme-*` scope once at mount, so a theme class change keeps the wrong ink. Re-resolve when the scope class changes (MutationObserver on the scope element, or the existing theme subscription). Until then the window passes `theme` explicitly (it does in the proposal; keep it either way).

### 2.6 Export the still renderer

`renderWallpaperStill` (`blocks/Wallpaper/still.ts`) is not exported from `blocks/Wallpaper/index.ts`. Export it (and its size type) from `@/butler-ds`; §4 needs it in the app renderer.

---

## 3. Static prerender build (no React at runtime)

The window must load in ≤300 ms, so it ships as prerendered static HTML. Pipeline: one script, wired as a Vite plugin like today's `startup-assets` (`apply: "build"`), output into the app dist (`dist/lifecycle/`) and the DS site.

New: `packages/butler-app/client/ui/src/components/lifecycle/LifecycleWindowView.tsx` (port of `LifecycleWindow.tsx`, DS only, using §2 APIs; no app stores, no IPC) and `packages/butler-app/client/ui/scripts/lifecycle-window-build.ts`.

Build steps (Playwright Chromium, same pattern as `scripts/generate-wallpaper-posters.ts`):

1. Start a Vite dev server on the UI root, open a page that renders `LifecycleWindowView` inside `data-viewport="desktop"` at a **1280×800 viewport**, in a 360×264 container, once with **every slot present** (title, stage line, detail, caption, both buttons; mark canvas), for `theme-light`, and read the DOM.
2. Serialize the window subtree's markup. Mark each slot with `data-slot` (`title`, `line`, `detail`, `caption`, `secondary`, `primary`, `mark`).
3. Collect CSS: every rule from the page's stylesheets that matches a node in the subtree, the `:root`, `.theme-light`, `.theme-dark` token blocks the subtree uses (closure over `var()` references), `@keyframes` used, and `@media (prefers-reduced-motion)` / `[data-motion="reduced"]` rules. Drop every width-based `@media` rule. Inline into one `<style>`.
4. Font: subset Pretendard Variable to the glyphs of all `lifecycle.*` strings in ko and en plus digits/punctuation (pyftsubset or fonttools via the existing font pipeline if present; otherwise a small Bun script with `subset-font`), inline as a `data:` WOFF2 in `@font-face`. No font fetch, no fallback reflow.
5. Emit:
   - `dist/lifecycle/lifecycle.html`: markup + inline CSS + CSP `default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self' data: file:; font-src data:; connect-src 'none'`.
   - `dist/lifecycle/mark.js`: `Bun.build` of `ButlerThinkingMark/markLoop.ts` (minified IIFE exposing `startMarkLoop`; measured 8.9 KB). It draws into the `mark` slot canvas; the first frame is the idle logo, drawn before reveal.
   - `dist/lifecycle/state.js` (hand-written, vanilla, ≤3 KB): reads `copy.json`, applies `{kind, state, stage, locale, theme, reducedMotion, forceQuit}` from the preload bridge: sets slot text, `hidden` on unused slots, `role`, the theme class on `<html>`, `lang`, `data-motion`, button variant class (from the prerendered DS class names recorded in step 2 for default vs destructive), and calls the mark's state setter. Line changes animate by toggling the RollingSwap DS classes recorded in step 2 (outgoing/incoming frames); under reduced motion, swap instantly.
   - `dist/lifecycle/copy.json`: the `lifecycle.*` keys for ko and en, projected from `packages/butler-i18n` at build time.
   - `dist/lifecycle/manifest.json`: input hashes (view source, DS files used, tokens.css, i18n keys, font) for `--check`.
6. `--check` mode (run in `bun run check`): rebuild in memory and fail if outputs differ ("Lifecycle window is stale. Run …"), like `check-wallpaper-posters`.

Delete codex's `electron/startup/startup.{html,css,js}`, `electron/assets/lifecycle-tokens.css`, `lifecycle-mark.svg`, `sync-lifecycle-assets.mjs` and the HTML builder in `lifecycle-window.mjs`.

---

## 4. Wallpaper stills

The backdrop is the user's own wallpaper as the app draws it, at window size.

- **User still (primary).** In the app renderer, whenever the resolved wallpaper source, its params, the theme or (for day-phase modules) the 15-minute day phase changes, render `renderWallpaperStill(source, { width: 720, height: 528 }, tone)` (2× window) with the card rect as content rect, encode WebP (quality 0.9), and send it over a new preload IPC to main, which writes `<Electron userData>/lifecycle/still-<tone>.webp` plus `still.json` `{ sourceKey, tone, averageColor, rendered_at }`. Write only when `sourceKey`+tone changed (idle SSD writes must stay ~0). Render both tones only for sources whose look differs per tone; scene/photo sources write one file used for both.
- **Built-in fallback stills.** `scripts/generate-lifecycle-stills.ts` (copy of the poster generator) renders every built-in × tone at 720×528 with the card content rect; day-phase modules (shoreline) at 4 phases. Output `src/…/lifecycle/stills/*.webp` + `keys.json` with `averageColor`. Used on first launch, when the user still is missing/unreadable, or the stored source key no longer matches the settings row.
- **Choosing at startup (main process, before the window exists):** read the settings row read-only as codex's `startup-appearance.mjs` does (keep its single indexed query, zero busy timeout, 64 KiB gateway JSON bound). Pick user still if its `sourceKey` matches, else the built-in still for the module/tone/phase, else Bloom. Uploaded-image sources without a user still use the asset's existing thumbnail. Never read or log anything else from settings.
- `averageColor` is the native window colour (§5).

---

## 5. Electron windows

OS-specific behaviour (corner preference, DWM attributes, vibrancy) goes only through `crates/butler-platform` (#260); the Electron code uses common BrowserWindow flags.

### 5.1 Startup window creation and reveal

Keep codex's `bootstrap.mjs` order: register the scheme, single-instance lock, `app.whenReady()` → create the startup window **before** importing `main.mjs`. Then:

1. Resolve appearance (§4) and theme (§1) synchronously; record `appearance_read_start/end`.
2. `new BrowserWindow({ width: 360, height: 264, useContentSize: true, frame: false, resizable: false, maximizable: false, fullscreenable: false, show: false, hasShadow: true, roundedCorners: true, backgroundColor: averageColor ?? surfaceBase[theme], title: "Butler", webPreferences: { preload: lifecycle-preload.cjs, sandbox: true, contextIsolation: true, nodeIntegration: false } })`. `surfaceBase` = DS `--color-surface-base` per theme (light `#f8f9fa`, dark `#1f2023`), emitted into `manifest.json` by the build, not hard-coded.
3. Position: centred on the display and bounds where the main window will open (its saved bounds), else the primary work area.
4. Deny `window.open`, block navigation, no menu, no DevTools in packaged builds.
5. `loadFile(dist/lifecycle/lifecycle.html)` with the initial state in the query (`kind=startup&stage=prepare&locale&theme&motion&still=<file URL or data>`; the still path is validated main-side: only the userData lifecycle dir or bundled stills).
6. The page decodes the still (`img.decode()`), draws the mark's first frame, waits two rAFs, then calls `painted()`. Main records `splash_painted`, calls `show()`, records `splash_shown`. If `painted()` has not arrived within 300 ms of `ready-to-show`, show anyway (record `splash_forced_show`).
7. No minimum display time. Handoff: when the main window reports fresh data painted (codex's `renderer_data_painted` contract: navigation, settings, catalog, messages, then two rAFs), call `mainWindow.show()` then destroy the startup window in the same tick.

### 5.2 Stage mapping (startup)

| UI stage | Starts at | Ends at |
| --- | --- | --- |
| `prepare` | `app_ready` | `agent_starting` |
| `service` | `agent_starting` | `agent_ready` |
| `screen` | `agent_ready` | `renderer_loaded` (protocol + `loadURL`) |
| `upgrade` | legacy migration begins (only if it runs) | migration ends |
| `data` | `renderer_loaded` / after migration | `renderer_data_painted` |

Failure reason by the stage that failed: `service` → `reason.service`; `screen` → `reason.screen`; `data` or `upgrade` → `reason.data`; `prepare` → `reason.service`.

### 5.3 Timings

- A stage line stays visible at least **600 ms** before the next one replaces it (queue the newest; skip intermediate stages that finished during the dwell). The window itself has no minimum duration.
- **Slow**: a stage running longer than **8 s** shows the slow caption. Re-tune from host data (§8): `max(8 s, p95 × 1.5)` per stage, stored as constants with the measurement date.
- **Error**: keep codex's bounded waits (agent stage 120 s, others 30 s), plus immediate failure on `render-process-gone`, `did-fail-load`, agent exit during startup, or a fatal startup error.
- **Quit timeout**: **15 s** after Quit starts (replaces codex's 6 s copy change).

### 5.4 Retry and log

- **Retry** (startup error): stop any partially started agent through the normal supervisor stop (without showing the quit window), then `app.relaunch(); app.exit(0)`.
- **Open log** (startup error, quit timeout/failed): write `<BUTLER_DATA>/app/runtime/foreground/lifecycle-diagnostics-<UTC timestamp>.json` (mode 0600): timing list, stage, failed stage, supervisor diagnostics, platform/arch/version. No prompts, tokens, chat content or settings beyond wallpaper kind. Then `shell.showItemInFolder(file)`. Keep at most 5 such files (delete oldest). No save dialog.
- Keyboard: on error/failed, focus moves to the primary button (or Open log when it is the only one); Enter activates it; Esc quits the app from the startup error (normal quit path) and does nothing in the quit window.

### 5.5 Quit window

- Created **when Quit starts**, not preloaded (a hidden renderer for the whole session costs memory and wakeups). Same window options and page with `kind=quit`.
- Order: create + load (≈100–150 ms) → on `painted()` show the quit window, then hide the main window. Cap: if not painted within 300 ms, hide the main window anyway and show the quit window when painted. Position: centred over the main window's bounds.
- `closable: false`; the window is destroyed in `before-quit` when `finalQuitAllowed` (codex's flow).
- Stages from the agent's `[native-shutdown] phase=… edge=…` lines (codex's `quit-agent-trace.mjs`), resolved by priority on the set of active phases:
  1. `turn_drain` or `app_projection_join` → `saving`
  2. any phase containing `stor`, or `transcript_close` → `storage`
  3. any phase containing `embedding` → `search`
  4. `runtime_close` → `services`
  5. any `app_*` or `control_close` → `connections`
  6. `port_release` event → `finishing`
- `stopServerProcess` failure → `failed` (owner stays alive, as in codex's QUIT_PROFILE).

### 5.6 Force quit (flagged)

Not available until the supervisor has `forceStop()`: kill the App-owned agent child (`SIGKILL` / Windows terminate via butler-platform), mark the foreground instance not-clean, then `finalQuitAllowed = true; app.quit()`. Requires owner approval and an E2E proving restart recovery (queue intact, interrupted input retryable). Until then `lifecycle.forceQuit` is false and the UI never renders the button.

---

## 6. Copy keys (packages/butler-i18n, ko + en)

Add exactly these under `lifecycle`; the static build projects them into `copy.json`. Product name stays **"Butler"** in Korean for these keys (owner decision 2026-10-05). Remove the `quit*` strings from `electron/i18n/desktop-copy.mjs` that codex added.

| Key | ko | en |
| --- | --- | --- |
| `lifecycle.startup.title` | Butler 시작 중… | Starting Butler… |
| `lifecycle.startup.stage.prepare` | 준비하는 중… | Getting ready… |
| `lifecycle.startup.stage.service` | 백그라운드 서비스를 시작하는 중… | Starting the background service… |
| `lifecycle.startup.stage.screen` | 화면을 준비하는 중… | Preparing the screen… |
| `lifecycle.startup.stage.upgrade` | 데이터를 업데이트하는 중… | Updating your data… |
| `lifecycle.startup.stage.data` | 데이터를 불러오는 중… | Loading your data… |
| `lifecycle.startup.failed` | Butler를 시작하지 못했습니다 | Butler couldn't start |
| `lifecycle.startup.reason.service` | 백그라운드 서비스가 응답하지 않습니다. | The background service didn't respond. |
| `lifecycle.startup.reason.screen` | 화면을 열지 못했습니다. | Couldn't open the screen. |
| `lifecycle.startup.reason.data` | 데이터를 불러오지 못했습니다. | Couldn't load your data. |
| `lifecycle.quit.title` | Butler 종료 중… | Quitting Butler… |
| `lifecycle.quit.stage.saving` | 작업을 저장하는 중… | Saving your work… |
| `lifecycle.quit.stage.search` | 검색 데이터를 정리하는 중… | Wrapping up search data… |
| `lifecycle.quit.stage.storage` | 저장소를 닫는 중… | Closing storage… |
| `lifecycle.quit.stage.connections` | 연결을 닫는 중… | Closing connections… |
| `lifecycle.quit.stage.services` | 서비스를 정리하는 중… | Stopping services… |
| `lifecycle.quit.stage.finishing` | 마무리하는 중… | Finishing up… |
| `lifecycle.quit.failed` | Butler를 종료하지 못했습니다 | Butler couldn't quit |
| `lifecycle.slow` | 평소보다 오래 걸리고 있습니다. | Taking longer than usual. |
| `lifecycle.action.retry` | 다시 시도 | Try again |
| `lifecycle.action.openLog` | 로그 열기 | Open log |
| `lifecycle.quit.forceHint` (flag only) | 진행 중인 작업이 중단됩니다. | Work in progress will stop. |
| `lifecycle.action.forceQuit` (flag only) | 강제 종료 | Force quit |

Locale = the app's language setting (same source as the main window), else `app.getLocale()`.

---

## 7. Accessibility

- Stage line: `role="status"`, `aria-live="polite"`; failure title: `role="alert"`.
- Focus rules in §5.4; visible DS focus ring; buttons ≥28px with the desktop pointer (coarse pointer keeps 44px via §2.1).
- Destructive button has `aria-description` = force hint (flag only).
- Contrast: card text uses DS tones on the opaque surface; covered by the DS contrast test.
- Reduced motion: no mark morph, no line roll; still-logo breathe only.
- The window's accessible name is its title (`Butler 시작 중…` / `Butler 종료 중…`).

---

## 8. Startup timing plan

### 8.1 What `measure-startup.mjs` gives today (codex/startup-splash)

One cold-profile and one warm-profile run (fresh process each; fresh vs reused temp HOME/BUTLER_DATA/userData). Per run a table of startup events with `process_ms` (since OS process creation, `process.getCreationTime()`), `launch_request_ms` (since spawn) and `timestamp_ms` (epoch): `process_start, entry, will_finish_launching, app_ready, appearance_read_start/end, splash_ready_to_show, splash_painted, splash_shown, runtime_import_start/imported`, the agent stages, `renderer_loaded`, migration, `renderer_data_painted, main_window_ready, window_ready`. It prints a hint when `app_ready` > 1 s.

Not measured: Gatekeeper/Finder (direct executable launch), cold OS disk cache, on-screen presentation (`splash_shown` is the `show()` call), repeated samples, machine-readable output.

### 8.2 Script changes

- `--runs N` (default 5) per mode; print median and p95 per event and per stage interval (§5.2), plus `splash_painted − app_ready`.
- `--json <file>`: write all samples (no paths, no env).
- Add the new events: `splash_forced_show`, `stage_<name>_start/end`, `quit_*`.
- **Windows fixes:**
  - Override `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `TEMP`/`TMP` (all inside the temp root), not only `HOME`; `os.homedir()` reads `USERPROFILE` on Windows, so today a run can touch the real profile.
  - Stop through the normal quit path: `SIGTERM` is a hard kill on Windows. Send the app's quit IPC/CLI (`--butler-quit-main-ui`, which bootstrap already recognises) and wait for exit; `taskkill /T /F` only as the 15 s last resort, logged as `forced_stop`.
  - Accept the Squirrel layout: when given the root `Butler.exe` stub (or `Update.exe --processStart Butler.exe`), measure from the spawn of the stub; also support `app-<version>\Butler.exe` directly. Report both.
  - Spawn without a shell; quote paths; use `path.win32` when the target is `.exe`.
- Keep: never the installed owner app, temp dirs only, delete them at the end.

### 8.3 Mac host (built `.app`, outside the sandbox)

1. `measure-startup.mjs --runs 5` cold + warm → median/p95 of `app_ready`, `splash_painted − app_ready` (budget ≤300 ms, target ≤150 ms warm), `splash_shown`, each stage, `main_window_ready`.
2. Fresh quarantined install from the release zip/DMG, launched with `open -a`: wall-clock from just before `open` (`date +%s%3N`) to `splash_shown.timestamp_ms` in `app/runtime/foreground/startup-progress.json`. Includes Gatekeeper. Do not remove quarantine.
3. Repeat (1) with a synthetic owner-scale fixture: App DB ~1.3 GB, 600+ chats, ~300k events (generated, never copied from `~/.butler`). Confirms the settings read stays indexed and measures the `data` stage at scale.
4. `tests/smoke/app-quit-feedback.ts` normal and `--blocked`: main hide → quit window shown ≤200 ms; exit clean; queue recovered.

### 8.4 Windows host

1. Hosted `windows-latest` runner (`windows-installer.yml`, `hosted-only=true`): the §8.2 script, `--runs 5`, against the Squirrel stub and `app-<version>\Butler.exe`.
2. First launch after install (includes Defender scan): installer smoke records install end → `splash_shown`.
3. Installer GIF capture (`capture-installer.ps1`) at 100, 150 and 200% DPI.
4. Owner Windows PC numbers only when the owner asks: launch inside the interactive session (e.g. `schtasks /create … /it` + `/run`); an SSH session has no desktop and cannot show windows.

Decision rule: if `app_ready` p50 > 1 s on either host, evaluate the native pre-splash in codex's STARTUP.md before more JS work. Record all numbers in the PR and in the Project Ledger `butler` project.

---

## 9. Installer GIF (#481)

Replace codex's `electron/scripts/render-install-animation.ts` with the proposal's `render-install-gif.ts` (move to `electron/scripts/`), keep `loadingGif` wiring in `create-windows-installer.mjs` and the existing `setupIcon`.

- Frames from the DS engine itself: `MorphSim` + `drawFrame` from `ButlerThinkingMark/thinking-mark`, light inks (`RISO_INKS.light`), stepped at a fixed 20 Hz (deterministic).
- Tile 192×192: opaque DS `--grayscale-01` (read from tokens.css), corner radius 58/256 of the tile (app icon), transparent only outside the corners. Mark canvas 168px centred (ring ≈69% of the tile).
- Schedule: 0.5 s logo hold (10 frames), 2.5 s working (50), then settle until `sim.idle` (≈65 frames); the rest frame is not repeated. Total ≈125 frames, 6.25 s, ≈560 KB (budget ≤600 KB).
- Assert: settled; rest frame equals the first frame; GIF89a signature. Encode with ffmpeg palettegen 64 colours, `paletteuse=dither=none:alpha_threshold=128`, loop 0.
- Two runs must be byte-identical (record the SHA-256 in the PR).
- Known residual: a ~170px pop at the seam comes from the DS engine (halftone outline clip vs `drawRest`, `canvas-drawing.ts`/`morph-outline.ts`). Fix in the DS by blending the halftone into the rest logo below M < 0.05; then the generator needs no change.

---

## 10. Performance budgets

| Item | Budget |
| --- | --- |
| `lifecycle.html` (markup + inline CSS, excluding font) | ≤ 20 KB |
| Inline font subset | ≤ 40 KB |
| `mark.js` | ≤ 10 KB |
| `state.js` | ≤ 3 KB |
| Still (720×528 WebP) | ≤ 80 KB each |
| `splash_painted − app_ready` | ≤ 300 ms (target ≤ 150 ms warm Mac) |
| Settings read for appearance | indexed single row, no scan, ≤ 5 ms at owner scale |
| Quit: Quit start → quit window shown | ≤ 200 ms (existing smoke) |
| Idle disk writes | none from lifecycle code (stills only on wallpaper/theme change) |

The build fails when a size budget is exceeded.

---

## 11. Verification (smokes and E2E only; no UI unit tests, no pixel sampling, no screen recordings)

1. **DS:** the §2.1 contract test; DS showcase coverage test; `bun run lint:design`, `lint:css`, `lint:ds`, `lint:motion`; `bun run app:design-system:smoke`.
2. **Static window smoke** (extend `tests/smoke/startup-splash.ts` / replace `app-quit-window.ts`): load `dist/lifecycle/lifecycle.html` at a 360×264 viewport for every state × light/dark × ko/en × forceQuit on/off. Assert: no horizontal/vertical overflow; no text truncated (`scrollWidth ≤ clientWidth`); every text and button is the top element at its centre (nothing covered by the backdrop); `Button` boxes 28px tall; title 15px, body 14px, caption 12px; only `mark.js`/`state.js` scripts, no network requests, no `type="module"`; `role`/`aria-live` per §7.
3. **Staleness:** `lifecycle-window-build.ts --check` and `generate-lifecycle-stills.ts --check` in `bun run check`.
4. **Native (host, §8):** startup smoke asserts the window is shown before `runtime_imported`, the main window is shown before the startup window is destroyed, and an injected agent failure shows the error state with Retry and Open log working (Retry relaunches; Open log creates the file and reveals it). `app-quit-feedback.ts` normal and `--blocked` with the new window.
5. **Windows installer:** hosted capture shows the GIF during install; DPI 100/150/200%; install/update/uninstall assertions unchanged.
6. **Owner review:** live preview build link plus `--smoke` captures of both windows in light and dark over a photo wallpaper.

## 12. Acceptance

- [ ] §2 DS changes merged with showcase/guidance; proposal workarounds removed.
- [ ] Both windows render from the prerendered static page; no React at runtime; budgets met.
- [ ] User still used when present; built-in still otherwise; native colour set before first paint; no white flash.
- [ ] Stage mapping, dwell, slow, error, retry, open log, quit window, quit stages and timeout as specified; force quit hidden behind the flag.
- [ ] Copy keys added (ko/en), codex `desktop-copy` quit strings removed.
- [ ] §11 smokes pass on macOS and hosted Windows; §8 numbers recorded in the PR and the Project Ledger.
- [ ] Installer GIF regenerated deterministically; captured frames attached to #481.
