# Token/cache fixes — 2026-10-04

Implemented audit priorities 1–4 on the win-fixes-5 chain, with the audit report merged into the task branch. No live model calls were made.

## Behavior and privacy

Every provider round appends component byte lengths and SHA-256 hashes to the existing prompt usage log: model, frozen tool list, tool choice, reasoning, instructions/system and every input item. The resolved cache key and endpoint are hashed; auth mode/provider identity are recorded without credentials. No prompt, tool arguments, output, endpoint or key is logged by these diagnostics. Missing provider cached-token reporting is distinct from an explicit zero. Failed requests and responses without usage still carry diagnostics. There is no timer, idle writer, database scan or new metrics store.

LCP uses `serialized-components-v1`: independently serialized components separated by newlines. This avoids treating an input array's closing bracket as a cache break when conversation items append. It is a reconstructed byte prefix, not the provider's rendered/token prefix or HTTP field ordering. Previous request bytes stay only in a bounded in-memory LRU (128 sessions, 32 MiB total), keyed by a session-scope hash; restart/eviction means no previous comparison. The request itself is never shortened when diagnostics cannot retain it.

The observed first mismatch is the final-report tool component. Working requests in the available replay remain append-only. Final reporting now retains the exact schemas and tool choice, and a runtime guard rejects and journals native tool calls before dispatch, effect admission or approval. Repeated calls and an empty final response cannot reopen execution. Explicit new user steering retains the existing continuation behavior.

The model projection recursively removes `changed_file`, `changed_files` and `changedFiles`, including nested arrays. All unrelated result fields survive; the immutable journal, App operation output and actual file retain full evidence. Work instructions require checkpoints/result reviews only for milestones, recovery or necessary quality decisions and batch independent bookkeeping in one native round, awaiting dependent results. Plan reviews, dispositions and exact effect approvals remain guarded by the existing runtime.

## Owner recording replay and limits

Source: the authorized Windows temporary test profile named in [the audit](../../../../plans/token-audit-2026-10-04.md). SQLite was read through `mode=ro`, `query_only`, inside a read transaction. The first 70 accepted rounds match the audit's 1,462,423 provider input tokens. The later 71st acceptance is excluded.

The source does **not** contain all serialized requests. Downloads investigation and execution authority checkpoints preserve 6 and 20 request history prefixes respectively; the final file-location turn preserves its initial message. Other initial prompts are approximated from original messages and matching admitted profiles; tools/results are reconstructed from accepted responses and journal rows. Two runtime result-reader responses lack persisted content and have explicit reconstruction-unavailable markers. Saved complete Work tail observations are retained, including after an omitted optional record. These estimates do not assert complete reconstruction of the owner's actual 70 request bodies. Public-path E2Es below separately verify complete result/evidence contracts and required guards.

The after reconstruction removes five optional checkpoints and two result reviews, keeps all other accepted tools and recorded evidence, strips only the three UI diff fields and retains final schemas. It uses the new static instructions. This is a counterfactual selection of optional records; a stub cannot prove what a live model will choose from the new instructions. Independent batching is measured separately in the public runtime replay.

Both reconstructions go through the real `ModelProvider` subscription serializer and a loopback-only stub in the generic `prefix_replay` example. Session aliases preserve the five actual session groupings; credentials, endpoint and cache-key namespace are synthetic stub values, so no claim is made about historical route/key identity. Input token estimates use `o200k_base` over serialized model/tools/tool_choice/reasoning/instructions/input, not a provider billing tokenizer. The before estimate is 11.46% above the original recorded total, another reason to treat the result as a modeled comparison, not measured billing savings. No private prompts/files were committed.

| Measurement | Before | After |
| --- | ---: | ---: |
| Requests, 10 turns | 70 | 63 |
| Mean requests/turn | 7.0 | 6.3 |
| Reconstructed input tokens, total | 1,629,957 | 1,281,316 |
| Mean input tokens/request | 23,285.10 | 20,338.35 |
| Mean LCP, consecutive requests of same session | 87.3369% (65 pairs) | 98.7273% (58 pairs) |
| Mean LCP, within same turn | 90.0015% (60 pairs) | 100% (53 pairs) |
| Six final-report LCPs, range | 0.005825–0.020975% | 100% |

