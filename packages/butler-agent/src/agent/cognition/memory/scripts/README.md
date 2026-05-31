# memory scripts

`packages/butler-agent/src/agent/cognition/memory/scripts/` contains memory ingestion, indexing, graph, hot-cache,
sync, and maintenance entrypoints. These scripts are normally invoked by
Butler services, CLI commands, or scheduled maintenance rather than directly by
users.

## Key Areas

- `save_hot.ts`, `compact.ts`, `query-hot.ts`: hot-cache write, compaction, and
  lookup.
- `index.ts`, `embed.ts`, `embed-server.ts`: vector indexing and embedding.
- `graph.ts`: memory graph writes and reads.
- `queue.ts`, `sync-consumer.ts`, `session-sync.ts`: transcript ingestion queue
  and consumer flow.
- `build-query-index.ts`: operator backfill for the exact `query_memory`
  SQLite projection from durable transcript JSONL.
- `import-session.ts`, `import-legacy-memory.ts`, `import-memories.ts`:
  explicit import paths.
- `consolidation-cycle.ts` and `phases/`: maintenance catchup, consolidation,
  optimization, and health checks.
- `lib/`: shared ingestion, lock, session id, activation, and budget helpers.

## Boundaries

Scripts must preserve source provenance and should fail safely on unsafe
transcript origins. Operator-facing summaries must avoid raw transcript and
memory text.

## Related Specs

- `SPEC-ASSOCIATIVE-MEMORY-RUNTIME` - Associative Memory Runtime
- `SPEC-MEMORY-QUALITY-LOOP` - Memory Quality Loop
- `SPEC-MANAGED-BUN-RUNTIME` - Butler-Managed Bun Runtime
