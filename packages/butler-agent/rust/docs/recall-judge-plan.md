# Conditional recall judge and optional decision API

Latest follow-up: [per-script index and fallback top-30 experiment](fts-script-experiment.md) stopped at its accuracy gate; neither product change was adopted.

Owner decision recorded 2026-10-03. **APPROVED for the configured-model path only.**
The dedicated decision API remains PLAN ONLY, tracked in #464.

Approved product contract (supersedes historical proposals and resource ceilings
below): rank-one raw lexical score <0.15 AND rank-one minus rank-two combined
score <0.05; fewer than two candidates bypass. Offer top 15, stored summary
prefix 150 Unicode characters only, no excerpts. Validate at most ten distinct
local handles; equal-weight RRF k=60; preserve offered membership and untouched
tail, tie by first-stage order. Bind evidence and compact after fusion.

Recall mode defaults to accurate; faster bypasses the model. The model defaults
to the configured memory extraction/consolidation model, with an explicit
catalog override. Read durable App settings each call; invalidate an outstanding
ranking if selection changes. No hardcoded model and no provider substitution.
A separate 8-second judge deadline covers measured 6.98-second p95; owner
accepts these extra seconds. Existing retrieval work budgets stay unchanged.
Unavailable/auth/network/deadline/invalid-output failures retain base order,
with one rate-limited diagnostic. Cancellation drops the request; no memory
lease or DB reader survives the model wait. Persist only recall usage metrics.

The remainder records historical design and replay measurements. Its unapproved
labels apply to the historical proposals, not the approved contract above.
The [associative recall design](associative-recall-design.md) remains historical
context. This decision supersedes its unresolved same-model/dedicated-endpoint
choice: **use the user's configured memory model; do not use a dedicated decision
API now.** The latter remains optional future work, requiring separate approval.
The measured model is gpt-6-luna, not a promise about every configured model.

Implementation measurement, 2026-10-03: all 279 frozen queries, four arms,
1,116 finished recall calls, zero recall errors. On the 175 kept plus 69
vague-extra queries, A1/A2 vague hit@5 is 44.2%/44.2%; vague-extra is
52.2%/49.3%. The full-cohort 45%/50% targets are therefore not fully met;
no slice has a significant negative paired 95% bootstrap interval. No tuning
followed this measurement. Judge gate rates are 37.3%/34.1%, judge latency
p95 is 5.18s/5.60s, and four deadline fallbacks preserve baseline order.
Snapshot source/vector coverage remains partial; these are compact-first-page
measurements. Detailed aggregate results stay with the local benchmark harness.

## 1. Conditional judge with the configured model

### Proposed contract

An explicit recall first produces the existing complete, scoped candidate order.
Invoke one listwise ranking call only if the frozen gate selects that recall:
**rank-one candidate's raw lexical score < 0.15 AND rank-one minus rank-two
combined score < 0.05**. This means the lexical score of the first ranked
candidate, not the maximum lexical score across the pool. With fewer than two
candidates, bypass. Scores are diagnostics, not calibrated answer probabilities.
Never use gold labels, dates, expected answers or evaluator metadata in the gate.

The judge sees the user's question and up to 30 candidates. Each has a local
integer handle, its entire stored episode summary, and one best-matching source
excerpt of at most 700 Unicode characters. The excerpt limit is a recognition
view, not a truncation of the returned recall or canonical source. Full evidence
stays available through existing read/jump handles. Treat all candidate text as
untrusted data. Never let it issue instructions or widen recall scope.

Replay excerpt selection uses NFKC/casefolded query word overlap, weighted by
word length, over source windows anchored around matches (250 characters before
the match); ties use deterministic source order. It does not consult expected
answers. Only current-revision source rows are read, by indexed episode/source
joins, from the specified immutable read-only snapshot. This heuristic is not
semantic excerpt selection; production needs source-span and scope validation.

