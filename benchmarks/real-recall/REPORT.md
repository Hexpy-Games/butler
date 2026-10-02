# Real-conversation recall benchmark (unfiltered)

Measurement date: 2026-10-02, Linux x86_64 (WSL). This benchmark changes no
production recall code. All private inputs, prompts, outputs and measurements
remain outside the worktree. The numbers below describe unfiltered candidates;
external quality review can change them without rerunning recall.

The decision rule is: **if B2 >= A1 on hit@5 and MRR within noise, the vector
stack is not earning its cost on this data.** Noise is assessed using the paired
query bootstrap intervals below, not independent arm confidence intervals.
This is an exploratory rule, not a predeclared equivalence margin.

Final external session decisions were intersected with user-input origin,
active status, complete summaries, complete current-revision episode vector
units, and the three genuine project scopes. Old session labels were ignored. Project identifiers are private configuration
in the output directory, not hardcoded or committed.
Post-2026-09-25 episodes without vectors are excluded by that prefilter.
Retrieval still searches the full product snapshot (727 episodes), including
test and vectorless memories; only the candidate/gold pool is filtered.

| Group | Kept sessions | Kept episodes | Sampled episodes | Sampled sessions | Sampled dates |
|---|---:|---:|---:|---:|---:|
| DAILY | 25 | 126 | 36 | 25 | 19 |
| SANDY | 68 | 308 | 36 | 36 | 15 |
| JEV | 1 | 10 | 10 | 1 | 1 |

Sampling uses seed 20261002, round-robin sessions and shuffled episodes. Luna
writes up to three Korean questions per episode, balancing associative vague,
paraphrase and literal-keyword styles. Five episodes are batched per call; 25
questions per argument-writing call; up to four calls run concurrently. Only
separate `codex exec -m gpt-6-luna` processes generate text. There is no Luna
classification or quality pass. Invalid episode IDs, unsupported exact answers
or turn IDs are rejected deterministically; literal answer/entity token leaks
are recorded but not filtered. The external decision model owns quality review. There are 210 retained
candidates: DAILY 90, SANDY 90, JEV 30, each group evenly split by style. Of
242 generated rows, 14 failed deterministic source checks and 18 valid surplus
rows were not needed for the target counts. Twenty-five of 70 vague candidates
have conservative literal leak flags; those flags are not an external quality
verdict. MODEL requested five results for 135 candidates and the default six
for 75; none explicitly disabled vectors. Result-page limits thus differ across
RAW and MODEL and are part of the model argument strategy being compared.

Gold identifies the source episode and supporting canonical turn IDs, with a
short exact answer substring. It does not union other episodes merely because
the same substring appears. The model argument writer receives the real tool
schema and question IDs/text only, never episodes, gold, groups or answers.

A1 is vector+RAW, B1 unavailable-vector+RAW, A2 vector+MODEL and B2
unavailable-vector+MODEL. RAW sends only the verbatim question as cue. MODEL
arguments are preserved. B omits the vector adapter and takes the product's
own degrade path, without changing recall ranking code. The native embedding
owner and unchanged private worker drive the real generation vector adapter;
no agent, asset acquisition or background consumers start. Default product
limits and deadlines remain. RAW defaults to six results, so hit@10 describes
the returned page, not a forced ten-result search.

The embedding worker warms before timing; cold time is recorded separately.
Arm order rotates across queries. The harness uses native en-US collation
and the current UTC clock for product ordering/recency inputs. Each result retains complete ranked IDs,
every gold rank, UTF-8 payload bytes, wall time, vector status, errors, full
structured payload and a 6,000-character text preview. Metrics use the complete
payload. Gold hit means any gold episode is present within the rank cutoff;
MRR uses the first gold rank. Answer presence falls back to NFKC/case/alphanumeric
normalized substring matching within returned result strings. External boolean
answer judgments override supplied rows; unsupplied rows retain fallback.

The prior run copy had embedding hash-cache and WAL/shm differences from its
old fingerprint. Before this measurement, copied WALs were checkpointed and
copied SQLite databases switched to rollback journaling to avoid shm writes
from read-only readers. The prepared copy was sealed read-only and its baseline
recorded after preparation. This affects storage preparation, not source rows or
ranking behavior. Snapshot hashes are compared to the original saved baseline.

Paired intervals use seeded 10,000-resample query bootstraps; two-sided sign
tests omit ties. Expansion-only counts require a gold association path without
lexical, alias or vector channel. Channels do not establish the counterfactual
that every direct seed failed. Search failure after successful embedding can
share the product's vector-unavailable code with search timeout; those cases
cannot be fully distinguished and are marked ambiguous.

Threats to validity: candidates and expected answers are model-written and
unfiltered; literal diagnostics can flag generic words or miss morphological
leaks; repeated facts can have relevant episodes outside the designated gold;
substring answer matching can misjudge correctness; correlated queries from
the same episode/session make query bootstrap intervals optimistic; JEV has
only one session/date; vector-complete filtering excludes recent vectorless
conversations; fresh project-bound callers differ from a real ongoing context;
MODEL can choose different limits or omit vector use; argument-writing model
latency/cost is excluded from tool wall times; shared-host load and warm
caches affect latency; recall source offers are measured, not a subsequent model
answer or conversation jump. The result cannot alone settle a removal decision.

