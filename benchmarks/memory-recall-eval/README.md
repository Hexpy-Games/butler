# Owner-local memory recall diagnostic

This harness reads owner-approved Butler data only when `--owner-data` is
provided. It writes a private corpus under `private/`, and keeps models and
per-question results ignored. Do not commit or upload those directories.

The current runner uses Butler's pinned Rust `ort` and `tokenizers` versions,
with BGE CLS pooling and E5 attention-mask mean pooling. E5 receives
`query: `/`passage: ` prefixes. The two E5 splitters are overlapping token
windows (512 token limit, 64-token overlap with decode headroom) and
sentence-aware packing. Both score a parent document by its best chunk.

**Limit:** this is a model and in-memory ranking diagnostic. It does not call
Butler's registration, generation projection, LanceDB search, graph-qualified
`recall_memory`, or canonical source reader. Its output cannot approve a model
replacement. `REPORT.md` records that decision boundary.

Run from the repository root on macOS:

```sh
python3 benchmarks/memory-recall-eval/build_corpus.py \
  --owner-data ~/.butler \
  --output benchmarks/memory-recall-eval/private/corpus.json
python3 benchmarks/memory-recall-eval/prepare_assets.py \
  --bge-root /path/to/pinned-bge-assets \
  --e5-root /path/to/pinned-e5-assets
cd packages/butler-agent/rust
cargo build -p butler-memory-recall-eval --release
cd ../../..
python3 benchmarks/memory-recall-eval/run.py \
  --binary "$CARGO_TARGET_DIR/release/butler-memory-recall-eval" \
  --output benchmarks/memory-recall-eval/results/raw.jsonl
python3 benchmarks/memory-recall-eval/lexical.py \
  --dataset benchmarks/memory-recall-eval/private/corpus.json \
  --output benchmarks/memory-recall-eval/results/lexical.jsonl
python3 benchmarks/memory-recall-eval/summarize.py \
  --input benchmarks/memory-recall-eval/results/raw.jsonl \
  --output benchmarks/memory-recall-eval/results/summary.json
```

The corpus builder opens the owner graph SQLite file in immutable read-only
mode. It samples real conversation sources, transcripts, recorded web search
snippets, learned claims and aliases, and canonical Ledger documents. It
creates 50 documents per category and one source-gold diagnostic question per
document. The questions are deterministic templates from source text. Labels
such as `ko_wrapper` and `two_anchor` describe only the template; they are
not independently authored cross-lingual or multi-hop questions.
