# Per-script index and fallback top-30 experiment

This is an offline experiment, not an enabled product analyzer. Run commands
with fresh `HOME` and `BUTLER_DATA`, preserving Cargo/Rustup cache paths.
Private inputs/outputs belong outside the repo; never modify the owner snapshot.
Use the noembed research's frozen seed-20261003 split (120 dev / 124 held out).
Python requires `regex==2026.9.29` and `tiktoken==0.14.0`.

1. Copy the snapshot, including the benchmark's synthetic canonical caller
   bindings from the saved conversation-store copy. Fingerprint immutable input
   files. Build the unmodified `butler-memory` example `fts_recall_probe`, `-j 8`,
   and save its executable outside the repo. Run `DATA --backfill` on the copy.
2. `prepare.py ARTIFACTS COPY_GRAPH OUTPUT` asserts all 714 complete native
   summary/entity/claim/source fields match the neutral Python analyzer before
   generating experimental fields and query expressions. Every script boundary
   uses Unicode Script properties, without language detection. Fold Latin,
   Cyrillic and Greek case/diacritics; other spaced scripts retain words. Hangul
   uses the research cue stopwords, distinct words, repeated character bigrams
   across words, and character postings for single-character cues. Han, Kana,
   Thai and other unspaced scripts use word/run tokens and bigrams. There is no
   translation, generated metadata, stemming or evidence truncation.
3. Clone the disposable data again. In one transaction replace
   `memory_episode_fts_v1` with `script-fields.json`, keeping native metadata,
   revision, project, canonical references and content hashes. Assert 714 rows
   and run the FTS5 integrity check. These fields are analyzed representations
   of the same complete content; metadata hashes describe that original content.
4. Apply `native-query.patch` using `git apply --unidiff-zero` from repo root,
   build only the probe, save its
   executable outside the repo, and immediately reverse the patch. Set
   `FTS_SCRIPT_QUERIES=OUTPUT/script-queries.json` only for the script probe.
   The bridge loads query expressions once on the existing blocking read path;
   all native selection, freshness, canonical rejection, ranking and gate scores
   remain in effect. It is never shipped or used in product checks/E2Es.
5. Run native dev probes, preserving all payloads/metrics, to
   `baseline-dev-valid.jsonl` and `script-dev.jsonl`. Run
   `lookup.py OUTPUT ARTIFACTS` for dev index timing: assert every ordered top-30
   lookup equals the unlimited SQL reference and all indexed row counts agree.
   Run `analyze.py freeze ARTIFACTS/questions.json OUTPUT`. Select by dev
   recall@30, recall@15, then lookup median, requiring keyword hit@5 and
   recall@15 no worse than baseline. Never tune using held-out results.
6. Run both frozen native probes on held-out queries, saving
   `baseline-heldout-valid.jsonl` and `script-heldout-valid.jsonl`. The vector
   control is the saved A1 trace from the recall-judge benchmark, with fresh
   judging in this run. Its retrieval build/time differs from these probes;
   that limitation must remain explicit in the report.
7. `experiment.py ARTIFACTS OUTPUT` makes four fresh held-out judge arms:
   neutral15, script15, frozen-winner30, vectors15. The unchanged native gate
   uses raw lexical rank-one <.15 and combined top-two gap <.05. All calls use
   gpt-6-luna, low effort, the product instructions, summary prefixes of 150
   Unicode characters, no excerpts/tools, at most four concurrent CLI processes.
   Validate up to ten distinct local handles; equal-weight RRF60 ties preserve
   base order. Preserve all candidates and the entire untouched tail beyond the
   offered count. Bypass and failed/deadline calls retain complete base order;
   never retry a failure. The CLI wall deadline is 8 seconds, including wrapper
   overhead, rather than a minimal-provider-only measurement.
8. `analyze.py report ARTIFACTS/questions.json OUTPUT` produces private aggregate
   ceilings, per-slice hit@1/5/MRR@30, paired 10,000-resample percentile intervals
   (seed 20261003), session-cluster sensitivity, gate counts, payload token
   estimates (o200k_base), actual completed-call API usage and gated wall med/p95.
   Missing gold contributes zero. Deadline calls stay in quality/latency
   denominators; missing completed API usage is never invented. Actual input
   includes the Codex wrapper and cached tokens; payload estimates exclude it.
9. Adopt only if winner30 meets 70/89 original and 16/35 extra hit@5, or its
   paired hit@5 improvement over winner15 is supported by a positive 95% lower
   bound with no keyword regression beyond its CI, and gated wall p95 <8s.
   Otherwise report the stopped experiment. Candidate ordering does not prove
   final-page/answer correctness or complete source coverage. The question split
   is exploratory; related sessions cross halves.
10. Recheck immutable input fingerprints, publish aggregates only, and delete
    disposable data/index/query/prompt copies, Python bytecode and task target.