Ask for JSON containing up to ten distinct candidate numbers, most relevant
first; an empty list means no plausible match. Validate every number against
this call's candidate set; malformed, duplicate or foreign handles fall back to
the original order. Combine the shortlist with the first-stage order using
equal-weight reciprocal-rank fusion, k=60. Unlisted candidates get zero judge
contribution; ties keep first-stage order. Reorder only the offered top 30,
append the remaining candidates unchanged, and preserve every candidate,
evidence reference, source revision and current-state check. No fabricated
confidence field and no new persisted query log. Exact-evidence protection is
not separately implemented or proven by this replay.

Use the already configured chat model/provider and its existing authentication,
permissions, privacy mode and deadline. Capture its configuration for the call;
configuration changes cancel or invalidate outstanding ranking. A recall judge
must not become a planner, extraction step or second authority for memory writes.
The outer calling model still controls recall/read/refine and any answer.

### A. Replay protocol and limits

Private artifacts are under `/home/yeonw/workspace/bench/out/judge/`:
`prepare.py`, `run.py`, `analyze.py`, `manifest.json`, `prompt-contract.txt`,
per-call prompts, raw event/output files, `usage.json` and aggregate `report.json`.
No question, expected answer, source ID, summary or excerpt is committed.
Inputs are `out/vague/all-queries.jsonl`, `all-baseline-results.jsonl`,
`out/keep.jsonl`, and snapshot generation
`73c90516-3dcf-4f9a-b7f2-238a15a3973d/graph.sqlite` in the bench directory.

Use arm A1, vector-enabled raw cues, and strict source-episode gold matched by
SHA-256 of `memory_chunk_id`. Keep 175 filtered original questions plus all
69 vague-extra questions: 244 total. Seed 20261003 shuffles sorted IDs within
each slice; floor(n/2) is dev, the remainder held out. Dev has 120 questions;
held out has 124. Freeze the supplied gate, ranking prompt and k=60 before
judging either half; no outcome-based tuning or failed-call retries.

Judge only the 95 gated questions and an equal-size random sample of 95 from
149 bypass questions. Submit independent single-recall jobs in batches of up
to four concurrent `codex exec -m gpt-6-luna` processes, effort low, ephemeral,
read-only, with user config ignored, schema-constrained output and no tools.
This gives per-recall usage rather than allocating batch totals by assumption.
All 190 calls and output permutations must validate before reporting results.

The split is question-stratified, not session-disjoint: related generated cues
can occur in both halves. Report paired 10,000-resample percentile bootstrap
95% intervals and session-cluster sensitivity intervals. These are exploratory
ranking results on generated cues, not confirmation on independent real cues.
The reference external API's saved permutations/split are not supplied here:
its reported gains cannot be paired with this run. The fixed A1 same-run control
is the comparison; it need not reproduce that reference's slice percentages.

Metrics below measure **candidate order**, not actual serialized product top
five, answer correctness, canonical evidence reads or one-step conversation
jumps. Baseline candidates outside the offered pool remain in the MRR
calculation; a missing gold contributes zero. "Overall-kept" includes all
244 retained questions, including extra; original-only results are separate.

### Held-out ranking results

Values are baseline -> gated judge; brackets are paired 95% CI of the change.
Hit values/deltas are percentages/percentage points; MRR uses reciprocal rank.

| Slice | n | Gated / n | Hit@1; delta CI | Hit@5; delta CI | MRR; delta CI |
|---|---:|---:|---|---|---|
| vague | 22 | 12/22 | 13.6 -> 31.8; [4.5, 36.4] | 36.4 -> 54.5; [4.5, 36.4] | 0.259 -> 0.414; [0.041, 0.292] |
| vague-extra | 35 | 18/35 | 20.0 -> 31.4; [2.9, 22.9] | 45.7 -> 62.9; [5.7, 31.4] | 0.305 -> 0.427; [0.052, 0.206] |
| paraphrase | 34 | 11/34 | 38.2 -> 44.1; [0.0, 14.7] | 73.5 -> 76.5; [0.0, 8.8] | 0.526 -> 0.560; [-0.009, 0.092] |
| keyword | 33 | 3/33 | 63.6 -> 63.6; [0.0, 0.0] | 90.9 -> 90.9; [0.0, 0.0] | 0.740 -> 0.742; [0.000, 0.006] |
| overall-kept | 124 | 44/124 | 35.5 -> 43.5; [3.2, 12.9] | 63.7 -> 72.6; [4.0, 14.5] | 0.473 -> 0.545; [0.037, 0.108] |
| original-kept | 89 | 26/89 | 41.6 -> 48.3; [2.2, 12.4] | 70.8 -> 76.4; [1.1, 11.2] | 0.539 -> 0.591; [0.017, 0.094] |

