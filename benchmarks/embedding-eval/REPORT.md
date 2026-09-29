# Embedding worker memory evaluation (2026-09-29)

## Decision

**Take multilingual-e5-small to a product-path validation; keep the current model for now.** On this diagnostic corpus, E5-small used 619 MiB physical footprint after load and peaked at 699 MiB, versus BGE-M3 at 1,685 and 2,817 MiB in the same 4-thread, CPU-arena-off evaluation setting. It also found the relevant document first on 16/17 queries versus BGE's 15/17. Its 512-token limit caused 24 originals to become 30 embedding chunks. A larger independent Korean/English corpus and Butler's projection → LanceDB search → canonical source-read path are still needed before changing the product model. LanceDB remains in place.

The full setting grid is [MATRIX.csv](MATRIX.csv), model results are [MODELS.csv](MODELS.csv), and repeat measurements are [REPEATS.csv](REPEATS.csv) and [INTERACTION.csv](INTERACTION.csv). These contain byte counts and query-level miss IDs; model files and intermediate JSONL are ignored.

## Method and limits

- macOS 27.0, arm64 CPU; release Rust binary, static ONNX Runtime via `ort 2.0.0-rc.13`, `tokenizers 0.22.2`. Every arm starts a new process and uses the same ORT session/tensor APIs and tokenizer version as `butler-memory/src/cognition/embedding.rs`. The harness is independent of the product worker and never reads Butler user data.
- Source: the prior synthetic [24-document, 17-query dataset](dataset.json), SHA-256 `d8cd355eef2fc4812de7f1e3570e09286531a00e2c72eaf605f9a8bc0266c60e`; this is a small diagnostic set, not product recall acceptance. Each query has its fixed relevant-document ID. Cosine scores rank normalized vectors in memory. No LanceDB search or canonical source-read is included in this new run.
- `footprint -f bytes --noCategories -p <owned PID>` supplies `phys_footprint` immediately after session load and the OS-reported `phys_footprint_peak` after all inference. Peaks include long-document inference; they are not a sampled checkpoint. Repeated fresh processes expose macOS allocation variation. MiB below means 1,048,576 bytes.
- Load is **ORT session construction only** from local cached ONNX files. It excludes download, SHA verification, tokenizer load, process launch, and product IPC. Query times include tokenization and one ORT inference, excluding vector-store search. With 17 observations, empirical p95 is the slowest query. The 16-document time is 16 sequential embedding calls, matching the current unbatched product approach; it is not one padded ONNX batch.
- E5 uses `query: ` / `passage: `, attention-mask mean pooling and normalization; BGE uses normalized CLS; Snowflake uses `query: ` only and its ONNX `sentence_embedding`; GTE uses normalized CLS without a prefix. Inputs above the model limit are tokenized, decoded into nonoverlapping chunks with headroom, re-encoded, and **checked** against the limit. Document score is the maximum chunk cosine. E5's long original produces seven vectors; no text is silently truncated. This chunking is an experimental contract, not yet Butler's production splitter.

## A. BGE-M3 ORT settings

The full 128 combinations cross prepacking, `Disable/Basic/Extended/All` graph optimization, CPU arena, memory pattern, 1/4 intra-op threads, and `session.use_env_allocators`. An additional arm mirrors the product's current `Session::builder().with_intra_threads(1).with_inter_threads(1)` default settings. The grid evaluates one short document and query so every configuration is measured at the same load/short-inference boundary; the model table below includes the long-document peak.

