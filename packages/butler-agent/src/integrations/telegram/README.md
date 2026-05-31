# telegram integration

`packages/butler-agent/src/integrations/telegram/` contains Telegram command-package utilities. The
live transport adapter lives in `packages/butler-agent/src/interfaces/transport/telegram/`; this
folder keeps Telegram command registration, topic helpers, and
integration-local command handling code.

## Key Areas

- `commands/registry.ts` and `commands/router.ts`: command registration and
  routing for Telegram command text.
- `commands/topic-store.ts`, `commands/topic.ts`, and `commands/topic-util.ts`:
  topic-oriented helper state.
- `commands/handlers.ts` and `commands/butler.ts`: integration command
  handlers.
- `commands/strings.ko.ts`: Korean command strings.

## Boundaries

Do not add product session ownership here. Live ingress and outbound delivery
should pass through transport adapters, gateway routing, session actors, and
delivery guard.

## Related Specs

- `SPEC-TRANSPORT-EXPANSION-READINESS` - Transport Expansion Readiness
- `SPEC-NATIVE-PRODUCT` - Native Butler Product
- `SPEC-OPERATIONAL-RELIABILITY` - Operational Reliability
