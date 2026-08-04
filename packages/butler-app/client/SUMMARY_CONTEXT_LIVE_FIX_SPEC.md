# Butler Summary Progress and Context Accuracy Fix

Status: accepted for implementation on 2026-08-04

## Intent lock

- Accepted intent: fix every confirmed cause of the Summary progress display
  appearing static and the context display remaining at an inaccurate 9%.
- Approved revision: the 2026-08-04 user instruction to proceed with all fixes,
  preserving the earlier requirements that implementation uses a Luna worker,
  review uses Sol high, UI uses Butler Design System components and tokens, and
  idle sessions do no polling or periodic reconciliation.
- Observable outcome: canonical Ledger progress state changes are visibly
  distinguishable in the Summary tab, while inspector and composer show the
  latest current-prompt occupancy from provider telemetry after SSE progress
  events.
- Canonical public path:
  - BTCC guided model round -> provider prompt metric with Turn attribution ->
    App session-view context projection -> SSE-triggered store reconciliation ->
    Summary, Context inspector, and composer context control.
  - BTCC progress event -> canonical safe progress row -> Summary panel -> Butler
    DS ActivityFeed icon.
- Non-goals: a new event transport, periodic polling, cumulative billing-token
  accounting, exposing raw prompts, changing the ContextDonutButton visual API,
  or redesigning the Context panel.
- Forbidden substitutions: deriving context from transcript size, treating
  reserved capacity as consumed context, adding a timer, adding raw UI controls
  or colors outside the Butler DS, or testing only source strings.

## Ownership, recovery, and failure contract

- The provider adapter owns durable prompt-usage attribution in the existing
  `metrics/prompt-cache-usage.jsonl` schema; no schema migration or raw text is
  added. The App context read model owns safe selection and aggregation. The UI
  owns only DS presentation of the resulting public projection.
- Existing active work is not interrupted. The change takes effect on the next
  model round; already-written unattributed metrics remain readable only through
  the constrained compatibility rule below.
- Missing, malformed, stale, cross-session, or cross-Turn metrics are ignored.
  The projection falls back to context-monitor telemetry and then the existing
  estimator. Failed session-view refreshes retain the last coherent view, and a
  later SSE event or reconnect can reconcile it.
- App or service restart requires no repair operation: metrics remain append-only
  and are re-read under the same selection rules. The behavior is identical on
  macOS, Linux, and Windows because it changes no platform adapter or path
  contract.
- Provider token counts and aggregate category counts are public-safe telemetry;
  prompts, tool payloads, hidden reasoning, secrets, and private paths remain
  prohibited from the App response and logs introduced by this change.

## F1. Canonical progress state presentation

The Summary panel continues to render semantic rows through the Butler DS
`ActivityFeed`. Its state-to-icon mapping recognizes the canonical Ledger and
Turn vocabulary:

- `delivered`, `complete`, and `completed` render the DS completed icon;
- `accepted`, `active`, `thinking`, `running`, `streaming`, `reviewing`,
  `correction_required`, `waiting_for_tool`, and `retrying` render the DS running
  icon;
- `failed` renders the DS failure icon;
- `cancelled` and `stopped` render the DS cancelled icon;
- absent, planned, pending, and unknown values retain the neutral icon.

No local SVG, raw color, animation, or non-DS status primitive is introduced.
The existing row selection, ordering, privacy filtering, and maximum of eight
rows remain unchanged.

Acceptance:

1. A real `btcc_work_ledger` row visibly changes from `active` to `completed`.
2. Every canonical state family above has a component-level behavioral test.
3. Unknown state values remain safe and neutral.

## F2. Provider prompt usage attribution

Every guided BTCC model round supplies its canonical Turn ID through the
existing provider `usageAttribution` contract. The prompt-cache metric records
that ID before the model-round-completed progress event is published. Therefore
the existing SSE progress event can trigger one bounded session-view refresh
that observes the new metric; no dedicated polling or timer is added.

For metrics written by earlier Butler builds without a Turn ID, the read model
may use a fallback only when all of the following hold:

- the metric has no Turn ID;
- its scope exactly identifies the active runtime session's guided BTCC scope;
- its timestamp is not earlier than the latest Turn start time;
- no newer exact-Turn metric is available.

Metrics from another session, an earlier Turn, or an explicitly different Turn
must never influence the projection. Exact Turn attribution has priority over
the compatibility fallback.

Acceptance:

1. A guided model round records its Turn ID in provider usage telemetry.
2. Exact-Turn telemetry is selected for the current Turn.
3. A same-session, post-start legacy metric is selected when attribution is
   absent; earlier-Turn and other-session metrics are rejected.
4. Prompt contents and private paths remain absent from the public response.

## F3. Accurate context occupancy semantics

`ContextDetailsView.used_tokens` means tokens occupying the current model prompt,
not reserved future capacity. When provider telemetry is available it equals the
latest provider `promptTokens`. When only the context monitor or estimator is
available it is the sum of the actual non-reserve categories. Output, tool, and
compaction reserves remain present as safe detail categories and continue to
inform working-budget pressure, but they are excluded from `used_tokens` and
`ratio`.

The inspector chart stacks only actual occupied categories so that its segments
plus free context equal the context budget. Reserve categories remain visible in
the existing DS detail rows. Summary text, Context inspector percentage, and the
composer DS donut all consume the same `ContextDetailsView.ratio`.

Acceptance:

1. Provider prompt usage of 64,000 reports exactly 64,000 used tokens before
   clamping and a ratio of `64_000 / budget_tokens`.
2. Without live telemetry, fixed reserves do not create a false 20,000-token
   baseline in `used_tokens`.
3. Chart occupied segments sum to `used_tokens`; free context is
   `budget_tokens - used_tokens`.
4. Inspector and composer receive the same refreshed ratio through the existing
   atomic session-view application.

## Validation and delivery

- Tests are added before or alongside production changes and import the real
  state mapper, guided loop/provider path, read model, context store, and chart
  builder where practical.
- Targeted UI and agent tests, UI/agent type checking, lint, `git diff --check`,
  and `bun run check` must pass.
- Production UI is rebuilt after implementation. Runtime restart is performed
  only after the reviewed commit is integrated into local `main`.
- The final report records the implementation commit, review result, validation
  evidence, restart status, and any residual live-observation limitation.