Absolute bootstrap 95% intervals for held-out judged metrics (same resamples):

| Slice | Hit@1 CI (%) | Hit@5 CI (%) | MRR CI |
|---|---|---|---|
| vague | [13.6, 50.0] | [31.8, 72.7] | [0.244, 0.591] |
| vague-extra | [17.1, 48.6] | [45.7, 77.1] | [0.294, 0.566] |
| paraphrase | [26.5, 61.8] | [61.8, 91.2] | [0.417, 0.697] |
| keyword | [48.5, 78.8] | [78.8, 100.0] | [0.622, 0.856] |
| overall-kept | [34.7, 52.4] | [64.5, 79.8] | [0.470, 0.618] |

Session-cluster sensitivity intervals for the paired held-out change:

| Slice | Clusters | Hit@1 delta CI (pp) | Hit@5 delta CI (pp) | MRR delta CI |
|---|---:|---|---|---|
| vague | 16 | [5.0, 33.3] | [0.0, 31.6] | [0.031, 0.265] |
| vague-extra | 29 | [2.9, 21.6] | [5.7, 31.0] | [0.055, 0.201] |
| paraphrase | 32 | [0.0, 13.9] | [0.0, 9.4] | [-0.012, 0.084] |
| keyword | 29 | [0.0, 0.0] | [0.0, 0.0] | [0.000, 0.007] |
| overall-kept | 64 | [3.7, 12.4] | [4.3, 13.8] | [0.039, 0.106] |

Held-out hit@5 wins/losses: vague 4/0, extra 6/0, paraphrase 1/0,
keyword 0/0. Paraphrase MRR has 3 improvements and 1 deterioration; its
delta interval includes zero. No measured slice regresses beyond noise, but
small samples and generated-cue correlation do not prove non-inferiority.

**Quality verdict:** candidate hit@5 meets vague >=45% (12/22 =54.5%) and
extra >=50% (22/35 =62.9%), with positive paired improvements and no
hit@5 losses. The absolute intervals still extend below both target thresholds; product
final-returned targets and real-cue generalization remain unverified.

Dev results are descriptive; no gate/prompt change was made from them:

| Dev slice | n | Hit@1; delta CI | Hit@5; delta CI | MRR; delta CI |
|---|---:|---|---|---|
| vague | 21 | 23.8 -> 33.3; [0.0, 23.8] | 33.3 -> 42.9; [0.0, 23.8] | 0.275 -> 0.397; [0.025, 0.245] |
| vague-extra | 34 | 8.8 -> 17.6; [0.0, 20.6] | 50.0 -> 61.8; [2.9, 23.5] | 0.273 -> 0.377; [0.049, 0.174] |
| paraphrase | 33 | 45.5 -> 51.5; [0.0, 15.2] | 63.6 -> 66.7; [0.0, 9.1] | 0.544 -> 0.592; [0.000, 0.119] |
| keyword | 32 | 50.0 -> 56.2; [0.0, 15.6] | 87.5 -> 87.5; [0.0, 0.0] | 0.667 -> 0.699; [0.000, 0.078] |
| overall-kept | 120 | 32.5 -> 40.0; [3.3, 12.5] | 60.8 -> 66.7; [1.7, 10.0] | 0.453 -> 0.525; [0.041, 0.108] |

Gate invocation: 95/244 =38.9% overall; dev 51/120 =42.5%, held out
44/124 =35.5%. Audit calls are additional measurement only, not a product
call rate. All 190 processes succeeded, no tool calls or invalid outputs,
and full candidate permutations validated. Of the judged recalls, 170 had
30 offered candidates and 20 had only 17 available; none were padded or
dropped. No invocation was retried by the replay runner.

### Bypass audit: does the gate miss useful ranking?