Modeled input reduction: **21.39%**. Across-turn changes still alter user/context instructions or input; they are not rewritten or concealed to improve LCP. Provider cache hits/recovery cannot be measured with a stub (it deliberately omits cached tokens).

| Turn | Requests before → after | Original provider input | Reconstructed input before → after |
| --- | ---: | ---: | ---: |
| D1 | 4 → 4 | 44,071 | 55,738 → 55,674 |
| D2 | 10 → 8 | 158,377 | 178,895 → 137,054 |
| D3 | 2 → 2 | 17,566 | 21,254 → 29,270 |
| D4 | 7 → 7 | 90,400 | 100,689 → 100,577 |
| D5 | 23 → 19 | 706,609 | 813,545 → 607,671 |
| D6 | 2 → 2 | 20,965 | 21,197 → 29,213 |
| S1 | 4 → 4 | 45,775 | 55,950 → 55,886 |
| S2 | 15 → 14 | 350,800 | 349,768 → 225,037 |
| S3 | 2 → 2 | 16,938 | 20,062 → 28,078 |
| S4 | 1 → 1 | 10,922 | 12,859 → 12,856 |

Per-request input token estimates in request order (after excludes only optional calls, rather than renumbering recorded round identities):

| Turn | Before | After |
| --- | --- | --- |
| D1 | 13406, 13682, 14166, 14484 | 13390, 13666, 14150, 14468 |
| D2 | 11353, 11583, 13246, 14815, 15742, 21679, 24043, 24421, 24765, 17248 | 11352, 11582, 13245, 14814, 15741, 21678, 24042, 24600 |
| D3 | 14384, 6870 | 14368, 14902 |
| D4 | 13389, 13855, 13962, 14322, 14590, 15108, 15463 | 13373, 13839, 13946, 14306, 14574, 15092, 15447 |
| D5 | 12048, 12266, 12464, 12941, 13478, 13588, 15733, 17838, 26826, 27868, 30011, 32968, 34661, 35478, 43374, 52295, 53938, 55987, 59761, 61666, 65038, 65401, 57917 | 12047, 12265, 12463, 12940, 13477, 13587, 15732, 17837, 26825, 29580, 32537, 34230, 35047, 42943, 51864, 55225, 60579, 63951, 64542 |
| D6 | 14321, 6876 | 14305, 14908 |
| S1 | 13489, 13765, 14199, 14497 | 13473, 13749, 14183, 14481 |
| S2 | 10225, 10434, 10896, 11267, 11549, 12326, 23038, 29198, 29949, 30049, 30316, 34093, 37461, 38262, 30705 | 10224, 10433, 10895, 11266, 11548, 12325, 15478, 15790, 16541, 16641, 20418, 23786, 24587, 25105 |
| S3 | 13808, 6254 | 13792, 14286 |
| S4 | 12859 | 12856 |

## Public-path validation

The existing write/edit replay stays at 7 requests. Its reconstructed input vector changes from `[10753,11188,11903,12562,12898,13297,6191]` to `[10748,11197,11926,12599,12861,13150,13971]`; final LCP changes from 0.019454% to 100%. The final input grows because the previously removed tool schemas now remain present. Full App diff and final file contents are asserted, as are all model-projection diff spellings.

The existing Work replay stays at 9 requests, with final LCP 0.018866% → 100%. Its before vector is `[10749,11112,11575,12014,12456,13023,13154,13505,6178]`; after is `[10734,11099,11564,12005,12449,13019,13150,13493,14075]`. The equivalent total-calculation replay with independent review/todo bookkeeping batched and optional records absent uses **6 requests**, input vector `[10734,11109,11584,12661,13006,13603]`, and 100% LCP for all five comparisons. Both assert the exact final answer and recorded execution; the batched replay additionally asserts the actual command stdout is exactly `42` with exit code 0, accepted plan review and recorded disposition. The earlier baseline was captured before behavior changes, with the diagnostic/reconstruction helper only.

