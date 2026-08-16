# mock transport

`packages/butler-agent/src/interfaces/transport/mock/` contains the in-memory transport adapter used by tests to
exercise Butler without an external transport.

## Key Files

- `adapter.ts`: mock transport adapter, captured outbound actions, and failure
  injection hooks.

## Boundaries

Mock transport should satisfy the same adapter contract as production
transports. Tests should use it through gateway, session actor, runtime, and
delivery guard paths whenever possible.

## Related Specs

- `SPEC-TRANSPORT-EXPANSION-READINESS` - Transport Expansion Readiness
- `SPEC-OPERATIONAL-RELIABILITY` - Operational Reliability
- `SPEC-NATIVE-PRODUCT` - Native Butler Product
