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
- `queue.ts`, `sync-consumer.ts`, `session-sync.ts`: canonical completion notices,
  consumer flow, and source catchup through the existing projection owner.
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

The v2 source and projection owner is `../projection/ingestion.ts`. Canonical
source registration, semantic graph, episode vectors, node vectors, and hot-cache
receipts have separate progress states. A queue acknowledgment or saved source
does not prove all derived stages are ready. Legacy transcript/index import
helpers above are compatibility operations and do not replace this v2 path.

Generation initialization, identity maintenance, and rebuild commands use the
existing `consolidation-cycle.ts` maintenance entry. Rebuild operations use
`--memory-rebuild OPERATION`, with `--generation ID` after preparation:

- `prepare` classifies durable origin evidence and creates a consistent canonical
  and typed-source snapshot, returning the candidate generation ID.
- `build` registers and advances that candidate through the normal projection
  owners. Repeating it continues pending work and preserves successful plans.
- `retry-failed` makes known failed semantic, vector, and cache work eligible for
  normal retry; it does not mark that work complete.
- `validate --acceptance FILE` checks isolated implementation qualification and
  the candidate's own source and projection readiness.
- `activate` rechecks the final source inventory and readiness before switching
  the serving descriptor. A new source delta requires catchup and validation.
- `rollback` restores the previous generation and reports actual pending work.
  A legacy destination remains paused and degraded.

An in-flight recall retains its admitted generation; subsequent calls resolve the
new descriptor. Qualification artifacts preserve their verification generation
and original evidence. They are not evidence about a different candidate's data.
The governing contract is `SPEC-MEMORY-RECOVERY-MULTILINGUAL` T6. Implementation
and isolated validation do not establish that operational data has been rebuilt
or activated.

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

The request queue permits one active inference and bounds admitted work to 64
requests / 4 MiB by default. Interactive requests receive priority, with a waiting
background request admitted after eight consecutive interactive starts. Queued
cancellation prevents inference from starting; cancellation of an already active,
uncancellable inference does not release the slot until that work settles.
Deadline and cancellation come from the calling operation. Queue wait and actual
inference duration are separate observations, and checked embedding reports
unsupported or omitted input instead of treating it as a complete vector result.

## Related Specs

- `SPEC-MEMORY-RECOVERY-MULTILINGUAL` - Multilingual graph-memory recovery
- `SPEC-ASSOCIATIVE-MEMORY-RUNTIME` - Associative Memory Runtime
- `SPEC-MEMORY-QUALITY-LOOP` - Memory Quality Loop
- `SPEC-MANAGED-BUN-RUNTIME` - Butler-Managed Bun Runtime
