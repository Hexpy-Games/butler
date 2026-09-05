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

## OpenAI catalog contract

- The bundled OpenAI catalog follows the official provider model metadata and
  exposes `openai/gpt-6-astra` as the current latest selectable model.
- `auto:codex-latest` resolves to the newest eligible model returned by OpenAI
  model discovery, including GPT-6 Astra. It fails closed when discovery is
  unavailable.
- Adding a selectable model does not change Butler's persisted or fallback
  default model. Default changes require a separate product decision.
- GPT-6 Astra uses the Responses runtime with the documented 1,050,000-token
  context window, 128,000-token maximum output, image input, and reasoning
  efforts from `low` through `max`; unsupported `none` is not exposed.

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
