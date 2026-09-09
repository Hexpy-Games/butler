# Local output limit omission

## Scope and plan

For local models, an unspecified output limit remains unspecified through discovery, registration, configuration reads, ordinary rounds and context-summary rounds. The provider server selects its default. Explicit configuration and request limits remain supported. Hosted providers keep their current behavior.

Tasks: remove the local 4096 fallback; suppress synthesized summary limits only for local models without a configured limit; verify persistence and outbound payloads; remove the known automatic 4096 value for the operational Qwen model and restart/health-check the runtime.

No blanket migration of saved 4096 values: other entries may represent explicit user settings. Server defaults/context limits still apply; omission does not imply unlimited generation. Reasoning-effort forwarding is outside this correction.

## Validation and rollout

- Removed fallback in local discovery, registration and read normalization. Local output metadata is optional; reasoning budget calculations safely handle absence.
- Guided context summaries omit their synthesized cap when the active model is local and has no configured cap. Explicit local and hosted summary limits retain the prior calculation.
- Focused provider tests: 7 passed, covering discovery, persistence, explicit 4096 preservation, ordinary outbound omission, request override, and existing hosted behavior. Changed-file ESLint and diff whitespace checks passed.
- App HTTP discovery/registration/edit tests: 3 passed. Discovery and registered catalog omit the unspecified output limit. A relative reasoning budget has no absolute token budget without an explicit output cap.
- Full backend type check blocked by `integrations/project-ledger/client.ts:102` (TS2339), outside this diff.
- Broader Guided Turn suite: 39 passed, 55 failed, including Work admission and tool surface failures. No claim of full-suite success or baseline equivalence; those failures were not repaired in this scope.
- Operational config: removed only `models.local[model_ref=local/qwen3.8-27b].max_output_tokens`; context remains 114688. Actual local adapter HTTP request had neither max_tokens nor max_completion_tokens and the live server returned OK (57 prompt, 35 output tokens).
- Restarted 2026-09-09 22:32 KST: main launcher 19350, native child 20100; embed launcher 20403. App health ok; embedding health ready.
- Review: no additional provider implementation, retry path, module boundary or hosted behavior introduced. The previously failing long Work was not replayed; the live probe verifies omission and server acceptance, not completion of that Work.

## Commit-time revalidation

Focused provider, local HTTP registration, and failure-diagnostic regressions: 14 passed. Backend TypeScript now passes on the current checkout; the earlier unrelated error is no longer present. Earlier broad Guided suite failure evidence remains historical, not a claim about the current baseline.
