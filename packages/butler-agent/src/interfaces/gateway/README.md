# Gateway Session Interface

`packages/butler-agent/src/interfaces/gateway/` contains the native Butler and
steward session actors that run behind the agent-owned gateway core. Transport
contracts, routing, inbound queueing, and gateway server dispatch live in
`packages/butler-agent/src/gateways/core/`.

## Key Files

- `session-actor.ts`: serialized per-session turn execution.
- `packages/butler-agent/src/agent/prompt/prompt-assembler.ts`: system, persona, memory, context, and
  tool prompt assembly used by the gateway.
- `native-butler-bootstrap.ts` and `native-steward-bootstrap.ts`: live native
  bootstraps.
- `worker-result-monitor.ts`: planned/direct worker completion promotion and
  retryable delivery.
- `butler-session.ts`, `steward-session.ts`, and `session-lifecycle.ts`:
  session identity and lifecycle helpers.

## Boundaries

Transport adapters should not own conversation logic. Session actors consume
transport-neutral envelopes from gateway core and return outbound actions;
transport-specific rendering stays below the transport layer.

Steward is a durable gateway session actor and runs through the same native
tool-loop and WorkStream completion gates as Butler-facing sessions for
non-trivial custody, review, synthesis, and routing work. Worker remains an
internal runtime actor behind task dispatch, but its native turn events are
projected into safe worker activity timelines and legacy task summaries.
Gateway read routes must expose derived safe timeline/progress data rather than
raw prompts, provider payloads, task internals, or secrets.

## Related Specs

- `SPEC-NATIVE-PRODUCT` - Native Butler Product
- `SPEC-BUTLER-AGENT-LOOP` - Butler Agent Loop
- `SPEC-AUTONOMOUS-PLANNED-DISPATCH` - Autonomous Planned Dispatch
- `SPEC-WORKER-BTCC-RUNTIME-NORMALIZATION` - Worker BTCC Runtime Normalization
- `SPEC-OPERATIONAL-RELIABILITY` - Operational Reliability
- `SPEC-TRANSPORT-EXPANSION-READINESS` - Transport Expansion Readiness
