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
call disables it. If LanceDB or the embed server is unavailable, recall keeps
lexical, contextual, graph, explicit, project, and task-memory fallback paths
and adds degraded-mode diagnostics such as `vector=unavailable:*`.

## Related Specs

- `SPEC-ASSOCIATIVE-MEMORY-RUNTIME` - Associative Memory Runtime
- `SPEC-BUTLER-RETRIEVAL-PLANNING` - Retrieval Planning And Evidence-Grounded Recall
- `SPEC-MEMORY-QUALITY-LOOP` - Memory Quality Loop
- `SPEC-CONTEXT-MANAGEMENT-OPTIMIZATION` - Context Management Optimization