Reproduce summaries with private paths:

```sh
python3 benchmarks/real-recall/summarize.py --out /home/yeonw/workspace/bench/out
python3 benchmarks/real-recall/summarize.py --out /home/yeonw/workspace/bench/out \
  --keep-queries /private/keep.jsonl --answer-judgments /private/judgments.jsonl
```

Keep inputs accept a JSON array of IDs, one ID per line, or JSONL `query_id`
rows. Judgment rows contain `query_id`, `arm`, and boolean `answer_present`.
Filtered summaries get a separate suffix, preserving unfiltered aggregates.

Validation: the benchmark builds with the repository's pinned Rust 1.91.0.
`cargo fmt -p butler-real-recall-bench`, `cargo clippy -j 8 -p
butler-real-recall-bench -- -D warnings`, source-check on the Rust workspace,
and source-check on the benchmark directory pass. The existing recall test
selection passes all three tests (zero failures/ignored). Python syntax,
synthetic leak/metric checks, filter input formats, and the external-filter plus
answer-override CLI check pass. A sealed-copy product smoke run passes, and
snapshot/copy content hashes remain unchanged after that smoke run.

Initial command setup failures were corrected without production edits: a
repository-root formatter invocation found no targets; host Rust 1.98 Clippy
flagged an existing `butler-core/src/json_lines.rs` warning, while pinned 1.91
passes; source-check given the repository root used the wrong workspace layout,
while its intended Rust-workspace root and the separate benchmark root pass.

Unfiltered results (percentages; Answer is normalized fallback, not an external judge):

| Arm / slice | n | H@1 | H@5 | H@10 | MRR | Empty | Answer | ms med / p95 | bytes med / max |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| A1 | 210 | 38.6% | 61.9% | 62.4% | 0.481 | 0.0% | 58.6% | 2612.0 / 3605.7 | 23853 / 24548 |
| B1 | 210 | 28.1% | 45.2% | 45.7% | 0.350 | 0.0% | 44.8% | 2611.6 / 3461.4 | 23703 / 24552 |
| A2 | 210 | 32.9% | 54.3% | 54.3% | 0.415 | 0.0% | 51.4% | 2359.3 / 3285.7 | 23786 / 24571 |
| B2 | 210 | 22.4% | 37.1% | 37.1% | 0.287 | 0.0% | 35.2% | 3115.3 / 3503.2 | 23719 / 24576 |

| Arm / slice | n | H@1 | H@5 | H@10 | MRR | Empty | Answer | ms med / p95 | bytes med / max |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| A1/DAILY | 90 | 55.6% | 74.4% | 74.4% | 0.639 | 0.0% | 62.2% | 2485.1 / 3675.9 | 23983 / 24548 |
| B1/DAILY | 90 | 34.4% | 47.8% | 47.8% | 0.404 | 0.0% | 42.2% | 3142.8 / 3550.7 | 23796 / 24537 |
| A2/DAILY | 90 | 48.9% | 70.0% | 70.0% | 0.582 | 0.0% | 60.0% | 2381.5 / 2612.2 | 23946 / 24571 |
| B2/DAILY | 90 | 30.0% | 46.7% | 46.7% | 0.377 | 0.0% | 36.7% | 3184.8 / 3510.2 | 23817 / 24542 |
| A1/JEV | 30 | 36.7% | 70.0% | 70.0% | 0.511 | 0.0% | 73.3% | 780.0 / 887.3 | 23120 / 24480 |
| B1/JEV | 30 | 30.0% | 66.7% | 66.7% | 0.458 | 0.0% | 70.0% | 624.6 / 708.9 | 22776 / 24534 |
| A2/JEV | 30 | 36.7% | 63.3% | 63.3% | 0.489 | 0.0% | 63.3% | 2281.8 / 2463.9 | 22916 / 24483 |
| B2/JEV | 30 | 40.0% | 56.7% | 56.7% | 0.478 | 0.0% | 60.0% | 2974.1 / 3496.4 | 22453 / 24574 |
| A1/SANDY | 90 | 22.2% | 46.7% | 47.8% | 0.313 | 0.0% | 50.0% | 2827.2 / 3131.5 | 23878 / 24529 |
| B1/SANDY | 90 | 21.1% | 35.6% | 36.7% | 0.260 | 0.0% | 38.9% | 2406.0 / 2784.2 | 23789 / 24552 |
| A2/SANDY | 90 | 15.6% | 35.6% | 35.6% | 0.224 | 0.0% | 38.9% | 2350.3 / 3566.1 | 23756 / 24522 |
| B2/SANDY | 90 | 8.9% | 21.1% | 21.1% | 0.133 | 0.0% | 25.6% | 3066.7 / 3457.5 | 23732 / 24576 |

