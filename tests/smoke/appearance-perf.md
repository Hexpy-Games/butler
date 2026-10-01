# Appearance navigation performance

Measured on macOS arm64 on 2026-10-01, Playwright 1.59.1, Chromium 147.0.7727.15,
1280×900 and 375×900, DPR 1, no throttling. All runs use isolated HOME/DATA,
the native gateway and its stub model; no model calls were made. Some samples
ran alongside local builds. These are browser measurements, not packaged
Electron or whole-owner-database measurements.

## Root cause

The list had only 11 choices (none plus 10 modules), but each live thumbnail
compiled shaders, drew a 1440×900 still and copied/scaled/encoded it on mount.
The three photo modules first decoded 2000px-wide originals, then resized them.
Dark-tone detection could also start the light stills before the dark ones.
The result was 15–30 draw calls, 15–20 React commits and multi-second UI tasks.

The `/wallpapers` response was 61 bytes and completed in milliseconds. Reopening
already cached stills took 18–30ms. The endpoint is re-read on each mount, but is
not the observed bottleneck. It remains fresh; no stale list cache was added.
There were no video elements or animated thumbnail canvases. Main-thread image
decode time was zero: decode ran off-thread; the blocking work was the shader /
GPU still path. Layout/paint and font requests did not explain the seconds of
scripting; fonts' resource completion was delayed behind the blocked thread.
No per-card layout measuring or eager theme/font-preview computation was found.

## Fix

Built-in defaults load 320×200 PNG posters produced by the exact renderer,
composition, still clock and tone. The build checks engine, shader, manifest and
photo hashes and rejects stale assets. Modified parameters and user modules use
the same renderer on one worker, serializing draws and caching by content/tone.
ImageBitmap decoding requests the resized output directly, without first
allocating a full-resolution bitmap. Images declare dimensions and async decode.
All choices, controls, light/dark behavior and local scrims remain intact.

The source API and list length do not justify caching stale list data or
virtualizing this shipped collection. No thumbnail animation or idle disk write
was added.

## Before / after

Ranges below are the four cold cases per width: Silk and Sunset Clouds, light
and dark. The window extends through all 10 loaded thumbnails plus one second.
Long-task counts are summed over the four cases. JS heap is CDP used heap, not
process RSS. Scripting/layout/paint totals are trace event durations, not wall
time; off-thread image decode is reported separately.

| Metric | 1280 before | 1280 after | 375 before | 375 after |
| --- | ---: | ---: | ---: | ---: |
| Interactive ms | 2264–3660 | 28–41 | 2318–9601 | 33–41 |
| All thumbnails ready ms | 2931–5100 | 44–50 | 2982–11934 | 41–45 |
| Tasks >50ms | 22 | 0 | 22 | 0 |
| Longest task ms | 2245–3637 | 21–24 | 2289–9517 | 14–16 |
| Scripting ms | 2257–3653 | 27–30 | 2315–9582 | 31–35 |
| Layout/style ms | 15–20 | 16–20 | 25–57 | 35–39 |
| Prepaint/paint ms | 7–10 | 6–8 | 8–16 | 10–15 |
| Main-thread decode ms | 0 | 0 | 0 | 0 |
| Off-thread image decode ms | 70–218 | 8–9 | 62–142 | 6–7 |
| Resource requests | 8–11 | 15 | 8–11 | 15 |
| Encoded bytes MB | 1.086–2.078 | 1.107–1.154 | 1.086–2.078 | 1.107–1.154 |
| Mounted App function components | 253–269 | 253–269 | 253–269 | 253–269 |
| Picker DOM nodes | 88–97 | 88–97 | 88–97 | 88–97 |
| React commits | 17–20 | 10 | 15–17 | 10 |
| Runtime thumbnail WebGL draws | 15–30 | 0 | 15–30 | 0 |
| Thumbnail original bitmaps | 3–6 at 2000px | 0 | 3–6 at 2000px | 0 |
| Rendered images / videos | 10 / 0 | 10 / 0 | 10 / 0 | 10 / 0 |
| JS heap MB | 9.9–13.4 | 12.6–12.7 | 10.0–13.5 | 13.1–13.5 |

PNG posters preserve fidelity; the light cold-load bytes can be slightly larger,
while the duplicate dark photo loads disappear. Requests increase because each
small poster is a separate asset. Both versions issue two API reads on reopening
(`/wallpapers`, `/personalization`), with no repeated shader/image generation.
Per-request byte counts, durations and TTFB are retained in the evidence JSON.
The browser harness uses HTTP; it does not measure native Electron IPC.

With 600 complete chat summaries and the freshly built native agent, shipped
backgrounds were interactive within 42ms, all stills within 67ms. Edited Silk
and Clouds parameters were interactive within 45ms; the exact edited still
completed within 479ms on the worker. Both suites had zero >50ms UI tasks and
retained all choices, order, selection and parameter values on reopening.

The evidence includes 80 samples (cold and reopen), all request timings,
bitmap sizes, mounted component counts, JS heap and trace-derived work. A GPU
`used_bytes` value is recorded only when reported by a GPU task, otherwise null;
this is not a total GPU/process-memory measurement. It is not proof at a 1.3GB
App DB / 300k events, nor a packaged Electron acceptance run.

## Validation

- `bun install --frozen-lockfile --ignore-scripts`, `bun run check`, DS lint,
  typecheck and the production UI build passed, including after main was updated
  to `2567a992e`.
- Existing picker/model/still/image-cache/settings contracts: 38 passed.
- Existing DS showcase/design tests: 51 passed, 2 pre-existing skips.
- Native agent static-ORT build, cargo fmt and Rust source-check passed. No Rust
  production source changed, so touched-crate clippy is not applicable.
- Final 600-chat App smoke: all 16 cases passed, maximum interactive 41.6ms,
  maximum task 28.4ms, no long tasks or full-size thumbnail bitmaps.
- The full DS smoke passed bundle, fonts, navigation, WebKit mobile and App DS
  checks, then timed out in `ds-viewer-overflow-smoke.ts:189` on
  `FoundationHeroMotion`. The unchanged test against an isolated archive/build
  of main `2567a992e` reproduced the same 30-second `networkidle` timeout.
  No assertion, timeout or tolerance was weakened. Later full-suite steps did
  not execute. This is tracked alongside the matching DS overflow test issue
  [#390](https://github.com/Hexpy-Games/butler/issues/390); its cause remains
  unconfirmed and outside this Appearance fix.

## Reproduce

Build the current native agent and UI, then run with fresh temporary HOME and
BUTLER_DATA, the existing Playwright cache, and an absolute
`BUTLER_NATIVE_AGENT_EXECUTABLE`:

```sh
bun run tests/smoke/appearance-perf-smoke.ts --out=/tmp/appearance-perf
bun run tests/smoke/appearance-perf-smoke.ts --owner-scale --out=/tmp/appearance-scale
bun run tests/smoke/appearance-perf-smoke.ts --owner-scale --custom-only --out=/tmp/appearance-custom
```

`--report-only` collects baseline numbers without enforcing the 150ms / 50ms
budgets. It still asserts content completeness. `--mobile-only` limits to 375px.
Every run writes raw CDP traces and JSON results. The committed compact evidence
is [evidence/appearance-perf.json](evidence/appearance-perf.json).