Judge the random bypass sample for this diagnostic only; the gated results
above leave every bypass unchanged. Held-out audit has 50 questions:

| Audit slice | n | Hit@1; delta CI | Hit@5; delta CI | MRR; delta CI |
|---|---:|---|---|---|
| vague | 7 | 42.9 -> 71.4; [0.0, 57.1] | 71.4 -> 71.4; [0.0, 0.0] | 0.527 -> 0.744; [0.014, 0.446] |
| vague-extra | 14 | 35.7 -> 35.7; [0.0, 0.0] | 64.3 -> 71.4; [0.0, 21.4] | 0.452 -> 0.539; [0.028, 0.153] |
| paraphrase | 14 | 50.0 -> 57.1; [0.0, 21.4] | 78.6 -> 78.6; [0.0, 0.0] | 0.640 -> 0.680; [0.000, 0.117] |
| keyword | 15 | 46.7 -> 60.0; [0.0, 33.3] | 86.7 -> 86.7; [0.0, 0.0] | 0.611 -> 0.711; [-0.000, 0.233] |
| bypass_judged | 50 | 44.0 -> 54.0; [2.0, 18.0] | 76.0 -> 78.0; [0.0, 6.0] | 0.563 -> 0.659; [0.044, 0.158] |

Audit held-out hit@5 gains 1 and loses 0; hit@1 gains 5, MRR improves
14 and worsens 3. Dev bypass audit (45) has one hit@5 gain and one loss:
75.6% ->75.6%, paired delta CI [-6.7, 6.7] pp. The gate is useful for
limiting calls and already reaches the target point estimates, but is not
a perfect classifier of useful judging. Do not widen it using held-out
audit labels; any new gate needs a newly held-out confirmation set.

### Measured per-judged-recall resources

Triples are median / p95 / maximum. p95 uses linear interpolation.

| Cohort | n | Input tokens | Cached input tokens | Output tokens | Wall seconds |
|---|---:|---|---|---|---|
| all-judged | 190 | 25584.0 / 31222.5 / 66573.0 | 13056.0 / 13056.0 / 41472.0 | 24.0 / 34.0 / 72.0 | 3.98 / 5.73 / 7.94 |
| gated-heldout | 44 | 25032.5 / 31245.0 / 50945.0 | 13056.0 / 13056.0 / 37376.0 | 24.0 / 34.0 / 72.0 | 4.08 / 6.16 / 7.94 |
| audit-heldout | 50 | 25192.0 / 29853.1 / 31498.0 | 13056.0 / 13056.0 / 13056.0 | 24.0 / 34.0 / 34.0 | 3.95 / 4.87 / 5.30 |

Reported reasoning-output tokens are zero throughout. **Cost verdict: FAIL**
against 12k total input tokens per judged recall: 190/190 exceed it, including
44/44 gated held-out calls. Output stays <=72 tokens. **Latency verdict: FAIL**
against the design's <=500 ms gated p95: measured 6.16 s. This harness includes
agent wrapper/process overhead; it does not prove the minimal product request
would have the same cost or latency. It also supplies no evidence that the
product would meet either ceiling. Do not subtract cached-input tokens or
reduce evidence/candidates to pass. Approval remains withheld pending the
specific resource and product-boundary acceptance checks below.

### Cost and latency interpretation

`turn.completed.usage` supplies actual input, cached-input and output counts,
including Codex's fixed agent/tool wrapper. Cached tokens still count as input;
never subtract them to make the 12k ceiling pass. Wall time measures process
launch through completed JSON under four-job host contention; it excludes
first-stage retrieval and the earlier batched evidence preparation. This is
neither a product provider-only latency nor a cold/warm product benchmark.
No direct monetary price is claimed: price the configured provider's uncached,
cached and output rates separately. Payload-only tokens and a minimal product
request's exact cost remain unverified. Do not transfer external API timings.

### Smaller judge inputs — measurement only, NOT YET APPROVED

