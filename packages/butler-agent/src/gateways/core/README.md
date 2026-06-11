# Gateway Core

`packages/butler-agent/src/gateways/core/` owns transport-neutral gateway
contracts, app transport envelopes, inbound queueing, routing, and the gateway
server dispatcher. Channel-specific gateways should connect here without
importing Butler App client code.

## Key Files

- `contracts.ts`: transport envelope, adapter, route, and dispatch contracts.
- `router.ts`: session/project/steward routing from inbound envelopes.
- `server.ts`: gateway dispatcher that invokes role handlers.
- `inbound-queue.ts`: durable inbound event queue used by app and service flows.
- `app-transport.ts` and `client.ts`: app transport envelope helpers and queue
  client.

## Boundaries

This module may depend on agent runtime and harness contracts where needed. It
must not depend on Butler App UI, Electron, or app scripts.

## Queue Reliability

`NativeInboundQueue` pending files are ordered by their sortable queue-id
filename prefix. Claiming must sort filenames before reading records and lazily
parse only until the caller's eligible claim limit is satisfied, so dispatcher
polls stay bounded by active capacity instead of pending queue depth.

## Related Specs

- `SPEC-NATIVE-PRODUCT` - Native Butler Product
- `SPEC-TRANSPORT-EXPANSION-READINESS` - Transport Expansion Readiness
- `SPEC-OPERATIONAL-RELIABILITY` - Operational Reliability
