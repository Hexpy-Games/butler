# providers integration

`packages/butler-agent/src/integrations/providers/` owns model-provider adapters, model catalogs,
auth helpers, local-model registration, prompt-cache telemetry, and provider
error normalization.

## Key Files

- `provider.ts`: hosted and local provider request execution.
- `openai-auth.ts` and `openai-models.ts`: OpenAI auth profiles and model
  discovery.
- `local-models.ts`, `registered-models.ts`, `model-catalog.ts`, and
  `model-ref.ts`: local and hosted model registration plus model reference
  normalization.
- `control-plane.ts`, `native-main-state.ts`, and `prompt-cache-metrics.ts`:
  provider-facing runtime status and telemetry.

## Boundaries

Provider integrations translate between Butler and model backends. They should
not own agent policy, project-session routing, transport delivery, or product
UI state.

## Related Specs

- `SPEC-OPENAI-AUTH-AND-MODELS` - OpenAI Auth And Model Discovery
- `SPEC-MODEL-PROVIDER-CONTROL-UX` - Model And Provider Control UX
- `SPEC-BUTLER-AGENT-LOOP` - Butler Agent Loop
