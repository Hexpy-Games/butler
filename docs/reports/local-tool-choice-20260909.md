# Local tool choice correction

Accepted scope: fix the confirmed local vLLM HTTP 400, validate, and restart the
running Butler service. OpenAI and hosted adapters and retry policy are unchanged.

Plan: (1) include tools and tool_choice together only for nonempty tools in the
existing local model-round adapter; (2) test empty tools and auto/required tools;
(3) verify a harmless text-only request against the configured Qwen server using
the actual adapter; (4) restart the native service and verify service health.

Review: this addresses the exact rejected request at its existing serializer;
no shared protocol change or new fallback is needed. Preserve unrelated edits.

Validation: five provider usage/serialization tests pass (29 assertions), including
empty-tools requests with omitted/auto/required choice and tool-enabled requests
preserving auto/required. Backend TypeScript, focused ESLint, and diff check pass.
Actual runLocalModelRound against configured Qwen returned text OK, no tool calls,
finish_reason stop for an empty-tools request. No user conversation was sent.

Rollout: 2026-09-09 20:58:01 KST butler-main restarted via bounded native
supervisor, PID 4851 -> 63896, loading this checkout. Embed restored at 20:58:03,
PID 64740, after existing startup cleanup. App health ok and embed ready.

Final review: only local serializer changed; hosted/OpenAI and retry policy
unchanged. Existing unrelated diagnostics changes retained. Live smoke verifies
the rejected request shape; the user's whole previous Work was not rerun.