| BGE configuration | Idle MiB | Peak MiB | ORT load ms | Evidence |
| --- | ---: | ---: | ---: | --- |
| Product defaults, one run | 1,663 | 1,663 | 500 | [MATRIX.csv](MATRIX.csv) |
| Product defaults, 3 repeats | 1,659–1,722 | 1,659–1,722 | 445–482 | [REPEATS.csv](REPEATS.csv) |
| All optimization, prepacking **off**, memory pattern **off**, CPU arena on, 1 thread, 3 shuffled repeats | 1,513–1,532 | 1,514–1,534 | 321–341 | [INTERACTION.csv](INTERACTION.csv) |
| Same, prepacking off, memory pattern **on**, 3 repeats | 1,747–1,748 | 1,747–1,749 | 344–384 | [INTERACTION.csv](INTERACTION.csv) |
| Same, prepacking **on**, memory pattern off, 3 repeats | 1,667–1,724 | 1,667–1,724 | 467–485 | [INTERACTION.csv](INTERACTION.csv) |

The largest reliable reduction here requires **both prepacking and memory pattern off**: the shuffled 3-run median was 1,522 MiB, versus 1,722 MiB for the product-default repeat median. Turning only one off was not reliably helpful. Across the 128 arms, the matched median difference from disabling memory pattern was −131 MiB and from disabling prepacking was −42 MiB, but both have strong interaction and noise; these marginal figures are not additive. Graph optimization level, 1 versus 4 threads, and `use_env_allocators` did not show a stable isolated memory win. CPU arena off also did not yield a stable isolated win in this grid, despite the earlier plan's approximately 66 MB observation. No shared allocator was registered, so `use_env_allocators` is only a config-entry probe; one session has nothing to share with another.

For the full corpus, BGE with prepacking and memory pattern off, arena on and 1 thread used **1,475 MiB idle / 2,539 MiB peak**, with 91.7 ms query p95 and 1,785 ms for 16 serial documents. The 4-thread/arena-off comparison used **1,685 / 2,817 MiB**, 26.9 ms p95 and 531 ms for 16 documents. Both scored 15/17 Recall@1. This memory option has a substantial speed cost and was not applied to the product.

### Why 543 MiB on disk becomes about 1.66 GiB resident

