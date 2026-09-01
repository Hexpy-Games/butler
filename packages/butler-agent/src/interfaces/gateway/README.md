# Gateway Session Interface

`packages/butler-agent/src/interfaces/gateway/` contains the native Butler and
Steward adapters that admit every principal message to the replacement BTCC.
The product process entrypoints live under
`packages/butler-agent/src/application/` and inject the completed BTCC assembly
into these adapters.
Transport
contracts, routing, inbound queueing, and gateway server dispatch live in
`packages/butler-agent/src/gateways/core/`.

## Key Files

- `btcc/btcc-session-actor.ts`: the single principal-Turn gateway actor.
- `packages/butler-agent/src/agent/prompt/prompt-assembler.ts`: system, persona, memory, context, and
  tool prompt assembly used by the gateway.
- `btcc/index.ts`: transport-neutral BTCC request adapters and dispatch.
- `btcc/btcc-lifecycle-service.ts`: session identity and actor ownership.

## Boundaries

Transport adapters should not own conversation logic. Session actors consume
transport-neutral envelopes from gateway core and return outbound actions;
transport-specific rendering stays below the transport layer.

Butler and Steward messages share the same BTCC actor and differ only in their
stored binding and admitted project context. There is no compatibility
principal-Turn actor or alternate queued dispatcher. A separately launched
Worker remains an independent execution subsystem, not a principal-Turn
fallback. Gateway read routes expose committed BTCC projections rather than raw
prompts, provider payloads, or private runtime state.

## Runtime interruption contract

- An execution-integrity interruption preserves the admitted Turn and parks the
  exact inbound queue item for process replacement; it must not synthesize a
  failure or replay inside the process that observed the interruption.
- A control request that reaches an already terminal Turn is itself terminal.
  In particular, cancelling an `already_delivered` Turn acknowledges the
  no-op result and completes the control queue item; it must not be parked for
  process replacement.
- Native Butler must then end that process cleanly so the watchdog starts a new
  owner. The new owner is the only path that may recover and resume the parked
  item.
- A parked interruption must therefore never leave a healthy-looking native
  process alive indefinitely with the App Turn still displayed as running.

## Related Specs

- `SPEC-NATIVE-PRODUCT` - Native Butler Product
- `SPEC-BTCC-ADAPTIVE-TURN-ALGORITHM` - BTCC Adaptive Turn Algorithm
- `SPEC-OPERATIONAL-RELIABILITY` - Operational Reliability
- `SPEC-TRANSPORT-EXPANSION-READINESS` - Transport Expansion Readiness
