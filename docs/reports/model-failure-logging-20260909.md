# Model failure diagnostics — 2026-09-09

## Intent and scope
The user requires model-call failures to leave enough evidence to identify why
they failed. The Qwen incident lost HTTP status and cause when the guided loop
converted a provider exception to a public runtime failure.

## Plan and acceptance
1. At the existing guided provider boundary, log each failed call to the existing
   service stderr log before retry/terminal handling. Include timestamp, turn,
   round, effective model and the existing sanitized provider diagnostic (HTTP
   status, cause, provider error code/type, request identity and token counts when
   available). This small operational record is independent of developer mode.
2. Pass the failure through the existing execution-local model observer so the
   gated DeveloperLogStore preserves it even when the loop returns a reduced
   runtime failure. Clear it at the next request, avoiding stale failure capture.
3. Verify HTTP rejection, retry then success, logging failure isolation, and
   persisted developer diagnostics. Keep retry policy and public errors unchanged.

The existing service logger, observer and DeveloperLogStore own their respective
records. No new database, logging service, public error payload, or settings
change. No prompt/request body is added to operational logs. Existing secret
redaction applies. Historical missing errors cannot be reconstructed.

Plan review: the changes occur before the observed lossy catch, cover normal and
Steward calls through the same production boundary, and leave recovery ownership
unchanged. Deployment/restart is a separate operational action.

## Validation
- Implemented at the existing production guided provider wrapper. Each failed
  attempt writes `btcc_model_round_failed` to service stderr before the route or
  operational-report catch can reduce it. Normal and Steward use this boundary.
- Existing execution-local observer now retains the last provider failure for
  DeveloperLogStore. Public `BtccRuntimeFailure` remains code/retryable only.
- Four production guided-path regressions pass: developer mode off/on HTTP 400,
  HTTP 503 then successful retry, and throwing logger/observer isolation. The
  tests use admitted Turns and the real JSONL DeveloperLogStore.
- Sixteen existing developer capture/store and retry-policy tests pass. Backend
  TypeScript, focused ESLint and diff whitespace checks pass.
- Whole-change review: original error is rethrown, route policy is unchanged,
  failed-attempt logging is unconditional, and the developer capture resets on
  the next request. Operational logs contain no request body; existing bounded
  sanitized diagnostics retain HTTP status, cause and provider identifiers.
- No live provider request or service restart was performed. The running service
  needs to load the changed code before operational logging takes effect. Existing
  staged repository work is preserved; this correction is left unstaged rather
  than committing unrelated staged changes.

## Operational rollout
- User authorized applying to the running service. At 2026-09-09 20:21:48 KST,
  restarted butler-main through the existing bounded native supervisor API.
  Launcher PID 50223 -> 4851; native runtime child PID 5269 loads this checkout.
- Existing startup orphan cleanup terminated the embed child; restored embed-server
  through the same supervisor API (launcher PID 9274).
- App health returned ok; embed health returned ready with zero active/queued
  requests. No live model error was deliberately injected.

## Commit-time revalidation

All four focused production-path failure logging regressions pass on the current checkout. Backend TypeScript passes. This correction is now included in the user-authorized commit alongside the local output-limit correction.
