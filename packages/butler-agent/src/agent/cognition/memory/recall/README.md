# Memory recall

`recallSourceBackedMemory` in `engine.ts` is the current v2 associative recall
entry. It resolves candidates within a pinned generation, traverses graph
relations, ranks episodes, and hydrates current canonical or typed source
evidence. It does not start from the globally newest 200 memories.

## Owners and evidence

- `contracts.ts`: runtime-bound scope, time, source, coverage, and result types.
- `candidates.ts`: indexed alias/lexical/context/time candidates and source
  eligibility, including revision, project, origin, and as-of constraints.
- `graph.ts`: bounded relation expansion and graph activation.
- `ranking.ts`: episode ranking from the admitted evidence channels.
- `vector.ts`: checked embedding, generation-bound LanceDB readers, vector/source
  joins, and explicit backend availability diagnostics.
- `engine.ts`: one operation's budgets, generation pin, channel composition,
  graph/source hydration, and returned continuation.

Returned `channels` identify actual contributions. Vector availability alone
does not establish a vector hit. `association_path` contains the traversed
relations; evidence carries its basis, current revision, source handle, and
`read_args`. Aliases and identity history require source support. Unicode
normalization is a search aid and is not permission to merge similar names.

Graph-only calls set `include_vector=false`. Hybrid calls add checked vector
candidates to the same graph/source path. A missing or incomplete vector backend
is exposed in coverage and qualifications while available graph evidence remains
usable. An invalid serving descriptor or unresolved source is never a reason to
substitute unrelated legacy results.

## Reading and time

The native tool owner supplies canonical session/turn identity and enforces
scope. Normal conversation evidence is limited to public user/assistant origins.
Conversation time, event time, and `as_of` are distinct constraints. Current
supersession and historical identity decisions are checked against the requested
time and source scope.

Use `read_conversation_session` with unchanged returned `read_args` to inspect
the actual original source; follow its cursor for the remaining bytes. Use
`query_memory` for exact chronological, wording, and count queries. A summary is
not the complete original source.

Unversioned calls retain the legacy scorer, contextual fallback, and retrieval
planner path. Admitted v1 calls use the same source-backed engine as v2, with
admitted channel/strategy constraints and a v1 argument/result adapter. The
legacy algorithm must not be described as the v2 graph algorithm. Performance
claims require measured sample counts and backend state; a fast partial or empty
result is not a successful recall benchmark.

Governing contract: `SPEC-MEMORY-RECOVERY-MULTILINGUAL`.
