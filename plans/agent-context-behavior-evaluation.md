# Agent context behavior evaluation — 2026-10-02

Recommendation: **ship as is for the context reduction**. No regression was observed in this bounded suite. Main passed 91/102 (89.22%); `codex/agent-context` passed 98/102 (96.08%). Seven paired observations improved, none deteriorated. This is a small repeated scenario sample, not a guarantee about arbitrary work.

Compared `origin/main` at `53fa0a3130da` with `origin/codex/agent-context` at `fa16b90a3`. The evaluation branch adds instrumentation and tests only; no context-branch product fix was necessary. All live calls used `openai/gpt-6-luna`, foreground low effort. Existing cognition background calls also used Luna. Credentials came from the E2E mechanism's supported read-only Codex auth fallback, explicitly passed through `BUTLER_E2E_CODEX_AUTH_JSON`. Every run used fresh temporary HOME/BUTLER_DATA/CODEX_HOME; no owner's Butler data was accessed. Each version used two concurrent scenarios, three repetitions, independent empty sandboxes, identical fixtures and model configuration. Pending approval/forms were observed and stopped without approval.

| Category | Main | Reduced context |
| --- | ---: | ---: |
| Files | 12/12 | 12/12 |
| Shell | 6/6 | 6/6 |
| Schedules | 6/9 | 6/9 |
| Memory remember/recall/query | 8/9 | 8/9 |
| Ask user | 6/6 | 6/6 |
| Delegation discovery/no-dispatch | 9/9 | 9/9 |
| MCP discovery/execution | 6/6 | 6/6 |
| Approval | 10/12 | 12/12 |
| Korean replies | 6/6 | 6/6 |
| Persona/EOL | 6/6 | 6/6 |
| Global/project/duplicate rules | 9/9 | 9/9 |
| Long context | 1/6 | 6/6 |
| Correctable tool errors | 6/6 | 6/6 |

All failing transcript IDs and their per-request token counts are in [summary.json](evidence/agent-context/summary.json) and the individual `main-<id>.json` / `after-<id>.json` files. The two complete result files include every successful observation too. Exact IDs:

- Both: `SCHEDULE-CREATE-1`, `SCHEDULE-CREATE-2`, `SCHEDULE-CREATE-3`, `MEMORY-EXACT-2`.
- Main only: `APPROVE-SHELL-1`, `APPROVE-MCP-2`, `LONG-PERSONA-1`, `LONG-PERSONA-2`, `LONG-PERSONA-3`, `LONG-RULE-2`, `LONG-RULE-3`.

Schedule creation's catalog description explicitly says `enabled:false`, outside the session's scoped progressive surface, in both versions. Both agents correctly refused to invent or execute an unavailable capability. These failures remain counted conservatively against the requested create behavior. The memory failure uses `recall_memory` with vector search disabled rather than the required `query_memory`; both versions made this choice in repetition two. These are baseline limitations, not demonstrated reduction regressions. Main's shell case stopped after `effect_work_required`; the reduced branch created Work/Plan Review and reached the exact-action approval without modifying the file. Main's MCP case asked a generic structured approval rather than reaching the MCP authority card. The reduced branch reached the actual MCP authority card in all repetitions. Main omitted persona/rule tails; the new excerpt policy retained them.

## Token measurements and full prompt evidence

Measured with `o200k_base`, including the serialized request envelope; these are estimates, not billed usage. Fresh session: **13,600 → 10,492 tokens** (22.85% reduction), versus the original audit's 13,598 → 10,494 result (dynamic identifiers can differ by a few tokens). Instructions: 4,051 → 2,312; schemas: 8,996 → 7,645. Initial visible tool schemas: 35 → 29. Across all 102 comparable observations, mean first request: 13,769.80 → 10,649.25; sum of all foreground serialized requests: 4,174,300 → 3,437,289. The latter includes repeated context across rounds and is not a billing metric.

Ten representative sessions are captured fully before/after: fresh, Korean, persona, EOL, rules, duplicate rules, project, long persona, long rules, MCP. Each `prompts-{main,after}/<session>.json` contains the complete instructions, input, and every visible schema; corresponding `.txt` files render all prompt messages. `structural.json` has per-session token counts. Capture used the real gateway admission path and deterministic TURN-02 replay, not a hand-assembled prompt.


