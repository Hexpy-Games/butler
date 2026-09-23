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

## Custom connections and catalog refresh (2026-09-23)

Settings presents the former Local provider as **Custom**. Existing `local/`
references and API routes remain compatible. The existing Settings registration
flow owns URL, optional API key, exact model ID, display name and context window.
Both discovery and manual entry are available; discovery is never required.
The supported wire protocol is OpenAI-compatible Chat Completions with optional
Bearer authentication. Other wire protocols still use their built-in adapters.

API base paths are retained verbatim; a bare host defaults to `/v1`. Raw model IDs
(including organization prefixes) are sent unchanged. Separate endpoints sharing
an ID receive distinct references. Updating a connection retains its key only
when its API base URL is unchanged; explicit empty keys remove authentication.
Keys are stored separately in `auth/custom-model-credentials.json` with mode 0600,
never returned in catalog metadata or settings events, and never redirected.

Acceptance: Settings supports manual registration before discovery; authenticated
model discovery and a subsequent provider request use the entered key, URL and
raw ID; edit preserves/replaces/removes credentials; endpoint changes do not reuse
saved secrets; public catalog and events omit secrets; existing local refs work.

Catalog sources checked: [OpenAI](https://developers.openai.com/api/docs/models),
[Anthropic](https://platform.claude.com/docs/en/models/overview),
[xAI](https://docs.x.ai/developers/models),
[Google](https://ai.google.dev/gemini-api/docs/models),
[Qwen](https://www.alibabacloud.com/help/en/model-studio/text-generation-model),
[Kimi](https://platform.kimi.ai/docs/models),
[Z.AI](https://docs.z.ai/guides/llm/glm-5.3), and
[OpenCode Go](https://opencode.ai/docs/go/). Kimi's current lineup was already
present. Defaults and persisted model choices are unchanged. Catalog availability
is not proof that a particular account has access.
