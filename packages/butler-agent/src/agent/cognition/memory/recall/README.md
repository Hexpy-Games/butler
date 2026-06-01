# Memory Recall

`packages/butler-agent/src/agent/cognition/memory/recall/` contains the
runtime associative recall engine. It ranks local memory candidates while
keeping evidence channels explicit: vector similarity, lexical match,
contextual continuity, graph activation, explicit salience, recency, and
frequency are reported separately.

## Key Files

- `engine.ts`: associative recall scoring, contextual evidence, verification,
  sync file-backed recall, and async vector-augmented recall.
- `vector.ts`: LanceDB/vector episode connector and degraded-mode diagnostics.

## Evidence Channels

- `semantic_similarity` is set only for candidates returned by the vector
  backend.
- `lexical_match` is BM25/IDF-style lexical evidence from the bounded recall
  corpus. It is not semantic search.
- `contextual_match` is continuity evidence from bounded recent context, active
  task/project state, related graph nodes, or concrete session/artifact
  provenance. Recency alone does not create contextual evidence.
- `graph_activation` is associative graph evidence.
- `explicit_salience` is reserved for user-explicit rules, corrections, and
  durable preferences.

## Boundaries

Recall should return compact, provenance-bearing context. It should abstain
when evidence is weak rather than injecting low-confidence memory into the
active prompt.

`query_memory` remains the exact transcript/app-message lookup path. Recall
items are candidate memory evidence, not exact chronological database facts.
Exact quote/date/count/first/last requests should use `query_memory` or recent
conversation context instead of summary recall alone.

Vector episode search is attempted by the `recall_memory` tool unless the tool
call disables it. Tool calls can provide a structured retrieval policy directly;
when they do not and the runtime has a model available, Butler runs the bounded
retrieval planner before recall and forwards generated `search_vector_episode`
queries into vector search. If LanceDB or the embed server is unavailable,
recall keeps lexical, contextual, graph, explicit, project, and task-memory
fallback paths and adds degraded-mode diagnostics such as
`vector=unavailable:*`.

## Policy Constants

Recall constants in `engine.ts` and `vector.ts` must be named. A number may
stay inline only when it is an obvious arithmetic identity such as `0`, `1`, or
`1000` in a milliseconds conversion.

The lexical scorer uses BM25 constants matching Apache Lucene
`BM25Similarity`: `k1 = 1.2`, `b = 0.75`, and the documented IDF smoothing
formula `log(1 + (docCount - docFreq + 0.5)/(docFreq + 0.5))`. Lucene cites
Robertson et al., "Okapi at TREC-3", for the BM25 similarity implementation.

The remaining recall thresholds are not claimed to be research-derived. They
are named tunable policy constants and are protected by regression tests:
minimum recall score, graph spread factors, hub/conflict/superseded penalties,
recency window, cache TTL, and vector timeout/circuit/overfetch limits.

Reference:

- https://lucene.apache.org/core/10_2_2/core/org/apache/lucene/search/similarities/BM25Similarity.html

## Related Specs

- `SPEC-ASSOCIATIVE-MEMORY-RUNTIME` - Associative Memory Runtime
- `SPEC-BUTLER-RETRIEVAL-PLANNING` - Butler Retrieval Planning And Evidence-Grounded Recall
- `SPEC-MEMORY-QUALITY-LOOP` - Memory Quality Loop
- `SPEC-CONTEXT-MANAGEMENT-OPTIMIZATION` - Context Management Optimization
