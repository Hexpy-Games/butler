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

## Embedding lifecycle

`embed-server.ts` keeps BGE-M3 lazy and serializes inference through the
supervised Unix-socket service. `EMBED_IDLE_RECYCLE_MS` controls the bounded
idle boundary (default 15 minutes, capped at 24 hours); validation may set a
shorter value. The boundary is armed only after all in-flight requests settle.
When the runtime cannot reliably unload the Transformers pipeline, the server
exits at the boundary and the native supervisor starts a fresh unloaded
process. A request that races a recycle is therefore retried by the normal
caller timeout/fallback path rather than receiving a partially unloaded model.

The same lifecycle snapshot is available at `GET /health` on the configured
`EMBED_HEALTH_PORT` and through a Unix-socket request of `{"health":true}`.
Snapshots report `starting`, `ready`, `busy`, `recycling`, or `unavailable`,
plus model-loaded and in-flight counts. A configured health bind failure makes
service readiness fail so a supervisor restart cannot silently leave only the
embedding socket available. App-managed runtimes receive a deterministic
per-data-root port instead of the former disabled (`0`) endpoint.

## Related Specs

- `SPEC-ASSOCIATIVE-MEMORY-RUNTIME` - Associative Memory Runtime
- `SPEC-MEMORY-QUALITY-LOOP` - Memory Quality Loop
- `SPEC-MANAGED-BUN-RUNTIME` - Butler-Managed Bun Runtime