Final-phase adversarial replays each use 11 requests and 100% LCP, reject repeated write calls (including after an empty answer), preserve cancelled App activities, create no forbidden file and request no approval. A nested MCP replay preserves unrelated receipt fields and all original App evidence while removing all three diff spellings from model results. Provider missing-vs-explicit-zero cache reporting and diagnostic hashes/lengths/key hash are asserted against captured HTTP bodies.

Prompt budget ratchet: all **21 profiles** stay at or below win-fixes-5 counts; aggregate **29,230 → 29,077** tokens. Existing function-length baselines only decrease (provider run 142 → 125, prompt run 156 → 133); test-count limits and performance budgets are unchanged. No new unit tests.

Builds of the touched agent/E2E crates and the offline example passed. Validation commands run from `packages/butler-agent/rust`, each under `crates/butler-e2e/scripts/isolated-run.sh` (fresh temporary HOME/BUTLER_DATA; real Rust caches preserved). Cargo uses `+1.91.0 -j 8`; no concurrent cargo builds; E2Es use at most four test threads.

- `cargo fmt --all` and formatting check.
- `cargo clippy -p butler-agent -p butler-models -p butler-turn -p butler-runtime -p butler-e2e --all-targets -- -D warnings`: PASS.
- Stub E2E token_cache, turn_continuation, tools_effects, tools, mcp, steward_presentation and usage: **27 passed**, including the prompt budget ratchet.
- Existing guided-host tests: **12 passed**; provider serialization/transport/prompt tests: **19 passed**; prompt usage golden-format test: **1 passed**. Existing agent-loop/guided-turn/Work guard tests: **27 passed** after updating the old final-tool-choice assertion to require preservation (no test added or weakened).
- Additional assertion of exact command stdout/exit code in the batched E2E: **1 passed**.
- Existing usage_scale and monitoring_scale E2Es: **2 passed**. Usage at 44,000 rows/640 transcripts: warm 24h **24.07 ms**, session **5.28 ms**, all-time **13.27 ms**, cold all-time **692.67 ms**. Monitoring at 600 chats/5,000 turns/300,000 events/50,000 Works: work-status p50 **4.32 ms**, p95 **24.97 ms**, session-view polling p95 **126.94 ms**. Existing tests assert full counts, latest state and scoped results. Existing debug timing mode reports budgets as unenforced; all measured timings are below those unchanged budgets.
- `cargo run -p butler-source-check -- .`: PASS; 499 non-E2E tests, zero test-count, function-length, architecture, platform and E2E-gate violations.
- `git diff --check`: PASS. Final `git fetch origin`: main remains `ec138feae`, win-fixes-5 remains `a1eae9119`.
- No TS/UI files changed; the conditional Bun/UI checks in AGENTS.md do not apply. No PR, tag or coordinator CI was created/run.

The generic replay input is JSONL with explicit `model`, `scope`, `label`, `instructions`, `tools` and semantic `messages`; stdout contains only aliased labels, token estimates and diagnostic hashes/lengths. Build/run `cargo build -p butler-models --example prefix_replay`, then feed the private reconstruction to `target/debug/examples/prefix_replay`. Passing an instruction-prefix JSON file instead prints per-profile token counts. Keep private source/reconstruction outside the repository and delete it after the measurement.

## Evidence still unavailable

Actual provider cache recovery, eligible internal cache boundaries and the cause of the audit's 48 Working requests with normalized cached=0 remain unmeasured. The historical source lacks full request bodies and raw SSE cached-token fields. New request-only diagnostics make those distinctions observable on a later authorized provider campaign; no speculative prefix rewrite or content truncation was added. No live campaign, Windows build or coordinator CI was run in this Linux task.
