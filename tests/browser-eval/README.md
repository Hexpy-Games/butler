# Browser evaluation fixtures

No model calls or product code. Chromium is the implemented L1 backend; P2a supplies a `SnapshotProvider` adapter for the App. A0 serializes the full Chromium AX tree, joins backend node IDs to fixture IDs without visibility filtering, and classifies standard control roles as actionable. Non-semantic canvas/cart targets intentionally reduce recall.

Run from the repository root with fresh temporary `HOME` and `BUTLER_DATA`, `PLAYWRIGHT_BROWSERS_PATH` pointing at an installed Chromium cache, and `BUTLER_BROWSER_EVAL_OUTPUT` pointing outside the repository:

```
bun tests/smoke/browser-fixtures-smoke.ts
bun tests/smoke/browser-perception-smoke.ts
bun tests/browser-eval/runner.ts fixtures A0
```

For restricted macOS runners set `BUTLER_SMOKE_BROWSER_ARGS='["--single-process"]'`. The existing shared smoke helper owns browser cleanup. Normal Chromium on Windows needs no extra flags. Host resolver rules exist only in the launched browser; no hosts file, system DNS, product grant or loopback policy changes. The local Bun server binds an ephemeral loopback port. Reuse one context per run; close each fixture page.

Each fixture has static HTML and `truth.json`; targets/decoys are unique DOM IDs across its frames/shadow roots. Success requires server-received events and values; any decoy event fails it. Downloads and forbidden navigations use server-received requests. Gold-path smoke validates all 20 success predicates and rejection of a received decoy event. It is a scripted fixture validation, not L2 agent evidence.

L1 saves all 20 screenshots, raw snapshots, requests, and `l1.json`. Recall counts actionable or explicitly covered real targets; leak counts actionable, unannotated decoys. Covered accuracy requires the exact covering ID for every gold covered target, including missing targets as failures. Empty covered sets report null. Byte counts are exact UTF-8; token counts are estimates (`ceil(bytes/4)`), not tokenizer or provider usage. `scriptMs` is end-to-end AX acquisition and ID-join time including protocol overhead; grid time is null for A0. No model task-success claim is made by L1.

Fixtures use bundled Noto Sans KR (Latin and Hangul), OFL license in the asset directory, fixed RNG seed 737 and Date 2026-10-06T12:00:00Z. CSS has no animation. F05/F17 retain specified elapsed timers; F15 has the urgency countdown. Geometry is 1280×800 at device scale 1.

The L2–L4 runner needs an explicit `TaskExecutor`; CLI execution refuses unimplemented arms and non-fixture suites. Arm A4 is an evaluation control with unverified points, never a product policy. Report contracts retain resolved targets, refusal recovery, provider-send bytes, cost, latency, pass³ and an explicitly unavailable bootstrap interval until its implementation. No live provider exists here.

Real-site parameters and scripted answer checks must be bound before execution. The research enumerates 11 flows while requesting 12; Kakao/Naver Map are separate entries. WebGames pins upstream route task symbols and source revision without challenge content. OM2W lists 60 stratified selection slots, not upstream task IDs: bind actual task IDs and revision before running; no task content is downloaded or fabricated. Future record/replay uses existing butler-e2e BRW cassettes; observation mismatches are drift, not retries. Only owner-authorized Luna recordings are eligible.
