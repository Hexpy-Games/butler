# P2a. Embedding model: fix now, evaluate a replacement after 0.1.0

## Current state (measured 2026-09-29)
- **Model and download.** BGE-M3 (`Xenova/bge-m3`, `model_quantized.onnx`, 543 MB) is NOT bundled. On first use the worker downloads it from Hugging Face at a pinned revision, verifies each file's SHA-256, and stores it in `DATA/cache/models` (`butler-agent/src/host/embedding/worker/assets.rs`).
- **Worker memory (Rust/ORT, M-series Mac, release build):**
  - resident while idle: about **1.66 GB** phys_footprint;
  - CPU arena off saves about 66 MB, and that is the only setting that helps.
- **Worker speed:**
  - load takes 2.4 s, of which 1.7 s is SHA-256 verification;
  - with 4 intra-op threads, one query takes 21 ms and a batch of 16 takes 0.44 s.
- **Batches are not really batched.** The "batch" path runs inference one text at a time.
- **Correctness bug:** the active generation still carries the JS embedding identity, so no new memory has received vectors since the Rust cutover (`completion/consumer/process/vector.rs`). See draft #325 for the migration design.

## Step 1: before or with the vector-bug fix (keep BGE-M3)
1. Set arena off and 4 intra-op threads for interactive queries. Throttle background work by duty cycle.
2. Implement real batched inference: one ONNX run per padded batch, with texts sorted by length.
3. Reap the worker when idle. The model stays loaded while a conversation is active and unloads after about 10 minutes idle.
4. Embed new memories in batches during the idle gap after a turn, while the model is already loaded, with a maximum delay such as 5 minutes.
5. Never re-hash 570 MB on every load. Cache the verified digest keyed by (size, mtime).
6. E2E coverage:
   - a memory written in chat A is found from chat B by keyword immediately, and by paraphrase right after the batch runs;
   - the worker exits after the idle timeout;
   - measure the footprint while idle and at peak.

## Step 2: replacement evaluation (after 0.1.0)
Prior Python experiment: `~/.codex/artifacts/embedding-model-comparison-20260925/HANDOFF-KO.md` (4 models, 24 docs, 17 queries).

Decision criteria, in priority order:
1. **Memory.** Resident and peak phys_footprint of the worker in the Rust/ORT path. BGE-M3 today is 1.66 GB.
2. **Distributable (hard gate).** The license allows redistribution. No gated access: auto-download needs no login or terms acceptance. Download size is acceptable. EmbeddingGemma is gated (HF login plus terms), so it is **excluded** for automatic distribution.
3. **Speed.** Query embedding p95, load time, and batch throughput.
4. **Quality.** Korean and English recall on a larger fixed corpus, through the product's real projection and recall path.
5. **Integration cost.** Storage and search changes, e.g. multi-vector.

Candidates:
- **KURE-v2** (Apache-2.0, ungated, 295 MB). Best quality (17/17 top-1) and lowest memory in Python (0.58 GB physical). But:
  - it is multi-vector (ColBERT-style, 128-d per token);
  - query time was ~600 ms in the Python/BF16 single-thread path;
  - index size grows per token.

  Tasks:
  - export to ONNX and quantize int8; measure in Rust/ORT;
  - measure token-row storage and exact vs compressed MaxSim search cost at owner scale (~15k units);
  - measure end-to-end quality.
- **BGE-M3.** The baseline.
- Optionally, a small single-vector multilingual model with a permissive license. Add it only if it passes the distribution gate.

Adopt a replacement only if it clearly reduces memory, passes the distribution gate, has a query p95 within the interactive budget (target ≤100 ms), and does not regress quality. Otherwise keep BGE-M3 with the Step 1 fixes.

## Distribution choice (decide after the model is chosen)
Pick one of three options, depending on the license and size:
- (a) runtime download from the upstream hub (as today);
- (b) runtime download from our own GitHub release assets, which requires a license that permits redistribution;
- (c) bundling in the app package.

Always verify the SHA. When the model is unavailable, degrade to lexical and alias recall.
