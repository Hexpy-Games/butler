# Model Provider Catalog

Spec ID: SPEC-MODEL-PROVIDER-CATALOG

## Purpose

Butler exposes one app-visible model catalog that covers hosted providers,
registered hosted models, and local OpenAI-compatible models. The catalog is
owned by Butler Agent provider integrations and consumed by the App settings UI,
first-run setup, and app gateway protocol.

## Provider Contract

- Hosted providers with built-in catalog metadata must appear in
  `/model-catalog` with a stable `provider_id`, user-facing `provider_label`,
  `auth_methods`, and at least one runtime-supported text model.
- Hosted providers other than OpenAI use API key auth only. OpenAI may expose
  both API key auth and Codex OAuth.
- The model catalog must include enough metadata for settings selectors:
  `model_ref`, `display_name`, `status`, context window, max output tokens,
  reasoning effort options, token estimator, source URL, and runtime support.
- Registered hosted models must be normalized through the same catalog metadata
  before they become selectable runtime models.
- Runtime execution must fail closed for unknown hosted provider ids instead of
  silently falling back to a different provider.

## Z.AI GLM

- `zai` is a hosted provider labelled `Z.AI / GLM`.
- z.ai GLM models are registered with API key auth and use the Z.AI
  OpenAI-compatible chat completions API.
- Default API base URL: `https://api.z.ai/api/paas/v4`.
- App users may edit the provider API base URL while adding or editing a
  registered z.ai model. Runtime execution must prefer the stored model
  `api_base_url`, then `BUTLER_ZAI_BASE_URL`, then the default base URL.
- Operators may still override the base URL with `BUTLER_ZAI_BASE_URL`,
  including for GLM Coding Plan endpoints.
- The built-in GLM catalog includes:
  - `zai/glm-5.2`, latest, 1M context, 128K max output.
  - `zai/glm-5.1`, recommended, 200K context, 128K max output.
  - `zai/glm-4.7`, available, 200K context, 128K max output.

## Validation

- Unit tests must assert `/model-catalog` exposes `zai`, its GLM models, and
  API key auth.
- Unit tests must assert hosted registration accepts z.ai GLM models and masks
  credentials.
- Runtime provider tests must assert a registered z.ai GLM model calls the
  OpenAI-compatible Z.AI endpoint with the registered API key.
- UI tests or source guards must assert the hosted model form exposes the API
  base URL field for providers that advertise a default base URL.