Private artifacts: `/home/yeonw/workspace/bench/out/judge-cost/` (`protocol.json`,
`selection-policy-correction.json`, frozen selection, per-stage prompts/outputs/usage,
`dev-reports.json`, `heldout-reports.json`, `report.md`, token sensitivity and validation).
All 48 K/excerpt/summary combinations plus one two-stage arm ran on the same dev
half: K = 10/15/20/30, excerpt = 0/200/400/700, summary = 150/300/500 Unicode
characters. Caps take prefixes of the saved text; no new excerpt selection or
summary generation. Two-stage uses the first stored summary line capped at 150
characters for 30 offers (no separate titles in saved prompts), then 700-character
excerpts for its first five; refined ranks precede the remaining initial shortlist.
The frozen gate, cohort, split, prompt instructions and k=60 fusion stay unchanged.
Every complete candidate permutation and untouched tail is validated; only the
95 gated queries and original 95-query control sample receive calls, at most four
concurrently, gpt-6-luna only. Controls never affect gated metrics.

Selection on dev retains the prior full-input vague result (9/21 =42.9%), requires
extra >=50%, and rejects any slice whose paired Hit@5 or MRR change CI is wholly
negative; minimize gated median input, then p95/max and wall time. The initial
45% dev screen was corrected before held-out judging: 45% is the held-out target,
while the prior full-input dev result itself is below it. All 49 arms were evaluated
before freezing K=15, summary cap 150, no excerpt, for 94 held-out gated/control
calls. No failed call was retried. Full results include paired 10,000-resample
95% CIs, absolute and session-cluster sensitivity intervals, and control audits.

Input counts tokenize the exact instruction + question/candidate JSON with
**tiktoken 0.14.0, o200k_base**, excluding the agent wrapper; cached tokens are
never subtracted. This
is a plain-text estimate: gpt-6-luna has no mapping in that tokenizer release,
and provider roles/schema framing are unmeasured. Output is actual native API
`turn.completed.usage.output_tokens` (all generated work is judging, no tools),
summed over stages. Wall time includes Codex launch/wrapper and host contention.
Triples below are median / p95 / maximum; costs use gated recalls only.

| Arm / split | Gated n | Vague / extra Hit@5 (%) | Input estimate | API output tokens | Wall seconds |
|---|---:|---|---|---|---|
| Previous full-summary +700 / held-out | 44 | 54.5 / 62.9 | 11430.5 / 17377.6 / 19416 | 24 / 34 / 72 | 4.08 / 6.16 / 7.94 |
| K15, summary150, no excerpt / dev | 51 | 42.9 / 55.9 | 1194 / 1331 / 1381 | 22 / 34 / 34 | 4.01 / 6.67 / 8.46 |
| K15, summary150, no excerpt / held-out | 44 | 45.5 / 60.0 | 1160.5 / 1343.7 / 1409 | 22 / 34 / 34 | 4.12 / 6.98 / 9.89 |
| Two-stage K30/5, summary150 +700 / dev | 51 | 42.9 / 55.9 | 2711 / 4269.5 / 4854 | 40 / 56 / 58 | 8.27 / 11.38 / 12.90 |

Held-out baseline -> selected gated ranking; brackets are paired 95% change CIs
(Hit@5 percentages / percentage points; MRR reciprocal rank):

| Slice | n | Hit@5; delta CI | MRR; delta CI |
|---|---:|---|---|
| vague | 22 | 36.4 -> 45.5; [0.0, 22.7] | 0.259 -> 0.402; [0.032, 0.283] |
| vague-extra | 35 | 45.7 -> 60.0; [2.9, 25.7] | 0.305 -> 0.373; [0.014, 0.134] |
| paraphrase | 34 | 73.5 -> 73.5; [0.0, 0.0] | 0.526 -> 0.558; [0.000, 0.076] |
| keyword | 33 | 90.9 -> 90.9; [0.0, 0.0] | 0.740 -> 0.740; [0.000, 0.000] |
| overall-kept | 124 | 63.7 -> 69.4; [1.6, 10.5] | 0.473 -> 0.526; [0.024, 0.087] |