The pinned BGE ONNX has **566,383,616 bytes of INT8/UINT8 initializers and only 1,286,144 bytes of FLOAT initializers**; it uses 144 `MatMulInteger` nodes. The file is genuinely quantized. A complete persistent fp32 copy of every weight is **not established** by this graph or benchmark. ORT maintains in-memory model/initializer structures, kernel-ready weights and execution allocations in addition to the file bytes. ORT documents [prepacked initializer buffers and per-session allocation](https://onnxruntime.ai/docs/get-started/with-c.html) and [memory-pattern preallocation](https://onnxruntime.ai/docs/api/java/ai/onnxruntime/OrtSession.SessionOptions.html); the measured interaction above shows those settings account for roughly 200 MiB in this process. The remaining roughly 900 MiB above the 543 MiB file in the low-memory arm is **not attributed to a particular tensor copy** without allocator-level tracing. The 1.66 GiB figure is process physical footprint, not a weight-size estimate.

## B. Single-vector multilingual models

All files were pinned to a full repository revision, fetched without login, and SHA-256 checked in [fetch.py](fetch.py). The model cards/Hugging Face API reported no gate at measurement time. E5 files named `avx512_vnni` still executed through the local arm64 ORT CPU path; the filename does not prove arm64-specific optimization. GTE's public ONNX is on an official-repository **PR revision**, not `main`; `main`'s PyTorch loader declares `trust_remote_code`. The standalone ONNX ran without executing that remote Python code. Its int8 file is produced by ONNX Runtime dynamic quantization from the 1,255,519,330-byte PR export.

| Model / pinned revision | License / gate | ONNX MiB | Runtime code note |
| --- | --- | ---: | --- |
| [Xenova/bge-m3](https://huggingface.co/Xenova/bge-m3) `4de13258303883538bd53b696b452bf8099f0858` | MIT / none | 543.3 | Existing baseline |
| [multilingual-e5-small](https://huggingface.co/intfloat/multilingual-e5-small) `614241f622f53c4eeff9890bdc4f31cfecc418b3` | MIT / none | 112.9 | Plain ORT |
| [multilingual-e5-base](https://huggingface.co/intfloat/multilingual-e5-base) `d128750597153bb5987e10b1c3493a34e5a4502a` | MIT / none | 265.8 | Plain ORT |
| [snowflake-arctic-embed-m-v2.0](https://huggingface.co/Snowflake/snowflake-arctic-embed-m-v2.0) `95c2741480856aa9666782eb4afe11959938017f` | Apache-2.0 / none | 296.5 | ONNX embeds pooling; source Python uses custom code |
| [gte-multilingual-base](https://huggingface.co/Alibaba-NLP/gte-multilingual-base) ONNX PR `a3dc39eb01581850e5115626349f6dfca99f0438` | Apache-2.0 / none | 324.2 int8 | Original ONNX 1,197.4 MiB; source Python needs custom code |

| Model, 4 threads and arena off unless stated | Idle / peak MiB | ORT load ms | Query p50 / p95 ms | 16 docs ms | Recall@1 / @3 | MRR | Vectors for 24 docs |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| E5-small | **619 / 699** | **143** | **4.3 / 5.6** | **89** | **16/17 / 17/17** | **0.9706** | 30 |
| E5-base | 961 / 1,003 | 237 | 8.9 / 10.2 | 203 | 16/17 / 17/17 | 0.9706 | 30 |
| Snowflake | 1,036 / 1,097 | 219 | 9.5 / 11.6 | 205 | 14/17 / 17/17 | 0.9118 | 24 |
| GTE dynamic int8 | 1,086 / 1,966 | 276 | 9.0 / 11.7 | 228 | 13/17 / 17/17 | 0.8824 | 24 |
| BGE-M3 | 1,685 / 2,817 | 449 | 22.2 / 26.9 | 531 | 15/17 / 17/17 | 0.9412 | 24 |

E5-small's three additional full-corpus runs gave 605–616 MiB idle and 686–696 MiB peak, with the same 16/17 top-1 result. These are local inference and in-memory ranking numbers, **not** the full Butler recall result. E5's 512-token limit and extra vectors are the main integration cost at the owner's ~500-token average unit size; actual unit-length distribution and segmentation need measurement. Quantized GTE's score should not be treated as the model's unquantized quality, and its high long-input peak matters despite moderate idle footprint.

## C. KURE-v2 and LanceDB (static check only)

This checkout pins `lancedb = 0.27.2` and `lance = 4.0.0`. The local LanceDB query planner accepts nested multivectors (`lancedb-0.27.2/src/table/query.rs`), but no indexed **sum-MaxSim** search API/implementation was found in these pinned crates. Therefore this task did not claim native MaxSim index support or run a KURE latency benchmark. At 15,000 units × 500 token vectors × 128 int8 dimensions, raw token values alone would be **960 MB decimal / 916 MiB**, before IDs, index and metadata; fp32 values would be 3.84 GB decimal. The Ledger's earlier exact int8 MaxSim p95 of about 630 ms and ~983 MB storage are prior-work observations, not measurements from this harness. KURE remains a separate multivector integration task.

## Reproduce and review

From the repository root, install [requirements.txt](requirements.txt) in a local environment, run `python3 benchmarks/embedding-eval/fetch.py`, then build `cargo build -p butler-embedding-eval --release` from `packages/butler-agent/rust`. With `CARGO_TARGET_DIR` pointing to this worktree's `target`, run:

```sh
python3 benchmarks/embedding-eval/run.py matrix --binary target/release/butler-embedding-eval --output benchmarks/embedding-eval/results/matrix.jsonl
python3 benchmarks/embedding-eval/run.py models --binary target/release/butler-embedding-eval --output benchmarks/embedding-eval/results/models.jsonl
```

The pinned ONNX SHA-256 values are in `fetch.py`; the dataset and CSV measurements are tracked. No production model, download flow, vector generation, or LanceDB setting was changed.
