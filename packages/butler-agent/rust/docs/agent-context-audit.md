# Agent context and failure-feedback audit

Scope: #13, #195, #194, #193, #196, #198. Baseline: `53fa0a3130da`.
Measurements use the stub tier, the real service/admission/prompt/provider builders,
and `o200k_base`. No live provider calls or claimed provider cache-hit measurements.

## Reproducible measurement

`butler-e2e/tests/agent_context.rs` captures the first ordinary provider request,
checks one model request and one correct delivered assistant answer, and prints a
JSON table. Run it with `BUTLER_E2E_TIER=stub BUTLER_E2E_SKIP_BUILD=1`; set
`BUTLER_E2E_BIN` to a saved baseline binary for the comparison. Isolate HOME and
BUTLER_DATA as required by AGENTS.md. The fixture creates a fresh install and a
large synthetic profile: a long persona, exact EOL, 60 rule files linked twice,
36 profile hints, source-backed current hot cache, session continuity, and project
memory. It exercises production durable admission rather than constructing an
estimated prompt in a test.

All counts are tokenizer estimates, not provider invoices. Whole-request counts
include JSON framing and escaped input. Document counts measure loaded admitted
text, including head/tail excerpts and inserted retrieval markers. Only decoded
provider text is used for section accounting; serialized input is measured
separately. Section counts are not additive because token boundaries, framing, and repeated text vary.
UUIDs and temporary workspace paths cause small run-to-run token differences.

| First request | Fresh before | Fresh after | Large before | Large after |
| --- | ---: | ---: | ---: | ---: |
| Instructions | 4,051 | 2,312 | 10,881 | 9,092 |
| Tool schemas | 8,996 | 7,645 | 9,836 | 7,808 |
| Serialized input | 268 | 278 | 10,672 | 10,819 |
| Serialized complete request | 13,598 | 10,494 | 32,201 | 28,507 |
| Tool definitions | 35 | 29 | 39 | 30 |
| Guided fixed instruction prefix | 2,516 | 777 | 2,579 | 777 |

Complete-request reduction: 3,104 tokens (22.8%) fresh; 3,694 (11.5%) large.
Instructions plus schemas fall by 3,090 (23.7%) and 3,817 (18.4%). Large input
increases slightly because project context and runtime state survive instead of
being displaced by duplicate rules. This is a context-size measurement, not a
latency benchmark or an owner-scale throughput claim.

| Admitted section: loaded tokens including retrieval markers | Fresh before | Fresh after | Large before | Large after |
| --- | ---: | ---: | ---: | ---: |
| Runtime system contract | 161 | 161 | 161 | 161 |
| Role | 297 | 297 | 297 | 297 |
| Persona reminder | 449 | 449 | 814 | 831 |
| Exact EOL | 341 | 341 | 6,009 | 6,009 |
| Rules | 0 | 0 | 6,544 | 6,423 |
| Runtime state | 161 | 166 | 0 | 208 |
| Profile projection | 0 | 0 | 733 | 729 |
| Hot cache | 0 | 0 | 978 | 41 |
| Session continuity | 0 | 0 | 1,810 | 37 |
| Project memory | 0 | 0 | 0 | 2,816 |

The large fixture deliberately exceeds its preview budgets. Project memory gets
priority over older continuity and global hot-cache hints. All originals remain
in admitted storage or their source files; low-priority sections carry explicit
retrieval markers. Exact EOL, governing instructions, current request, authority,
current atomic tool delivery and live Work anchors are preserved. This does not
truncate an answer, skip an action or reduce a performance test's required content.

The admitted rule document falls from 15,003 to 7,503 stored tokens after duplicate
links are removed. The hot-cache and continuity entries after reduction consist
primarily of retrieval markers and small head/tail excerpts.

## Reductions and catalog capacity

- Rule-link deduplication preserves the first occurrence and rule order; it does
  not deduplicate distinct files or similar but different instructions.
- Existing phase/grouped tool selection is enabled by default. Tools remain
  discoverable through `tool_search`, `tool_describe`, and `tool_call` subject to
  the existing role/access/phase policy. Explicit `BUTLER_PHASE_TOOL_SURFACE=off`
  retains the legacy surface. Native tools required by the current phase remain
  offered; discovery does not confer new permission.
- Document previews use deterministic UTF-8 head/tail excerpts and retrieval
  markers. Runtime state and rules outrank optional historical hints. Local model
  windows also scale optional/persona budgets. User-selected project source
  identities/topics/continuation pointers remain intact; only quoted excerpts
  are bounded, with `read_project_source` pointing at the admitted snapshot.
