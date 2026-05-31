# memory recall

`packages/butler-agent/src/agent/cognition/memory/recall/` contains the runtime recall engine. It ranks explicit
matches and graph-associated memories while applying abstention, hub-node,
recency, supersession, and contradiction controls.

## Key Files

- `engine.ts`: associative recall scoring and file-backed recall runner.

## Boundaries

Recall should return compact, provenance-bearing context. It should abstain
when evidence is weak rather than injecting low-confidence memory into the
active prompt.

## Related Specs

- `SPEC-ASSOCIATIVE-MEMORY-RUNTIME` - Associative Memory Runtime
- `SPEC-MEMORY-QUALITY-LOOP` - Memory Quality Loop
- `SPEC-CONTEXT-MANAGEMENT-OPTIMIZATION` - Context Management Optimization
