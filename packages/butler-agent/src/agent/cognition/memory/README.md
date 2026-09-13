# Memory

This module owns source-backed memory projection, associative recall, exact
history lookup, and memory maintenance. The Conversation Store owns original
conversation text; graph, vector, and cache records are derived evidence.

## Current v2 path

Normal canonical completion publishes a source notice. `projection/ingestion.ts`
registers the source and advances durable projection jobs through semantic graph,
episode vector, node vector, and hot-cache work. Each stage reports its own state;
source registration does not mean semantic processing is complete. Extraction
uses bounded source windows and preserves successful plans across later retries.

The same projection owner accepts source-backed explicit records and task reports.
It does not import arbitrary transcript text as an authoritative conversation.
Source revision, origin, project scope, and consent remain runtime-owned facts.
Original Unicode text and UTF-8 spans are preserved; searchable aliases do not
replace the original spelling or prove that two entities are identical.

`projection/generation.ts` resolves the serving descriptor and generation paths.
Each recall pins its generation. An unavailable or invalid v2 generation is
reported as unavailable; it is not silently replaced by legacy recall.

## Owners

- `projection/`: source registration, bounded extraction, durable plans and stage
  receipts, generation metadata, and explicit identity decisions.
- `recall/`: indexed seeds, relation traversal, ranking, current source validation,
  and optional LanceDB vector contribution.
- `exact-query.ts`: exact history lookup through canonical SQLite projections.
- `quality.ts`: observed processing coverage and availability. Unknown inventory
  is not reported as zero work or complete coverage.
- `project-memory.ts`: source-backed project capsules and diagnostics.
- `scripts/`: existing consumer, embedding service, and maintenance entrypoints.
- `legacy-import.ts` and legacy script helpers: compatibility paths, not another
  v2 source or graph writer.

Hot-cache publication belongs to `../continuity/hot-cache-writer.ts`; runtime
prompt readers check source currentness, scope, validity, and the complete entry
budget before including an entry. A cached summary does not replace graph or
canonical source evidence.

## Public tool boundary

`query_memory` answers exact wording, date, count, and chronological questions.
`recall_memory` follows associative evidence and returns source handles, coverage,
and qualifications. `read_conversation_session` resolves those handles and reads
the original source using the returned `read_args` and continuation cursor.

The tool owner binds runtime session/turn identity to canonical conversation
identity. Ordinary recall excludes internal-control and unknown-origin
conversation sources. A model cannot promote them by supplying a different ID.
Admitted v1 calls retain their compatibility contract; current v2 calls use the
source-backed path and explicit partial/unavailable results.

Private data lives under `$BUTLER_DATA`. Diagnostics expose bounded counts and
provenance rather than raw private transcripts. The governing recovery contract
is `SPEC-MEMORY-RECOVERY-MULTILINGUAL`; implementation and isolated acceptance do
not imply that an operational generation has been rebuilt or activated.
