# Real conversation recall benchmark

Offline measurement only: production recall behavior is unchanged. Rust calls
`MemoryRecall::recall_tool`, public argument validation, canonical binding,
the active generation graph reader, `GenerationVectorAdapter`, and the native
host embedding owner/worker. The build script stages unchanged private host
modules in Cargo's output directory. It starts no agent or background consumers.

All conversation-derived inputs, prompts, model outputs, bindings, fingerprints,
results and labels belong outside the worktree. Output guards reject paths inside
it. Commit only generic code and the aggregate REPORT.md. The snapshot is read
through immutable SQLite connections. Prepare fresh empty caller sessions on a
second copy, never on the snapshot. Recall must leave both fingerprints unchanged.

Use absolute paths for the private snapshot, writable run copy, output and target.
Reuse prepared copies, tool schema and fingerprints when available. Supply a
private `project-groups.json` array of `{project_id, group}` rows under OUT, with
DAILY/JEV/SANDY groups (null project ID for the global DAILY scope). Owner project
identifiers are private configuration, never hardcoded in this harness.
Otherwise:

```sh
cp -a --reflink=auto "$SNAPSHOT" "$COPY"
python3 benchmarks/real-recall/prepare_run.py --snapshot "$SNAPSHOT" --copy "$COPY" --out "$OUT"
```

Before measurement, seal the prepared copy (after model asset cache warm-up):

```sh
python3 benchmarks/real-recall/prepare_run.py --snapshot "$SNAPSHOT" --copy "$COPY" --out "$OUT" --seal-existing
```

Sealing checkpoints copied SQLite WALs, switches copied databases to rollback
journaling to avoid read-only reader shm writes, and removes write permissions
from the copy. It verifies the snapshot and records the measurement baseline.
Restore directory write permissions only when deleting the copy afterwards.

Supply `final-sessions.jsonl` externally: one row per session with `session_id`,
`group`, `label` and provenance. `corpus.py` performs no model classification.
It intersects genuine labels with user-input, active, summary-complete,
complete episode vector units and the three real project scopes. It extracts
canonical source turns and entity labels. The old `sessions.jsonl` is ignored.

```sh
python3 benchmarks/real-recall/corpus.py --data "$SNAPSHOT" --out "$OUT"
python3 benchmarks/real-recall/queries.py --out "$OUT" --schema "$OUT/tool-schema.json"
```

Generation uses only separate `codex exec -m gpt-6-luna` text-only processes,
five episodes per generation batch, 25 questions per argument batch, at most four
concurrent processes. Full canonical turns support exact expected answers and
turn IDs. Round-robin sessions with deterministic shuffled episodes spreads the
sample; no quality classifier runs. Invalid source/turn assertions are rejected;
leak tokens are conservative literal diagnostics, never a quality filter.
Up to three questions per episode and 30 per DAILY/SANDY style, 13 per JEV style
are retained. Gold IDs identify the source episode; repeated facts elsewhere may
also be relevant but are not automatically unioned just because text matches.

MODEL argument writing sees the actual tool description/schema and only question
IDs/text, never source material, groups or gold labels. Cached output is reused
only for identical prompts. Fresh caller project scope is bound independently.

Every check/test below needs fresh temporary HOME and BUTLER_DATA, keeping the
real Cargo and Rustup caches via absolute CARGO_HOME/RUSTUP_HOME. Model generation
uses its working authentication environment, outside those check invocations.

```sh
export CARGO_HOME=/absolute/cargo-cache RUSTUP_HOME=/absolute/rustup-cache
export HOME=$(mktemp -d) BUTLER_DATA=$(mktemp -d)
cargo build --manifest-path benchmarks/real-recall/Cargo.toml -j 8
"$CARGO_TARGET_DIR/debug/butler-real-recall-bench" "$COPY" "$OUT/queries.jsonl" "$OUT/results.jsonl"
python3 benchmarks/real-recall/verify.py --out "$OUT"
python3 benchmarks/real-recall/prepare_run.py --snapshot "$SNAPSHOT" --copy "$COPY" --out "$OUT" --verify
python3 benchmarks/real-recall/summarize.py --out "$OUT"
python3 benchmarks/real-recall/summarize.py --out "$OUT" --keep-queries /private/keep.jsonl --answer-judgments /private/judgments.jsonl
```

A1/B1 send the question verbatim as cue; A2/B2 preserve model arguments.
A installs the real vector adapter; B omits it to exercise the product's vector
unavailable degrade path. Arm order rotates per query. Native inference warms
before timing, with cold time saved separately. No limits, deadlines, response
budgets or ranking weights change. RAW uses the default six-result page; hit@10
therefore describes the returned page rather than ten forced candidates.

Each result contains full structured payload, complete ranked IDs and every gold
rank, UTF-8 result bytes, elapsed milliseconds, error, inference lane status,
and a payload text preview capped at 6,000 Unicode characters. The complete
payload remains available for metric verification. Inference timeouts are
observable; a search timeout after inference can share the generic unavailable
code with other search failures and is explicitly marked ambiguous.

Summaries report overall/group/style metrics, paired wins/losses/ties,
two-sided sign tests and seeded 10,000-resample query bootstrap 95% intervals.
Keep files accept one ID per line, a JSON array of IDs, or JSONL `query_id` rows.
Judgments use JSONL `query_id, arm, answer_present` boolean rows; unspecified rows
fall back to normalized expected-answer matching within returned result strings.
Filtered outputs get a `-filtered` suffix; unfiltered aggregates stay intact.
Graph-only gold hits require association paths and no lexical/alias/vector
channel; provenance does not establish a causal counterfactual.

Decision rule: if B2 >= A1 on hit@5 and MRR within noise, the vector stack is not
earning its cost on this data. Query bootstrap does not account for session or
episode dependence. External quality filtering and answer judging remain necessary.
After verifying fingerprints, delete the private run copy and build target;
retain the snapshot and private output for reproducibility.