**Recommendation:** K=15, summary prefix 150, no excerpts is the cheapest
dev-eligible tested input and meets held-out point targets: 10/22 vague and
21/35 extra, with no held-out Hit@5 losses or slice regression beyond noise.
It preserves less of the prior Hit@5 gain, especially vague (two wins versus four);
vague Hit@5 delta CI includes zero. Extra MRR has eight wins/two losses.
Dev loses one keyword hit; its CI includes zero. Held-out control audit gains one
paraphrase hit and loses one keyword hit (aggregate 76% ->76%); keep the gate.

**12k payload verdict: fits as estimated**, 0/44 gated held-out recalls exceed it;
cl100k_base sensitivity is 1646 / 1950 / 2131 tokens. Original full-summary payload
alone exceeds 12k in 19/44 held-out gated recalls (91/190 across the original run).
Exact minimal-provider billable input remains unverified; the Codex wrapper is
not made cheaper by this counting method. The 6.98 s gated p95 still fails the
500 ms design budget. Absolute Hit@5 CIs are [22.7, 68.2]% vague and [42.9, 74.3]%
extra: thresholds and non-inferiority are not statistically established. Generated
cues, related sessions across halves, one stochastic output per configuration,
prefix selection and candidate-order-only evaluation limit generalization.
Completed: 4881 new live stage calls, 4798 complete recall permutations, zero
failed calls/tool calls; frozen inputs/split, privacy and document checks accompany
the aggregate report. No product changes, builds, real-cue confirmation, exact
provider request, product evidence/jump or cold/warm latency verification.
**NOT YET APPROVED remains in force.**

### Offline, cancellation and fallbacks

Bypass adds zero provider calls. Offline/local mode may use only the configured
usable local model; never silently switch to a remote provider or load a new
resident model. If no usable model exists, the model is unavailable, the
remaining deadline is insufficient, parsing fails or evidence becomes stale,
return the complete first-stage recall. Retain existing partial-lane metadata.
An empty valid shortlist leaves the base order intact.

Cancellation releases the inference request and evidence buffers promptly;
shutdown never waits for it. No timer, background scan, idle I/O, startup
migration or synchronous database work on Tokio workers. Ranking reads are
bounded and use the existing blocking-I/O boundary. It creates no graph/data
writes. Any separately approved evidence/index/consolidation write must use
the existing consolidation lease, durable receipts and data-authority guard;
refused legacy folders must remain byte-identical, including checkpoints.
Nothing blocks turn admission/startup/shutdown. No retries to hide failures.

### Implementation tasks and acceptance — NOT YET APPROVED

1. **Resolve the measurement blockers first.** Reproduce the frozen protocol
   with an exact minimal configured-provider request, real session-disjoint
   held-out cues and a same-run product boundary. Vague hit@5 >=45%, extra
   >=50%; report paired hit@1/5 and MRR intervals for every slice, and review
   displaced prior hits. No slice may regress beyond noise; inconclusive
   intervals remain experimental, not proof of equivalence. Demonstrate <=12k
   input and <=500 output tokens per judged recall, gated p95 <=500 ms within
   existing deadlines, bypass p95 <=20 ms and realistic call fraction <=40%.
   Do not approve by dropping candidates/content or increasing budgets.
2. **Bounded candidate evidence view.** Reuse existing compact-page/read
   handles. Stub E2E checks all offered IDs, current revision, scope/as-of,
   edited/revoked sources, correct excerpts and one-step canonical jumps.
   Never hide lower candidates to fit an envelope; preserve full pagination.
3. **Same-model conditional ranking.** Capture configured provider, freeze
   gate diagnostics and validate/fuse the response. Stub/replay E2E checks
   exact bypass identity, complete candidate count/order, successful ranking,
   empty output, malformed/duplicate/foreign IDs, provider error, deadline,
   offline/local behavior, cancellation and configuration changes. Review
   whether protected exact-evidence candidates are needed; measure that policy
   as a separate frozen arm rather than silently changing this replay.
4. **Integration and resource checks.** Run existing recall, source-revision,
   vector/cursor, memory hot-cache/idle, durable-configuration, migration MIG-01
   and shutdown/queue coverage. Shutdown includes the active turn and queued
   follow-ups. Perf tests at owner scale assert complete counts/order/latest
   state alongside latency, cold/warm/offline behavior and zero added idle
   writes (also no added idle reads). No background residency or deadline
   increase. E2E stub/replay only; isolate HOME/BUTLER_DATA. OS code only in
   butler-platform; files <=500 lines, production functions <=80 lines.