- Model catalog capacity is a ceiling for global/environment/explicit window
  settings. Local discovery uses reported model/server capacity; an unknown
  capacity is zero/unsupported until explicitly configured, instead of inventing
  a 16,384-token window. Fractional values below one no longer suppress valid
  fallback metadata. Summarizers obey the same output cap for local/hosted models.

## Compaction guarantees (#194)

Manual compaction measures the actual estimator's output rather than assuming
four characters per token. Tool groups are processed in deterministic reverse
start order, so expanding a crossing group cannot split an earlier group due to
HashMap iteration order.

Rolling compaction makes at most one bounded summary request per preparation.
Input reduction halves the historical range on UTF-8 boundaries; it terminates.
Oversized output is clipped according to serialized JSON bytes, including escape
expansion and an explicit retrieval marker. Partial historical input carries its
omitted byte count and exact readers. Empty/failing summarization uses a fixed
retrieval placeholder. The complete projected request is measured again;
if the summary envelope cannot fit, a minimal explicit history retrieval marker
replaces it and every mandatory atomic unit survives. A mandatory request plus
that minimum marker that exceeds the actual model capacity fails explicitly without
making another model call. Model-generated summary wording is only deterministic
for identical producer output; code cannot make a nondeterministic live model
produce identical prose. Source digests, selection, projection, fallback and byte
bounds are deterministic.

Regression coverage reuses existing pure-logic test cases (no unit-test count
increase): multilingual/escaped clipping, repeated projection/digest equality,
100 independently seeded crossing tool-group maps, oversized/empty/failing
summary producers, mandatory overflow without producer calls, and local output
caps. E2E coverage asserts real first requests and delivered content.

## Turn-ending and handoff inventory (#193/#196)

This inventory covers the Rust runtime after PR #434's model-solvable tool-code
reclassification. It distinguishes ending a Turn from bounding a retrievable
preview or refusing an unauthorized action.

| Location under `crates/` | Trigger | Disposition |
| --- | --- | --- |
| `butler-turn/src/btcc/agent_loop/driver.rs` | Text-only candidate | Accepted by Work policy, or actionable model feedback. No iteration cap. |
| same | Empty model answer | Every occurrence becomes feedback, including `typed_terminal`; repeated emptiness no longer ends work after one correction. |
| same; `butler-agent/src/host/guided/journal.rs` | Text-form tool invocation | Preserve history and give native-schema correction; no runtime failure or silent drop. |
| `butler-models/src/models/provider/result/local.rs` | Local text/native call parsing | All valid calls retained (removed first-eight cap); rejected/oversized calls produce correction feedback. Parser input limits protect parsing, not silent completion. |
| `butler-agent/src/host/guided/work.rs` | Missing/currently stale Work disposition | Re-read durable Work, name the required `record_work_disposition` correction, continue on every failed candidate. Removed one-correction forced settlement. An explicitly recorded current open disposition remains an authorized progress report, rather than inferred completion. |
| same | Ledger publication not applied/uncertain during candidate review | Feed the facts back for reconciliation instead of accepting an unsupported final answer. |
| `butler-turn/src/btcc/agent_loop/completion.rs`, `driver/batch.rs` | Authority pending or waiting for worker | Typed suspension with durable continuation/queue ownership; not a success or a request that user redo the work. |
| `butler-agent/src/host/guided/tools/question.rs` | Explicit model `ask_user` | Validate schema, persist a question and await the user's answer. Invalid questions remain tool feedback. |
| `butler-agent/src/host/guided/tools/feedback.rs` | Known model-solvable tool rejection | Existing explicit allowlist returns durable actionable tool error. Unknown identity/storage/journal corruption still fails closed. |
| `butler-turn/src/btcc/continuation_budget.rs` and `continuation_budget/validation.rs` | Explicit opt-in stateless elapsed/idle/input/output budgets | Disabled by default; exhaustion is an explicit typed error. Model/tool round counters are accounting only. No budget is raised or weakened. |
| `butler-turn/src/btcc/model_route/routed.rs` | Exhausted provider transport retries/configured route | Typed provider failure, never silently reported as completed. This patch adds no model switching. |
| `butler-turn/src/btcc/agent_loop/model_round.rs` | Provider/auth/quota/network/timeout failure | Operational failure with stored progress; model cannot repair unavailable transport by receiving a message through it. |
| same; `butler-runtime/src/context/round_projection/compaction.rs` | Mandatory input physically cannot fit | Explicit capacity failure; preserves governing/current input rather than discarding it. |
| `butler-turn/src/btcc/agent_loop/ports.rs`, driver | Cancellation or corrupt policy/store/replay contract | Explicit cancellation/integrity error. Approval/access defaults remain intact. |
| `butler-agent/src/host/guided/work/closeout.rs`, `work.rs` reconcile path | Abrupt closeout without current disposition | Existing durable runtime-owned open fallback remains for settlement outside ordinary candidate review. It is not reachable by exhausting a model correction count. |
| `butler-turn/src/btcc/turn/transition.rs`, `turn/failure.rs` | External operational failure / legacy typed no-visible outcome | Truthful failed status with saved progress. The ordinary empty-model path no longer produces no-visible. |
| `butler-turn/src/btcc/subsessions/` | Child waits, authority, result settlement | Durable relation/result state. The Rust loop has no hidden Steward/Worker round cap. |