| Arm / slice | n | H@1 | H@5 | H@10 | MRR | Empty | Answer | ms med / p95 | bytes med / max |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| A1/vague | 70 | 22.9% | 40.0% | 40.0% | 0.299 | 0.0% | 32.9% | 2579.2 / 3554.7 | 23900 / 24548 |
| B1/vague | 70 | 14.3% | 28.6% | 28.6% | 0.196 | 0.0% | 24.3% | 2636.4 / 3535.5 | 23980 / 24537 |
| A2/vague | 70 | 24.3% | 31.4% | 31.4% | 0.270 | 0.0% | 28.6% | 2376.6 / 2665.6 | 23885 / 24495 |
| B2/vague | 70 | 12.9% | 18.6% | 18.6% | 0.151 | 0.0% | 15.7% | 3161.6 / 3509.8 | 23698 / 24574 |
| A1/paraphrase | 70 | 41.4% | 61.4% | 61.4% | 0.494 | 0.0% | 61.4% | 2602.0 / 3666.0 | 23850 / 24529 |
| B1/paraphrase | 70 | 20.0% | 34.3% | 34.3% | 0.260 | 0.0% | 38.6% | 2605.1 / 3447.7 | 23748 / 24514 |
| A2/paraphrase | 70 | 31.4% | 60.0% | 60.0% | 0.426 | 0.0% | 57.1% | 2351.8 / 2804.8 | 23460 / 24451 |
| B2/paraphrase | 70 | 15.7% | 28.6% | 28.6% | 0.211 | 0.0% | 30.0% | 3118.1 / 3472.4 | 23956 / 24576 |
| A1/keyword | 70 | 51.4% | 84.3% | 85.7% | 0.650 | 0.0% | 81.4% | 2665.9 / 3620.6 | 23737 / 24529 |
| B1/keyword | 70 | 50.0% | 72.9% | 74.3% | 0.595 | 0.0% | 71.4% | 2561.7 / 3327.2 | 23358 / 24552 |
| A2/keyword | 70 | 42.9% | 71.4% | 71.4% | 0.549 | 0.0% | 68.6% | 2353.3 / 3566.1 | 23849 / 24571 |
| B2/keyword | 70 | 38.6% | 64.3% | 64.3% | 0.499 | 0.0% | 60.0% | 3046.2 / 3506.5 | 23712 / 24552 |

Paired differences are first arm minus second. W/L/T use hit@5.

| Comparison | Hit@5 W/L/T | Hit@5 difference (95% CI), pp | MRR W/L/T | MRR difference (95% CI) |
|---|---:|---:|---:|---:|
| A1-B1 | 41/6/163 | +16.67 (+10.95, +22.86) | 60/13/137 | +0.131 (+0.084, +0.179) |
| A2-B2 | 47/11/152 | +17.14 (+10.48, +23.81) | 58/21/131 | +0.128 (+0.077, +0.181) |
| B2-A1 | 5/57/148 | -24.76 (-31.43, -18.10) | 14/76/120 | -0.194 (-0.249, -0.142) |

Vector-on found a gold episode that vector-off missed for 41 RAW queries (19.5%)
and 47 MODEL queries (22.4%); all these gold results expose the vector channel.
Vector-off found gold missed by vector-on for 6 RAW queries (2.9%) and 11 MODEL
queries (5.2%). These are any-returned-rank comparisons, separate from hit@5.

The result exposes channels and association paths. There are **zero vague gold
hits supported only by graph expansion in every arm** under the stated channel
criterion. This does not prove that graph expansion has no other contribution.

Native inference ran for all 420 vector-arm calls, with zero observed inference
timeouts or errors. Both A arms reported partial vector coverage in all 210
records, with `vector_current_rows_missing`; B arms reported the intentional
`vector_unavailable` degrade code. Missing rows concern the full retrieval pool,
even though the candidate gold pool required complete vectors. All 840 tool
calls returned nonempty results and zero tool errors. Cold native warm-up took
1,611.1 ms, outside tool timings. Full structured responses were retained even
when their separate 6,000-character preview was capped.

**Decision-rule outcome: not met.** B2 hit@5 is 37.1% versus A1 61.9%; B2 MRR is
0.287 versus A1 0.481. Paired B2−A1 differences are −24.76 percentage points
(95% CI −31.43 to −18.10) and −0.194 MRR (−0.249 to −0.142). Both intervals
exclude zero. On these unfiltered candidates the vector lane earns a measurable
recall gain; MODEL argument writing does not replace it. This does not establish
that the stack's total engineering/resource cost is justified, nor supersede
external quality filtering. Warm RAW median latency is almost identical between
A1 and B1; the observed MODEL latency difference is reported without claiming
an unverified cause.

Final validation passes: 210 questions and 840 complete arm records, unique
arm coverage per query, byte sizes against complete serialized payloads,
rank lists/every gold rank, preview length, and synthetic metric/filter input
arithmetic. Snapshot and sealed copy content hashes match their measurement
baselines after the full run. The filter CLI check confirms supplied answer
judgments override fallback while unspecified rows retain it and filtered
outputs preserve the canonical unfiltered summary. No live model calls were
made by tests. External quality filtering and answer judging are intentionally
outside this task; no authorized benchmark step was omitted.
