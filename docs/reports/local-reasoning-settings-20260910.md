# Local reasoning effort settings

## Scope and plan

Expose the verified Qwen3.8 template values (none, low, medium, xhigh) through the existing model catalog and effort selectors. Forward the selected value as top-level reasoning_effort in both tool rounds and text requests. Keep unknown local models and hosted providers on their existing protocols. Preserve saved selections; an unspecified Qwen effort retains the server default (xhigh).

Tasks: (1) model capability and request mapping, (2) settings compatibility, (3) targeted request/catalog tests and typecheck/build, (4) diff review, commit and running-service rollout.

## Design review

Named effort is independent of the legacy output-token ratio. Qwen3.8 model IDs, including namespaced/quantized names, identify its known template contract. This is not a claim that every OpenAI-compatible server supports named effort. Unsupported explicit efforts fail instead of being silently translated. No sampling or output-limit changes. The obsolete token-ratio control is hidden for models with named low effort support.

## Validation and review

- Provider boundary suite: 8 passed, 72 assertions. Covers all four catalog values through both outbound paths, absent output caps, rejected unsupported efforts, namespaced model IDs, and unchanged legacy request fields.
- Backend/UI typecheck and production UI build passed (existing bundle-size warning).
- Module shape audit: 5 source files, no review flags. Final diff review confirmed catalog metadata drives existing selectors and prevents token-ratio labels from replacing native effort names.
