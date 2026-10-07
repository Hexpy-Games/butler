# tests

`tests/` contains Butler's automated review gates. Tests are organized around
product contracts: CLI, transport, runtime, memory, context, reliability,
search, tasks, installer, release packaging, and native purge constraints.

## Key Areas

- `unit/`: Bun unit and integration-style tests, plus shell gates.
- `smoke/`: deterministic smoke scripts that exercise product integration
  paths outside the unit runner.
- `live/`: optional live validation scripts that may require model credentials,
  network access, or longer runtimes.
- `managed-bun-runtime.test.sh`: managed runtime install/repair gate.
- `native-purge-gate.sh`: native product purge and documentation gate.

## Boundaries

Tests should assert real product contracts, not only mocks. Prefer isolated
`BUTLER_HOME` and `BUTLER_DATA` fixtures for stateful behavior, and avoid
storing raw private data in fixtures or snapshots.

Tests never touch the owner's real `~/.butler`. The Bun preload
`support/isolated-user-data.ts` gives every test process a private `HOME`,
`BUTLER_DATA` and XDG dirs (and passes them to spawned children); the Rust
E2E harness does the same for the agent it starts, and CI fails a run that
leaves anything under the runner's `~/.butler`.

## Related Specs

- `SPEC-BUTLER-CLI` - Butler CLI
- `SPEC-NATIVE-PRODUCT` - Native Butler Product
- `SPEC-OPERATIONAL-RELIABILITY` - Operational Reliability
- `SPEC-MANAGED-BUN-RUNTIME` - Butler-Managed Bun Runtime
- `SPEC-TRANSPORT-EXPANSION-READINESS` - Transport Expansion Readiness

## Visual verification (#526)

Blocking checks use content, computed CSS, geometry, visibility and completed
render signals, never artwork pixel counts or image-diff thresholds. Wallpaper
emits `data-wallpaper-state="painted"`, `data-painted-module`, `data-painted-tone`
and a `butler:wallpaper:first-frame:*` performance mark after drawing. Requested
`data-module` / `data-tone` alone do not prove a frame. Scene changes, none,
context loss and disposal invalidate readiness. Signals write only in memory;
steady frames do not update attributes or add marks. ButlerThinkingMark emits
`data-mark-state="painted"` after drawing.

Inventory of the previous sampling gates (all replaced):

- `support/newchat-visual.ts`: wallpaper colour-count advisory removed; first
  frame required. CSS alpha checks now normalize computed CSS without pixels.
- `smoke/app-layout-smoke.ts`: bloom saturation/cell/mean/minimum luminance and
  silk coverage/spread thresholds replaced with actual module/tone readiness;
  assistant mark alpha scan replaced with draw completion. Geometry retained.
- `smoke/ds-viewer-navigation-smoke.ts`: hero screenshot luminance thresholds
  replaced with completed-frame tone matching the chrome theme.
- `smoke/question-input-geometry.ts`: CSS colour normalization no longer reads
  canvas pixels; focus contrast >=3:1, token, clipping and geometry gates remain.
- Unused `support/drawn-webgl-frame.ts` and `wallpaper-frame-sampler.ts` deleted.
  No image-diff pass/fail thresholds were found. The thinking-mark morph test's
  “pixel-identical” name refers to pure numeric geometry, not image sampling.

For human-visible correctness, `support/visual-judge.ts` saves expected/actual
PNGs, the multimodal request and verdict alongside the actual screenshot.
`BUTLER_VISUAL_JUDGE=1` enables it; default CI makes zero judge calls. New-chat
smoke also needs `BUTLER_VISUAL_EXPECTED_DIR` and `BUTLER_VISUAL_JUDGE_REPLAY`.
Replay JSON maps the full request SHA-256 to `{ "pass": boolean, "reason": string }`;
missing/mismatched cassettes and invalid/negative verdicts fail. Bloom/silk
layout and DS hero checks use the same optional comparison. Other smokes may
call the helper with a written expectation and an explicit stub/replay transport.
The stub harness proves the plumbing, not visual acceptance. There is no live
transport in tests. If recording externally is necessary, use only
`openai/gpt-6-luna`, then replay it; do not silently substitute a passing stub.
Run `bun tests/smoke/visual-judge-harness.ts` in an isolated HOME/BUTLER_DATA
(with `BUTLER_SMOKE_BROWSER_ARGS='["--single-process"]'` on restricted runners).

`packages/butler-app/client/ui/scripts/wallpaper-paint-harness.ts` exercises
real WebGL scene/tone switches, context loss/recovery, none/disposal and verifies
zero canvas attribute mutations on paused frames and bounded performance marks.