| Session | Main tokens/tools | Reduced tokens/tools |
| --- | ---: | ---: |
| fresh | 13600/35 | 10492/29 |
| ko | 13604/35 | 10486/29 |
| persona | 13222/35 | 10109/29 |
| eol | 13240/35 | 10129/29 |
| rules | 13634/35 | 10531/29 |
| duplicates | 13670/35 | 10521/29 |
| project | 14675/39 | 10832/30 |
| long_persona | 13683/35 | 10591/29 |
| long_rules | 20112/35 | 17083/29 |
| mcp | 13605/35 | 10491/29 |

## Reproducibility and checker corrections

The scenario manifest is `crates/butler-e2e/fixtures/agent-behavior/scenarios.json`; the harness is `tests/agent_behavior.rs`. Run `comparative_live_behavior` with the existing live tier, `BUTLER_E2E_MODEL` and `BUTLER_E2E_MODEL_MATRIX` set to `openai/gpt-6-luna@low`, the desired `BUTLER_E2E_BIN`, and `BUTLER_BEHAVIOR_OUTPUT`. `BUTLER_BEHAVIOR_IDS` optionally selects a subset; default runs all 34 three times. Run `structural_prompt_sessions` on the replay tier to capture the ten full requests.

Original runs each completed 102 observations. Three faulty fixture/checker assumptions were identified from captured evidence, not model outcomes:

1. Read-only `printf` requires no approval. Replaced the shell approval fixture with `printf made-by-tool > made.txt`, asserting no file exists before approval; ran the corrected scenario three times on each version.
2. WrongTypes mutates only top-level strings and did not affect array/nested file-read arguments. Replaced it with malformed JSON injection and ran both recovery scenarios three times on each version. Every counted recovery includes the actual `invalid_arguments` feedback and a delivered correct result/file.
3. Normalized MCP journal arguments omit the route, and semantic errors can be journaled as completed. Check actual provider input tool calls/feedback as well as durable journal results. Discovery accepts a provider-constrained catalog search as the same discovery class; file approval accepts either file-write or shell-write class, with exact action and absent file still required. Steward spelling is case-insensitive. Korean checks require at least five Hangul syllables and dominant Korean prose after excluding code and the expected filename/secret marker, rather than merely detecting one Korean character. File equality is byte-exact; captured successful write receipts independently verify the expected SHA-256 and byte length for every scored write scenario.

The corrected shell/recovery observations replace their invalid originals, yielding 102 comparable observations per version. All **222 original plus corrective observations** remain in `observations.json.gz`, with full captured foreground requests, tool feedback, transcripts, approvals and original checker failures. It deduplicates identical request fields/input items by SHA-256; `scripts/expand-agent-behavior.py` reconstructs every complete request without losing content. No live test was retried to fish for a passing outcome. The final results are deterministically rescored by `crates/butler-e2e/scripts/score-agent-behavior.py`. Original assertion-based runs returned failure; this report does not describe them as green. The corrections keep forbidden-action, durable content, exact approval and reply checks intact. A preliminary interrupted instrumentation calibration is excluded.

## Validation

- Main native build and context native build: passed, cargo -j8.
- Live credential round trip: passed (8.04s).
- Full live comparison: 102 observations per version, rates above; original assertion commands failed as expected on the recorded failures.
- Corrective live scenarios: nine observations per version; raw commands failed on the journal-only error check, which was corrected using captured `invalid_arguments` feedback. Main additionally had its shell failure.
- Ten full prompt captures per version: passed (32.74s / 45.59s).
- Existing agent context E2E: 1 passed. Existing agent feedback E2Es: 3 passed. E2E library test target: 0 tests.
- Rust fmt, E2E clippy `-D warnings`, Rust source check: passed.

Limits: actual worker/steward execution is outside this small suite (discovery and forbidden dispatch are covered). It does not measure long-running task quality or throughput. The long-context fixtures exercise excerpts and source recovery, not every possible conversation compaction history. UI validation and Ledger performance findings are delivered separately on `codex/ui-smokes`.