5. **Product review.** Keep this unapproved until quality/resource gates and
   privacy/authority review pass. No new UI status line without an actionable
   choice. If settings copy is later needed, write Korean and English
   independently and use the existing approved memory/settings names.

## 2. Optional later: dedicated decision API

**PLAN ONLY — owner explicitly decided NOT to use it now.** No endpoint,
credentials, dependency, setting or product implementation is added here.
The configured chat model remains the only proposed current judge.

A separately approved rank-only endpoint could replace just the conditional
ranking request, retaining the candidate/evidence contract, frozen gate,
validation, fusion, cancellation and complete base fallback. It cannot answer,
extract, write memory, plan tools or acquire broader retrieval authority. The
existing architecture's retirement of separate planners/verifiers requires an
explicit narrow normative exception before this endpoint is implemented.

Potential speed and cost benefits are hypotheses until measured with identical
inputs and paired controls. The supplied external replay reported vague
hit@5 40.9% ->54.5%, extra 55.9% ->58.8%, paraphrase 88.2% ->88.2%, keyword
97.0% ->97.0% on its held-out half, at approximately 38% invocation. Those
reported aggregates are historical context, not reproduced measurements here,
and do not establish this provider's price, latency, or product response quality.
Compare full request latency (evidence fetch/network included), input/output
usage, cache pricing, rate limits and availability against the configured model
before proposing adoption; no speed/cost promise or universal reranking.

A different provider receives the recall question and historical summaries/
excerpts. That is a new data disclosure, including potentially unrelated
candidate evidence. Any future UI must explain the provider/destination,
sent fields and its retention policy before opt-in. Use a **per-user, default-off
setting** with separately approved endpoint/credentials; permission is never
inherited from another user or ordinary chat-model configuration. Offer revocable
consent, minimize fields and never persist conversational payloads in product
logs. Offline/privacy restrictions always override the opt-in. No silent
provider substitution, no new resident local judge and no background requests.

When unavailable, disabled, rate-limited, invalid, cancelled or out of deadline,
return the complete base recall. A configured-model fallback is allowed only if
separately specified and still fits the original deadline/call budget; do not
cascade paid requests automatically. Setting or endpoint changes invalidate
outstanding calls. Any future configuration write follows the data-authority
guard and existing lease/receipt contract, never a refused legacy tree.

Future acceptance: explicit owner approval; default-off per-user isolation and
revocation E2E; consent/data-destination validation; offline and unavailable
fallback; malformed/stale output; cancellation/shutdown including queued turns;
zero added idle I/O; complete evidence/results; paired session-disjoint quality
and cost/latency comparison with the same strict gold and product boundaries.
Keep the first-stage path working when no endpoint is configured.

Tracking issue: [#464](https://github.com/Hexpy-Games/butler/issues/464). Opening the issue records optional work; it does
not approve implementation.

## Validation and remaining work

Completed: 190 live measurement calls with gpt-6-luna; permutation/completeness,
no-tool and usage validation; seeded paired and session-cluster bootstraps;
source-reference/line-limit/private-text screening; isolated cargo fmt and fmt
--check; isolated source-check with the existing source-identical prebuilt
binary from codex-captain-p6 (binary newer than checker sources); isolated
`node deploy/licenses/generate.mjs --check`; isolated `git diff --check`.
No fingerprint refresh requested, no new dependency or licence, no builds.
Clippy is not applicable: no Rust crate sources/manifests changed. No product
E2E/perf tests run because no product behavior changed and builds are forbidden.
Source-check used the prebuilt binary instead of `cargo run` to avoid a build.
The worktree target directory was absent and remains absent.

Unverified: product serialization/evidence/jump correctness, bypass latency,
cold/warm/offline provider behavior, actual minimal-request input cost,
provider-only latency, monetary cost, other configured models, source fetch
latency, exact-evidence protection, and independent real-cue/session-disjoint
confirmation. All proposed implementation and optional-API acceptance work
remains undone by design, not silently approved by these aggregate results.
