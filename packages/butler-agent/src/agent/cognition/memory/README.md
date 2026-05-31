# memory

`packages/butler-agent/src/agent/cognition/memory/` owns Butler's associative memory system. It combines hot-cache
summaries, vector rows, graph edges, recall scoring, quality checks, and
maintenance jobs so runtime prompts can recall useful context without carrying
every transcript line.

## Key Areas

- `quality.ts`: memory health and quality reporting.
- `project-memory.ts`: deterministic project capsule refresh, promotion,
  inspect diagnostics, and refresh failure history.
- `legacy-import.ts`: one-shot import helpers for private prior memory data.
- `recall/`: associative recall engine.
- `exact-query.ts`: indexed exact conversation-history lookup for
  `query_memory`; runtime reads SQLite projections instead of raw transcript
  files.
- `scripts/`: ingestion, hot cache, vector index, graph, queue, sync, and
  consolidation-cycle maintenance scripts.

## Boundaries

Code lives here; private memory data lives under
`$BUTLER_DATA/cognition/memory` and related Butler data paths. Runtime and CLI
output should expose provenance, counts, and summaries instead of raw private
memory text.

## Related Specs

- `SPEC-ASSOCIATIVE-MEMORY-RUNTIME` - Associative Memory Runtime
- `SPEC-MEMORY-QUALITY-LOOP` - Memory Quality Loop
- `SPEC-CONTEXT-MANAGEMENT-OPTIMIZATION` - Context Management Optimization
- `SPEC-PROJECT-MEMORY-RUNTIME` - Project Memory Runtime
- `SPEC-NATIVE-PRODUCT` - Native Butler Product
