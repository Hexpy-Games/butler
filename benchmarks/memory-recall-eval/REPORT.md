# E5-small memory recall evaluation — diagnostic, NO-GO

## Decision

**NO-GO for replacing BGE-M3.** This run does not establish non-regressing
quality on Butler's product recall path. On 300 source-derived prompts,
E5-small with overlapping chunks scored 48.0% Recall@1 versus BGE-M3's
50.3%. A lexical/recorded-alias proxy scored 61.7%, exposing how strongly
the generated prompts reuse source words. The prior 17-query result in
Ledger `REPORT-EMBEDDING-MEMORY-EVAL-20260929` and draft PR #337 remains
a small diagnostic, not product acceptance. Keep the default BGE-M3.

If E5 is taken to a proper product-path evaluation, use **512-token windows
with 64-token overlap** as the provisional splitter: it beat sentence packing
on Recall@1, MRR and evidence found, while using fewer peak MiB here. That
choice is provisional because neither splitter was run through Butler's
projection, LanceDB and graph-qualified recall.

## Corpus and method

- Read-only owner data: 50 real items each from short conversation, long
  conversation, recorded web search snippets, learned claims/aliases,
  Project Ledger, and dated or negated text; **300 real, 0 synthetic**.
  No item is duplicated across categories. KO/EN/mixed conversations each
  have 15/15/20 items in both length categories. Project items include
  23 specs, 15 plans, 2 decisions and 10 reports.
- One deterministic source-gold question per item, with a literal answer
  span checked to occur in its source. Raw text and per-question results
  were kept in ignored local directories.
- BGE and E5 used the same pinned ONNX assets and Rust `ort`/`tokenizers`
  versions as PR #337, 4 intra-op threads and CPU arena off. BGE used
  normalized CLS; E5 used `query: ` / `passage: `, attention-mask mean
  pooling and normalization. Each arm ran in a fresh process. E5 returned
  the best child-chunk score for each parent item. The lexical proxy used
  token overlap, inverse document frequency and recorded aliases.
- **Measured path:** local ORT tokenization/inference and in-memory cosine
  ranking. Query latency includes both; ingest time includes embedding and
  in-memory collection. Worker memory is macOS `phys_footprint` after model
  load and OS peak after inference. The lexical proxy uses Python elapsed
  time. These are **not product recall latency or ingest measurements**.

| Arm | R@1 | R@5 | MRR | nDCG@10 | Evidence text found | Query p50/p95 ms | Worker idle/peak MiB | Ingest s | Vectors | Lance size |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| BGE-M3 | 50.3% | 69.0% | .594 | .627 | 57.7% | 23.4 / 33.9 | 1,658 / 12,113 | 279.0 | 300 | not measured |
| E5 overlap 64 | 48.0% | 69.0% | .578 | .617 | 58.7% | 4.5 / 6.3 | 603 / 731 | 19.3 | 567 | not measured |
| E5 sentence | 47.0% | 69.7% | .575 | .615 | 56.3% | 4.7 / 6.2 | 603 / 776 | 18.6 | 518 | not measured |
| Lexical/alias proxy | 61.7% | 86.0% | .725 | .767 | 75.0% | 1.1 / 1.2 | n/a | <1 | 0 | n/a |

The 12,113 MiB BGE peak came from these unusually long whole Ledger items;
the prior 24-document experiment reported a 2,817 MiB peak. This corpus
is therefore unsuitable for extrapolating owner-scale worker peak or
product ingest time. No Lance table was built in this run.

## Category breakdown

Each category has 50 questions. Evidence found means the top text contains
the exact gold answer span; it can count a different source that repeats
that span. The source-gold rank metrics are more trustworthy here.

| Category | BGE R@1/R@5 | E5 overlap R@1/R@5 | E5 sentence R@1/R@5 | E5 overlap MRR / nDCG@10 | E5 overlap evidence |
| --- | ---: | ---: | ---: | ---: | ---: |
| Conversation, long | 22% / 54% | 32% / 64% | 28% / 62% | .463 / .521 | 64% |
| Conversation, short | 62% / 82% | 54% / 76% | 54% / 80% | .647 / .699 | 60% |
| Learned claims | 84% / 94% | 74% / 82% | 72% / 84% | .786 / .816 | 76% |
| Project Ledger | 4% / 16% | 2% / 22% | 2% / 22% | .120 / .146 | 2% |
| Dated/negated text | 54% / 74% | 52% / 82% | 52% / 82% | .643 / .690 | 76% |
| Recorded web snippets | 76% / 94% | 74% / 88% | 74% / 88% | .808 / .829 | 74% |

Against BGE, overlapping E5 lost 35 BGE top-1 cases and gained 28.
The largest net losses were learned claims (8 losses, 3 gains) and short
conversations (8, 4). Long conversations improved (5 losses, 10 gains),
consistent with E5 covering deep text by 567 child vectors; sentence
packing lost three net top-1 cases to overlapping windows. On the mixed
language source subset, BGE got 60.7% top-1 and E5 overlap 53.6%; KO was
60.0% versus 61.7%, and EN tied at 36.7%. These are source-language groups,
not a genuine translated-query test. No causal attribution to tokenization,
code identifiers, or cross-lingual alignment is established.

Project items were especially poor for every arm. Many long Ledger files
share names, paths and boilerplate, and the template questions select nearby
words rather than independently identifying a fact. The 4%/2% top-1 scores
are a prompt-quality warning, not evidence that project recall is unusable.

## Acceptance gaps

1. The 300 prompts are generated against real sources, but their template
   labels (`ko_wrapper`, `two_anchor`, `dated`) do not establish genuine
   cross-lingual, multi-hop or past-versus-current reasoning. Feedback and
   corrections are present only insofar as they became learned claims or
   conversation text; they were not sampled as a separate store. Manual
   gold review and adversarial near-duplicate pairs remain necessary.
2. This harness does not perform registration, projection, generation-bound
   LanceDB search, graph qualification, the `recall_memory` tool call, or
   canonical source reading on an isolated `BUTLER_DATA`. Consequently,
   product Recall@k, evidence rate, p95, ingest time, vector count and Lance
   size are **unmeasured**. The table above reports diagnostic values only.
3. Product code currently fixes the physical vector schema at 1024 dimensions
   (`generation_vectors/rows.rs:30`), validates native generation identity
   against 1024 and CLS (`generation/types.rs`), and admits vector hits only
   with matching generation version, vector key and projection receipt
   (`graph/recall/vectors.rs`). E5 is 384-dimensional with mean pooling;
   a harness-only model switch must preserve those contracts before a real
   product-path comparison is possible. The default was not changed.

The missing public-path evidence and diagnostic quality regression both
support NO-GO. A future review must use independently authored gold
questions, isolated generations for both models, and the actual tool path
before reconsidering the replacement.
