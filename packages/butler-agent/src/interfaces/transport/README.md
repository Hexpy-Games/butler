# transport interfaces

`packages/butler-agent/src/interfaces/transport/` owns transport adapter contracts and delivery guarantees.
Conversation and worker-completion logic should stay transport-neutral above
this layer; adapters translate outbound actions into provider-specific API
calls.

## Key Files

- `contracts.ts`: inbound envelope, outbound action, adapter, and delivery
  target contracts.
- `delivery-guard.ts`: retry, deduplication, idempotency, and delivery status
  handling.
- `mock/`: in-memory adapter for transport-agnostic tests.

## Boundaries

Adapters should not own session state, worker state, or model decisions. They
render and deliver transport-specific messages for gateway-owned actions.

## Related Specs

- `SPEC-TRANSPORT-EXPANSION-READINESS` - Transport Expansion Readiness
- `SPEC-OPERATIONAL-RELIABILITY` - Operational Reliability
- `SPEC-NATIVE-PRODUCT` - Native Butler Product
