# providers integration

`packages/butler-agent/src/integrations/providers/` owns model-provider adapters, model catalogs,
auth helpers, local-model registration, prompt-cache telemetry, and provider
error normalization.

## Structure

- `registry.ts`: resolves one provider adapter from the effective turn model.
- `runtime.ts`: provider-neutral prompt entrypoint. It delegates to the resolved
  adapter and contains no provider branches.
- `provider.ts`: compatibility exports only.
- `<provider>/adapter.ts`: binds that provider's catalog, capabilities, and
  prompt/tool invocation.
- `<provider>/catalog.ts`: immutable model metadata owned by the provider.
- `<provider>/runtime.ts` or focused runtime modules: request construction,
  response normalization, and provider-specific tool behavior.
- `shared/`: provider-neutral contracts, registration, usage accounting, tool
  mechanics, and reusable protocol transports.

OpenAI auth and model discovery live under `openai/`. Local model registration
and execution live under `local/`. Hosted provider registration is shared
because it stores user-configured provider/model records rather than executing
one provider protocol.

## Boundaries

Provider integrations translate between Butler and model backends. They should
not own agent policy, project-session routing, transport delivery, or product
UI state.

Capabilities and invocation must come from the same model-scoped adapter. A
session model override must never reuse structured-output or tool capabilities
resolved from the global default model.

## Related Specs

- `SPEC-OPENAI-AUTH-AND-MODELS` - OpenAI Auth And Model Discovery
- `SPEC-MODEL-PROVIDER-CONTROL-UX` - Model And Provider Control UX
- `SPEC-BUTLER-AGENT-LOOP` - Butler Agent Loop
- `SPEC-PROVIDER-ADAPTER-ARCHITECTURE` - Provider Adapter Architecture
