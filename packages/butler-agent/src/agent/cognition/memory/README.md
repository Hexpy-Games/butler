# memory

`packages/butler-agent/src/agent/cognition/memory/` owns Butler's local memory
system. It combines hot-cache summaries, exact transcript projections, vector
episode rows, graph edges, recall scoring, quality checks, and maintenance jobs
so runtime prompts can recall useful context without carrying every transcript
line.

## Key Areas

- `quality.ts`: memory health and quality reporting.
- `project-memory.ts`: deterministic project capsule refresh, promotion,
  inspect diagnostics, and refresh failure history.
- `legacy-import.ts`: one-shot import helpers for private prior memory data.
- `recall/`: associative recall engine.
- `exact-query.ts`: indexed exact conversation-history lookup for
  `query_memory`; runtime reads SQLite projections instead of raw transcript
  files.
- `retrieval-planning.ts`: structured retrieval-plan contract for choosing
  recent context, exact transcript lookup, lexical memory, vector episode,
  graph, explicit memory, and task-state strategies.
- `scripts/`: ingestion, hot cache, vector index, graph, queue, sync, and
  consolidation-cycle maintenance scripts.

## Boundaries

Code lives here; private memory data lives under
`$BUTLER_DATA/cognition/memory` and related Butler data paths. Runtime and CLI
output should expose provenance, counts, and summaries instead of raw private
memory text.

`query_memory` and `recall_memory` have different jobs:

- `query_memory` is exact transcript/app-message search for wording, dates,
  counts, speaker filters, first/last, and chronological evidence.
- `recall_memory` is associative durable recall across hot cache, graph,
  explicit memory, project/task memory, lexical fallback, contextual continuity,
  and vector episode hits.

Score labels must describe the actual evidence source. Lexical matching is
reported as `lexical_match`, contextual continuity as `contextual_match`, and
real vector backend hits as `semantic_similarity`.

## Related Specs

- `SPEC-ASSOCIATIVE-MEMORY-RUNTIME` - Associative Memory Runtime
- `SPEC-BUTLER-RETRIEVAL-PLANNING` - Retrieval Planning And Evidence-Grounded Recall
- `SPEC-MEMORY-QUALITY-LOOP` - Memory Quality Loop
- `SPEC-CONTEXT-MANAGEMENT-OPTIMIZATION` - Context Management Optimization
- `SPEC-PROJECT-MEMORY-RUNTIME` - Project Memory Runtime
- `SPEC-NATIVE-PRODUCT` - Native Butler Product