Runtime correction counts live outside the projected transcript, so compaction
cannot erase them. Counts describe facts and suggest another approach; they never
terminate work. They are scoped to an execution; suspension restores durable
messages but starts new counter accounting. This is not a migration of child
statuses or implementation of every proposal in the legacy #193 prototype.

Read/list byte limits, artifact bounds, Work/effect/prior-result previews and
subsession dashboard projections do not cap execution. Full records remain
accessible through exact readers. The unchanged abrupt-closeout fallback still
uses generic runtime copy; eliminating all such copy requires the separate
external-failure/recovery contract and is not claimed as solved by this change.

## Raw results and cache expectations (#198)

`butler-agent/src/host/guided/tools/message.rs` calls the shared bounded preview
in `message/preview.rs` and `message/preview/bound.rs`; full payloads remain in the
operation-result store/journal. Current exact reader messages are not duplicated
by provider continuation; the existing serializer/continuation tests cover this.
`butler-turn/src/btcc/turn/transition.rs` delivers the final model content; it does
not convert ToolResult payloads into assistant messages. The TOOL-01 stub E2E
checks that the model received a function-call output while the user received
exactly the model's final text with no raw tool envelope. Explicit operation-output
inspection APIs still exist and are not automatic conversation delivery.

Steward/Worker context admission inherits the parent's project/feedback document
references in `butler-turn/src/btcc/turn/preparation/context.rs`; it does not depend
on adding an unbounded second hot-cache fetch. Existing preparation/admission
coverage exercises the durable reference inheritance.

OpenAI phase surfaces now supply the existing stable provider-prefix identity:
model, ordered schema surface, tool choice, reasoning and fixed instruction prefix
precede variable persona/EOL/current input. Expect a cold prefix on the initial
request after upgrading, then reuse when those stable fields match. Changes to
role/phase/tool surface/model/reasoning invalidate that prefix; dynamic documents
need not invalidate the common prefix. Working/final-report schema changes now
carry a digest in the surface and provider continuation, allowing the existing cache contract to identify a new prefix instead
of failing the Turn. Local/Anthropic/Gemini carriers retain
phase-grouped tools but do not fabricate an OpenAI cache identity. Cache support,
retention and hit rate depend on the provider; stub usage cannot establish a
percentage or a measured cached-token count. The measured fixed instruction prefix
plus serialized schemas is approximately 8.4k tokens fresh and 8.6k large, before
provider framing; it is an estimate of reusable material for each unchanged surface.

## Validation and remaining external failure

Every run used fresh temporary HOME/BUTLER_DATA, stub/replay model calls, cargo
`-j8`, and no more than four E2E threads.

| Check | Result |
| --- | --- |
| Agent debug build | Pass |
| Models / Turn unit suites | 65 / 110 pass; the existing ignored stdio fixture is spawned by its parent test |
| Runtime context unit suite | 20 pass, including deterministic/bounded compaction regressions |
| Agent guided-adapter unit suite | 12 pass |
| Stub E2Es: context, feedback, durable configuration, hot cache, local setup, tools, streaming, tool effects, Steward results, legacy subsessions | 34 pass |
| Same context measurement against saved baseline and final binary | Both pass; exact EOL/role/runtime contract and one delivered answer asserted |
| `cargo fmt --all`, Clippy all targets for five touched crates with `-D warnings`, source check | Pass; source-check ratchets only tightened |
| `bun install --frozen-lockfile --ignore-scripts` | Pass, 1,605 packages |
| `bun run check` | Earlier run passed; final run failed: 955 pass, 25 existing skips, one unchanged Ledger CRUD timeout |

The final Bun failure remains unresolved at `tests/unit/project-ledger-cli.test.ts:687`:
7,190.45 ms against the unchanged 5,000 ms limit. The test and Ledger implementation
have no diff from main. Root cause is not established; no retry or timeout change.
Searched open issues and recorded this observation in
[#418](https://github.com/Hexpy-Games/butler/issues/418#issuecomment-5953163986).

