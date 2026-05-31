# telegram transport

`packages/butler-agent/src/interfaces/transport/telegram/` contains the live Telegram transport adapter. It
maps Telegram updates into transport-neutral inbound envelopes and renders
outbound actions into Telegram Bot API calls.

## Key Files

- `adapter.ts`: outbound delivery adapter.
- `api.ts`: Bot API client helpers.
- `polling-runner.ts`: `getUpdates` polling loop.
- `live-gateway.ts`: live ingress wiring.
- `markdown-v2.ts`: MarkdownV2 conversion and escaping.
- `native-controls.ts`: callback and control-event helpers.

## Boundaries

Telegram-specific code should remain below the transport adapter boundary.
Gateway routing, session actors, task state, and worker-completion promotion
must remain transport-agnostic.

## Related Specs

- `SPEC-TRANSPORT-EXPANSION-READINESS` - Transport Expansion Readiness
- `SPEC-OPERATIONAL-RELIABILITY` - Operational Reliability
- `SPEC-NATIVE-PRODUCT` - Native Butler Product
